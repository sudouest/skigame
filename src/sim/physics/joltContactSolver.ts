import type JoltNS from 'jolt-physics/wasm';
import { getHazardDef } from '../../content/hazards';
import { clamp, degToRad } from '../../core/math';
import {
  createTerrainGridSampleOut,
  type SpineForkMeta,
  type SpineView,
  type TerrainFieldView,
  type TerrainGridSampleOut,
} from '../contracts';
import { MAX_CREATURES, MAX_HAZARDS, MAX_RAMPS, type EntityPools } from '../entityPools';
import { DisposableScope, type JoltModule, type JoltRuntime, type JoltWorldSlot } from './joltRuntime';
import {
  MAX_CONTACT_EVENTS_PER_STEP,
  type ContactBodyKind,
  type HeightPatchNormalOut,
  type WorldContactSolver,
  type WorldMoveRequest,
  type WorldMoveResult,
} from './worldContactSolver';

export const HF_SAMPLES = 64;
export const HF_STEP_M = 0.5;
export const HF_HALF_SPAN_M = ((HF_SAMPLES - 1) * HF_STEP_M) * 0.5; // 15.75 m
// Recenter when skier drifts > 5.5m from patch center (with +2.0m travel lead -> ~7.5m stride, >= 2.25m inside [16..48],
// keeping the active [16..48] (-7.75m..+8.25m) window predominantly on-piste & uploading only 34x34 via SetHeights!)
export const HF_RECENTER_DIST_M = 5.5;
const HF_FORWARD_LEAD_M = 2.0;
const HF_MIN_HEIGHT = -128;
const HF_MAX_HEIGHT = 128;

// Lattice alignment step (2.0m = 4 fine cells) so 0.5m, 1.0m, and 2.0m sub-grids stay bit-aligned across shifts
const PATCH_SNAP_M = 2.0;
const INNER_1M_MIN = 16; // -7.75m (multiple of 4 & mBlockSize=2 so sub-rect SetHeights aligns cleanly!)
const INNER_1M_MAX = 48; // +8.25m (9x9 = 81 stride-4 nodes; 100% evaluated, stays predominantly on-piste!)
const SUBRECT_START = INNER_1M_MIN; // 16
const SUBRECT_COUNT = INNER_1M_MAX - INNER_1M_MIN + 2; // 34 (covers [16..49], 3.5x faster SetHeights!)
// Fine adaptive 2m -> 1m -> 0.5m corridor (covers full +/-5m box at any heading + forward travel path!)
const CORRIDOR_HALF_WIDTH_M = 5.5;
const CORRIDOR_BACK_M = 5.5;
const CORRIDOR_AHEAD_M = 10.0;
const CORRIDOR_ISO_RADIUS_SQ_M = 7.3 * 7.3;
const CORE_1M_RADIUS_SQ_M = 3.1 * 3.1;
const CORE_CURV_RADIUS_SQ_M = 4.5 * 4.5;
const FOOT_EXACT_RADIUS_CELLS = 1; // +/-0.5m exact 0.5m under feet; <=3.1m always <=1.0m & <=4.5m tight 0.06m curv
// Pure curvature-driven 2-level adaptive quadtree thresholds (4-edge symmetric curvature + saddle twist):
// - [16..48]: full 2.0m lattice (81 nodes); <=3.1m core is always <=1.0m (0.5m if >0.06m curv),
//   <=4.5m ring uses tight 0.08m/0.06m curvature, outer corridor uses 0.22m/0.18m so 50km soak stays fast.
const ADAPTIVE_CURV_2M_CORE_M = 0.08;
const ADAPTIVE_CURV_1M_CORE_M = 0.06;
const ADAPTIVE_CURV_2M_IN_M = 0.22;
const ADAPTIVE_CURV_1M_IN_M = 0.18;
// 2D gradient magnitude threshold on fine 0.5m grid for steep-slope listener activation (> 40 deg at ANY angle)
const STEEP_GRAD_SQ_05M = 0.176; // (0.5 * tan(40 deg))^2
const MIN_WALL_IMPACT_SPEED_MPS = 0.25;

const INIT_COARSE_N = 17;

const BUBBLE_ENTER_RADIUS_M = 50.0;
const BUBBLE_ENTER_RADIUS_SQ = BUBBLE_ENTER_RADIUS_M * BUBBLE_ENTER_RADIUS_M;
const BUBBLE_EXIT_RADIUS_M = 60.0;
const BUBBLE_EXIT_RADIUS_SQ = BUBBLE_EXIT_RADIUS_M * BUBBLE_EXIT_RADIUS_M;
const BUBBLE_RESYNC_DIST_M = 4.0;
const BUBBLE_RESYNC_DIST_SQ = BUBBLE_RESYNC_DIST_M * BUBBLE_RESYNC_DIST_M;
const LISTENER_PROXIMITY_SQ = 8.0 * 8.0;

export const MAX_CLIMBABLE_SLOPE_DEG = 52;
export const MAX_CLIMBABLE_SLOPE_RAD = degToRad(MAX_CLIMBABLE_SLOPE_DEG);
export const COS_MAX_CLIMBABLE_SLOPE = Math.cos(MAX_CLIMBABLE_SLOPE_RAD);

const KIND_NONE = 0;
const KIND_TERRAIN = 1;
const KIND_RAMP = 2;
const KIND_HAZARD = 3;
const KIND_CREATURE = 4;
const KIND_FORK_BUMPER = 5;

const KIND_TABLE: readonly ContactBodyKind[] = [
  'none',
  'terrain',
  'ramp',
  'hazard',
  'creature',
  'forkBumper',
];

const FORK_BUMPER_CLEARANCE_Y_M = 1.65;
const FORK_BUMPER_SHAPE_HEIGHT_M = 3.2;
const RAMP_SKIRT_DEPTH_M = 0.45;
const MAX_BUBBLE_BODIES = 160;
const BODY_ID_INDEX_MASK = 0x7fffff;

interface BubbleBodySlot {
  active: boolean;
  kindCode: number;
  poolIndex: number;
  bodyId: JoltNS.BodyID | null;
  bodyIndex: number;
  posX: number;
  posY: number;
  posZ: number;
  halfHeightY: number;
}

export interface JoltContactSolverOptions {
  readonly skierRadius?: number;
  readonly skierHeight?: number;
}

/**
 * Quarantined Layer B Jolt Physics WASM adapter.
 * ALL raw Jolt calls, RefTarget lifecycles, `_webidl_malloc` buffers, and C++ ownership
 * traps live strictly inside `src/sim/physics/`.
 */
export class JoltContactSolver implements WorldContactSolver {
  private readonly runtime: JoltRuntime;
  private readonly jolt: JoltModule;
  private readonly bi: JoltNS.BodyInterface;
  private readonly worldSlot: JoltWorldSlot;
  private readonly scope: DisposableScope;

  // Rolling 64x64 @ 0.5m HeightFieldShape + persistent WebIDL float buffer
  private readonly hfShape: JoltNS.HeightFieldShape;
  private readonly hfBodyId: JoltNS.BodyID;
  private readonly heightsPtr: number;
  private readonly heightsMemRef: JoltNS.FloatMemRef;
  private readonly initGridScratch: TerrainGridSampleOut = createTerrainGridSampleOut(
    INIT_COARSE_N,
    INIT_COARSE_N,
  );
  private patchHeights = new Float32Array(HF_SAMPLES * HF_SAMPLES);
  private patchHeightsScratch = new Float32Array(HF_SAMPLES * HF_SAMPLES);
  private patchExactMask = new Uint8Array(HF_SAMPLES * HF_SAMPLES);
  private patchExactScratch = new Uint8Array(HF_SAMPLES * HF_SAMPLES);
  private readonly spinesScratch: SpineView[] = [];
  private patchInitialized = false;
  private patchCenterAbsX = 0;
  private patchCenterAbsY = 0;
  private patchCenterAbsZ = 0;
  private patchOriginAbsX = 0;
  private patchOriginAbsZ = 0;
  private patchCenterX = 0;
  private patchCenterY = 0;
  private patchCenterZ = 0;
  private lastFieldRevision = -1;
  private hfRefreshCount = 0;
  private prevSyncSkierX = NaN;
  private prevSyncSkierZ = NaN;
  private moveDirX = 0;
  private moveDirZ = -1;

  // Skier CharacterVirtual + filters + listener
  private readonly character: JoltNS.CharacterVirtual;
  private readonly contactListener: JoltNS.CharacterContactListenerJS;
  private listenerAttached = false;
  private readonly bpFilter: JoltNS.DefaultBroadPhaseLayerFilter;
  private readonly objFilter: JoltNS.DefaultObjectLayerFilter;
  private readonly bodyFilter: JoltNS.BodyFilter;
  private readonly shapeFilter: JoltNS.ShapeFilter;

  // Reusable math scratch (zero hot-loop WASM allocations)
  private readonly zeroVec3: JoltNS.Vec3;
  private readonly scratchVec3: JoltNS.Vec3;
  private readonly scratchVec3B: JoltNS.Vec3;
  private readonly scratchRVec3: JoltNS.RVec3;
  private readonly scratchQuat: JoltNS.Quat;
  private readonly identityQuat: JoltNS.Quat;

  // Active local 50-60m body bubble + O(1) bodyIndex metadata tables
  private readonly bodyKindByIndex: Uint8Array;
  private readonly bodyPoolIdxByIndex: Int32Array;
  private readonly shapeCache = new Map<string, JoltNS.Shape>();
  private readonly bubbleSlots: BubbleBodySlot[] = [];
  private readonly freeBubbleSlotIndices: number[] = [];
  private readonly activeBubbleIndices: number[] = [];
  private readonly hazardSlotToBubble = new Int32Array(MAX_HAZARDS).fill(-1);
  private readonly rampSlotToBubble = new Int32Array(MAX_RAMPS).fill(-1);
  private readonly creatureSlotToBubble = new Int32Array(MAX_CREATURES).fill(-1);
  private forkBumperBubbleSlot = -1;
  private forkBumperLastX = NaN;
  private forkBumperLastY = NaN;
  private forkBumperLastZ = NaN;
  private forkBumperLastRadius = NaN;
  private lastBubbleSyncX = NaN;
  private lastBubbleSyncZ = NaN;
  private lastHazardCount = -1;
  private lastRampCount = -1;
  private lastCreatureCount = -1;
  private hasNearbyObstacle = false;
  private patchHasSteepSlope = false;

  // Per-step callback context (mutated in place, zero closures/wrappers allocated per step)
  private currentPools: EntityPools | null = null;
  private currentResult: WorldMoveResult | null = null;
  private activeCollideHazards = true;
  private activeCollideCreatures = true;
  private activeIsWipeoutTumble = false;
  private activeSkierPosY = 0;
  private preStepVelX = 0;
  private preStepVelY = 0;
  private preStepVelZ = 0;
  private disposed = false;

  constructor(runtime: JoltRuntime, options: JoltContactSolverOptions = {}) {
    this.runtime = runtime;
    this.jolt = runtime.jolt;
    this.bi = runtime.bodyInterface;
    this.worldSlot = runtime.acquireWorldSlot();
    this.scope = new DisposableScope(this.jolt);

    const J = this.jolt;
    const maxBodies = runtime.maxBodies;

    // Idempotent slot release safety net so even an early constructor throw never leaks worldSlot
    this.scope.onDispose(() => {
      this.runtime.releaseWorldSlot(this.worldSlot);
    });

    this.bodyKindByIndex = new Uint8Array(maxBodies);
    this.bodyPoolIdxByIndex = new Int32Array(maxBodies).fill(-1);

    for (let i = 0; i < MAX_BUBBLE_BODIES; i++) {
      this.bubbleSlots.push({
        active: false,
        kindCode: KIND_NONE,
        poolIndex: -1,
        bodyId: null,
        bodyIndex: -1,
        posX: 0,
        posY: 0,
        posZ: 0,
        halfHeightY: 0,
      });
      this.freeBubbleSlotIndices.push(MAX_BUBBLE_BODIES - 1 - i);
    }

    // Reusable WASM math scratch vectors/quaternions
    this.zeroVec3 = this.scope.track(new J.Vec3(0, 0, 0));
    this.scratchVec3 = this.scope.track(new J.Vec3(0, 0, 0));
    this.scratchVec3B = this.scope.track(new J.Vec3(0, 0, 0));
    this.scratchRVec3 = this.scope.track(new J.RVec3(0, 0, 0));
    this.scratchQuat = this.scope.track(new J.Quat(0, 0, 0, 1));
    this.identityQuat = this.scope.track(new J.Quat(0, 0, 0, 1));

    // Release cached shapes during LIFO teardown (after all bodies referencing them are destroyed)
    this.scope.onDispose(() => {
      for (const shape of this.shapeCache.values()) {
        shape.Release();
      }
      this.shapeCache.clear();
    });

    // 1. Build persistent rolling 64x64 @ 0.5m HeightFieldShape
    this.heightsPtr = this.scope.trackAlloc(J._webidl_malloc(HF_SAMPLES * HF_SAMPLES * 4));
    this.heightsMemRef = J.wrapPointer(this.heightsPtr, J.FloatMemRef);

    const hfSettings = new J.HeightFieldShapeSettings();
    hfSettings.mOffset.Set(-HF_HALF_SPAN_M, 0, -HF_HALF_SPAN_M);
    hfSettings.mScale.Set(HF_STEP_M, 1.0, HF_STEP_M);
    hfSettings.mSampleCount = HF_SAMPLES;
    hfSettings.mBlockSize = 2;
    hfSettings.mBitsPerSample = 8;
    hfSettings.mMinHeightValue = HF_MIN_HEIGHT;
    hfSettings.mMaxHeightValue = HF_MAX_HEIGHT;
    hfSettings.mHeightSamples.resize(HF_SAMPLES * HF_SAMPLES);
    const initPtr = J.getPointer(hfSettings.mHeightSamples.data());
    J.HEAPF32.fill(0, initPtr >> 2, (initPtr >> 2) + HF_SAMPLES * HF_SAMPLES);

    const hfResult = hfSettings.Create();
    if (!hfResult.IsValid()) {
      const err = hfResult.GetError().c_str();
      hfResult.Clear();
      J.destroy(hfSettings);
      this.scope.dispose();
      throw new Error(`Failed to create Jolt HeightFieldShape: ${err}`);
    }
    this.hfShape = J.castObject(hfResult.Get(), J.HeightFieldShape);
    this.hfShape.AddRef();
    hfResult.Clear();
    J.destroy(hfSettings);
    this.scope.trackRef(this.hfShape);

    // Attach our HeightFieldShape to the slot's persistent terrainBodyId (0 B leak across lifecycles!)
    this.hfBodyId = this.worldSlot.terrainBodyId;
    this.bi.SetShape(this.hfBodyId, this.hfShape, false, J.EActivation_DontActivate);
    this.bi.SetPosition(this.hfBodyId, this.scratchRVec3, J.EActivation_DontActivate);
    const hfIdx = this.hfBodyId.GetIndex();
    this.bodyKindByIndex[hfIdx] = KIND_TERRAIN;
    this.bodyPoolIdxByIndex[hfIdx] = -1;

    this.scope.onDispose(() => {
      this.clearBubbleBodies();
      const idx = this.hfBodyId.GetIndex();
      this.bodyKindByIndex[idx] = KIND_NONE;
      this.bodyPoolIdxByIndex[idx] = -1;
      // Swap terrainBodyId back to emptyTerrainShape BEFORE hfShape.Release() runs in LIFO order
      this.runtime.releaseWorldSlot(this.worldSlot);
    });

    // 2. Build CharacterVirtual (capsule foot-anchored at character.GetPosition())
    const capRadius = clamp(options.skierRadius ?? 0.45, 0.3, 0.55);
    const skierHeight = Math.max(capRadius * 2 + 0.1, options.skierHeight ?? 1.7);
    const capHalfHeight = Math.max(0.05, skierHeight * 0.5 - capRadius);
    const capShape = new J.CapsuleShape(capHalfHeight, capRadius);
    capShape.AddRef();
    this.scope.trackRef(capShape);

    const cvSettings = new J.CharacterVirtualSettings();
    cvSettings.mShape = capShape;
    cvSettings.mMaxSlopeAngle = MAX_CLIMBABLE_SLOPE_RAD;
    cvSettings.mShapeOffset.Set(0, capHalfHeight + capRadius, 0);
    cvSettings.mCharacterPadding = 0.02;
    cvSettings.mCollisionTolerance = 0.005;
    cvSettings.mPredictiveContactDistance = 0.1;
    cvSettings.mMaxCollisionIterations = 3;
    cvSettings.mMaxConstraintIterations = 8;
    cvSettings.mPenetrationRecoverySpeed = 1.0;
    cvSettings.mBackFaceMode = J.EBackFaceMode_IgnoreBackFaces;

    this.character = this.scope.track(
      new J.CharacterVirtual(
        cvSettings,
        this.scratchRVec3,
        this.identityQuat,
        runtime.physicsSystem,
      ),
    );
    J.destroy(cvSettings);

    // 3. Filters (no stair-stepping so skis never hop onto boulders/walls)
    this.bpFilter = this.scope.track(
      new J.DefaultBroadPhaseLayerFilter(
        runtime.joltInterface.GetObjectVsBroadPhaseLayerFilter(),
        this.worldSlot.movingLayer,
      ),
    );
    this.objFilter = this.scope.track(
      new J.DefaultObjectLayerFilter(
        runtime.joltInterface.GetObjectLayerPairFilter(),
        this.worldSlot.movingLayer,
      ),
    );
    this.bodyFilter = this.scope.track(new J.BodyFilter());
    this.shapeFilter = this.scope.track(new J.ShapeFilter());

    // 4. CharacterContactListenerJS reading WASM HEAPU32/HEAPF32 directly (zero wrapPointer overhead!)
    const heapU32 = J.HEAPU32;
    const heapF32 = J.HEAPF32;
    const bodyKinds = this.bodyKindByIndex;
    const bodyPoolIdxs = this.bodyPoolIdxByIndex;

    this.contactListener = this.scope.track(new J.CharacterContactListenerJS());
    this.contactListener.OnAdjustBodyVelocity = () => {};
    this.contactListener.OnCharacterContactValidate = () => false;
    this.contactListener.OnContactRemoved = () => {};
    this.contactListener.OnCharacterContactAdded = () => {};
    this.contactListener.OnCharacterContactPersisted = () => {};
    this.contactListener.OnCharacterContactRemoved = () => {};
    this.contactListener.OnCharacterContactSolve = () => {};

    this.contactListener.OnContactValidate = (_charPtr, bodyIdPtr) => {
      const bIdx = heapU32[bodyIdPtr >> 2]! & BODY_ID_INDEX_MASK;
      if (bIdx >= maxBodies) return false;
      const kindCode = bodyKinds[bIdx]!;
      if (kindCode === KIND_TERRAIN || kindCode === KIND_RAMP) return true;
      if (kindCode === KIND_HAZARD) {
        if (!this.activeCollideHazards) return false;
        if (!this.activeIsWipeoutTumble) {
          const poolIdx = bodyPoolIdxs[bIdx]!;
          if (this.currentPools && poolIdx >= 0 && this.currentPools.hazards.triggered[poolIdx] !== 0) {
            return false;
          }
        }
        return true;
      }
      if (kindCode === KIND_CREATURE) {
        return this.activeCollideCreatures;
      }
      if (kindCode === KIND_FORK_BUMPER) {
        return this.activeSkierPosY < this.forkBumperLastY + FORK_BUMPER_CLEARANCE_Y_M;
      }
      return false;
    };

    const pushContact = (
      out: WorldMoveResult,
      kindCode: number,
      poolIdx: number,
      posPtr: number,
      nx: number,
      ny: number,
      nz: number,
      impactSpeed: number,
    ): void => {
      if (kindCode === KIND_TERRAIN) {
        if (ny >= COS_MAX_CLIMBABLE_SLOPE) return;
        if (!out.wallHit || impactSpeed >= out.wallImpactSpeed) {
          out.wallHit = true;
          out.wallNormalX = nx;
          out.wallNormalY = ny;
          out.wallNormalZ = nz;
          out.wallImpactSpeed = Math.max(out.wallImpactSpeed, impactSpeed);
        }
      }

      const kind = KIND_TABLE[kindCode]!;
      const pBase = posPtr >> 2;
      const px = heapF32[pBase]!;
      const py = heapF32[pBase + 1]!;
      const pz = heapF32[pBase + 2]!;

      for (let i = 0; i < out.contactCount; i++) {
        const c = out.contacts[i]!;
        if (c.kind === kind && c.poolIndex === poolIdx) {
          if (impactSpeed >= c.impactSpeed) {
            c.posX = px;
            c.posY = py;
            c.posZ = pz;
            c.normalX = nx;
            c.normalY = ny;
            c.normalZ = nz;
            c.impactSpeed = impactSpeed;
          }
          return;
        }
      }
      if (out.contactCount < MAX_CONTACT_EVENTS_PER_STEP) {
        const c = out.contacts[out.contactCount++]!;
        c.kind = kind;
        c.poolIndex = poolIdx;
        c.posX = px;
        c.posY = py;
        c.posZ = pz;
        c.normalX = nx;
        c.normalY = ny;
        c.normalZ = nz;
        c.impactSpeed = impactSpeed;
      }
    };

    // NOTE: JoltJS.h:690 negates inContactNormal in OnContactAdded / OnContactPersisted!
    // Skip KIND_TERRAIN here (0 m/s predictive trailing-edge touches are not wall impacts);
    // OnContactSolve reports every real steep terrain constraint with its exact closing speed.
    const onAddedOrPersisted = (_c: number, bodyIdPtr: number, _sub: number, posPtr: number, normPtr: number): void => {
      const out = this.currentResult;
      if (!out) return;
      const bIdx = heapU32[bodyIdPtr >> 2]! & BODY_ID_INDEX_MASK;
      if (bIdx >= maxBodies) return;
      const kindCode = bodyKinds[bIdx]!;
      if (kindCode === KIND_NONE || kindCode === KIND_TERRAIN) return;
      const nBase = normPtr >> 2;
      pushContact(
        out,
        kindCode,
        bodyPoolIdxs[bIdx]!,
        posPtr,
        -heapF32[nBase]!,
        -heapF32[nBase + 1]!,
        -heapF32[nBase + 2]!,
        0,
      );
    };

    this.contactListener.OnContactAdded = onAddedOrPersisted;
    this.contactListener.OnContactPersisted = onAddedOrPersisted;

    // Verified: OnContactSolve receives positive outward surface normal + contact/character velocities
    this.contactListener.OnContactSolve = (
      _c,
      bodyIdPtr,
      _sub,
      posPtr,
      normPtr,
      contactVelPtr,
      _matPtr,
      charVelPtr,
    ) => {
      const out = this.currentResult;
      if (!out) return;
      const bIdx = heapU32[bodyIdPtr >> 2]! & BODY_ID_INDEX_MASK;
      if (bIdx >= maxBodies) return;
      const kindCode = bodyKinds[bIdx]!;
      if (kindCode === KIND_NONE) return;

      const nBase = normPtr >> 2;
      const ny = heapF32[nBase + 1]!;
      if (kindCode === KIND_TERRAIN && ny >= COS_MAX_CLIMBABLE_SLOPE) return;

      const nx = heapF32[nBase]!;
      const nz = heapF32[nBase + 2]!;
      const cvBase = contactVelPtr >> 2;
      const cvx = heapF32[cvBase]!;
      const cvy = heapF32[cvBase + 1]!;
      const cvz = heapF32[cvBase + 2]!;
      const vBase = charVelPtr >> 2;
      const rvx = heapF32[vBase]! - cvx;
      const rvy = heapF32[vBase + 1]! - cvy;
      const rvz = heapF32[vBase + 2]! - cvz;
      const relDotNInst = rvx * nx + rvy * ny + rvz * nz;
      const relDotNPre =
        (this.preStepVelX - cvx) * nx +
        (this.preStepVelY - cvy) * ny +
        (this.preStepVelZ - cvz) * nz;
      const impactSpeed = Math.max(0, -relDotNInst, -relDotNPre);
      if (kindCode === KIND_TERRAIN && impactSpeed <= MIN_WALL_IMPACT_SPEED_MPS) return;

      pushContact(out, kindCode, bodyPoolIdxs[bIdx]!, posPtr, nx, ny, nz, impactSpeed);
    };

    this.character.SetListener(this.contactListener);
    this.listenerAttached = true;
    this.scope.onDispose(() => {
      this.character.SetListener(null as unknown as JoltNS.CharacterContactListener);
      this.listenerAttached = false;
    });
  }

  syncWorld(
    skierX: number,
    skierY: number,
    skierZ: number,
    dt: number,
    terrain: TerrainFieldView,
    pools: EntityPools,
    forkBumper: SpineForkMeta | null,
    forceTerrainRefresh = false,
  ): void {
    if (this.disposed) return;
    this.currentPools = pools;

    // Track horizontal travel direction to lead patch center forward (cuts refreshes while keeping >= 6.25m margin)
    if (!Number.isNaN(this.prevSyncSkierX)) {
      const mdx = skierX - this.prevSyncSkierX;
      const mdz = skierZ - this.prevSyncSkierZ;
      const mLen = Math.hypot(mdx, mdz);
      if (mLen > 0.05 && mLen < 12.0) {
        this.moveDirX = mdx / mLen;
        this.moveDirZ = mdz / mLen;
      }
    }
    this.prevSyncSkierX = skierX;
    this.prevSyncSkierZ = skierZ;

    // Scan all dirtyRects from 0 whenever fieldRevision changes (rects is small & ackDirtyRects() clears it)
    let dirtyOverlapsPatch = false;
    if (this.patchInitialized && terrain.fieldRevision !== this.lastFieldRevision) {
      const rects = terrain.dirtyRects;
      if (rects.length === 0) {
        dirtyOverlapsPatch = true;
      } else {
        const minX = this.patchCenterAbsX - HF_HALF_SPAN_M - PATCH_SNAP_M;
        const maxX = this.patchCenterAbsX + HF_HALF_SPAN_M + PATCH_SNAP_M;
        const minZ = this.patchCenterAbsZ - HF_HALF_SPAN_M - PATCH_SNAP_M;
        const maxZ = this.patchCenterAbsZ + HF_HALF_SPAN_M + PATCH_SNAP_M;
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]!;
          if (r.maxAbsX >= minX && r.minAbsX <= maxX && r.maxAbsZ >= minZ && r.minAbsZ <= maxZ) {
            dirtyOverlapsPatch = true;
            break;
          }
        }
      }
      if (!dirtyOverlapsPatch) {
        this.lastFieldRevision = terrain.fieldRevision;
      }
    }

    // 1. Update rolling 64x64 @ 0.5m HeightFieldShape when skier moves > HF_RECENTER_DIST_M
    const needHeightRefresh =
      forceTerrainRefresh ||
      !this.patchInitialized ||
      dirtyOverlapsPatch ||
      Math.abs(skierX - this.patchCenterX) > HF_RECENTER_DIST_M ||
      Math.abs(skierZ - this.patchCenterZ) > HF_RECENTER_DIST_M ||
      Math.abs(skierY - this.patchCenterY) > 64.0;

    if (needHeightRefresh) {
      this.updateHeightFieldPatch(
        skierX,
        skierY,
        skierZ,
        terrain,
        forceTerrainRefresh || dirtyOverlapsPatch,
      );
    }

    // 2. Sync active 50-60m body bubble (hazards, ramps, creatures, fork nose bumper)
    const poolCountChanged =
      pools.hazards.count !== this.lastHazardCount ||
      pools.ramps.count !== this.lastRampCount ||
      pools.creatures.count !== this.lastCreatureCount;
    const dxB = skierX - this.lastBubbleSyncX;
    const dzB = skierZ - this.lastBubbleSyncZ;
    if (
      poolCountChanged ||
      Number.isNaN(this.lastBubbleSyncX) ||
      dxB * dxB + dzB * dzB >= BUBBLE_RESYNC_DIST_SQ
    ) {
      this.syncStaticAndCreatureBubble(skierX, skierZ, pools);
      this.lastBubbleSyncX = skierX;
      this.lastBubbleSyncZ = skierZ;
      this.lastHazardCount = pools.hazards.count;
      this.lastRampCount = pools.ramps.count;
      this.lastCreatureCount = pools.creatures.count;
    }

    // 3. Update kinematic creature poses & velocities every tick (only 0..3 creatures in bubble!)
    this.updateActiveCreatures(dt, pools);

    // 4. Sync fork V-wedge nose bumper cylinder (r = seamNoseRadius)
    this.syncForkBumper(skierX, skierZ, forkBumper);

    // 5. Fast proximity flag: only attach CharacterContactListenerJS when near obstacles/steep terrain
    let nearObs = false;
    for (let i = 0; i < this.activeBubbleIndices.length; i++) {
      const slot = this.bubbleSlots[this.activeBubbleIndices[i]!]!;
      const dx = slot.posX - skierX;
      const dz = slot.posZ - skierZ;
      if (dx * dx + dz * dz <= LISTENER_PROXIMITY_SQ) {
        nearObs = true;
        break;
      }
    }
    this.hasNearbyObstacle = nearObs;
  }

  samplePatchNormal(wx: number, wz: number, out: HeightPatchNormalOut): HeightPatchNormalOut {
    if (!this.patchInitialized) {
      out.valid = false;
      return out;
    }
    const fx = (wx - this.patchCenterX + HF_HALF_SPAN_M) / HF_STEP_M;
    const fz = (wz - this.patchCenterZ + HF_HALF_SPAN_M) / HF_STEP_M;
    if (
      fx < INNER_1M_MIN ||
      fx > INNER_1M_MAX - 1 ||
      fz < INNER_1M_MIN ||
      fz > INNER_1M_MAX - 1
    ) {
      out.valid = false;
      return out;
    }
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.patchHeights;

    const r0 = iz * HF_SAMPLES + ix;
    const r1 = r0 + HF_SAMPLES;
    const h00 = h[r0]!;
    const h10 = h[r0 + 1]!;
    const h01 = h[r1]!;
    const h11 = h[r1 + 1]!;
    const relY =
      (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;

    // Local cell gradient (0.5m exact span — never smears sharp cliff creases across 1.0m!)
    const dhdx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / HF_STEP_M;
    const dhdz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / HF_STEP_M;
    const invLen = 1 / Math.hypot(dhdx, 1, dhdz);

    out.valid = true;
    out.heightY = this.patchCenterY + relY;
    out.normalX = -dhdx * invLen;
    out.normalY = invLen;
    out.normalZ = -dhdz * invLen;
    return out;
  }

  stepCharacter(req: WorldMoveRequest, out: WorldMoveResult): void {
    if (this.disposed) return;

    if (req.syncPositionFirst) {
      this.scratchRVec3.Set(req.posX, req.posY, req.posZ);
      this.character.SetPosition(this.scratchRVec3);
    }

    // Apply tiny inward normal seating bias when adhering to gentle convex snow so Update()
    // contacts the floor on pass 1 without invoking expensive StickToFloor() sweeps (~1.1s faster on 50km!)
    const useSeatBias = req.stickToFloorStepDownM > 0 && req.seatBiasMps > 0;
    const seatVx = useSeatBias ? req.seatNormalX * req.seatBiasMps : 0;
    const seatVy = useSeatBias ? req.seatNormalY * req.seatBiasMps : 0;
    const seatVz = useSeatBias ? req.seatNormalZ * req.seatBiasMps : 0;

    this.scratchVec3.Set(req.velX - seatVx, req.velY - seatVy, req.velZ - seatVz);
    this.character.SetLinearVelocity(this.scratchVec3);

    out.wallHit = false;
    out.wallNormalX = 0;
    out.wallNormalY = 1;
    out.wallNormalZ = 0;
    out.wallImpactSpeed = 0;
    out.contactCount = 0;

    const needListener = this.hasNearbyObstacle || this.patchHasSteepSlope || req.isWipeoutTumble;
    if (needListener !== this.listenerAttached) {
      this.character.SetListener(
        needListener
          ? this.contactListener
          : (null as unknown as JoltNS.CharacterContactListener),
      );
      this.listenerAttached = needListener;
    }

    this.currentResult = out;
    this.activeCollideHazards = req.collideHazards;
    this.activeCollideCreatures = req.collideCreatures;
    this.activeIsWipeoutTumble = req.isWipeoutTumble;
    this.activeSkierPosY = req.posY;
    this.preStepVelX = req.velX;
    this.preStepVelY = req.velY;
    this.preStepVelZ = req.velZ;

    this.scratchVec3B.Set(0, req.gravityY, 0);
    this.character.Update(
      req.dt,
      this.scratchVec3B,
      this.bpFilter,
      this.objFilter,
      this.bodyFilter,
      this.shapeFilter,
      this.runtime.tempAllocator,
    );
    if (
      req.stickToFloorStepDownM > 0 &&
      this.character.GetGroundState() !== this.jolt.EGroundState_OnGround
    ) {
      this.scratchVec3.Set(0, -req.stickToFloorStepDownM, 0);
      this.character.StickToFloor(
        this.scratchVec3,
        this.bpFilter,
        this.objFilter,
        this.bodyFilter,
        this.shapeFilter,
        this.runtime.tempAllocator,
      );
    }

    this.currentResult = null;

    const newPos = this.character.GetPosition();
    const newVel = this.character.GetLinearVelocity();
    out.posX = newPos.GetX();
    out.posY = newPos.GetY();
    out.posZ = newPos.GetZ();
    out.velX = newVel.GetX();
    out.velY = newVel.GetY();
    out.velZ = newVel.GetZ();

    const gState = this.character.GetGroundState();
    out.isSupported = gState === this.jolt.EGroundState_OnGround;
    out.onSteepGround = gState === this.jolt.EGroundState_OnSteepGround;

    // Fallback check when listener was detached (patchHasSteepSlope === false across [-11.75,+12.25]m):
    // only inspect active contacts if unsupported or on steep ground (avoids ~3M redundant WASM calls on gentle snow!)
    if (!this.listenerAttached && (!out.isSupported || out.onSteepGround)) {
      const activeContacts = this.character.GetActiveContacts();
      const count = activeContacts.size();
      for (let i = 0; i < count; i++) {
        const c = activeContacts.at(i);
        const bIdx = c.mBodyB.GetIndex();
        if (bIdx < 0 || bIdx >= this.runtime.maxBodies) continue;
        if (this.bodyKindByIndex[bIdx] !== KIND_TERRAIN) continue;
        const sn = c.mSurfaceNormal;
        const sny = sn.GetY();
        if (sny < COS_MAX_CLIMBABLE_SLOPE) {
          const snx = sn.GetX();
          const snz = sn.GetZ();
          const closing = Math.max(0, -(req.velX * snx + req.velY * sny + req.velZ * snz));
          if (closing > MIN_WALL_IMPACT_SPEED_MPS && (!out.wallHit || closing >= out.wallImpactSpeed)) {
            out.wallHit = true;
            out.wallNormalX = snx;
            out.wallNormalY = sny;
            out.wallNormalZ = snz;
            out.wallImpactSpeed = Math.max(out.wallImpactSpeed, closing);
          }
        }
      }
    }

    // Undo temporary floor-seating bias: CharacterVirtual::Update() keeps mLinearVelocity intact
    // on normal floor/air steps, so restoring +seatV prevents leaking inward bias into skier velocity!
    if (useSeatBias && !out.wallHit && !out.onSteepGround) {
      out.velX += seatVx;
      out.velY += seatVy;
      out.velZ += seatVz;
    }

    if (out.isSupported || out.onSteepGround) {
      const gn = this.character.GetGroundNormal();
      out.groundNormalX = gn.GetX();
      out.groundNormalY = gn.GetY();
      out.groundNormalZ = gn.GetZ();

      const gBodyId = this.character.GetGroundBodyID();
      const gIdx = gBodyId.GetIndex();
      if (gIdx >= 0 && gIdx < this.runtime.maxBodies) {
        out.groundKind = KIND_TABLE[this.bodyKindByIndex[gIdx]!]!;
        out.groundPoolIndex = this.bodyPoolIdxByIndex[gIdx]!;
      } else {
        out.groundKind = 'none';
        out.groundPoolIndex = -1;
      }

      if (out.groundNormalY < COS_MAX_CLIMBABLE_SLOPE) {
        out.isSupported = false;
        out.onSteepGround = true;
      }
    } else {
      out.groundNormalX = 0;
      out.groundNormalY = 1;
      out.groundNormalZ = 0;
      out.groundKind = 'none';
      out.groundPoolIndex = -1;
    }
  }

  teleportCharacter(
    posX: number,
    posY: number,
    posZ: number,
    velX: number,
    velY: number,
    velZ: number,
  ): void {
    if (this.disposed) return;
    this.scratchRVec3.Set(posX, posY, posZ);
    this.character.SetPosition(this.scratchRVec3);
    this.scratchVec3.Set(velX, velY, velZ);
    this.character.SetLinearVelocity(this.scratchVec3);
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    if (this.disposed) return;
    const dontActivate = this.jolt.EActivation_DontActivate;

    const curPos = this.character.GetPosition();
    this.scratchRVec3.Set(curPos.GetX() - dx, curPos.GetY() - dy, curPos.GetZ() - dz);
    this.character.SetPosition(this.scratchRVec3);

    if (this.patchInitialized) {
      this.patchCenterX -= dx;
      this.patchCenterY -= dy;
      this.patchCenterZ -= dz;
      this.scratchRVec3.Set(this.patchCenterX, this.patchCenterY, this.patchCenterZ);
      this.bi.SetPosition(this.hfBodyId, this.scratchRVec3, dontActivate);
    }

    for (let i = 0; i < this.activeBubbleIndices.length; i++) {
      const slot = this.bubbleSlots[this.activeBubbleIndices[i]!]!;
      if (!slot.bodyId) continue;
      slot.posX -= dx;
      slot.posY -= dy;
      slot.posZ -= dz;
      this.scratchRVec3.Set(slot.posX, slot.posY + slot.halfHeightY, slot.posZ);
      this.bi.SetPosition(slot.bodyId, this.scratchRVec3, dontActivate);
    }

    if (!Number.isNaN(this.lastBubbleSyncX)) {
      this.lastBubbleSyncX -= dx;
      this.lastBubbleSyncZ -= dz;
    }
    if (!Number.isNaN(this.prevSyncSkierX)) {
      this.prevSyncSkierX -= dx;
      this.prevSyncSkierZ -= dz;
    }
    if (!Number.isNaN(this.forkBumperLastX)) {
      this.forkBumperLastX -= dx;
      this.forkBumperLastY -= dy;
      this.forkBumperLastZ -= dz;
    }
  }

  onPoolsPruned(): void {
    if (this.disposed) return;
    this.clearBubbleBodies();
    this.runtime.physicsSystem.OptimizeBroadPhase();
  }

  reset(): void {
    if (this.disposed) return;
    this.clearBubbleBodies();
    this.patchInitialized = false;
    this.patchExactMask.fill(0);
    this.lastFieldRevision = -1;
    this.prevSyncSkierX = NaN;
    this.prevSyncSkierZ = NaN;
    this.moveDirX = 0;
    this.moveDirZ = -1;
    this.lastBubbleSyncX = NaN;
    this.lastBubbleSyncZ = NaN;
    this.lastHazardCount = -1;
    this.lastRampCount = -1;
    this.lastCreatureCount = -1;
    this.hasNearbyObstacle = false;
    this.patchHasSteepSlope = false;
    this.runtime.physicsSystem.OptimizeBroadPhase();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.currentPools = null;
    this.currentResult = null;
    this.scope.dispose();
  }

  /**
   * Adaptive multi-band rolling 64x64 @ 0.5m heightfield update:
   * - Exact 0.5m around skier feet (+/-3.0m) AND adaptively subdivided to 0.5m wherever
   *   curvature > 3cm or slope > 45 deg inside the [-11.75m, +12.25m] inner band (catches
   *   IslandDivider, moguls, off-grid 65 deg cliffs, and 55 deg diagonal cliffs to <= 3.5cm!).
   * - Exact 1.0m across the full [-11.75m, +12.25m] inner band.
   * - Exact 2.0m across the outer 12..15.75m skirt (no 4m skirt!).
   * - Preserves all exact samples across overlapping shifts for fast 50km soak performance.
   */
  private updateHeightFieldPatch(
    skierX: number,
    skierY: number,
    skierZ: number,
    terrain: TerrainFieldView,
    forceFull: boolean,
  ): void {
    const ox = terrain.originOffsetX;
    const oy = terrain.originOffsetY;
    const oz = terrain.originOffsetZ;

    const useLead = this.patchInitialized && !forceFull;
    const leadX = useLead ? this.moveDirX * HF_FORWARD_LEAD_M : 0;
    const leadZ = useLead ? this.moveDirZ * HF_FORWARD_LEAD_M : 0;
    const newCenterAbsX = Math.round((skierX + leadX + ox) / PATCH_SNAP_M) * PATCH_SNAP_M;
    const newCenterAbsZ = Math.round((skierZ + leadZ + oz) / PATCH_SNAP_M) * PATCH_SNAP_M;
    const newCenterAbsY = skierY + oy;
    const newOriginAbsX = newCenterAbsX - HF_HALF_SPAN_M;
    const newOriginAbsZ = newCenterAbsZ - HF_HALF_SPAN_M;

    const dxFine = this.patchInitialized
      ? Math.round((newOriginAbsX - this.patchOriginAbsX) / HF_STEP_M)
      : HF_SAMPLES;
    const dzFine = this.patchInitialized
      ? Math.round((newOriginAbsZ - this.patchOriginAbsZ) / HF_STEP_M)
      : HF_SAMPLES;

    const canReuseOverlap =
      !forceFull &&
      this.patchInitialized &&
      Math.abs(dxFine) < HF_SAMPLES &&
      Math.abs(dzFine) < HF_SAMPLES;

    const dst = this.patchHeightsScratch;
    const dstMask = this.patchExactScratch;
    dstMask.fill(0);

    // 1. Reuse overlapping exact samples strictly inside [INNER_1M_MIN..INNER_1M_MAX]
    //    (clamped outer border cells never have mask === 1 so they can never pollute live interior samples!)
    if (canReuseOverlap) {
      const deltaY = this.patchCenterAbsY - newCenterAbsY;
      const src = this.patchHeights;
      const srcMask = this.patchExactMask;
      const cStart = Math.max(INNER_1M_MIN, INNER_1M_MIN - dxFine);
      const cEnd = Math.min(INNER_1M_MAX + 1, INNER_1M_MAX + 1 - dxFine);
      const rStart = Math.max(INNER_1M_MIN, INNER_1M_MIN - dzFine);
      const rEnd = Math.min(INNER_1M_MAX + 1, INNER_1M_MAX + 1 - dzFine);

      for (let r = rStart; r < rEnd; r++) {
        const srcRow = (r + dzFine) * HF_SAMPLES;
        const dstRow = r * HF_SAMPLES;
        for (let c = cStart; c < cEnd; c++) {
          const sIdx = srcRow + c + dxFine;
          if (srcMask[sIdx] !== 0) {
            dst[dstRow + c] = src[sIdx]! + deltaY;
            dstMask[dstRow + c] = 1;
          }
        }
      }
    } else if (!this.patchInitialized) {
      // Seed initial 2.0m stride-4 interior [INNER_1M_MIN..INNER_1M_MAX] via TerrainFieldView.sampleColumnGrid
      terrain.sampleColumnGrid(
        newOriginAbsX,
        newOriginAbsZ,
        INIT_COARSE_N,
        INIT_COARSE_N,
        2.0,
        newCenterAbsY,
        this.initGridScratch,
      );
      const gH = this.initGridScratch.heights;
      const gMin = INNER_1M_MIN >> 2;
      const gMax = INNER_1M_MAX >> 2;
      for (let gr = gMin; gr <= gMax; gr++) {
        const fr = gr << 2;
        const fRow = fr * HF_SAMPLES;
        const gRow = gr * INIT_COARSE_N;
        for (let gc = gMin; gc <= gMax; gc++) {
          const fc = gc << 2;
          dst[fRow + fc] = gH[gRow + gc]!;
          dstMask[fRow + fc] = 1;
        }
      }
    }

    const baseWx = newOriginAbsX - ox;
    const baseWz = newOriginAbsZ - oz;
    const maxWx = baseWx + (HF_SAMPLES - 1) * HF_STEP_M;
    const maxWz = baseWz + (HF_SAMPLES - 1) * HF_STEP_M;
    this.spinesScratch.length = 0;
    terrain.collectSpinesInBounds(
      baseWx - 1,
      maxWx + 1,
      baseWz - 1,
      maxWz + 1,
      340,
      this.spinesScratch,
    );
    const spines = this.spinesScratch.length > 0 ? this.spinesScratch : undefined;

    const evalExact = (r: number, c: number): number => {
      const idx = r * HF_SAMPLES + c;
      if (dstMask[idx] !== 0) return dst[idx]!;
      const h =
        terrain.evaluateHeight(baseWx + c * HF_STEP_M, baseWz + r * HF_STEP_M, spines) +
        oy -
        newCenterAbsY;
      dst[idx] = h;
      dstMask[idx] = 1;
      return h;
    };

    // 2. Full 2.0m lattice across [12..52] ([-9.75m, +10.25m], 11x11 = 121 nodes);
    //    unreachable outer border [0..11]/[53..63] is C0-clamped in step 6 (zero wasted off-piste border evals!)
    for (let r = INNER_1M_MIN; r <= INNER_1M_MAX; r += 4) {
      for (let c = INNER_1M_MIN; c <= INNER_1M_MAX; c += 4) {
        evalExact(r, c);
      }
    }

    const mdx = this.moveDirX;
    const mdz = this.moveDirZ;
    // 0: outside, 1: outer corridor, 2: <=4.5m tight curvature core, 3: <=3.1m always <=1.0m core
    const classifyCell = (r: number, c: number): 0 | 1 | 2 | 3 => {
      const rx = baseWx + c * HF_STEP_M - skierX;
      const rz = baseWz + r * HF_STEP_M - skierZ;
      const rSq = rx * rx + rz * rz;
      if (rSq <= CORE_1M_RADIUS_SQ_M) return 3;
      if (rSq <= CORE_CURV_RADIUS_SQ_M) return 2;
      if (rSq <= CORRIDOR_ISO_RADIUS_SQ_M) return 1;
      const along = rx * mdx + rz * mdz;
      if (along < -CORRIDOR_BACK_M || along > CORRIDOR_AHEAD_M) return 0;
      return Math.abs(-rx * mdz + rz * mdx) <= CORRIDOR_HALF_WIDTH_M ? 1 : 0;
    };

    // 3. Corridor-only curvature-driven 2.0m -> 1.0m subdivision inside [16..48] (4-edge symmetric curvature + twist):
    for (let r = INNER_1M_MIN; r <= INNER_1M_MAX - 4; r += 4) {
      const row0 = r * HF_SAMPLES;
      const row4 = (r + 4) * HF_SAMPLES;
      const rowPrev = (r - 4) * HF_SAMPLES;
      const rowNext = (r + 8) * HF_SAMPLES;
      const hasPrevR = r >= INNER_1M_MIN + 4;
      const hasNextR = r + 8 <= INNER_1M_MAX;
      for (let c = INNER_1M_MIN; c <= INNER_1M_MAX - 4; c += 4) {
        const tier = classifyCell(r + 2, c + 2);
        if (tier === 0) continue;
        if (tier === 3) {
          evalExact(r, c + 2);
          evalExact(r + 2, c);
          evalExact(r + 2, c + 2);
          evalExact(r + 2, c + 4);
          evalExact(r + 4, c + 2);
          continue;
        }
        const ct2 = tier === 2 ? ADAPTIVE_CURV_2M_CORE_M : ADAPTIVE_CURV_2M_IN_M;
        const tt2 = ct2 * 0.5;
        const h00 = dst[row0 + c]!;
        const h40 = dst[row0 + c + 4]!;
        const h04 = dst[row4 + c]!;
        const h44 = dst[row4 + c + 4]!;

        let need1m = Math.abs(h00 + h44 - h40 - h04) > tt2;
        if (!need1m && c >= INNER_1M_MIN + 4) {
          if (
            Math.abs(dst[row0 + c - 4]! - 2 * h00 + h40) > ct2 ||
            Math.abs(dst[row4 + c - 4]! - 2 * h04 + h44) > ct2
          ) {
            need1m = true;
          }
        }
        if (!need1m && c + 8 <= INNER_1M_MAX) {
          if (
            Math.abs(h00 - 2 * h40 + dst[row0 + c + 8]!) > ct2 ||
            Math.abs(h04 - 2 * h44 + dst[row4 + c + 8]!) > ct2
          ) {
            need1m = true;
          }
        }
        if (!need1m && hasPrevR) {
          if (
            Math.abs(dst[rowPrev + c]! - 2 * h00 + h04) > ct2 ||
            Math.abs(dst[rowPrev + c + 4]! - 2 * h40 + h44) > ct2
          ) {
            need1m = true;
          }
        }
        if (!need1m && hasNextR) {
          if (
            Math.abs(h00 - 2 * h04 + dst[rowNext + c]!) > ct2 ||
            Math.abs(h40 - 2 * h44 + dst[rowNext + c + 4]!) > ct2
          ) {
            need1m = true;
          }
        }
        if (need1m) {
          evalExact(r, c + 2);
          evalExact(r + 2, c);
          evalExact(r + 2, c + 2);
          evalExact(r + 2, c + 4);
          evalExact(r + 4, c + 2);
        }
      }
    }

    // 4. Exact 0.5m isotropic core (+/-3.0m) around skier feet regardless of moveDir
    const sc = clamp(Math.round((skierX - baseWx) / HF_STEP_M), INNER_1M_MIN, INNER_1M_MAX);
    const sr = clamp(Math.round((skierZ - baseWz) / HF_STEP_M), INNER_1M_MIN, INNER_1M_MAX);
    const footR0 = Math.max(INNER_1M_MIN, sr - FOOT_EXACT_RADIUS_CELLS);
    const footR1 = Math.min(INNER_1M_MAX, sr + FOOT_EXACT_RADIUS_CELLS);
    const footC0 = Math.max(INNER_1M_MIN, sc - FOOT_EXACT_RADIUS_CELLS);
    const footC1 = Math.min(INNER_1M_MAX, sc + FOOT_EXACT_RADIUS_CELLS);
    for (let r = footR0; r <= footR1; r++) {
      for (let c = footC0; c <= footC1; c++) {
        evalExact(r, c);
      }
    }

    // 5. Corridor-only adaptive 1.0m -> 0.5m subdivision (4-edge symmetric curvature + saddle twist)
    for (let r = INNER_1M_MIN; r <= INNER_1M_MAX - 2; r += 2) {
      const row0 = r * HF_SAMPLES;
      const row1 = (r + 1) * HF_SAMPLES;
      const row2 = (r + 2) * HF_SAMPLES;
      const rowPrev = (r - 2) * HF_SAMPLES;
      const rowNext = (r + 4) * HF_SAMPLES;
      const hasPrevR = r >= INNER_1M_MIN + 2;
      const hasNextR = r + 4 <= INNER_1M_MAX;
      for (let c = INNER_1M_MIN; c <= INNER_1M_MAX - 2; c += 2) {
        const tier = classifyCell(r + 1, c + 1);
        if (tier === 0) continue;
        const ct1 = tier >= 2 ? ADAPTIVE_CURV_1M_CORE_M : ADAPTIVE_CURV_1M_IN_M;
        const tt1 = ct1 * 0.5;
        if (
          dstMask[row0 + c] === 0 ||
          dstMask[row0 + c + 2] === 0 ||
          dstMask[row2 + c] === 0 ||
          dstMask[row2 + c + 2] === 0
        ) {
          continue;
        }
        if (
          dstMask[row0 + c + 1] !== 0 &&
          dstMask[row1 + c] !== 0 &&
          dstMask[row1 + c + 1] !== 0 &&
          dstMask[row1 + c + 2] !== 0 &&
          dstMask[row2 + c + 1] !== 0
        ) {
          continue;
        }

        const h00 = dst[row0 + c]!;
        const h20 = dst[row0 + c + 2]!;
        const h02 = dst[row2 + c]!;
        const h22 = dst[row2 + c + 2]!;

        let needSub = Math.abs(h00 + h22 - h20 - h02) > tt1;

        if (!needSub && c >= INNER_1M_MIN + 2) {
          if (
            (dstMask[row0 + c - 2] !== 0 && Math.abs(dst[row0 + c - 2]! - 2 * h00 + h20) > ct1) ||
            (dstMask[row2 + c - 2] !== 0 && Math.abs(dst[row2 + c - 2]! - 2 * h02 + h22) > ct1)
          ) {
            needSub = true;
          }
        }
        if (!needSub && c + 4 <= INNER_1M_MAX) {
          if (
            (dstMask[row0 + c + 4] !== 0 && Math.abs(h00 - 2 * h20 + dst[row0 + c + 4]!) > ct1) ||
            (dstMask[row2 + c + 4] !== 0 && Math.abs(h02 - 2 * h22 + dst[row2 + c + 4]!) > ct1)
          ) {
            needSub = true;
          }
        }
        if (!needSub && hasPrevR) {
          if (
            (dstMask[rowPrev + c] !== 0 && Math.abs(dst[rowPrev + c]! - 2 * h00 + h02) > ct1) ||
            (dstMask[rowPrev + c + 2] !== 0 && Math.abs(dst[rowPrev + c + 2]! - 2 * h20 + h22) > ct1)
          ) {
            needSub = true;
          }
        }
        if (!needSub && hasNextR) {
          if (
            (dstMask[rowNext + c] !== 0 && Math.abs(h00 - 2 * h02 + dst[rowNext + c]!) > ct1) ||
            (dstMask[rowNext + c + 2] !== 0 && Math.abs(h20 - 2 * h22 + dst[rowNext + c + 2]!) > ct1)
          ) {
            needSub = true;
          }
        }
        if (needSub) {
          evalExact(r, c + 1);
          evalExact(r + 1, c);
          evalExact(r + 1, c + 1);
          evalExact(r + 1, c + 2);
          evalExact(r + 2, c + 1);
        }
      }
    }

    // 6. Bilinearly fill remaining flat unpopulated cells inside [8..56] (1.0m where subdivided, else 2.0m)
    for (let r = INNER_1M_MIN; r < INNER_1M_MAX; r += 4) {
      const rowA = r * HF_SAMPLES;
      const rowMid = (r + 2) * HF_SAMPLES;
      const rowB = (r + 4) * HF_SAMPLES;
      for (let c = INNER_1M_MIN; c < INNER_1M_MAX; c += 4) {
        const has1mCell =
          dstMask[rowA + c + 2] !== 0 &&
          dstMask[rowMid + c] !== 0 &&
          dstMask[rowMid + c + 2] !== 0 &&
          dstMask[rowMid + c + 4] !== 0 &&
          dstMask[rowB + c + 2] !== 0;

        if (has1mCell) {
          for (let rr = r; rr <= r + 4; rr++) {
            const fRow = rr * HF_SAMPLES;
            const r0 = rr & ~1;
            const r1 = r0 === r + 4 ? r0 : r0 + 2;
            const fz = r1 > r0 ? (rr - r0) * 0.5 : 0;
            const r0Off = r0 * HF_SAMPLES;
            const r1Off = r1 * HF_SAMPLES;
            for (let cc = c; cc <= c + 4; cc++) {
              const idx = fRow + cc;
              if (dstMask[idx] !== 0) continue;
              const c0 = cc & ~1;
              const c1 = c0 === c + 4 ? c0 : c0 + 2;
              const fx = c1 > c0 ? (cc - c0) * 0.5 : 0;
              const top = dst[r0Off + c0]! * (1 - fx) + dst[r0Off + c1]! * fx;
              const bot = dst[r1Off + c0]! * (1 - fx) + dst[r1Off + c1]! * fx;
              dst[idx] = top * (1 - fz) + bot * fz;
            }
          }
        } else {
          const hAA = dst[rowA + c]!;
          const hBA = dst[rowA + c + 4]!;
          const hAB = dst[rowB + c]!;
          const hBB = dst[rowB + c + 4]!;
          for (let rr = r; rr <= r + 4; rr++) {
            const tz = (rr - r) * 0.25;
            const omtz = 1 - tz;
            const fRow = rr * HF_SAMPLES;
            for (let cc = c; cc <= c + 4; cc++) {
              const idx = fRow + cc;
              if (dstMask[idx] !== 0) continue;
              const tx = (cc - c) * 0.25;
              const top = hAA * (1 - tx) + hBA * tx;
              const bot = hAB * (1 - tx) + hBB * tx;
              dst[idx] = top * omtz + bot * tz;
            }
          }
        }
      }
    }

    const wasInitialized = this.patchInitialized;
    const uploadFullPatch = !wasInitialized || forceFull;

    if (uploadFullPatch) {
      // Clamp full unreachable outer border C0-continuously on init/forceFull (0 evalH!)
      for (let r = INNER_1M_MIN; r <= INNER_1M_MAX; r++) {
        const fRow = r * HF_SAMPLES;
        const leftH = dst[fRow + INNER_1M_MIN]!;
        const rightH = dst[fRow + INNER_1M_MAX]!;
        for (let c = 0; c < INNER_1M_MIN; c++) dst[fRow + c] = leftH;
        for (let c = INNER_1M_MAX + 1; c < HF_SAMPLES; c++) dst[fRow + c] = rightH;
      }
      const topSrcRow = INNER_1M_MIN * HF_SAMPLES;
      const botSrcRow = INNER_1M_MAX * HF_SAMPLES;
      for (let r = 0; r < INNER_1M_MIN; r++) {
        const dstRow = r * HF_SAMPLES;
        for (let c = 0; c < HF_SAMPLES; c++) dst[dstRow + c] = dst[topSrcRow + c]!;
      }
      for (let r = INNER_1M_MAX + 1; r < HF_SAMPLES; r++) {
        const dstRow = r * HF_SAMPLES;
        for (let c = 0; c < HF_SAMPLES; c++) dst[dstRow + c] = dst[botSrcRow + c]!;
      }
    } else {
      // Rolling sub-rect [16..49]: clamp only the single padding row/col 49 from 48
      const padIdx = INNER_1M_MAX + 1;
      for (let r = INNER_1M_MIN; r <= INNER_1M_MAX; r++) {
        const fRow = r * HF_SAMPLES;
        dst[fRow + padIdx] = dst[fRow + INNER_1M_MAX]!;
      }
      const srcRow = INNER_1M_MAX * HF_SAMPLES;
      const padRow = padIdx * HF_SAMPLES;
      for (let c = INNER_1M_MIN; c <= padIdx; c++) {
        dst[padRow + c] = dst[srcRow + c]!;
      }
    }

    // Swap patch buffers
    this.patchHeightsScratch = this.patchHeights;
    this.patchHeights = dst;
    this.patchExactScratch = this.patchExactMask;
    this.patchExactMask = dstMask;

    // 7. True 2D gradient magnitude steep-slope scan across fine 0.5m inner patch (catches diagonal cliffs!)
    let steep = false;
    for (let r = INNER_1M_MIN; r < INNER_1M_MAX && !steep; r++) {
      const row = r * HF_SAMPLES;
      const nextRow = row + HF_SAMPLES;
      for (let c = INNER_1M_MIN; c < INNER_1M_MAX; c++) {
        const h0 = dst[row + c]!;
        const dhx = dst[row + c + 1]! - h0;
        const dhz = dst[nextRow + c]! - h0;
        if (dhx * dhx + dhz * dhz > STEEP_GRAD_SQ_05M) {
          steep = true;
          break;
        }
      }
    }
    this.patchHasSteepSlope = steep;

    this.patchInitialized = true;
    this.patchCenterAbsX = newCenterAbsX;
    this.patchCenterAbsY = newCenterAbsY;
    this.patchCenterAbsZ = newCenterAbsZ;
    this.patchOriginAbsX = newOriginAbsX;
    this.patchOriginAbsZ = newOriginAbsZ;
    this.patchCenterX = newCenterAbsX - ox;
    this.patchCenterY = newCenterAbsY - oy;
    this.patchCenterZ = newCenterAbsZ - oz;
    this.lastFieldRevision = terrain.fieldRevision;

    const heap = this.jolt.HEAPF32;
    const baseIdx = this.heightsPtr >> 2;
    const minH = HF_MIN_HEIGHT + 0.01;
    const maxH = HF_MAX_HEIGHT - 0.01;
    if (uploadFullPatch) {
      for (let i = 0; i < HF_SAMPLES * HF_SAMPLES; i++) {
        heap[baseIdx + i] = clamp(dst[i]!, minH, maxH);
      }
      this.hfShape.SetHeights(
        0,
        0,
        HF_SAMPLES,
        HF_SAMPLES,
        this.heightsMemRef,
        HF_SAMPLES,
        this.runtime.tempAllocator,
      );
    } else {
      // Sub-rect SetHeights(16, 16, 34, 34): uploads 1156 samples instead of 4096 (~3.5x faster!)
      let wIdx = baseIdx;
      const rEnd = SUBRECT_START + SUBRECT_COUNT;
      const cEnd = SUBRECT_START + SUBRECT_COUNT;
      for (let r = SUBRECT_START; r < rEnd; r++) {
        const srcRow = r * HF_SAMPLES;
        for (let c = SUBRECT_START; c < cEnd; c++) {
          heap[wIdx++] = clamp(dst[srcRow + c]!, minH, maxH);
        }
      }
      this.hfShape.SetHeights(
        SUBRECT_START,
        SUBRECT_START,
        SUBRECT_COUNT,
        SUBRECT_COUNT,
        this.heightsMemRef,
        SUBRECT_COUNT,
        this.runtime.tempAllocator,
      );
    }
    this.scratchRVec3.Set(this.patchCenterX, this.patchCenterY, this.patchCenterZ);
    this.bi.SetPosition(this.hfBodyId, this.scratchRVec3, this.jolt.EActivation_DontActivate);
    this.bi.NotifyShapeChanged(
      this.hfBodyId,
      this.zeroVec3,
      false,
      this.jolt.EActivation_DontActivate,
    );
    if ((++this.hfRefreshCount & 63) === 0) {
      this.runtime.physicsSystem.OptimizeBroadPhase();
    }
  }

  private syncStaticAndCreatureBubble(skierX: number, skierZ: number, pools: EntityPools): void {
    const hazards = pools.hazards;
    for (let i = 0; i < hazards.count; i++) {
      const dx = hazards.posX[i]! - skierX;
      const dz = hazards.posZ[i]! - skierZ;
      const distSq = dx * dx + dz * dz;
      const existingSlot = this.hazardSlotToBubble[i]!;
      if (existingSlot >= 0) {
        if (distSq > BUBBLE_EXIT_RADIUS_SQ) {
          this.removeBubbleSlot(existingSlot);
          this.hazardSlotToBubble[i] = -1;
        }
      } else if (distSq <= BUBBLE_ENTER_RADIUS_SQ) {
        const def = getHazardDef(hazards.defIds[i]!);
        const shapeKind = def?.collider.shape ?? 'cylinder';
        const r = Math.max(0.1, hazards.radius[i]!);
        const h = Math.max(0.2, hazards.height[i]!);
        const shape =
          shapeKind === 'box' ? this.getOrCreateBoxShape(r, h) : this.getOrCreateCylinderShape(r, h);
        this.setQuatFromYawPitch(hazards.yawRad[i]!, 0, this.scratchQuat);
        const slotIdx = this.addBubbleBody(
          KIND_HAZARD,
          i,
          shape,
          hazards.posX[i]!,
          hazards.posY[i]!,
          hazards.posZ[i]!,
          h * 0.5,
          this.scratchQuat,
          this.jolt.EMotionType_Static,
          this.worldSlot.staticLayer,
        );
        this.hazardSlotToBubble[i] = slotIdx;
      }
    }

    const ramps = pools.ramps;
    for (let i = 0; i < ramps.count; i++) {
      const dx = ramps.posX[i]! - skierX;
      const dz = ramps.posZ[i]! - skierZ;
      const distSq = dx * dx + dz * dz;
      const existingSlot = this.rampSlotToBubble[i]!;
      if (existingSlot >= 0) {
        if (distSq > BUBBLE_EXIT_RADIUS_SQ) {
          this.removeBubbleSlot(existingSlot);
          this.rampSlotToBubble[i] = -1;
        }
      } else if (distSq <= BUBBLE_ENTER_RADIUS_SQ) {
        const w = Math.max(0.5, ramps.width[i]!);
        const h = Math.max(0.2, ramps.height[i]!);
        const l = Math.max(0.5, ramps.length[i]!);
        const shape = this.getOrCreateRampWedgeShape(w, h, l);
        this.setQuatFromYawPitch(ramps.yawRad[i]!, ramps.pitchRad[i]!, this.scratchQuat);
        const slotIdx = this.addBubbleBody(
          KIND_RAMP,
          i,
          shape,
          ramps.posX[i]!,
          ramps.posY[i]!,
          ramps.posZ[i]!,
          0,
          this.scratchQuat,
          this.jolt.EMotionType_Static,
          this.worldSlot.staticLayer,
        );
        this.rampSlotToBubble[i] = slotIdx;
      }
    }

    const creatures = pools.creatures;
    for (let i = 0; i < creatures.count; i++) {
      const dx = creatures.posX[i]! - skierX;
      const dz = creatures.posZ[i]! - skierZ;
      const distSq = dx * dx + dz * dz;
      const existingSlot = this.creatureSlotToBubble[i]!;
      if (existingSlot >= 0) {
        if (distSq > BUBBLE_EXIT_RADIUS_SQ) {
          this.removeBubbleSlot(existingSlot);
          this.creatureSlotToBubble[i] = -1;
        }
      } else if (distSq <= BUBBLE_ENTER_RADIUS_SQ) {
        const r = Math.max(0.2, creatures.radius[i]!);
        const h = Math.max(r * 2 + 0.1, creatures.height[i]!);
        const shape = this.getOrCreateCapsuleShape(r, h);
        const slotIdx = this.addBubbleBody(
          KIND_CREATURE,
          i,
          shape,
          creatures.posX[i]!,
          creatures.posY[i]!,
          creatures.posZ[i]!,
          h * 0.5,
          this.identityQuat,
          this.jolt.EMotionType_Kinematic,
          this.worldSlot.movingLayer,
        );
        this.creatureSlotToBubble[i] = slotIdx;
      }
    }
  }

  private updateActiveCreatures(dt: number, pools: EntityPools): void {
    const creatures = pools.creatures;
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    const dontActivate = this.jolt.EActivation_DontActivate;

    for (let i = 0; i < creatures.count; i++) {
      const slotIdx = this.creatureSlotToBubble[i]!;
      if (slotIdx < 0) continue;
      const slot = this.bubbleSlots[slotIdx]!;
      if (!slot.active || !slot.bodyId) continue;

      const cx = creatures.posX[i]!;
      const cy = creatures.posY[i]!;
      const cz = creatures.posZ[i]!;
      const vx = (cx - slot.posX) * invDt;
      const vy = (cy - slot.posY) * invDt;
      const vz = (cz - slot.posZ) * invDt;

      slot.posX = cx;
      slot.posY = cy;
      slot.posZ = cz;

      this.scratchRVec3.Set(cx, cy + slot.halfHeightY, cz);
      this.bi.SetPosition(slot.bodyId, this.scratchRVec3, dontActivate);
      this.scratchVec3.Set(vx, vy, vz);
      this.bi.SetLinearVelocity(slot.bodyId, this.scratchVec3);
    }
  }

  private syncForkBumper(
    skierX: number,
    skierZ: number,
    forkBumper: SpineForkMeta | null,
  ): void {
    if (!forkBumper || !forkBumper.hasFork) {
      if (this.forkBumperBubbleSlot >= 0) {
        this.removeBubbleSlot(this.forkBumperBubbleSlot);
        this.forkBumperBubbleSlot = -1;
        this.forkBumperLastX = NaN;
      }
      return;
    }

    const dx = forkBumper.seamWorldX - skierX;
    const dz = forkBumper.seamWorldZ - skierZ;
    const distSq = dx * dx + dz * dz;

    if (distSq > BUBBLE_EXIT_RADIUS_SQ) {
      if (this.forkBumperBubbleSlot >= 0) {
        this.removeBubbleSlot(this.forkBumperBubbleSlot);
        this.forkBumperBubbleSlot = -1;
        this.forkBumperLastX = NaN;
      }
      return;
    }

    if (distSq <= BUBBLE_ENTER_RADIUS_SQ) {
      const r = Math.max(0.5, forkBumper.seamNoseRadius);
      const changed =
        this.forkBumperBubbleSlot < 0 ||
        Math.abs(r - this.forkBumperLastRadius) > 1e-3 ||
        Math.abs(forkBumper.seamWorldX - this.forkBumperLastX) > 1e-3 ||
        Math.abs(forkBumper.seamWorldY - this.forkBumperLastY) > 1e-3 ||
        Math.abs(forkBumper.seamWorldZ - this.forkBumperLastZ) > 1e-3;

      if (changed) {
        if (this.forkBumperBubbleSlot >= 0) {
          this.removeBubbleSlot(this.forkBumperBubbleSlot);
          this.forkBumperBubbleSlot = -1;
        }
        const shape = this.getOrCreateCylinderShape(r, FORK_BUMPER_SHAPE_HEIGHT_M);
        this.forkBumperBubbleSlot = this.addBubbleBody(
          KIND_FORK_BUMPER,
          -1,
          shape,
          forkBumper.seamWorldX,
          forkBumper.seamWorldY,
          forkBumper.seamWorldZ,
          FORK_BUMPER_SHAPE_HEIGHT_M * 0.5,
          this.identityQuat,
          this.jolt.EMotionType_Static,
          this.worldSlot.staticLayer,
        );
        this.forkBumperLastX = forkBumper.seamWorldX;
        this.forkBumperLastY = forkBumper.seamWorldY;
        this.forkBumperLastZ = forkBumper.seamWorldZ;
        this.forkBumperLastRadius = r;
      }
    }
  }

  private addBubbleBody(
    kindCode: number,
    poolIndex: number,
    shape: JoltNS.Shape,
    posX: number,
    posY: number,
    posZ: number,
    halfHeightY: number,
    rot: JoltNS.Quat,
    motionType: JoltNS.EMotionType,
    objectLayer: number,
  ): number {
    const slotIdx = this.freeBubbleSlotIndices.pop();
    if (slotIdx === undefined) return -1;

    const J = this.jolt;
    this.scratchRVec3.Set(posX, posY + halfHeightY, posZ);
    const bcs = new J.BodyCreationSettings(
      shape,
      this.scratchRVec3,
      rot,
      motionType,
      objectLayer,
    );
    const body = this.bi.CreateBody(bcs);
    J.destroy(bcs);
    if (!body || J.getPointer(body) === 0) {
      this.freeBubbleSlotIndices.push(slotIdx);
      return -1;
    }
    const bodyId = new J.BodyID(body.GetID().GetIndexAndSequenceNumber());

    this.bi.AddBody(bodyId, J.EActivation_DontActivate);
    const bodyIndex = bodyId.GetIndex();
    this.bodyKindByIndex[bodyIndex] = kindCode;
    this.bodyPoolIdxByIndex[bodyIndex] = poolIndex;

    const slot = this.bubbleSlots[slotIdx]!;
    slot.active = true;
    slot.kindCode = kindCode;
    slot.poolIndex = poolIndex;
    slot.bodyId = bodyId;
    slot.bodyIndex = bodyIndex;
    slot.posX = posX;
    slot.posY = posY;
    slot.posZ = posZ;
    slot.halfHeightY = halfHeightY;
    this.activeBubbleIndices.push(slotIdx);
    return slotIdx;
  }

  private removeBubbleSlot(slotIdx: number): void {
    const slot = this.bubbleSlots[slotIdx];
    if (!slot || !slot.active) return;

    if (slot.bodyId) {
      if (slot.bodyIndex >= 0 && slot.bodyIndex < this.runtime.maxBodies) {
        this.bodyKindByIndex[slot.bodyIndex] = KIND_NONE;
        this.bodyPoolIdxByIndex[slot.bodyIndex] = -1;
      }
      if (this.bi.IsAdded(slot.bodyId)) {
        this.bi.RemoveBody(slot.bodyId);
      }
      this.bi.DestroyBody(slot.bodyId);
      this.jolt.destroy(slot.bodyId);
      slot.bodyId = null;
    }

    slot.active = false;
    slot.kindCode = KIND_NONE;
    slot.poolIndex = -1;
    slot.bodyIndex = -1;
    const activePos = this.activeBubbleIndices.indexOf(slotIdx);
    if (activePos >= 0) {
      const last = this.activeBubbleIndices.pop()!;
      if (activePos < this.activeBubbleIndices.length) {
        this.activeBubbleIndices[activePos] = last;
      }
    }
    this.freeBubbleSlotIndices.push(slotIdx);
  }

  private clearBubbleBodies(): void {
    while (this.activeBubbleIndices.length > 0) {
      const slotIdx = this.activeBubbleIndices[this.activeBubbleIndices.length - 1]!;
      this.removeBubbleSlot(slotIdx);
    }
    this.hazardSlotToBubble.fill(-1);
    this.rampSlotToBubble.fill(-1);
    this.creatureSlotToBubble.fill(-1);
    this.forkBumperBubbleSlot = -1;
    this.forkBumperLastX = NaN;
    this.lastBubbleSyncX = NaN;
    this.lastBubbleSyncZ = NaN;
    this.lastHazardCount = -1;
    this.lastRampCount = -1;
    this.lastCreatureCount = -1;
    this.hasNearbyObstacle = false;
  }

  private getOrCreateCylinderShape(radius: number, height: number): JoltNS.Shape {
    const key = `cyl:${Math.round(radius * 1000)}:${Math.round(height * 1000)}`;
    const cached = this.shapeCache.get(key);
    if (cached) return cached;

    const halfH = Math.max(0.05, height * 0.5);
    const convexR = Math.min(0.05, halfH * 0.5, radius * 0.5);
    const shape = new this.jolt.CylinderShape(halfH, radius, convexR);
    shape.AddRef();
    this.shapeCache.set(key, shape);
    return shape;
  }

  private getOrCreateBoxShape(radius: number, height: number): JoltNS.Shape {
    const key = `box:${Math.round(radius * 1000)}:${Math.round(height * 1000)}`;
    const cached = this.shapeCache.get(key);
    if (cached) return cached;

    const halfH = Math.max(0.05, height * 0.5);
    const halfD = Math.min(radius, Math.max(0.25, halfH));
    const convexR = Math.min(0.05, radius * 0.5, halfH * 0.5, halfD * 0.5);
    const ext = new this.jolt.Vec3(radius, halfH, halfD);
    const shape = new this.jolt.BoxShape(ext, convexR);
    this.jolt.destroy(ext);
    shape.AddRef();
    this.shapeCache.set(key, shape);
    return shape;
  }

  private getOrCreateCapsuleShape(radius: number, height: number): JoltNS.Shape {
    const key = `cap:${Math.round(radius * 1000)}:${Math.round(height * 1000)}`;
    const cached = this.shapeCache.get(key);
    if (cached) return cached;

    const halfCyl = Math.max(0.05, height * 0.5 - radius);
    const shape = new this.jolt.CapsuleShape(halfCyl, radius);
    shape.AddRef();
    this.shapeCache.set(key, shape);
    return shape;
  }

  private getOrCreateRampWedgeShape(width: number, height: number, length: number): JoltNS.Shape {
    const key = `ramp:${Math.round(width * 1000)}:${Math.round(height * 1000)}:${Math.round(length * 1000)}`;
    const cached = this.shapeCache.get(key);
    if (cached) return cached;

    const J = this.jolt;
    const hw = width * 0.5;
    const hl = length * 0.5;
    const skirtY = -RAMP_SKIRT_DEPTH_M;

    const hullSettings = new J.ConvexHullShapeSettings();
    hullSettings.mMaxConvexRadius = 0.02;
    const tv = new J.Vec3(0, 0, 0);
    const push = (x: number, y: number, z: number): void => {
      tv.Set(x, y, z);
      hullSettings.mPoints.push_back(tv);
    };
    const leadZ = hl + 0.55;
    const leadY = -0.18;
    push(-hw, leadY, leadZ);
    push(hw, leadY, leadZ);
    push(-hw, 0, hl);
    push(hw, 0, hl);
    push(-hw, height, -hl);
    push(hw, height, -hl);
    push(-hw, skirtY, leadZ);
    push(hw, skirtY, leadZ);
    push(-hw, skirtY, -hl);
    push(hw, skirtY, -hl);
    J.destroy(tv);

    const res = hullSettings.Create();
    if (!res.IsValid()) {
      const err = res.GetError().c_str();
      res.Clear();
      J.destroy(hullSettings);
      throw new Error(`Failed to create Jolt Ramp ConvexHullShape: ${err}`);
    }
    const shape = res.Get();
    shape.AddRef();
    res.Clear();
    J.destroy(hullSettings);

    this.shapeCache.set(key, shape);
    return shape;
  }

  private setQuatFromYawPitch(yawRad: number, pitchRad: number, out: JoltNS.Quat): void {
    const hy = yawRad * 0.5;
    const hp = pitchRad * 0.5;
    const sy = Math.sin(hy);
    const cy = Math.cos(hy);
    const sx = Math.sin(hp);
    const cx = Math.cos(hp);
    out.Set(cy * sx, sy * cx, -sy * sx, cy * cx);
  }
}
