import * as THREE from 'three';
import { clamp } from '../../core/math';
import type {
  SegmentLandmarkRequirement,
  TerrainSegmentView,
  TrailWindowView,
} from '../../sim/contracts';
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
}

const MAX_ACTIVE_LANDMARKS = 48;

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

  private readonly assetWaiter: ((modelId: string) => Promise<void> | null) | undefined;
  private readonly forkArchPool: PooledForkArch[] = [];
  private readonly lanternPool: THREE.Group[] = [];
  private readonly deliveryArchPool: THREE.Group[] = [];
  private readonly cabinPool: THREE.Group[] = [];

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
      group.add(
        gfx.createMesh(meshAssets.lanternPostGeo, materials.propToonMaterial, `LanternPost_${i}`),
        gfx.createMesh(meshAssets.lanternGlowGeo, materials.beaconGlowMaterial, `LanternGlow_${i}`),
      );
      gfx.markAsCache(group, group.name);
      this.lanternPool.push(group);
    }

    for (let i = 0; i < 8; i++) {
      const group = new THREE.Group();
      group.name = `PooledDeliveryArch_${i}`;
      group.add(
        gfx.createMesh(meshAssets.deliveryArchGeo, materials.propToonMaterial, `DeliveryArch_${i}`),
        gfx.createMesh(
          meshAssets.deliveryArchGlowGeo,
          materials.beaconGlowMaterial,
          `DeliveryArchGlow_${i}`,
        ),
      );
      gfx.markAsCache(group, group.name);
      this.deliveryArchPool.push(group);
    }

    for (let i = 0; i < 8; i++) {
      const group = new THREE.Group();
      group.name = `PooledDeliveryCabin_${i}`;
      group.add(
        gfx.createMesh(meshAssets.cabinGeo, materials.propToonMaterial, `DeliveryCabin_${i}`),
        gfx.createMesh(meshAssets.cabinGlowGeo, materials.beaconGlowMaterial, `DeliveryCabinGlow_${i}`),
      );
      gfx.markAsCache(group, group.name);
      this.cabinPool.push(group);
    }
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

  sync(trailWindow: TrailWindowView): void {
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
