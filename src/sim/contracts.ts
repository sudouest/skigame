import type {
  LandscapeProfile,
  PisteSurfaceType,
  SurfaceType,
  VisualSpec,
} from '../content/types';

export type { PisteSurfaceType, SurfaceType };

/**
 * Coordinate & Angle Conventions (Right-handed +Y up):
 * - World Space: (X, Y, Z) with +Y up.
 * - Yaw / Heading (`yawRad`, `headingRad`): 0 rad faces -Z; positive +yaw rotates
 *   counter-clockwise around +Y (matching THREE.Object3D.rotation.y):
 *     forwardXZ = (-sin(yaw), 0, -cos(yaw))
 *     rightXZ   = ( cos(yaw), 0, -sin(yaw))
 * - Pitch (`pitchRad`): signed rotation around local +X right axis (Euler 'YXZ'):
 *   negative pitchRad < 0 points forward nose downhill (forwardY = sin(pitchRad) < 0).
 * - Bank (`bankRad`): lateral terrain lean around local forward tangent T(s).
 */

/**
 * Compile-time immutable numeric buffer view backed by TypedArrays (Float32Array, Uint8Array, etc.).
 * Prevents renderers/UI from mutating simulation-owned pooled buffers with zero runtime wrapping.
 */
export interface ReadonlyNumericBuffer {
  readonly length: number;
  readonly [index: number]: number;
}

export interface PlayerIntent {
  /** Continuous steering axis in [-1, 1] (-1 = left, +1 = right). */
  readonly steer: number;
  /** Relative horizontal pointer/touch drag delta accumulated for this step (normalized). */
  readonly pointerSteerDelta: number;
  /** Edge-triggered jump intent. */
  readonly jumpPressed: boolean;
  /** Continuous snowplow brake held state. */
  readonly brake: boolean;
}

export interface MutablePlayerIntent {
  steer: number;
  pointerSteerDelta: number;
  jumpPressed: boolean;
  brake: boolean;
}

export function createMutablePlayerIntent(): MutablePlayerIntent {
  return {
    steer: 0,
    pointerSteerDelta: 0,
    jumpPressed: false,
    brake: false,
  };
}

export interface SurfaceSample {
  segmentId: number;
  s: number;
  x: number;
  groundY: number;
  macroY: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  tangentX: number;
  tangentY: number;
  tangentZ: number;
  /** True local steepest-descent unit vector (-grad H projected onto terrain tangent plane). */
  fallLineX: number;
  fallLineY: number;
  fallLineZ: number;
  halfWidth: number;
  surfaceType: SurfaceType;
  onPiste: boolean;
  pisteWeight: number;
  inDivider: boolean;
  inChasmZone: boolean;
  chasmWipeoutDepth: number;
  /** Signed chasm relief offset relative to macroY (<= 0 inside chasms, 0 outside). */
  chasmRelief: number;
  nearestSpineY: number;
  valid: boolean;
}

export type ReadonlySurfaceSample = Readonly<SurfaceSample>;

export function createSurfaceSample(): SurfaceSample {
  return {
    segmentId: -1,
    s: 0,
    x: 0,
    groundY: 0,
    macroY: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    tangentX: 0,
    tangentY: 0,
    tangentZ: -1,
    fallLineX: 0,
    fallLineY: 0,
    fallLineZ: -1,
    halfWidth: 14,
    surfaceType: 'packed',
    onPiste: true,
    pisteWeight: 1,
    inDivider: false,
    inChasmZone: false,
    chasmWipeoutDepth: 0,
    chasmRelief: 0,
    nearestSpineY: 0,
    valid: false,
  };
}

export interface ActiveTrackProjectionOut {
  segmentId: number;
  s: number;
  x: number;
  halfWidth: number;
  tangentX: number;
  tangentY: number;
  tangentZ: number;
  distSq: number;
  valid: boolean;
}

export function createActiveTrackProjectionOut(): ActiveTrackProjectionOut {
  return {
    segmentId: -1,
    s: 0,
    x: 0,
    halfWidth: 14,
    tangentX: 0,
    tangentY: 0,
    tangentZ: -1,
    distSq: Infinity,
    valid: false,
  };
}

export interface ActiveTrackProjector {
  projectActiveWindow(
    posX: number,
    posZ: number,
    hintSegmentId: number,
    hintS: number,
    out: ActiveTrackProjectionOut,
  ): ActiveTrackProjectionOut;
}

export interface SurfaceQueryView {
  sampleSurface(
    posX: number,
    posZ: number,
    hintSegmentId: number,
    hintS: number,
    out: SurfaceSample,
  ): SurfaceSample;
  evaluateHeight(wx: number, wz: number): number;
}

export interface CameraPose {
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly lookAtX: number;
  readonly lookAtY: number;
  readonly lookAtZ: number;
  readonly rollRad: number;
  readonly minHorizontalFovDeg: number;
  readonly speedFovBoostDeg: number;
}

export interface RebaseInfo {
  readonly rebaseCount: number;
  /** Cumulative worldOriginOffset (Ox, Oy, Oz) subtracted from live simulation coordinates. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;
  /** Delta subtracted during the most recent rebase event. */
  readonly lastDeltaX: number;
  readonly lastDeltaY: number;
  readonly lastDeltaZ: number;
}

export type TrailSlotRole = 'prev' | 'curr' | 'nextLeft' | 'nextRight';

export interface ChunkRangeOut {
  startS: number;
  endS: number;
}

export function createChunkRangeOut(): ChunkRangeOut {
  return { startS: 0, endS: 0 };
}

export interface SpineFrameOut {
  posX: number;
  posY: number;
  posZ: number;
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  rightX: number;
  rightY: number;
  rightZ: number;
  /** Heading around +Y where 0 rad faces -Z (forwardXZ = (-sin(yaw), 0, -cos(yaw))). */
  yawRad: number;
  /** Signed downhill slope pitch around local +X (< 0 pitches nose downward). */
  pitchRad: number;
  bankRad: number;
  curvature: number;
  halfWidth: number;
  skirtWidth: number;
  dividerHalfWidth: number;
}

export function createSpineFrameOut(): SpineFrameOut {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    yawRad: 0,
    pitchRad: 0,
    bankRad: 0,
    curvature: 0,
    halfWidth: 14,
    skirtWidth: 12,
    dividerHalfWidth: 0,
  };
}

export interface RibbonPointOut {
  posX: number;
  posY: number;
  posZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  lateralX: number;
  halfWidth: number;
  skirtWidth: number;
  slopeDeg: number;
  localHeight: number;
  surfaceType: SurfaceType;
  inPlayableCorridor: boolean;
  inDivider: boolean;
  isInnerForkSlope: boolean;
}

export function createRibbonPointOut(): RibbonPointOut {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    lateralX: 0,
    halfWidth: 14,
    skirtWidth: 12,
    slopeDeg: 12,
    localHeight: 0,
    surfaceType: 'packed',
    inPlayableCorridor: true,
    inDivider: false,
    isInnerForkSlope: false,
  };
}

export interface SpineProjectionOut {
  s: number;
  signedX: number;
  longExt: number;
  distSq: number;
  spineX: number;
  spineY: number;
  spineZ: number;
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  rightX: number;
  rightZ: number;
  pitchRad: number;
  halfWidth: number;
  dividerHalfWidth: number;
}

export function createSpineProjectionOut(): SpineProjectionOut {
  return {
    s: 0,
    signedX: 0,
    longExt: 0,
    distSq: 0,
    spineX: 0,
    spineY: 0,
    spineZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    rightX: 1,
    rightZ: 0,
    pitchRad: 0,
    halfWidth: 14,
    dividerHalfWidth: 0,
  };
}

export interface PisteHeightOut {
  heightY: number;
  dividerHalfWidth: number;
  inDivider: boolean;
  dividerMask: number;
}

export function createPisteHeightOut(): PisteHeightOut {
  return {
    heightY: 0,
    dividerHalfWidth: 0,
    inDivider: false,
    dividerMask: 0,
  };
}

export interface SpineForkMeta {
  /** True when this segment splits at s = length into nextLeft & nextRight. */
  readonly hasFork: boolean;
  readonly leftStageId: string | null;
  readonly rightStageId: string | null;
  /** True when this segment starts immediately downstream of a fork seam (s = 0). */
  readonly isForkChild: boolean;
  readonly forkSide: 'none' | 'left' | 'right';
  /** Distance from s = 0 over which the inner snowbank ramps from 0 to full height. */
  readonly innerWallRampLength: number;
  /** Rounded soft-bumper V-wedge nose radius at the split apex (meters). */
  readonly seamNoseRadius: number;
  /** Current shifted world coordinates of the fork seam apex. */
  readonly seamWorldX: number;
  readonly seamWorldY: number;
  readonly seamWorldZ: number;
  readonly seamYawRad: number;
}

export interface SegmentForkMeta extends SpineForkMeta {
  /** Arc length after which static obstacles are forbidden ahead of the fork seam. */
  readonly obstacleFreeStartS: number;
}

export interface SpineMacroNodesView {
  readonly count: number;
  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly posZ: Float64Array;
  readonly fwdX: Float32Array;
  readonly fwdY: Float32Array;
  readonly fwdZ: Float32Array;
  readonly halfWidth: Float32Array;
  readonly useUpstreamExt: boolean;
  readonly useDownstreamExt: boolean;
  readonly upExtCount: number;
  readonly upExtX: Float64Array;
  readonly upExtY: Float64Array;
  readonly upExtZ: Float64Array;
  readonly upExtFwdX: number;
  readonly upExtFwdY: number;
  readonly upExtFwdZ: number;
  readonly upExtHalfWidth: number;
  readonly upBoundsMinX: number;
  readonly upBoundsMaxX: number;
  readonly upBoundsMinZ: number;
  readonly upBoundsMaxZ: number;
  readonly downExtCount: number;
  readonly downExtX: Float64Array;
  readonly downExtY: Float64Array;
  readonly downExtZ: Float64Array;
  readonly downExtFwdX: number;
  readonly downExtFwdY: number;
  readonly downExtFwdZ: number;
  readonly downExtHalfWidth: number;
  readonly downBoundsMinX: number;
  readonly downBoundsMaxX: number;
  readonly downBoundsMinZ: number;
  readonly downBoundsMaxZ: number;
}

export interface SpineCorridorSideView {
  readonly sideSign: -1 | 1;
  readonly count: number;
  readonly posX: Float64Array;
  readonly posZ: Float64Array;
  readonly radius: Float32Array;
  readonly invRadiusSq: Float32Array;
  readonly kernelWeight: Float32Array;
  readonly ampMag: Float32Array;
  readonly boundsMinX: number;
  readonly boundsMaxX: number;
  readonly boundsMinZ: number;
  readonly boundsMaxZ: number;
}

export interface SpineView {
  readonly id: number;
  readonly stageId: string;
  readonly seed: number;
  readonly length: number;
  readonly skirtWidth: number;
  readonly fork: SpineForkMeta;
  readonly landscape?: LandscapeProfile;
  readonly boundsMinX: number;
  readonly boundsMaxX: number;
  readonly boundsMinZ: number;
  readonly boundsMaxZ: number;
  readonly macroNodes?: SpineMacroNodesView;
  readonly corridorLeft?: SpineCorridorSideView;
  readonly corridorRight?: SpineCorridorSideView;

  sampleSpineFrame(s: number, out: SpineFrameOut): void;
  projectXZ(wx: number, wz: number, out: SpineProjectionOut): void;
  evaluatePisteHeight(s: number, x: number, out: PisteHeightOut): void;
  evaluatePisteSurface(s: number, x: number): PisteSurfaceType;
}

export interface WorldDirtyRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export type TopologyChangeListener = (
  isReset: boolean,
  dirtyWorldRects: readonly WorldDirtyRect[],
) => void;

export interface MountainSpineSource {
  readonly elevationSpines: readonly SpineView[];
  collectSpinesInBounds(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    padM: number,
    outSpines: SpineView[],
  ): void;
  addTopologyListener?(listener: TopologyChangeListener): void;
}

export interface MountainColumnOut {
  heightY: number;
  macroY: number;
  pisteWeight: number;
  onPiste: boolean;
  pisteSurfaceType: PisteSurfaceType;
  inDivider: boolean;
  dividerMask: number;
  inChasmZone: boolean;
  chasmWipeoutDepth: number;
  /** Signed chasm relief offset relative to macroY (<= 0 inside chasms, 0 outside). */
  chasmRelief: number;
  chasmDepthBelowSpine: number;
  nearestSpineY: number;
  nearestSegmentId: number;
  nearestStageId: string;
  secondaryStageId: string | null;
  secondaryStageWeight: number;
  nearestS: number;
  nearestSignedX: number;
  nearestHalfWidth: number;
  downhillX: number;
  downhillY: number;
  downhillZ: number;
}

export function createMountainColumnOut(): MountainColumnOut {
  return {
    heightY: 0,
    macroY: 0,
    pisteWeight: 0,
    onPiste: false,
    pisteSurfaceType: 'packed',
    inDivider: false,
    dividerMask: 0,
    inChasmZone: false,
    chasmWipeoutDepth: 0,
    chasmRelief: 0,
    chasmDepthBelowSpine: 0,
    nearestSpineY: 0,
    nearestSegmentId: -1,
    nearestStageId: 'sunny-blue',
    secondaryStageId: null,
    secondaryStageWeight: 0,
    nearestS: 0,
    nearestSignedX: 0,
    nearestHalfWidth: 14,
    downhillX: 0,
    downhillY: 0,
    downhillZ: -1,
  };
}

export interface MountainSampleOut extends MountainColumnOut {
  normalX: number;
  normalY: number;
  normalZ: number;
  surfaceType: SurfaceType;
}

export function createMountainSampleOut(): MountainSampleOut {
  return {
    ...createMountainColumnOut(),
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    surfaceType: 'packed',
  };
}

export interface TerrainDirtyRect {
  readonly minAbsX: number;
  readonly maxAbsX: number;
  readonly minAbsZ: number;
  readonly maxAbsZ: number;
}

export const TERRAIN_FLAG_ON_PISTE = 1 << 0;
export const TERRAIN_FLAG_IN_DIVIDER = 1 << 1;
export const TERRAIN_FLAG_IN_CHASM = 1 << 2;

/**
 * Unpacked, LinearFilter-safe continuous arrays for GPU textures, Jolt SetHeights, and CPU scenery.
 * NEVER bit-pack discrete IDs/flags into hardware LinearFilter texture channels!
 */
export interface TerrainGridSampleOut {
  readonly heights: Float32Array;
  readonly macroY: Float32Array;
  readonly normals: Float32Array;
  readonly pisteWeight: Float32Array;
  readonly iceWeight: Float32Array;
  readonly powderWeight: Float32Array;
  readonly dividerMask: Float32Array;
  readonly flowXZ: Float32Array;
  readonly offPisteDist: Float32Array;
  readonly primaryStageIdx: Uint8Array;
  readonly secondaryStageIdx: Uint8Array;
  readonly secondaryStageWeightU8: Uint8Array;
  readonly flags: Uint8Array;
}

export function createTerrainGridSampleOut(cols: number, rows: number): TerrainGridSampleOut {
  const count = Math.max(0, cols * rows);
  return {
    heights: new Float32Array(count),
    macroY: new Float32Array(count),
    normals: new Float32Array(count * 3),
    pisteWeight: new Float32Array(count),
    iceWeight: new Float32Array(count),
    powderWeight: new Float32Array(count),
    dividerMask: new Float32Array(count),
    flowXZ: new Float32Array(count * 2),
    offPisteDist: new Float32Array(count),
    primaryStageIdx: new Uint8Array(count),
    secondaryStageIdx: new Uint8Array(count),
    secondaryStageWeightU8: new Uint8Array(count),
    flags: new Uint8Array(count),
  };
}

export interface MountainFieldView {
  readonly worldSeed: number;
  readonly originOffsetX: number;
  readonly originOffsetZ: number;
  readonly fieldRevision?: number;
  collectSpinesInBounds(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    padM: number,
    outSpines: SpineView[],
  ): void;
  evaluateHeight(wx: number, wz: number, candidateSpines?: readonly SpineView[]): number;
  evaluateColumn(
    wx: number,
    wz: number,
    out: MountainColumnOut,
    candidateSpines?: readonly SpineView[],
  ): MountainColumnOut;
  /**
   * Full column + central-difference normal sample for simulation/scenery.
   * On strictly full interior groomed piste (`pisteWeight >= 1 - 1e-6`), skips off-piste macro/landscape
   * aggregation for speed (`macroY` reports `nearestSpineY`, `secondaryStage*` are omitted); call
   * `evaluateColumn` when full blended `macroY` and multi-stage metadata are needed.
   */
  evaluate(
    wx: number,
    wz: number,
    out: MountainSampleOut,
    candidateSpines?: readonly SpineView[],
  ): MountainSampleOut;
}

export interface TerrainFieldView extends MountainFieldView {
  readonly originOffsetY: number;
  readonly fieldRevision: number;
  readonly dirtyRects: readonly TerrainDirtyRect[];
  readonly stageIdTable: readonly string[];

  ackDirtyRects?(): void;

  evaluateSample(
    wx: number,
    wz: number,
    out: MountainSampleOut,
    candidateSpines?: readonly SpineView[],
  ): MountainSampleOut;

  sampleColumnGrid(
    originAbsX: number,
    originAbsZ: number,
    cols: number,
    rows: number,
    stepM: number,
    blockOriginY: number,
    out: TerrainGridSampleOut,
  ): void;
}

/**
 * Static landmark metadata consumed by LandmarkStreamer & scenery exclusion SpatialGrid.
 * Ownership boundaries (prevents double-spawning):
 * - 'forkArch' & 'deliveryLandmark': static scenery landmarks placed by LandmarkStreamer (cabins,
 *   lanterns, twin per-branch entrance gates at a trail split). Waiting/cheering children remain in DeliveryZonePoolView.
 * - Playable ski ramps belong exclusively to EntityPoolViews.ramps (not landmarks).
 */
export interface SegmentLandmarkRequirement {
  readonly id: string;
  readonly kind: 'forkArch' | 'deliveryLandmark';
  readonly segmentId: number;
  readonly s: number;
  readonly x: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  /** Heading around +Y where 0 rad faces -Z (THREE.Object3D.rotation.y). */
  readonly yawRad: number;
  readonly clearanceRadius: number;
  readonly visual: VisualSpec;
  /** Stage ID for 'forkArch' iconographic branch gate badge. */
  readonly badgeStageId?: string;
  /** Which fork branch this gate frames ('left' or 'right'). */
  readonly forkSide?: 'left' | 'right';
  /** Half-width in meters of the branch opening framed by this gate. */
  readonly gateHalfWidth?: number;
}

/**
 * Read-only view of a trail segment in the 4-slot sliding window.
 * Used by TerrainTilePool, LandmarkStreamer, and DebugDrawBuffer with zero allocation.
 */
export interface TerrainSegmentView {
  readonly id: number;
  readonly slot: TrailSlotRole;
  readonly stageId: string;
  readonly seed: number;
  readonly length: number;
  readonly chunkLength: number;
  readonly chunkCount: number;
  readonly prevSegmentId: number | null;
  readonly nextLeftId: number | null;
  readonly nextRightId: number | null;
  readonly fork: SegmentForkMeta;
  readonly landmarks: readonly SegmentLandmarkRequirement[];

  getChunkBounds(chunkIndex: number, out: ChunkRangeOut): void;
  sampleSpineFrame(s: number, out: SpineFrameOut): void;
  /** Evaluates surface at arc-length s and lateral offset x in meters. */
  evaluateSurfaceAtX(s: number, x: number, out: RibbonPointOut): void;
  /** Returns the guaranteed reachable centerline x offset at arc-length s. */
  sampleSafeX(s: number): number;
}

export interface TrailWindowView {
  readonly prev: TerrainSegmentView | null;
  readonly curr: TerrainSegmentView;
  readonly nextLeft: TerrainSegmentView | null;
  readonly nextRight: TerrainSegmentView | null;
}

export interface HazardPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  /** Local terrain surface normal for terrain-aligned contact shadow orientation. */
  readonly normalX: ReadonlyNumericBuffer;
  readonly normalY: ReadonlyNumericBuffer;
  readonly normalZ: ReadonlyNumericBuffer;
  /** Heading around +Y where 0 rad faces -Z (THREE.Object3D.rotation.y). */
  readonly yawRad: ReadonlyNumericBuffer;
  readonly scale: ReadonlyNumericBuffer;
  readonly radius: ReadonlyNumericBuffer;
  readonly height: ReadonlyNumericBuffer;
  /** 0 = intact, 1 = triggered/clipped. */
  readonly triggered: ReadonlyNumericBuffer;
}

export interface PresentPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly bobPhase: ReadonlyNumericBuffer;
  /** 0 = available in world, 1 = collected. */
  readonly collected: ReadonlyNumericBuffer;
}

export interface TossedPresentPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly prevPosX: ReadonlyNumericBuffer;
  readonly prevPosY: ReadonlyNumericBuffer;
  readonly prevPosZ: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly prevSpinRad: ReadonlyNumericBuffer;
  readonly spinRad: ReadonlyNumericBuffer;
  readonly progress: ReadonlyNumericBuffer;
  /** 0 = delivery toss arc, 1 = wipeout scatter burst. */
  readonly kind: ReadonlyNumericBuffer;
}

export interface DeliveryZonePoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly yawRad: ReadonlyNumericBuffer;
  readonly radius: ReadonlyNumericBuffer;
  readonly deliveredCount: ReadonlyNumericBuffer;
  /** 1 = active awaiting delivery, 0 = completed/inactive. */
  readonly active: ReadonlyNumericBuffer;
  readonly celebratingTimer: ReadonlyNumericBuffer;
}

export const CREATURE_PHASE_IDLE = 0;
export const CREATURE_PHASE_TELEGRAPH = 1;
export const CREATURE_PHASE_ATTACK = 2;
export const CREATURE_PHASE_RECOVER = 3;

export interface CreaturePoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly prevPosX: ReadonlyNumericBuffer;
  readonly prevPosY: ReadonlyNumericBuffer;
  readonly prevPosZ: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  /** Local terrain surface normal for terrain-aligned contact shadow orientation. */
  readonly normalX: ReadonlyNumericBuffer;
  readonly normalY: ReadonlyNumericBuffer;
  readonly normalZ: ReadonlyNumericBuffer;
  /** Heading around +Y where 0 rad faces -Z (forwardXZ = (-sin(heading), 0, -cos(heading))). */
  readonly prevHeadingRad: ReadonlyNumericBuffer;
  readonly headingRad: ReadonlyNumericBuffer;
  readonly groundY: ReadonlyNumericBuffer;
  /** Phase code: 0=idle, 1=telegraph, 2=attack/patrol, 3=recover. */
  readonly stateCode: ReadonlyNumericBuffer;
  readonly stateTimer: ReadonlyNumericBuffer;
  readonly telegraphProgress: ReadonlyNumericBuffer;
  readonly radius: ReadonlyNumericBuffer;
}

export interface SkiTrackPoolView {
  readonly count: number;
  readonly capacity: number;
  /** Ring buffer write head index; oldest sample starts at (head - count + capacity) % capacity. */
  readonly head: number;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly normalX: ReadonlyNumericBuffer;
  readonly normalY: ReadonlyNumericBuffer;
  readonly normalZ: ReadonlyNumericBuffer;
  readonly rightX: ReadonlyNumericBuffer;
  readonly rightY: ReadonlyNumericBuffer;
  readonly rightZ: ReadonlyNumericBuffer;
  readonly ageSec: ReadonlyNumericBuffer;
  /** 1 = grounded contact sample, 0 = airborne break. */
  readonly grounded: ReadonlyNumericBuffer;
}

export interface RampPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  /** Heading around +Y where 0 rad faces -Z (THREE.Object3D.rotation.y). */
  readonly yawRad: ReadonlyNumericBuffer;
  /** Signed downhill slope pitch at the ramp spawn point (Euler 'YXZ' X-rotation, < 0 downhill). */
  readonly pitchRad: ReadonlyNumericBuffer;
  readonly width: ReadonlyNumericBuffer;
  readonly length: ReadonlyNumericBuffer;
  readonly height: ReadonlyNumericBuffer;
}

export interface EntityPoolViews {
  readonly hazards: HazardPoolView;
  readonly presents: PresentPoolView;
  readonly tossedPresents: TossedPresentPoolView;
  readonly deliveryZones: DeliveryZonePoolView;
  readonly creatures: CreaturePoolView;
  readonly skiTracks: SkiTrackPoolView;
  readonly ramps: RampPoolView;
}

export interface DebugDrawView {
  readonly enabled: boolean;
  /** Number of safeX(s) world-space polyline points. */
  readonly safePathPointCount: number;
  /** Flat packed [x, y, z, ...] (length >= safePathPointCount * 3). */
  readonly safePathPoints: ReadonlyNumericBuffer;
  /** Segment ID per point so the renderer breaks strips across fork branches. */
  readonly safePathSegmentIds: ReadonlyNumericBuffer;

  /** Number of collider cylinders (hazards & creatures). */
  readonly colliderCount: number;
  /** Flat packed [x, groundY, z, ...] (length >= colliderCount * 3). */
  readonly colliderPositions: ReadonlyNumericBuffer;
  readonly colliderRadii: ReadonlyNumericBuffer;
  readonly colliderHeights: ReadonlyNumericBuffer;
  /** 0 = stumble/non-lethal, 1 = wipeout/lethal, 2 = creature. */
  readonly colliderKinds: ReadonlyNumericBuffer;

  /** Number of active delivery zone circles. */
  readonly deliveryZoneCount: number;
  /** Flat packed [x, y, z, ...] (length >= deliveryZoneCount * 3). */
  readonly deliveryPositions: ReadonlyNumericBuffer;
  readonly deliveryRadii: ReadonlyNumericBuffer;

  /** Number of visible fork V-wedge geometries. */
  readonly forkCount: number;
  /** Flat packed [x, y, z, ...] apex points. */
  readonly forkApexPositions: ReadonlyNumericBuffer;
  /** Flat packed [x, y, z, ...] left V-wedge endpoints. */
  readonly forkLeftTargets: ReadonlyNumericBuffer;
  /** Flat packed [x, y, z, ...] right V-wedge endpoints. */
  readonly forkRightTargets: ReadonlyNumericBuffer;
  readonly forkNoseRadii: ReadonlyNumericBuffer;

  /** Number of chunk boundary cross-lines. */
  readonly chunkBoundaryCount: number;
  /** Flat packed [x0, y0, z0, x1, y1, z1, ...] (length >= chunkBoundaryCount * 6). */
  readonly chunkBoundaryLines: ReadonlyNumericBuffer;

  /** Skier world position [x, y, z]. */
  readonly skierPos: ReadonlyNumericBuffer;
  /** Skier surface normal [nx, ny, nz]. */
  readonly skierNormal: ReadonlyNumericBuffer;
  /** Local downhill tangent [tx, ty, tz]. */
  readonly skierDownhill: ReadonlyNumericBuffer;
  /** Skier velocity [vx, vy, vz]. */
  readonly skierVelocity: ReadonlyNumericBuffer;
}

export interface SkierPose {
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly velX: number;
  readonly velY: number;
  readonly velZ: number;
  /** Heading around +Y where 0 rad faces -Z (forwardXZ = (-sin(heading), 0, -cos(heading))). */
  readonly headingRad: number;
  readonly carveAngleRad: number;
  /** Signed downhill pitch around local +X (Euler 'YXZ' X-rotation, < 0 downhill). */
  readonly pitchRad: number;
  readonly speed: number;
  readonly groundY: number;
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
  readonly grounded: boolean;
  readonly braking: boolean;
}

export interface ActiveWeatherState {
  readonly profileId: string;
  readonly blizzardEnabled: boolean;
  readonly blizzardIntensity: number;
  readonly snowParticleCount: number;
  readonly windLateral: number;
  readonly fogDistanceM: number;
  readonly blizzardDim: number;
}

export interface ReadonlySimState {
  readonly tickCount: number;
  readonly elapsedSec: number;
  readonly distanceM: number;
  readonly paused: boolean;
  readonly gameMode: 'endless' | 'scoreAttack';
  readonly livesRemaining: number;
  readonly gameOver: boolean;

  readonly skierId: string;
  readonly skierState: 'skiing' | 'wipeout' | 'recovering';
  readonly prevSkier: SkierPose;
  readonly currSkier: SkierPose;
  readonly surfaceSample: ReadonlySurfaceSample;
  readonly wipeoutTimerSec: number;
  readonly wipeoutDurationSec: number;
  readonly invulnerableTimerSec: number;
  readonly invulnerableDurationSec: number;

  readonly prevCamera: CameraPose;
  readonly currCamera: CameraPose;

  readonly score: number;
  readonly highCombo: number;
  readonly comboCount: number;
  readonly comboMultiplier: number;
  readonly comboTimerSec: number;
  readonly comboDurationSec: number;
  readonly carriedCount: number;
  readonly maxCarryCapacity: number;
  /** Fixed-capacity array; valid entries occupy [0, carriedCount). */
  readonly carriedPresentDefIds: readonly string[];
  readonly deliveredTotal: number;

  readonly activeStageId: string;
  readonly activeWeather: ActiveWeatherState;

  readonly trailWindow: TrailWindowView;
  readonly mountainField: TerrainFieldView;
  readonly rebase: RebaseInfo;
  readonly entities: EntityPoolViews;
  readonly debugDraw: DebugDrawView;
}

export interface SimEventMap {
  PRESENT_PICKED_UP: {
    readonly presentDefId: string;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly pickupPoints: number;
    readonly carriedCount: number;
    readonly maxCapacity: number;
  };
  PRESENT_DELIVERED: {
    readonly deliveryZoneId: string;
    readonly countDelivered: number;
    readonly pointsAwarded: number;
    readonly comboMultiplier: number;
    readonly totalScore: number;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
  };
  PLAYER_WIPEOUT: {
    readonly hazardId: string;
    readonly effect: 'wipeout' | 'stumble';
    readonly presentsDropped: number;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly recoverySec: number;
  };
  PLAYER_RECOVERED: {
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly invulnerableSec: number;
  };
  FORK_ENTERED: {
    readonly chosenSide: 'left' | 'right';
    readonly newSegmentId: number;
    readonly newStageId: string;
    readonly previousStageId: string;
  };
  WORLD_REBASED: {
    readonly rebaseCount: number;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly deltaZ: number;
    readonly totalOffsetX: number;
    readonly totalOffsetY: number;
    readonly totalOffsetZ: number;
  };
  CREATURE_TELEGRAPH: {
    readonly creatureDefId: string;
    readonly soundId: string;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly distanceToPlayerM: number;
    readonly showEdgeIndicator: boolean;
    readonly edgeSide: 'left' | 'right' | 'center';
  };
}

export type SimEvents = SimEventMap;
