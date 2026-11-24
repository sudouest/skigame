import { getStageDef, STAGE_SUNNY_BLUE } from '../../content/stages';
import { hashCoords2DU32, SeededRng } from '../../core/rng';
import { SpatialGrid } from '../../core/spatialGrid';
import {
  createMountainColumnOut,
  type MountainColumnOut,
  type MountainFieldView,
  type TerrainSegmentView,
  type TrailWindowView,
} from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import type { BillboardFrameName } from './spriteAtlas';
import {
  OUTER_TILE_SIZE_M,
  TerrainTilePool,
  createTileSurfaceSampleOut,
  type TileSurfaceSampleOut,
  type TerrainLodTier,
  type TerrainTileSlot,
} from './terrainTilePool';
import type { SharedToonMaterials } from './toonMaterials';

/** Default per-frame terrain streaming budget (ms), shared with ThreeRenderer. */
export const DEFAULT_TERRAIN_STREAM_BUDGET_MS = 5;
const ROWS_PER_YIELD = 4;
const MAX_SCENERY_PER_TILE = 36;
const INNER_FORWARD_SHIFT_M = 32;
const OUTER_FORWARD_SHIFT_M = 64;
const INNER_PARENT_HALF_EXTENT = 1; // 3 x 3 outer parent blocks -> 6 x 6 inner 32m tiles
const OUTER_TILE_HALF_EXTENT = 3; // 7 x 7 outer 64m tiles
const GRID_CENTER_HYSTERESIS_CELLS = 0.2;
const OUTER_DENSITY_TAPER = 0.22;

const TILE_KEY_BIAS = 0x800000;
const TILE_KEY_STRIDE = 0x1000000;
const TILE_KEY_LOD_STRIDE = 0x1000000000000;

export function packTileKey(lod: TerrainLodTier, absTileX: number, absTileZ: number): number {
  const ux = (absTileX + TILE_KEY_BIAS) >>> 0;
  const uz = (absTileZ + TILE_KEY_BIAS) >>> 0;
  return (lod & 1) * TILE_KEY_LOD_STRIDE + ux * TILE_KEY_STRIDE + uz;
}

export interface TileSceneryItem {
  localX: number;
  localY: number;
  localZ: number;
  width: number;
  height: number;
  frame: BillboardFrameName;
  flipX: boolean;
}

export interface SceneryProvider {
  readonly sceneryRevision: number;
  forEachActiveScenery(
    visitor: (
      originX: number,
      originY: number,
      originZ: number,
      item: TileSceneryItem,
    ) => boolean | void,
  ): void;
}

export interface TerrainStreamerOptions {
  readonly nowMs?: () => number;
  readonly innerCapacity?: number;
  readonly outerCapacity?: number;
  readonly tilePool?: TerrainTilePool;
}

interface TileRecord {
  key: number;
  lod: TerrainLodTier;
  absTileX: number;
  absTileZ: number;
  slot: TerrainTileSlot | null;
  readonly scenery: TileSceneryItem[];
  sceneryCount: number;
  readonly sceneryGrid: SpatialGrid<number>;
  readonly rng: SeededRng;
  gen: Generator<void, void, unknown> | null;
  waitingForSlot: boolean;
  completed: boolean;
  visible: boolean;
  priority: number;
}

const _colScratch: MountainColumnOut = createMountainColumnOut();
const _surfaceScratch: TileSurfaceSampleOut = createTileSurfaceSampleOut();
const compareJobPriority = (a: TileRecord, b: TileRecord): number => a.priority - b.priority;

/**
 * Time-budgeted, 2-tier world-grid terrain & off-piste scenery streamer.
 * Streams forward-biased `6 x 6` inner (`32m`) and `7 x 7` outer (`64m`) absolute-grid tiles,
 * swapping each `2 x 2` inner block atomically against its `64m` outer parent cell.
 */
export class TerrainStreamer implements SceneryProvider {
  readonly tilePool: TerrainTilePool;

  private readonly nowMs: () => number;
  private readonly tiles = new Map<number, TileRecord>();
  private readonly recordPool: TileRecord[] = [];
  private readonly desiredKeysScratch = new Set<number>();
  private readonly staleKeysScratch: number[] = [];
  private readonly orderedJobsScratch: TileRecord[] = [];
  private readonly activeSegmentsScratch: TerrainSegmentView[] = [];

  private readonly innerCell: number[] = [NaN, NaN];
  private readonly outerCell: number[] = [NaN, NaN];
  private _sceneryRevision = 0;
  private lastWorldSeed = -1;
  private lastCurrSegId = -1;
  private lastCurrSegSeed = -1;
  private lastCurrStageId = '';

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    options: TerrainStreamerOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.tilePool =
      options.tilePool ??
      new TerrainTilePool(gfx, materials.terrainMaterial, {
        innerCapacity: options.innerCapacity,
        outerCapacity: options.outerCapacity,
      });

    const recordCount = Math.max(
      160,
      this.tilePool.innerCapacity + this.tilePool.outerCapacity + 32,
    );
    for (let i = 0; i < recordCount; i++) {
      this.recordPool.push(this.createEmptyRecord());
    }
  }

  get sceneryRevision(): number {
    return this._sceneryRevision;
  }

  get activeTileCount(): number {
    return this.tiles.size;
  }

  get queuedTileCount(): number {
    let pending = 0;
    for (const rec of this.tiles.values()) {
      if (!rec.completed) pending++;
    }
    return pending;
  }

  /**
   * Reconciles active inner (`6 x 6`) and outer (`7 x 7`) absolute grid tiles around
   * `(focusX, focusZ)` biased forward along `(camFwdX, camFwdZ)`, stepping tile
   * generators within `budgetMs` and performing atomic `2 x 2` LOD swaps.
   */
  step(
    trailWindow: TrailWindowView,
    mountainField: MountainFieldView,
    focusX: number,
    focusZ: number,
    camFwdX = 0,
    camFwdZ = -1,
    budgetMs = DEFAULT_TERRAIN_STREAM_BUDGET_MS,
  ): void {
    const clampedBudgetMs = Math.max(1, budgetMs);
    const startMs = this.nowMs();

    // Detect worldSeed or reset discontinuities across runs
    const curr = trailWindow.curr;
    if (
      this.lastWorldSeed !== -1 &&
      (mountainField.worldSeed !== this.lastWorldSeed ||
        curr.id < this.lastCurrSegId ||
        (curr.id === this.lastCurrSegId &&
          (curr.seed !== this.lastCurrSegSeed || curr.stageId !== this.lastCurrStageId)))
    ) {
      this.clearAll();
    }
    this.lastWorldSeed = mountainField.worldSeed;
    this.lastCurrSegId = curr.id;
    this.lastCurrSegSeed = curr.seed;
    this.lastCurrStageId = curr.stageId;

    // Normalize camera XZ forward
    const fwdLen = Math.hypot(camFwdX, camFwdZ);
    const fx = fwdLen > 1e-4 ? camFwdX / fwdLen : 0;
    const fz = fwdLen > 1e-4 ? camFwdZ / fwdLen : -1;

    const absFocusX = focusX + mountainField.originOffsetX;
    const absFocusZ = focusZ + mountainField.originOffsetZ;

    const innerBiasAbsX = absFocusX + fx * INNER_FORWARD_SHIFT_M;
    const innerBiasAbsZ = absFocusZ + fz * INNER_FORWARD_SHIFT_M;
    // Hysteresis: only recentre a grid once the bias point leaves its cell by a margin,
    // so carving left/right never oscillates edge tiles across prune/rebuild.
    const innerParentCx = this.stabilizeCell(innerBiasAbsX, this.innerCell, 0);
    const innerParentCz = this.stabilizeCell(innerBiasAbsZ, this.innerCell, 1);

    const outerBiasAbsX = absFocusX + fx * OUTER_FORWARD_SHIFT_M;
    const outerBiasAbsZ = absFocusZ + fz * OUTER_FORWARD_SHIFT_M;
    const outerCx = this.stabilizeCell(outerBiasAbsX, this.outerCell, 0);
    const outerCz = this.stabilizeCell(outerBiasAbsZ, this.outerCell, 1);

    // 1. Collect desired tile keys across both LOD grids
    this.desiredKeysScratch.clear();

    for (let pz = innerParentCz - INNER_PARENT_HALF_EXTENT; pz <= innerParentCz + INNER_PARENT_HALF_EXTENT; pz++) {
      for (let px = innerParentCx - INNER_PARENT_HALF_EXTENT; px <= innerParentCx + INNER_PARENT_HALF_EXTENT; px++) {
        for (let cz = 0; cz < 2; cz++) {
          for (let cx = 0; cx < 2; cx++) {
            const tx = px * 2 + cx;
            const tz = pz * 2 + cz;
            this.desiredKeysScratch.add(packTileKey(0, tx, tz));
          }
        }
      }
    }

    for (let pz = outerCz - OUTER_TILE_HALF_EXTENT; pz <= outerCz + OUTER_TILE_HALF_EXTENT; pz++) {
      for (let px = outerCx - OUTER_TILE_HALF_EXTENT; px <= outerCx + OUTER_TILE_HALF_EXTENT; px++) {
        this.desiredKeysScratch.add(packTileKey(1, px, pz));
      }
    }

    // 2. Prune stale tiles first so pool slots are reclaimed immediately
    this.staleKeysScratch.length = 0;
    for (const key of this.tiles.keys()) {
      if (!this.desiredKeysScratch.has(key)) {
        this.staleKeysScratch.push(key);
      }
    }
    for (let i = 0; i < this.staleKeysScratch.length; i++) {
      const key = this.staleKeysScratch[i]!;
      const rec = this.tiles.get(key);
      if (rec) {
        this.releaseRecord(rec);
        this.tiles.delete(key);
      }
    }

    // 3. Enqueue missing tiles and update priorities
    for (let pz = innerParentCz - INNER_PARENT_HALF_EXTENT; pz <= innerParentCz + INNER_PARENT_HALF_EXTENT; pz++) {
      for (let px = innerParentCx - INNER_PARENT_HALF_EXTENT; px <= innerParentCx + INNER_PARENT_HALF_EXTENT; px++) {
        const pdx = (px + 0.5) * OUTER_TILE_SIZE_M - absFocusX;
        const pdz = (pz + 0.5) * OUTER_TILE_SIZE_M - absFocusZ;
        const parentDistSq = pdx * pdx + pdz * pdz;

        for (let cz = 0; cz < 2; cz++) {
          for (let cx = 0; cx < 2; cx++) {
            const tx = px * 2 + cx;
            const tz = pz * 2 + cz;
            const key = packTileKey(0, tx, tz);
            const priority = 100_000 + parentDistSq + cz * 2 + cx;
            this.ensureTileEnqueued(key, 0, tx, tz, priority, mountainField, trailWindow);
          }
        }
      }
    }

    for (let pz = outerCz - OUTER_TILE_HALF_EXTENT; pz <= outerCz + OUTER_TILE_HALF_EXTENT; pz++) {
      for (let px = outerCx - OUTER_TILE_HALF_EXTENT; px <= outerCx + OUTER_TILE_HALF_EXTENT; px++) {
        const key = packTileKey(1, px, pz);
        const dx = (px + 0.5) * OUTER_TILE_SIZE_M - absFocusX;
        const dz = (pz + 0.5) * OUTER_TILE_SIZE_M - absFocusZ;
        const distSq = dx * dx + dz * dz;
        const insideInnerZone =
          Math.abs(px - innerParentCx) <= INNER_PARENT_HALF_EXTENT &&
          Math.abs(pz - innerParentCz) <= INNER_PARENT_HALF_EXTENT;
        const priority = insideInnerZone ? distSq : 1_000_000 + distSq;
        this.ensureTileEnqueued(key, 1, px, pz, priority, mountainField, trailWindow);
      }
    }

    // 4. Step unfinished tile generators in priority order within frame budget
    this.orderedJobsScratch.length = 0;
    for (const rec of this.tiles.values()) {
      if (!rec.completed && rec.gen) {
        this.orderedJobsScratch.push(rec);
      }
    }
    this.orderedJobsScratch.sort(compareJobPriority);

    let tier0Full = false;
    let tier1Full = false;
    let budgetExpired = false;

    for (let i = 0; i < this.orderedJobsScratch.length && !budgetExpired; i++) {
      const job = this.orderedJobsScratch[i]!;
      if ((job.lod === 0 && tier0Full) || (job.lod === 1 && tier1Full)) {
        continue;
      }

      while (job.gen && !job.completed) {
        const result = job.gen.next();
        if (result.done) {
          job.completed = true;
          job.gen = null;
          break;
        }
        if (job.waitingForSlot) {
          if (job.lod === 0) tier0Full = true;
          else tier1Full = true;
          break;
        }
        if (this.nowMs() - startMs >= clampedBudgetMs) {
          budgetExpired = true;
          break;
        }
      }

      if (!budgetExpired && this.nowMs() - startMs >= clampedBudgetMs) {
        budgetExpired = true;
      }
    }

    // 5. Atomically reconcile 2 x 2 child vs 64m parent visibility & scenery revision
    this.reconcileLodVisibility();
  }

  /**
   * Shifts all active tile container transforms without vertex buffer re-uploads.
   */
  handleWorldRebased(deltaX: number, deltaY: number, deltaZ: number): void {
    this.tilePool.shiftAllOrigins(deltaX, deltaY, deltaZ);
    this._sceneryRevision++;
  }

  /**
   * Emits all visible `lod = 0` inner tiles first, followed by visible `lod = 1` outer tiles.
   */
  forEachActiveScenery(
    visitor: (
      originX: number,
      originY: number,
      originZ: number,
      item: TileSceneryItem,
    ) => boolean | void,
  ): void {
    for (const rec of this.tiles.values()) {
      if (rec.lod !== 0 || !rec.visible || !rec.slot) continue;
      const ox = rec.slot.originX;
      const oy = rec.slot.originY;
      const oz = rec.slot.originZ;
      for (let i = 0; i < rec.sceneryCount; i++) {
        if (visitor(ox, oy, oz, rec.scenery[i]!) === false) {
          return;
        }
      }
    }

    for (const rec of this.tiles.values()) {
      if (rec.lod !== 1 || !rec.visible || !rec.slot) continue;
      const ox = rec.slot.originX;
      const oy = rec.slot.originY;
      const oz = rec.slot.originZ;
      for (let i = 0; i < rec.sceneryCount; i++) {
        if (visitor(ox, oy, oz, rec.scenery[i]!) === false) {
          return;
        }
      }
    }
  }

  private stabilizeCell(biasAbs: number, cells: number[], axis: 0 | 1): number {
    const raw = biasAbs / OUTER_TILE_SIZE_M;
    const prev = cells[axis]!;
    if (Number.isNaN(prev) || Math.abs(raw - (prev + 0.5)) > 0.5 + GRID_CENTER_HYSTERESIS_CELLS) {
      cells[axis] = Math.floor(raw);
    }
    return cells[axis]!;
  }

  clearAll(): void {
    this.innerCell[0] = NaN;
    this.innerCell[1] = NaN;
    this.outerCell[0] = NaN;
    this.outerCell[1] = NaN;
    for (const rec of this.tiles.values()) {
      this.releaseRecord(rec);
    }
    this.tiles.clear();
    this._sceneryRevision++;
  }

  private ensureTileEnqueued(
    key: number,
    lod: TerrainLodTier,
    absTileX: number,
    absTileZ: number,
    priority: number,
    mountainField: MountainFieldView,
    trailWindow: TrailWindowView,
  ): void {
    const existing = this.tiles.get(key);
    if (existing) {
      existing.priority = priority;
      return;
    }

    const rec = this.acquireRecord(key, lod, absTileX, absTileZ, priority);
    rec.gen = this.buildTileGenerator(rec, mountainField, trailWindow);
    this.tiles.set(key, rec);
  }

  private *buildTileGenerator(
    rec: TileRecord,
    mountainField: MountainFieldView,
    trailWindow: TrailWindowView,
  ): Generator<void, void, unknown> {
    let slot = this.tilePool.acquireSlot(rec.lod, rec.absTileX, rec.absTileZ, mountainField);
    while (!slot) {
      rec.waitingForSlot = true;
      yield;
      rec.waitingForSlot = false;
      slot = this.tilePool.acquireSlot(rec.lod, rec.absTileX, rec.absTileZ, mountainField);
    }
    rec.slot = slot;

    // Phase A: Halo-padded height & color row generation
    const haloSpan = slot.spec.haloSpan;
    for (let r = 0; r < haloSpan; r++) {
      this.tilePool.writeBorderRow(slot, mountainField, r);
      if (r > 0 && r % ROWS_PER_YIELD === 0 && r < haloSpan - 1) {
        yield;
      }
    }

    yield;

    // Finalize geometry buffers (normals) first so scenery can sample the finished grid
    this.tilePool.finishSlot(slot);

    // Phase B: Deterministic per-tile off-piste scenery scatter (no heightfield re-evaluation)
    this.populateTileScenery(rec, slot, mountainField, trailWindow);
  }

  private populateTileScenery(
    rec: TileRecord,
    slot: TerrainTileSlot,
    mountainField: MountainFieldView,
    trailWindow: TrailWindowView,
  ): void {
    const tileSize = slot.spec.tileSize;
    const centerX = slot.originX + tileSize * 0.5;
    const centerZ = slot.originZ + tileSize * 0.5;

    mountainField.evaluateColumn(centerX, centerZ, _colScratch, slot.candidateSpines);
    const centerStage = getStageDef(_colScratch.nearestStageId) ?? STAGE_SUNNY_BLUE;
    const density = centerStage.layout.scenery.offPisteTreeDensity;

    const baseTarget = Math.round(density * 26);
    const targetCount =
      rec.lod === 0
        ? Math.min(MAX_SCENERY_PER_TILE, baseTarget)
        : Math.min(MAX_SCENERY_PER_TILE, Math.round(baseTarget * 4 * OUTER_DENSITY_TAPER));

    if (targetCount <= 0) {
      rec.sceneryCount = 0;
      return;
    }

    rec.sceneryGrid.clear();
    this.insertActiveLandmarks(rec, slot, trailWindow, centerX, centerZ, tileSize);

    const tileSeed =
      (hashCoords2DU32(
        rec.absTileX,
        rec.absTileZ,
        (mountainField.worldSeed ^ Math.imul(rec.lod + 1, 0x9e3779b9)) >>> 0,
      ) >>>
        0) ||
      1;
    rec.rng.setState(tileSeed);

    // Coarse 8m LOD normals smooth over cliff lips, so gate outer tiles more strictly.
    const minNormalY = rec.lod === 0 ? 0.78 : 0.85;
    const maxAttempts = targetCount * 3;
    let attempts = 0;
    while (rec.sceneryCount < targetCount && attempts < maxAttempts) {
      attempts++;
      const localX = rec.rng.nextRange(0, tileSize);
      const localZ = rec.rng.nextRange(0, tileSize);
      this.tilePool.sampleTileSurface(slot, localX, localZ, _surfaceScratch);
      if (_surfaceScratch.blocked || _surfaceScratch.minNormalY < minNormalY) {
        continue;
      }
      const relY = _surfaceScratch.relY;

      const localStage = centerStage;
      const isShrub = rec.rng.nextBool(0.22);
      const minRadius = isShrub
        ? localStage.layout.scenery.groundMinRadius
        : localStage.layout.scenery.canopyMinRadius;
      const radiusCheck = minRadius * 0.5;

      if (rec.sceneryGrid.hasOverlap(localX, localZ, radiusCheck)) {
        continue;
      }

      rec.sceneryGrid.insert(1000 + rec.sceneryCount, localX, localZ, radiusCheck);

      const item = rec.scenery[rec.sceneryCount++]!;
      item.localX = localX;
      item.localY = relY;
      item.localZ = localZ;
      item.flipX = rec.rng.nextBool(0.5);

      if (isShrub) {
        item.frame = 'snow_shrub';
        const sScale = rec.rng.nextRange(0.85, 1.35);
        item.width = 2.0 * sScale;
        item.height = 1.6 * sScale;
      } else {
        item.frame = rec.rng.nextBool(localStage.layout.scenery.frostedPineChance)
          ? 'pine_frosted'
          : 'pine_green';
        const tScale = rec.rng.nextRange(0.85, 1.4);
        item.width = 4.6 * tScale;
        item.height = 6.8 * tScale;
      }
    }
  }

  private insertActiveLandmarks(
    rec: TileRecord,
    slot: TerrainTileSlot,
    trailWindow: TrailWindowView,
    tileCenterX: number,
    tileCenterZ: number,
    tileSize: number,
  ): void {
    this.activeSegmentsScratch.length = 0;
    if (trailWindow.prev) this.activeSegmentsScratch.push(trailWindow.prev);
    this.activeSegmentsScratch.push(trailWindow.curr);
    if (trailWindow.nextLeft) this.activeSegmentsScratch.push(trailWindow.nextLeft);
    if (trailWindow.nextRight) this.activeSegmentsScratch.push(trailWindow.nextRight);

    const maxReach = tileSize * 0.75 + 16;
    for (let sIdx = 0; sIdx < this.activeSegmentsScratch.length; sIdx++) {
      const seg = this.activeSegmentsScratch[sIdx]!;
      const landmarks = seg.landmarks;
      for (let i = 0; i < landmarks.length; i++) {
        const lm = landmarks[i]!;
        const clearR = Math.max(2.5, lm.clearanceRadius);
        const dx = lm.worldX - tileCenterX;
        const dz = lm.worldZ - tileCenterZ;
        if (Math.abs(dx) > maxReach + clearR || Math.abs(dz) > maxReach + clearR) {
          continue;
        }
        rec.sceneryGrid.insert(
          i,
          lm.worldX - slot.originX,
          lm.worldZ - slot.originZ,
          clearR,
        );
      }
    }
  }

  private areAllInnerChildrenReady(parentX: number, parentZ: number): boolean {
    for (let cz = 0; cz < 2; cz++) {
      for (let cx = 0; cx < 2; cx++) {
        const childKey = packTileKey(0, parentX * 2 + cx, parentZ * 2 + cz);
        const child = this.tiles.get(childKey);
        if (!child || !child.completed || !child.slot || !child.slot.ready) {
          return false;
        }
      }
    }
    return true;
  }

  private reconcileLodVisibility(): void {
    let changed = false;

    for (const rec of this.tiles.values()) {
      const prevVisible = rec.visible;
      let nextVisible = false;

      if (rec.completed && rec.slot && rec.slot.ready) {
        if (rec.lod === 0) {
          const parentX = Math.floor(rec.absTileX / 2);
          const parentZ = Math.floor(rec.absTileZ / 2);
          nextVisible = this.areAllInnerChildrenReady(parentX, parentZ);
        } else {
          nextVisible = !this.areAllInnerChildrenReady(rec.absTileX, rec.absTileZ);
        }
      }

      if (rec.slot) {
        rec.slot.container.visible = nextVisible;
      }
      rec.visible = nextVisible;
      if (nextVisible !== prevVisible) {
        changed = true;
      }
    }

    if (changed) {
      this._sceneryRevision++;
    }
  }

  private createEmptyRecord(): TileRecord {
    const scenery: TileSceneryItem[] = [];
    for (let i = 0; i < MAX_SCENERY_PER_TILE; i++) {
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
    return {
      key: -1,
      lod: 0,
      absTileX: 0,
      absTileZ: 0,
      slot: null,
      scenery,
      sceneryCount: 0,
      sceneryGrid: new SpatialGrid<number>(8),
      rng: new SeededRng(1),
      gen: null,
      waitingForSlot: false,
      completed: false,
      visible: false,
      priority: 0,
    };
  }

  private acquireRecord(
    key: number,
    lod: TerrainLodTier,
    absTileX: number,
    absTileZ: number,
    priority: number,
  ): TileRecord {
    const rec = this.recordPool.pop() ?? this.createEmptyRecord();
    rec.key = key;
    rec.lod = lod;
    rec.absTileX = absTileX;
    rec.absTileZ = absTileZ;
    rec.slot = null;
    rec.sceneryCount = 0;
    rec.sceneryGrid.clear();
    rec.gen = null;
    rec.waitingForSlot = false;
    rec.completed = false;
    rec.visible = false;
    rec.priority = priority;
    return rec;
  }

  private releaseRecord(rec: TileRecord): void {
    if (rec.visible) {
      this._sceneryRevision++;
    }
    if (rec.slot) {
      this.tilePool.releaseSlot(rec.slot);
      rec.slot = null;
    }
    rec.gen = null;
    rec.waitingForSlot = false;
    rec.completed = false;
    rec.visible = false;
    rec.sceneryCount = 0;
    rec.sceneryGrid.clear();
    rec.key = -1;
    rec.absTileX = 0;
    rec.absTileZ = 0;
    this.recordPool.push(rec);
  }
}
