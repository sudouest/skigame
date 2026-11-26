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
  FOLK_CABIN_SMOKE_ORIGIN,
  FOLK_SMOKE_FRAMES,
} from './folkCabinModel';
import type { GraphicsUtils } from './graphicsUtils';
import { createForkArchObject, type ProceduralMeshAssets } from './meshFactory';
import type { SharedToonMaterials } from './toonMaterials';

type PooledLandmarkKind = 'forkArch' | 'delivery_arch' | 'delivery_cabin' | 'delivery_lantern';

interface PooledForkArch {
  readonly group: THREE.Group;
  readonly setBadge: (stageId?: string | null, gateHalfWidth?: number) => void;
}

interface ActiveLandmarkRecord {
  id: string;
  pooledKind: PooledLandmarkKind | null;
  obj: THREE.Object3D | null;
  forkArch: PooledForkArch | null;
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
}

const MAX_ACTIVE_LANDMARKS = 48;
const MAX_CABIN_POOLED = 8;
const MAX_CABIN_SMOKE_PUFFS = MAX_CABIN_POOLED * CABIN_SMOKE_PUFFS_PER_CABIN;

const _smokeMat4 = new THREE.Matrix4();
const _smokePos = new THREE.Vector3();
const _smokeCamQuat = new THREE.Quaternion();
const _smokeRollQuat = new THREE.Quaternion();
const _smokeScale = new THREE.Vector3();
const _smokeZAxis = new THREE.Vector3(0, 0, 1);

function resolveVisualSignature(lm: SegmentLandmarkRequirement): string {
  if (lm.visual.kind === 'mesh') {
    return `mesh:${lm.visual.modelId}`;
  }
  if (lm.visual.kind === 'procedural') {
    return `proc:${lm.visual.preset}`;
  }
  return `bb:${lm.visual.atlasId}:${lm.visual.frame}`;
}

function resolveScale(lm: SegmentLandmarkRequirement): number {
  if (lm.kind === 'forkArch') return 1;
  if (lm.visual.kind === 'procedural') {
    return clamp(lm.visual.scale ?? 1, 0.5, 2);
  }
  if (lm.visual.kind === 'mesh') {
    return clamp(lm.visual.scale ?? 1, 0.5, 2);
  }
  return 1;
}

function resolveYaw(lm: SegmentLandmarkRequirement): number {
  if (
    lm.kind !== 'forkArch' &&
    lm.visual.kind === 'procedural' &&
    lm.visual.preset === 'cabin'
  ) {
    return lm.yawRad + (lm.x < 0 ? Math.PI * 0.35 : -Math.PI * 0.35);
  }
  return lm.yawRad;
}

function resolvePooledKind(lm: SegmentLandmarkRequirement): PooledLandmarkKind {
  if (lm.kind === 'forkArch') return 'forkArch';
  const preset = lm.visual.kind === 'procedural' ? lm.visual.preset : 'lantern';
  if (preset === 'cabin') return 'delivery_cabin';
  if (preset === 'arch') return 'delivery_arch';
  return 'delivery_lantern';
}

/**
 * Reconciles pooled 3D landmarks (`forkArch` and `deliveryLandmark`) directly against
 * the active 4-slot `TrailWindowView` independent of terrain grid tiles.
 */
export class LandmarkStreamer {
  readonly rootGroup: THREE.Group;
  readonly cabinSmokeMesh: THREE.InstancedMesh;

  private readonly assetWaiter: ((modelId: string) => Promise<void> | null) | undefined;
  private readonly forkArchPool: PooledForkArch[] = [];
  private readonly lanternPool: THREE.Group[] = [];
  private readonly deliveryArchPool: THREE.Group[] = [];
  private readonly cabinPool: THREE.Group[] = [];
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

    for (let i = 0; i < MAX_ACTIVE_LANDMARKS; i++) {
      this.recordPool.push({
        id: '',
        pooledKind: null,
        obj: null,
        forkArch: null,
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

    for (let i = 0; i < 12; i++) {
      const arch = createForkArchObject(
        gfx,
        meshAssets,
        materials.propToonMaterial,
        materials.beaconGlowMaterial,
      );
      gfx.markAsCache(arch.group, `PooledForkArch_${i}`);
      this.forkArchPool.push(arch);
    }

    for (let i = 0; i < 12; i++) {
      const group = new THREE.Group();
      group.name = `PooledDeliveryLantern_${i}`;
      const postMesh = gfx.createMesh(
        meshAssets.lanternPostGeo,
        materials.propToonMaterial,
        `LanternPost_${i}`,
      );
      postMesh.castShadow = true;
      const glowMesh = gfx.createMesh(
        meshAssets.lanternGlowGeo,
        materials.beaconGlowMaterial,
        `LanternGlow_${i}`,
      );
      glowMesh.castShadow = false;
      group.add(postMesh, glowMesh);
      gfx.markAsCache(group, group.name);
      this.lanternPool.push(group);
    }

    for (let i = 0; i < 8; i++) {
      const group = new THREE.Group();
      group.name = `PooledDeliveryArch_${i}`;
      const archMesh = gfx.createMesh(
        meshAssets.deliveryArchGeo,
        materials.propToonMaterial,
        `DeliveryArch_${i}`,
      );
      archMesh.castShadow = true;
      const glowMesh = gfx.createMesh(
        meshAssets.deliveryArchGlowGeo,
        materials.beaconGlowMaterial,
        `DeliveryArchGlow_${i}`,
      );
      glowMesh.castShadow = false;
      group.add(archMesh, glowMesh);
      gfx.markAsCache(group, group.name);
      this.deliveryArchPool.push(group);
    }

    for (let i = 0; i < MAX_CABIN_POOLED; i++) {
      const group = new THREE.Group();
      group.name = `PooledDeliveryCabin_${i}`;
      const cabinMesh = gfx.createMesh(
        meshAssets.cabinGeo,
        materials.cabinToonMaterial,
        `DeliveryCabin_${i}`,
      );
      cabinMesh.castShadow = true;
      if (options.outlineMaterial) {
        const outlineMesh = gfx.createMesh(
          meshAssets.cabinGeo,
          options.outlineMaterial,
          `DeliveryCabinOutline_${i}`,
        );
        outlineMesh.castShadow = false;
        group.add(outlineMesh);
      }
      const glowMesh = gfx.createMesh(
        meshAssets.cabinGlowGeo,
        materials.beaconGlowMaterial,
        `DeliveryCabinGlow_${i}`,
      );
      glowMesh.castShadow = false;
      group.add(cabinMesh, glowMesh);
      gfx.markAsCache(group, group.name);
      this.cabinPool.push(group);
    }

    const instSmokeGeo = new THREE.BufferGeometry();
    instSmokeGeo.name = 'DeliveryCabinSmokePool_InstGeo';
    instSmokeGeo.index = meshAssets.cabinSmokeGeo.index;
    instSmokeGeo.setAttribute('position', meshAssets.cabinSmokeGeo.attributes.position!);
    instSmokeGeo.setAttribute('normal', meshAssets.cabinSmokeGeo.attributes.normal!);
    instSmokeGeo.setAttribute('uv', meshAssets.cabinSmokeGeo.attributes.uv!);

    this.smokeUvRects = new Float32Array(MAX_CABIN_SMOKE_PUFFS * 4);
    this.smokeUvRectAttr = new THREE.InstancedBufferAttribute(this.smokeUvRects, 4);
    this.smokeUvRectAttr.setUsage(THREE.DynamicDrawUsage);
    instSmokeGeo.setAttribute('aUvRect', this.smokeUvRectAttr);

    this.smokeAlphas = new Float32Array(MAX_CABIN_SMOKE_PUFFS);
    this.smokeAlphaAttr = new THREE.InstancedBufferAttribute(this.smokeAlphas, 1);
    this.smokeAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    instSmokeGeo.setAttribute('aSmokeAlpha', this.smokeAlphaAttr);
    gfx.markAsCache(instSmokeGeo, instSmokeGeo.name);

    this.cabinSmokeMesh = gfx.createInstancedMesh(
      instSmokeGeo,
      materials.cabinSmokeMaterial,
      MAX_CABIN_SMOKE_PUFFS,
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

    this.updateCabinSmoke(elapsedSec, camera, windLateral);
  }

  private updateCabinSmoke(
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
      if (rec.pooledKind !== 'delivery_cabin' || rec.obj === null) continue;
      const cosY = Math.cos(rec.yawRad);
      const sinY = Math.sin(rec.yawRad);
      const scale = rec.scale;

      const mouthX =
        rec.worldX + (FOLK_CABIN_SMOKE_ORIGIN.x * cosY + FOLK_CABIN_SMOKE_ORIGIN.z * sinY) * scale;
      const mouthY = rec.worldY + FOLK_CABIN_SMOKE_ORIGIN.y * scale;
      const mouthZ =
        rec.worldZ + (-FOLK_CABIN_SMOKE_ORIGIN.x * sinY + FOLK_CABIN_SMOKE_ORIGIN.z * cosY) * scale;

      const tiltX = -0.16 * cosY - 0.05 * sinY;
      const tiltZ = 0.16 * sinY - 0.05 * cosY;
      const seedPhase = ((rec.segmentSeed & 255) / 256) * 0.73;

      for (let k = 0; k < CABIN_SMOKE_PUFFS_PER_CABIN && count < MAX_CABIN_SMOKE_PUFFS; k++) {
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
          (0.34 + 0.96 * smoothstep(0.0, 0.9, u)) * (k % 3 === 1 ? 0.88 : 1.0) * scale;
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

    const yaw = resolveYaw(lm);
    const scale = resolveScale(lm);
    const badgeChanged =
      rec.segmentSeed !== segmentSeed ||
      rec.badgeStageId !== lm.badgeStageId ||
      rec.gateHalfWidth !== lm.gateHalfWidth;

    if (badgeChanged && rec.forkArch) {
      rec.forkArch.setBadge(lm.badgeStageId, lm.gateHalfWidth);
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
    const rec = this.recordPool.pop() ?? {
      id: '',
      pooledKind: null,
      obj: null,
      forkArch: null,
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
    rec.pooledKind = null;
    rec.obj = null;
    rec.forkArch = null;
    rec.segmentSeed = segmentSeed;
    rec.badgeStageId = lm.badgeStageId;
    rec.gateHalfWidth = lm.gateHalfWidth;
    rec.worldX = lm.worldX;
    rec.worldY = lm.worldY;
    rec.worldZ = lm.worldZ;
    rec.yawRad = resolveYaw(lm);
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
    const pooledKind = resolvePooledKind(lm);
    const yaw = resolveYaw(lm);
    const scale = resolveScale(lm);

    if (pooledKind === 'forkArch') {
      const arch = this.forkArchPool.pop();
      if (!arch) return;
      arch.setBadge(lm.badgeStageId, lm.gateHalfWidth);
      arch.group.position.set(lm.worldX, lm.worldY, lm.worldZ);
      arch.group.rotation.set(0, yaw, 0, 'YXZ');
      arch.group.scale.setScalar(scale);
      this.rootGroup.add(arch.group);
      rec.pooledKind = pooledKind;
      rec.obj = arch.group;
      rec.forkArch = arch;
    } else {
      const pool =
        pooledKind === 'delivery_cabin'
          ? this.cabinPool
          : pooledKind === 'delivery_arch'
            ? this.deliveryArchPool
            : this.lanternPool;
      const group = pool.pop();
      if (!group) return;
      group.position.set(lm.worldX, lm.worldY, lm.worldZ);
      group.rotation.set(0, yaw, 0, 'YXZ');
      group.scale.setScalar(scale);
      this.rootGroup.add(group);
      rec.pooledKind = pooledKind;
      rec.obj = group;
      rec.forkArch = null;
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

  private releaseRecord(rec: ActiveLandmarkRecord): void {
    rec.generation++;
    if (rec.obj) {
      rec.obj.removeFromParent();
      if (rec.pooledKind === 'forkArch' && rec.forkArch) {
        this.forkArchPool.push(rec.forkArch);
      } else if (rec.pooledKind === 'delivery_arch') {
        this.deliveryArchPool.push(rec.obj as THREE.Group);
      } else if (rec.pooledKind === 'delivery_cabin') {
        this.cabinPool.push(rec.obj as THREE.Group);
      } else if (rec.pooledKind === 'delivery_lantern') {
        this.lanternPool.push(rec.obj as THREE.Group);
      }
    }

    rec.id = '';
    rec.pooledKind = null;
    rec.obj = null;
    rec.forkArch = null;
    rec.badgeStageId = undefined;
    rec.gateHalfWidth = undefined;
    rec.visualSignature = '';
    rec.assetState = 'ready';
    this.recordPool.push(rec);
  }
}
