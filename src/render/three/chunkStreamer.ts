import * as THREE from 'three';
import { getStageDef } from '../../content/stages';
import { clamp } from '../../core/math';
import { SeededRng } from '../../core/rng';
import { SpatialGrid } from '../../core/spatialGrid';
import {
  createChunkRangeOut,
  createRibbonPointOut,
  type SegmentLandmarkRequirement,
  type TerrainSegmentView,
  type TrailWindowView,
} from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import {
  createForkArchObject,
  type ProceduralMeshAssets,
} from './meshFactory';
import {
  RIBBON_ROWS,
  RibbonPool,
  type RibbonChunkSlot,
} from './ribbonPool';
import type { BillboardFrameName } from './spriteAtlas';
import type { SharedToonMaterials } from './toonMaterials';

const ROWS_PER_YIELD = 5;
const MAX_SCENERY_PER_CHUNK = 28;
const MAX_CHUNKS_TRACKED = 64;

export interface ChunkSceneryItem {
  localX: number;
  localY: number;
  localZ: number;
  width: number;
  height: number;
  frame: BillboardFrameName;
  flipX: boolean;
}

interface PooledForkArch {
  readonly group: THREE.Group;
  readonly setBadges: (leftId?: string | null, rightId?: string | null) => void;
}

interface ChunkBuildRecord {
  key: number;
  segmentId: number;
  segmentSeed: number;
  stageId: string;
  chunkIndex: number;
  ribbonSlot: RibbonChunkSlot | null;
  landmarks: Array<{ kind: string; obj: THREE.Object3D; forkArch?: PooledForkArch }>;
  scenery: ChunkSceneryItem[];
  sceneryCount: number;
  sceneryGrid: SpatialGrid<number>;
  gen: Generator<void | Promise<void>, void, unknown> | null;
  waitingPromise: boolean;
  waitingForSlot: boolean;
  completed: boolean;
  priority: number;
}

export interface ChunkStreamerOptions {
  readonly nowMs?: () => number;
  readonly assetWaiter?: (modelId: string) => Promise<void> | null;
  readonly ribbonPoolCapacity?: number;
}

function packChunkKey(segmentId: number, chunkIndex: number): number {
  return segmentId * 1024 + (chunkIndex & 1023);
}

const _scratchRange = createChunkRangeOut();
const _scratchRibbon = createRibbonPointOut();
const compareJobPriority = (a: ChunkBuildRecord, b: ChunkBuildRecord): number =>
  a.priority - b.priority;

/**
 * Time-budgeted resumable chunk streamer driving `RibbonPool`, chunk-anchored landmarks
 * (`forkArch`, `deliveryLandmark`), and deterministic dual-radius off-trail scenery.
 */
export class ChunkStreamer {
  readonly ribbonPool: RibbonPool;
  private readonly gfx: GraphicsUtils;
  private readonly nowMs: () => number;
  private readonly assetWaiter: ((modelId: string) => Promise<void> | null) | undefined;

  private readonly chunks = new Map<number, ChunkBuildRecord>();
  private readonly recordPool: ChunkBuildRecord[] = [];
  private readonly activeSegmentIds: number[] = [];
  private readonly activeSegments: TerrainSegmentView[] = [];
  private readonly orderedJobs: ChunkBuildRecord[] = [];
  private readonly staleKeys: number[] = [];

  private readonly scratchRng = new SeededRng(1);

  // Pre-pooled landmark instances to avoid runtime mesh allocations & shader churn.
  private readonly forkArchPool: PooledForkArch[] = [];
  private readonly lanternPool: THREE.Group[] = [];
  private readonly deliveryArchPool: THREE.Group[] = [];
  private readonly cabinPool: THREE.Group[] = [];

  sceneryDirty = true;

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    meshAssets: ProceduralMeshAssets,
    options: ChunkStreamerOptions = {},
  ) {
    this.gfx = gfx;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.assetWaiter = options.assetWaiter;
    this.ribbonPool = new RibbonPool(
      gfx,
      materials.terrainMaterial,
      options.ribbonPoolCapacity,
    );

    // Pre-warm chunk records
    for (let i = 0; i < MAX_CHUNKS_TRACKED; i++) {
      const scenery: ChunkSceneryItem[] = [];
      for (let j = 0; j < MAX_SCENERY_PER_CHUNK; j++) {
        scenery.push({
          localX: 0,
          localY: 0,
          localZ: 0,
          width: 4,
          height: 6,
          frame: 'pine_green',
          flipX: false,
        });
      }
      this.recordPool.push({
        key: -1,
        segmentId: -1,
        segmentSeed: 0,
        stageId: '',
        chunkIndex: -1,
        ribbonSlot: null,
        landmarks: [],
        scenery,
        sceneryCount: 0,
        sceneryGrid: new SpatialGrid<number>(8),
        gen: null,
        waitingPromise: false,
        waitingForSlot: false,
        completed: false,
        priority: 0,
      });
    }

    // Pre-pool landmark objects (marked as cache so they persist cleanly across chunk recycling)
    for (let i = 0; i < 6; i++) {
      const arch = createForkArchObject(gfx, meshAssets, materials.propToonMaterial);
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
        gfx.createMesh(meshAssets.deliveryArchGlowGeo, materials.beaconGlowMaterial, `DeliveryArchGlow_${i}`),
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

  get activeChunkCount(): number {
    return this.chunks.size;
  }

  get queuedChunkCount(): number {
    let pending = 0;
    for (const rec of this.chunks.values()) {
      if (!rec.completed) pending++;
    }
    return pending;
  }

  private pushActiveSegment(seg: TerrainSegmentView | null): void {
    if (!seg) return;
    this.activeSegments.push(seg);
    this.activeSegmentIds.push(seg.id);
  }

  /**
   * Reconciles active 4-slot `TrailWindowView`, prunes unchosen/stale segments,
   * enqueues missing chunks, and steps chunk generator coroutines within `budgetMs`.
   */
  step(trailWindow: TrailWindowView, budgetMs = 14): void {
    const clampedBudgetMs = Math.max(1, budgetMs);
    const startMs = this.nowMs();

    // 1. Collect active segments ordered by streaming priority: curr > nextLeft/nextRight > prev
    this.activeSegments.length = 0;
    this.activeSegmentIds.length = 0;
    this.pushActiveSegment(trailWindow.curr);
    this.pushActiveSegment(trailWindow.nextLeft);
    this.pushActiveSegment(trailWindow.nextRight);
    this.pushActiveSegment(trailWindow.prev);

    // 2. Prune stale chunks not in active trail window
    this.staleKeys.length = 0;
    for (const [key, rec] of this.chunks) {
      if (!this.activeSegmentIds.includes(rec.segmentId)) {
        this.staleKeys.push(key);
      }
    }
    for (let i = 0; i < this.staleKeys.length; i++) {
      const key = this.staleKeys[i]!;
      const rec = this.chunks.get(key);
      if (rec) {
        this.releaseRecord(rec);
        this.chunks.delete(key);
      }
    }

    // 3. Enqueue missing chunks across the 4-slot window (and invalidate on seed/stageId changes)
    for (let sIdx = 0; sIdx < this.activeSegments.length; sIdx++) {
      const seg = this.activeSegments[sIdx]!;
      const priorityBase = sIdx * 100;
      for (let c = 0; c < seg.chunkCount; c++) {
        const key = packChunkKey(seg.id, c);
        const existing = this.chunks.get(key);
        if (existing && (existing.segmentSeed !== seg.seed || existing.stageId !== seg.stageId)) {
          this.releaseRecord(existing);
          this.chunks.delete(key);
        }
        const current = this.chunks.get(key);
        if (!current) {
          const rec = this.acquireRecord(key, seg.id, seg.seed, seg.stageId, c, priorityBase + c);
          if (!rec) continue;
          rec.gen = this.buildChunkGenerator(rec, seg, c);
          this.chunks.set(key, rec);
        } else {
          current.priority = priorityBase + c;
        }
      }
    }

    // 4. Collect unfinished runnable jobs and step in priority order until frame budget expires
    this.orderedJobs.length = 0;
    for (const rec of this.chunks.values()) {
      if (!rec.completed && !rec.waitingPromise && rec.gen) {
        this.orderedJobs.push(rec);
      }
    }
    this.orderedJobs.sort(compareJobPriority);

    for (let i = 0; i < this.orderedJobs.length; i++) {
      const job = this.orderedJobs[i]!;
      while (job.gen && !job.completed && !job.waitingPromise) {
        const result = job.gen.next();
        if (result.done) {
          job.completed = true;
          job.gen = null;
          this.sceneryDirty = true;
          break;
        }
        if (result.value && typeof (result.value as Promise<void>).then === 'function') {
          job.waitingPromise = true;
          (result.value as Promise<void>).then(
            () => {
              job.waitingPromise = false;
            },
            () => {
              job.waitingPromise = false;
            },
          );
          break;
        }
        if (job.waitingForSlot) {
          // Never busy-spin waiting for a free RibbonPool slot; yield to remaining jobs/next frame.
          break;
        }
        if (this.nowMs() - startMs >= clampedBudgetMs) {
          return;
        }
      }
      if (this.nowMs() - startMs >= clampedBudgetMs) {
        return;
      }
    }
  }

  /**
   * Translates chunk containers on `WORLD_REBASED` without touching vertex buffers.
   */
  handleWorldRebased(deltaX: number, deltaY: number, deltaZ: number): void {
    this.ribbonPool.shiftAllOrigins(deltaX, deltaY, deltaZ);
    this.sceneryDirty = true;
  }

  /**
   * Iterates all completed active chunk static scenery items without allocations.
   */
  forEachActiveScenery(
    visitor: (originX: number, originY: number, originZ: number, item: ChunkSceneryItem) => boolean | void,
  ): void {
    for (const rec of this.chunks.values()) {
      if (!rec.completed || !rec.ribbonSlot) continue;
      const ox = rec.ribbonSlot.originX;
      const oy = rec.ribbonSlot.originY;
      const oz = rec.ribbonSlot.originZ;
      for (let i = 0; i < rec.sceneryCount; i++) {
        if (visitor(ox, oy, oz, rec.scenery[i]!) === false) {
          return;
        }
      }
    }
  }

  clearAll(): void {
    for (const rec of this.chunks.values()) {
      this.releaseRecord(rec);
    }
    this.chunks.clear();
    this.sceneryDirty = true;
  }

  private acquireRecord(
    key: number,
    segmentId: number,
    segmentSeed: number,
    stageId: string,
    chunkIndex: number,
    priority: number,
  ): ChunkBuildRecord | null {
    const rec = this.recordPool.pop();
    if (!rec) return null;
    rec.key = key;
    rec.segmentId = segmentId;
    rec.segmentSeed = segmentSeed;
    rec.stageId = stageId;
    rec.chunkIndex = chunkIndex;
    rec.ribbonSlot = null;
    rec.landmarks.length = 0;
    rec.sceneryCount = 0;
    rec.sceneryGrid.clear();
    rec.gen = null;
    rec.waitingPromise = false;
    rec.waitingForSlot = false;
    rec.completed = false;
    rec.priority = priority;
    return rec;
  }

  private releaseRecord(rec: ChunkBuildRecord): void {
    for (let i = 0; i < rec.landmarks.length; i++) {
      const lm = rec.landmarks[i]!;
      lm.obj.removeFromParent();
      if (lm.forkArch) {
        this.forkArchPool.push(lm.forkArch);
      } else if (lm.kind === 'delivery_arch') {
        this.deliveryArchPool.push(lm.obj as THREE.Group);
      } else if (lm.kind === 'delivery_cabin') {
        this.cabinPool.push(lm.obj as THREE.Group);
      } else if (lm.kind === 'delivery_lantern') {
        this.lanternPool.push(lm.obj as THREE.Group);
      }
    }
    rec.landmarks.length = 0;

    if (rec.ribbonSlot) {
      this.ribbonPool.releaseSlot(rec.ribbonSlot);
      rec.ribbonSlot = null;
    }

    rec.gen = null;
    rec.waitingPromise = false;
    rec.waitingForSlot = false;
    rec.completed = false;
    rec.sceneryCount = 0;
    rec.sceneryGrid.clear();
    rec.key = -1;
    rec.segmentId = -1;
    rec.segmentSeed = 0;
    rec.stageId = '';
    rec.chunkIndex = -1;
    this.recordPool.push(rec);
    this.sceneryDirty = true;
  }

  private *buildChunkGenerator(
    rec: ChunkBuildRecord,
    segment: TerrainSegmentView,
    chunkIndex: number,
  ): Generator<void | Promise<void>, void, unknown> {
    segment.getChunkBounds(chunkIndex, _scratchRange);
    const startS = _scratchRange.startS;
    const endS = _scratchRange.endS;

    // Wait cleanly without busy-spinning if RibbonPool is momentarily full
    let slot = this.ribbonPool.acquireSlot(segment, chunkIndex, startS, endS);
    while (!slot) {
      rec.waitingForSlot = true;
      yield;
      rec.waitingForSlot = false;
      slot = this.ribbonPool.acquireSlot(segment, chunkIndex, startS, endS);
    }
    rec.ribbonSlot = slot;

    // Phase A: Build ribbon mesh rows progressively inside frame time budget
    for (let r = 0; r <= RIBBON_ROWS; r++) {
      this.ribbonPool.writeRow(slot, segment, r);
      if (r > 0 && r % ROWS_PER_YIELD === 0 && r < RIBBON_ROWS) {
        yield;
      }
    }
    this.ribbonPool.finishSlot(slot);
    yield;

    // Phase B: Spawn chunk-anchored landmarks (forkArch & deliveryLandmark)
    const landmarks = segment.landmarks;
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i]!;
      if (lm.chunkIndex !== chunkIndex) continue;

      if (lm.visual.kind === 'mesh' && this.assetWaiter) {
        const pending = this.assetWaiter(lm.visual.modelId);
        if (pending) {
          yield pending;
        }
      }

      this.attachLandmark(rec, slot, lm);
    }
    yield;

    // Phase C: Deterministic dual-radius off-trail scenery scatter using per-chunk grid in chunk-local coords
    const stageDef = getStageDef(segment.stageId);
    const pineDensity = stageDef?.layout.scenery.pineDensity ?? 0.5;
    const canopyMinR = stageDef?.layout.scenery.canopyMinRadius ?? 4.2;
    const groundMinR = stageDef?.layout.scenery.groundMinRadius ?? 2.0;

    rec.sceneryGrid.clear();
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i]!;
      rec.sceneryGrid.insert(
        i,
        lm.worldX - slot.originX,
        lm.worldZ - slot.originZ,
        Math.max(2.5, lm.clearanceRadius),
      );
    }

    this.scratchRng.setState(((segment.seed ^ Math.imul(chunkIndex + 1, 73856093)) >>> 0) || 1);
    const targetCount = Math.min(
      MAX_SCENERY_PER_CHUNK,
      Math.round((endS - startS) * pineDensity * 0.85),
    );
    const maxAttempts = targetCount * 3;
    const frostedChance = segment.stageId === 'icy-black' ? 0.65 : 0.2;

    let attempts = 0;
    while (rec.sceneryCount < targetCount && attempts < maxAttempts) {
      attempts++;
      const s = this.scratchRng.nextRange(startS + 1.0, Math.max(startS + 1.5, endS - 1.0));

      // Keep inner fork wedge clean for smooth branch visibility
      if (segment.fork.hasFork && s >= segment.length - 55) continue;
      if (segment.fork.isForkChild && s <= 30) continue;

      const side = this.scratchRng.nextBool(0.5) ? 1 : -1;
      const uMag = this.scratchRng.nextRange(0.76, 0.97);
      segment.evaluateRibbonPoint(s, side * uMag, _scratchRibbon);
      if (_scratchRibbon.inPlayableCorridor || _scratchRibbon.isInnerForkSlope) continue;

      const isShrub = this.scratchRng.nextBool(0.22);
      const radiusCheck = isShrub ? groundMinR : canopyMinR;

      const localX = _scratchRibbon.posX - slot.originX;
      const localY = _scratchRibbon.posY - slot.originY;
      const localZ = _scratchRibbon.posZ - slot.originZ;

      if (rec.sceneryGrid.hasOverlap(localX, localZ, radiusCheck)) {
        continue;
      }

      rec.sceneryGrid.insert(1000 + rec.sceneryCount, localX, localZ, radiusCheck);

      const item = rec.scenery[rec.sceneryCount++]!;
      item.localX = localX;
      item.localY = localY;
      item.localZ = localZ;
      item.flipX = this.scratchRng.nextBool(0.5);

      if (isShrub) {
        item.frame = 'snow_shrub';
        const sScale = this.scratchRng.nextRange(0.85, 1.35);
        item.width = 2.0 * sScale;
        item.height = 1.6 * sScale;
      } else {
        item.frame = this.scratchRng.nextBool(frostedChance) ? 'pine_frosted' : 'pine_green';
        const tScale = this.scratchRng.nextRange(0.85, 1.4);
        item.width = 4.6 * tScale;
        item.height = 6.8 * tScale;
      }

      if (attempts % 8 === 0) {
        yield;
      }
    }
  }

  private attachLandmark(
    rec: ChunkBuildRecord,
    slot: RibbonChunkSlot,
    lm: SegmentLandmarkRequirement,
  ): void {
    const localX = lm.worldX - slot.originX;
    const localY = lm.worldY - slot.originY;
    const localZ = lm.worldZ - slot.originZ;

    if (lm.kind === 'forkArch') {
      const arch = this.forkArchPool.pop();
      if (!arch) return;
      arch.setBadges(lm.leftBadgeStageId, lm.rightBadgeStageId);
      arch.group.position.set(localX, localY, localZ);
      arch.group.rotation.set(0, lm.yawRad, 0, 'YXZ');
      arch.group.scale.setScalar(1);
      slot.container.add(arch.group);
      rec.landmarks.push({ kind: 'forkArch', obj: arch.group, forkArch: arch });
      return;
    }

    const preset = lm.visual.kind === 'procedural' ? lm.visual.preset : 'lantern';
    const scale = lm.visual.kind === 'procedural' ? (lm.visual.scale ?? 1) : 1;

    if (preset === 'cabin') {
      const cabin = this.cabinPool.pop();
      if (!cabin) return;
      cabin.position.set(localX, localY, localZ);
      cabin.rotation.set(0, lm.yawRad + (lm.x < 0 ? Math.PI * 0.35 : -Math.PI * 0.35), 0, 'YXZ');
      cabin.scale.setScalar(clamp(scale, 0.5, 2));
      slot.container.add(cabin);
      rec.landmarks.push({ kind: 'delivery_cabin', obj: cabin });
    } else if (preset === 'arch') {
      const arch = this.deliveryArchPool.pop();
      if (!arch) return;
      arch.position.set(localX, localY, localZ);
      arch.rotation.set(0, lm.yawRad, 0, 'YXZ');
      arch.scale.setScalar(clamp(scale, 0.5, 2));
      slot.container.add(arch);
      rec.landmarks.push({ kind: 'delivery_arch', obj: arch });
    } else {
      const lantern = this.lanternPool.pop();
      if (!lantern) return;
      lantern.position.set(localX, localY, localZ);
      lantern.rotation.set(0, lm.yawRad, 0, 'YXZ');
      lantern.scale.setScalar(clamp(scale, 0.5, 2));
      slot.container.add(lantern);
      rec.landmarks.push({ kind: 'delivery_lantern', obj: lantern });
    }
  }
}
