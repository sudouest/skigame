import * as THREE from 'three';
import { clamp, smoothstep } from '../../core/math';
import type {
  SegmentLandmarkRequirement,
  TerrainSegmentView,
  TrailWindowView,
} from '../../sim/contracts';
import {
  CABIN_SMOKE_CYCLE_SEC,
  CABIN_SMOKE_PUFFS_PER_CABIN,
  CABIN_SMOKE_RISE_HEIGHT_M,
  FOLK_SMOKE_FRAMES,
} from './chimneySmoke';
import type { GraphicsUtils } from './graphicsUtils';
import {
  createDefaultLandmarkRegistry,
  type LandmarkInstanceHandle,
  type LandmarkModelDef,
  type LandmarkModelRegistry,
} from './landmarkRegistry';
import type { ProceduralMeshAssets } from './meshFactory';
import type { SharedToonMaterials } from './toonMaterials';

interface ActiveLandmarkRecord {
  id: string;
  modelId: string | null;
  modelDef: LandmarkModelDef | null;
  handle: LandmarkInstanceHandle | null;
  obj: THREE.Object3D | null;
  segmentSeed: number;
  badgeStageId: string | undefined;
  gateHalfWidth: number | undefined;
  worldX: number;
  worldY: number;
  worldZ: number;
  yawRad: number;
  scale: number;
  x: number;
  visualSignature: string;
  assetState: 'ready' | 'waiting';
  generation: number;
}

export interface LandmarkStreamerOptions {
  readonly assetWaiter?: (modelId: string) => Promise<void> | null;
  readonly outlineMaterial?: THREE.Material;
  readonly registry?: LandmarkModelRegistry;
}

const MAX_ACTIVE_LANDMARKS = 48;
const MAX_SMOKE_EMITTERS = 12;
const MAX_SMOKE_PUFFS = MAX_SMOKE_EMITTERS * CABIN_SMOKE_PUFFS_PER_CABIN;

const _smokeMat4 = new THREE.Matrix4();
const _smokePos = new THREE.Vector3();
const _smokeCamQuat = new THREE.Quaternion();
const _smokeRollQuat = new THREE.Quaternion();
const _smokeScale = new THREE.Vector3();
const _smokeZAxis = new THREE.Vector3(0, 0, 1);

function resolveVisualSignature(lm: SegmentLandmarkRequirement): string {
  if (lm.kind === 'forkArch') {
    return 'forkArch';
  }
  if (lm.visual.kind === 'mesh') {
    return `mesh:${lm.visual.modelId}`;
  }
  if (lm.visual.kind === 'procedural') {
    return lm.visual.variant
      ? `proc:${lm.visual.preset}:${lm.visual.variant}`
      : `proc:${lm.visual.preset}`;
  }
  return `bb:${lm.visual.atlasId}:${lm.visual.frame}`;
}

function resolveScale(lm: SegmentLandmarkRequirement): number {
  if (lm.kind === 'forkArch') return 1;
  if (lm.visual.kind === 'procedural' || lm.visual.kind === 'mesh') {
    return clamp(lm.visual.scale ?? 1, 0.5, 2);
  }
  return 1;
}

function resolveYaw(lm: SegmentLandmarkRequirement, modelDef: LandmarkModelDef | null): number {
  const yawPolicy = modelDef?.yawPolicy ?? 'none';
  if (yawPolicy === 'faceTrail') {
    return lm.yawRad + (lm.x < 0 ? Math.PI * 0.35 : -Math.PI * 0.35);
  }
  if (typeof yawPolicy === 'number') {
    return lm.yawRad + yawPolicy;
  }
  if (lm.kind !== 'forkArch' && lm.visual.kind === 'mesh' && lm.visual.yawOffset !== undefined) {
    return lm.yawRad + lm.visual.yawOffset;
  }
  return lm.yawRad;
}

/**
 * Reconciles pooled 3D landmarks (`forkArch`, `delivery_lantern`, `delivery_arch`,
 * `folk_log`, `folk_aframe`, and registered `.glb` models) directly against the active
 * 4-slot `TrailWindowView` independent of terrain grid tiles, plus a single-draw-call
 * rising chimney smoke particle pool.
 */
export class LandmarkStreamer {
  readonly rootGroup: THREE.Group;
  readonly cabinSmokeMesh: THREE.InstancedMesh;
  readonly registry: LandmarkModelRegistry;

  private readonly assetWaiter: ((modelId: string) => Promise<void> | null) | undefined;
  private readonly pools = new Map<string, LandmarkInstanceHandle[]>();
  private readonly smokeUvRects: Float32Array;
  private readonly smokeUvRectAttr: THREE.InstancedBufferAttribute;
  private readonly smokeAlphas: Float32Array;
  private readonly smokeAlphaAttr: THREE.InstancedBufferAttribute;

  private readonly activeRecords = new Map<string, ActiveLandmarkRecord>();
  private readonly recordPool: ActiveLandmarkRecord[] = [];
  private readonly activeSegmentsScratch: TerrainSegmentView[] = [];
  private readonly seenIdsScratch = new Set<string>();
  private readonly staleIdsScratch: string[] = [];

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    meshAssets: ProceduralMeshAssets,
    options: LandmarkStreamerOptions = {},
  ) {
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'LandmarkStreamerRoot';
    this.assetWaiter = options.assetWaiter;
    this.registry =
      options.registry ??
      createDefaultLandmarkRegistry(gfx, materials, meshAssets, options.outlineMaterial);

    for (let i = 0; i < MAX_ACTIVE_LANDMARKS; i++) {
      this.recordPool.push({
        id: '',
        modelId: null,
        modelDef: null,
        handle: null,
        obj: null,
        segmentSeed: 0,
        badgeStageId: undefined,
        gateHalfWidth: undefined,
        worldX: 0,
        worldY: 0,
        worldZ: 0,
        yawRad: 0,
        scale: 1,
        x: 0,
        visualSignature: '',
        assetState: 'ready',
        generation: 0,
      });
    }

    for (const def of this.registry.getDefs()) {
      const pool: LandmarkInstanceHandle[] = [];
      for (let i = 0; i < def.poolCapacity; i++) {
        pool.push(def.createInstance(i));
      }
      this.pools.set(def.id, pool);
    }

    const instSmokeGeo = new THREE.BufferGeometry();
    instSmokeGeo.name = 'DeliveryCabinSmokePool_InstGeo';
    instSmokeGeo.index = meshAssets.cabinSmokeGeo.index;
    instSmokeGeo.setAttribute('position', meshAssets.cabinSmokeGeo.attributes.position!);
    instSmokeGeo.setAttribute('normal', meshAssets.cabinSmokeGeo.attributes.normal!);
    instSmokeGeo.setAttribute('uv', meshAssets.cabinSmokeGeo.attributes.uv!);

    this.smokeUvRects = new Float32Array(MAX_SMOKE_PUFFS * 4);
    this.smokeUvRectAttr = new THREE.InstancedBufferAttribute(this.smokeUvRects, 4);
    this.smokeUvRectAttr.setUsage(THREE.DynamicDrawUsage);
    instSmokeGeo.setAttribute('aUvRect', this.smokeUvRectAttr);

    this.smokeAlphas = new Float32Array(MAX_SMOKE_PUFFS);
    this.smokeAlphaAttr = new THREE.InstancedBufferAttribute(this.smokeAlphas, 1);
    this.smokeAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    instSmokeGeo.setAttribute('aSmokeAlpha', this.smokeAlphaAttr);
    gfx.markAsCache(instSmokeGeo, instSmokeGeo.name);

    this.cabinSmokeMesh = gfx.createInstancedMesh(
      instSmokeGeo,
      materials.cabinSmokeMaterial,
      MAX_SMOKE_PUFFS,
      'DeliveryCabinSmokePool',
    );
    this.cabinSmokeMesh.frustumCulled = false;
    this.cabinSmokeMesh.castShadow = false;
    this.cabinSmokeMesh.receiveShadow = false;
    this.cabinSmokeMesh.renderOrder = 2;
    this.cabinSmokeMesh.count = 0;
    this.rootGroup.add(this.cabinSmokeMesh);
    gfx.markAsCache(this.cabinSmokeMesh, 'DeliveryCabinSmokePool');
  }

  get activeCount(): number {
    let attached = 0;
    for (const rec of this.activeRecords.values()) {
      if (rec.obj !== null) attached++;
    }
    return attached;
  }

  get pendingCount(): number {
    let pending = 0;
    for (const rec of this.activeRecords.values()) {
      if (rec.assetState === 'waiting') pending++;
    }
    return pending;
  }

  sync(
    trailWindow: TrailWindowView,
    elapsedSec = 0,
    camera?: THREE.Camera,
    windLateral = 0,
  ): void {
    this.activeSegmentsScratch.length = 0;
    if (trailWindow.prev) this.activeSegmentsScratch.push(trailWindow.prev);
    this.activeSegmentsScratch.push(trailWindow.curr);
    if (trailWindow.nextLeft) this.activeSegmentsScratch.push(trailWindow.nextLeft);
    if (trailWindow.nextRight) this.activeSegmentsScratch.push(trailWindow.nextRight);

    this.seenIdsScratch.clear();

    for (let sIdx = 0; sIdx < this.activeSegmentsScratch.length; sIdx++) {
      const seg = this.activeSegmentsScratch[sIdx]!;
      const landmarks = seg.landmarks;
      for (let i = 0; i < landmarks.length; i++) {
        const lm = landmarks[i]!;
        this.seenIdsScratch.add(lm.id);
        this.reconcileLandmark(seg.seed, lm);
      }
    }

    this.staleIdsScratch.length = 0;
    for (const id of this.activeRecords.keys()) {
      if (!this.seenIdsScratch.has(id)) {
        this.staleIdsScratch.push(id);
      }
    }
    for (let i = 0; i < this.staleIdsScratch.length; i++) {
      const id = this.staleIdsScratch[i]!;
      const rec = this.activeRecords.get(id);
      if (rec) {
        this.releaseRecord(rec);
        this.activeRecords.delete(id);
      }
    }

    this.updateLandmarkSmoke(elapsedSec, camera, windLateral);
  }

  private updateLandmarkSmoke(
    elapsedSec: number,
    camera: THREE.Camera | undefined,
    windLateral: number,
  ): void {
    if (camera) {
      _smokeCamQuat.copy(camera.quaternion);
    } else {
      _smokeCamQuat.identity();
    }

    const windDriftX = clamp(0.85 + windLateral * 0.35, -3.2, 3.2);
    const windDriftZ = 0.28;
    let count = 0;

    for (const rec of this.activeRecords.values()) {
      const anchors = rec.modelDef?.smokeAnchors;
      if (!anchors || anchors.length === 0 || rec.obj === null) continue;

      const cosY = Math.cos(rec.yawRad);
      const sinY = Math.sin(rec.yawRad);
      const scale = rec.scale;
      const baseSeedPhase = ((rec.segmentSeed & 255) / 256) * 0.73;

      for (let aIdx = 0; aIdx < anchors.length; aIdx++) {
        const anchor = anchors[aIdx]!;
        const mouthX = rec.worldX + (anchor.x * cosY + anchor.z * sinY) * scale;
        const mouthY = rec.worldY + anchor.y * scale;
        const mouthZ = rec.worldZ + (-anchor.x * sinY + anchor.z * cosY) * scale;

        const tiltX = anchor.tiltX * cosY + anchor.tiltZ * sinY;
        const tiltZ = -anchor.tiltX * sinY + anchor.tiltZ * cosY;
        const puffScale = anchor.puffScale ?? 1;
        const seedPhase = baseSeedPhase + aIdx * 0.31;

        for (let k = 0; k < CABIN_SMOKE_PUFFS_PER_CABIN && count < MAX_SMOKE_PUFFS; k++) {
          const rawPhase =
            elapsedSec / CABIN_SMOKE_CYCLE_SEC + k / CABIN_SMOKE_PUFFS_PER_CABIN + seedPhase;
          const u = ((rawPhase % 1) + 1) % 1;
          const invU = 1 - u;
          const dy = (u * 0.78 + (1 - invU * invU) * 0.22) * CABIN_SMOKE_RISE_HEIGHT_M * scale;

          const curlPhase = u * Math.PI * 3.2 + k * 1.15 + seedPhase * 6.28;
          const curlAmp = (0.12 + 0.42 * smoothstep(0.08, 0.85, u)) * scale;
          const windEase = u * u * 0.65 + u * 0.35;

          const px =
            mouthX +
            (tiltX * 0.55 * u + windDriftX * windEase) * scale +
            Math.sin(curlPhase) * curlAmp;
          const py = mouthY + dy;
          const pz =
            mouthZ +
            (tiltZ * 0.55 * u + windDriftZ * windEase) * scale +
            Math.cos(curlPhase * 0.85) * curlAmp * 0.75;

          const puffSize =
            (0.34 + 0.96 * smoothstep(0.0, 0.9, u)) *
            (k % 3 === 1 ? 0.88 : 1.0) *
            scale *
            puffScale;
          const spinRad = ((k & 1) === 0 ? 1 : -1) * (u * 1.65 + k * 0.52);
          const fadeIn = smoothstep(0.0, 0.12, u);
          const fadeOut = 1 - smoothstep(0.58, 1.0, u);
          const alpha = fadeIn * fadeOut * 0.92;

          _smokePos.set(px, py, pz);
          _smokeRollQuat.setFromAxisAngle(_smokeZAxis, spinRad);
          _smokeRollQuat.premultiply(_smokeCamQuat);
          _smokeScale.set(puffSize, puffSize, 1);
          _smokeMat4.compose(_smokePos, _smokeRollQuat, _smokeScale);
          this.cabinSmokeMesh.setMatrixAt(count, _smokeMat4);

          const frame = FOLK_SMOKE_FRAMES[k % FOLK_SMOKE_FRAMES.length]!;
          const flipX = (k & 1) === 1;
          const uvBase = count * 4;
          if (flipX) {
            this.smokeUvRects[uvBase] = frame.uOffset + frame.uScale;
            this.smokeUvRects[uvBase + 1] = frame.vOffset;
            this.smokeUvRects[uvBase + 2] = -frame.uScale;
            this.smokeUvRects[uvBase + 3] = frame.vScale;
          } else {
            this.smokeUvRects[uvBase] = frame.uOffset;
            this.smokeUvRects[uvBase + 1] = frame.vOffset;
            this.smokeUvRects[uvBase + 2] = frame.uScale;
            this.smokeUvRects[uvBase + 3] = frame.vScale;
          }
          this.smokeAlphas[count] = alpha;
          count++;
        }
      }
    }

    this.cabinSmokeMesh.count = count;
    if (count > 0) {
      this.cabinSmokeMesh.instanceMatrix.needsUpdate = true;
      this.smokeUvRectAttr.needsUpdate = true;
      this.smokeAlphaAttr.needsUpdate = true;
    }
  }

  handleWorldRebased(deltaX: number, deltaY: number, deltaZ: number): void {
    for (const rec of this.activeRecords.values()) {
      rec.worldX -= deltaX;
      rec.worldY -= deltaY;
      rec.worldZ -= deltaZ;
      if (rec.obj) {
        rec.obj.position.set(rec.worldX, rec.worldY, rec.worldZ);
      }
    }
  }

  clearAll(): void {
    for (const rec of this.activeRecords.values()) {
      this.releaseRecord(rec);
    }
    this.activeRecords.clear();
    this.cabinSmokeMesh.count = 0;
  }

  private resolveModelDef(visualSig: string): LandmarkModelDef | undefined {
    return this.registry.resolve(visualSig) ?? this.registry.resolve('proc:lantern');
  }

  private reconcileLandmark(segmentSeed: number, lm: SegmentLandmarkRequirement): void {
    const visualSig = resolveVisualSignature(lm);
    let rec = this.activeRecords.get(lm.id);

    if (rec && rec.visualSignature !== visualSig) {
      this.releaseRecord(rec);
      this.activeRecords.delete(lm.id);
      rec = undefined;
    }

    if (!rec) {
      rec = this.acquireRecord(lm.id, segmentSeed, lm, visualSig);
      this.activeRecords.set(lm.id, rec);
    }

    if (rec.assetState === 'waiting') {
      return;
    }

    if (!rec.obj) {
      this.attachPooledMesh(rec, segmentSeed, lm);
      return;
    }

    const yaw = resolveYaw(lm, rec.modelDef);
    const scale = resolveScale(lm);
    const badgeChanged =
      rec.segmentSeed !== segmentSeed ||
      rec.badgeStageId !== lm.badgeStageId ||
      rec.gateHalfWidth !== lm.gateHalfWidth;

    if (badgeChanged && rec.handle?.configure) {
      rec.handle.configure(lm, segmentSeed);
    }

    if (
      rec.worldX !== lm.worldX ||
      rec.worldY !== lm.worldY ||
      rec.worldZ !== lm.worldZ
    ) {
      rec.obj.position.set(lm.worldX, lm.worldY, lm.worldZ);
    }

    if (rec.yawRad !== yaw || rec.x !== lm.x) {
      rec.obj.rotation.set(0, yaw, 0, 'YXZ');
    }

    if (rec.scale !== scale) {
      rec.obj.scale.setScalar(scale);
    }

    rec.segmentSeed = segmentSeed;
    rec.badgeStageId = lm.badgeStageId;
    rec.gateHalfWidth = lm.gateHalfWidth;
    rec.worldX = lm.worldX;
    rec.worldY = lm.worldY;
    rec.worldZ = lm.worldZ;
    rec.yawRad = yaw;
    rec.scale = scale;
    rec.x = lm.x;
  }

  private acquireRecord(
    id: string,
    segmentSeed: number,
    lm: SegmentLandmarkRequirement,
    visualSignature: string,
  ): ActiveLandmarkRecord {
    const modelDef = this.resolveModelDef(visualSignature) ?? null;
    const rec = this.recordPool.pop() ?? {
      id: '',
      modelId: null,
      modelDef: null,
      handle: null,
      obj: null,
      segmentSeed: 0,
      badgeStageId: undefined,
      gateHalfWidth: undefined,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
      yawRad: 0,
      scale: 1,
      x: 0,
      visualSignature: '',
      assetState: 'ready' as const,
      generation: 0,
    };

    rec.id = id;
    rec.modelId = modelDef?.id ?? null;
    rec.modelDef = modelDef;
    rec.handle = null;
    rec.obj = null;
    rec.segmentSeed = segmentSeed;
    rec.badgeStageId = lm.badgeStageId;
    rec.gateHalfWidth = lm.gateHalfWidth;
    rec.worldX = lm.worldX;
    rec.worldY = lm.worldY;
    rec.worldZ = lm.worldZ;
    rec.yawRad = resolveYaw(lm, modelDef);
    rec.scale = resolveScale(lm);
    rec.x = lm.x;
    rec.visualSignature = visualSignature;
    rec.assetState = 'ready';
    rec.generation++;

    if (lm.visual.kind === 'mesh' && this.assetWaiter) {
      const pending = this.assetWaiter(lm.visual.modelId);
      if (pending) {
        rec.assetState = 'waiting';
        const expectedGen = rec.generation;
        pending.then(
          () => {
            if (rec.generation === expectedGen) {
              rec.assetState = 'ready';
            }
          },
          () => {
            if (rec.generation === expectedGen) {
              rec.assetState = 'ready';
            }
          },
        );
      }
    }

    return rec;
  }

  private attachPooledMesh(
    rec: ActiveLandmarkRecord,
    segmentSeed: number,
    lm: SegmentLandmarkRequirement,
  ): void {
    const modelDef = rec.modelDef ?? this.resolveModelDef(rec.visualSignature) ?? null;
    if (!modelDef) return;
    let pool = this.pools.get(modelDef.id);
    if (!pool) {
      pool = [];
      for (let i = 0; i < modelDef.poolCapacity; i++) {
        pool.push(modelDef.createInstance(i));
      }
      this.pools.set(modelDef.id, pool);
    }

    const handle = pool.pop();
    if (!handle) return;

    const yaw = resolveYaw(lm, modelDef);
    const scale = resolveScale(lm);
    handle.configure?.(lm, segmentSeed);
    handle.group.position.set(lm.worldX, lm.worldY, lm.worldZ);
    handle.group.rotation.set(0, yaw, 0, 'YXZ');
    handle.group.scale.setScalar(scale);
    this.rootGroup.add(handle.group);

    rec.modelId = modelDef.id;
    rec.modelDef = modelDef;
    rec.handle = handle;
    rec.obj = handle.group;
    rec.segmentSeed = segmentSeed;
    rec.badgeStageId = lm.badgeStageId;
    rec.gateHalfWidth = lm.gateHalfWidth;
    rec.worldX = lm.worldX;
    rec.worldY = lm.worldY;
    rec.worldZ = lm.worldZ;
    rec.yawRad = yaw;
    rec.scale = scale;
    rec.x = lm.x;
  }

  private releaseRecord(rec: ActiveLandmarkRecord): void {
    rec.generation++;
    if (rec.obj) {
      rec.obj.removeFromParent();
      if (rec.modelId && rec.handle) {
        this.pools.get(rec.modelId)?.push(rec.handle);
      }
    }

    rec.id = '';
    rec.modelId = null;
    rec.modelDef = null;
    rec.handle = null;
    rec.obj = null;
    rec.badgeStageId = undefined;
    rec.gateHalfWidth = undefined;
    rec.visualSignature = '';
    rec.assetState = 'ready';
    this.recordPool.push(rec);
  }
}
