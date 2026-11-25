import { DEFAULT_SCENERY_TIER_RULES } from '../../content/sceneryRules';
import { getStageDef, STAGE_SUNNY_BLUE } from '../../content/stages';
import { clamp, lerp } from '../../core/math';
import { fbm2D } from '../../core/noise';
import { hashCoords2DU32, SeededRng } from '../../core/rng';
import { SpatialGrid } from '../../core/spatialGrid';
import {
  createMountainColumnOut,
  createMountainSampleOut,
  type MountainColumnOut,
  type MountainSampleOut,
  type SpineView,
  type TerrainFieldView,
  type TerrainSegmentView,
  type TrailWindowView,
} from '../../sim/contracts';
import {
  computeScenerySlopeSinkY,
  computeStageSceneryDensity,
  selectWinningSceneryRule,
  speciesToBillboardFrame,
  type SceneryEnvSignal,
} from './scenerySelector';
import type { BillboardFrameName } from './spriteAtlas';

export const SCENERY_CELL_SIZE_M = 32;
export const DEFAULT_SCENERY_STREAM_BUDGET_MS = 2.0;

const SCENERY_CELL_HALF_EXTENT = 4; // 9 x 9 = 81 deterministic 32 m cells (288 m x 288 m)
const SCENERY_FORWARD_SHIFT_M = 48;
const SCENERY_HYSTERESIS_CELLS = 0.2;
const MAX_SCENERY_PER_CELL = 28;
const SCENERY_PISTE_WEIGHT_MAX = 0.15;
const SCENERY_MIN_NORMAL_Y = 0.72;
const SPINE_BOUNDS_PAD_M = 310;
const NEAR_PRIORITY_RADIUS_CELLS = 2;

const CELL_KEY_BIAS = 0x800000;
const CELL_KEY_STRIDE = 0x1000000;

export function packSceneryCellKey(absCellX: number, absCellZ: number): number {
  const ux = (absCellX + CELL_KEY_BIAS) >>> 0;
  const uz = (absCellZ + CELL_KEY_BIAS) >>> 0;
  return ux * CELL_KEY_STRIDE + uz;
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

export interface SceneryCellStreamerOptions {
  readonly nowMs?: () => number;
  readonly halfExtentCells?: number;
}

interface SceneryCellRecord {
  key: number;
  absCellX: number;
  absCellZ: number;
  originX: number;
  originY: number;
  originZ: number;
  readonly items: TileSceneryItem[];
  itemCount: number;
  populated: boolean;
  priority: number;
  distCellsSq: number;
}

const compareCellPriority = (a: SceneryCellRecord, b: SceneryCellRecord): number =>
  a.priority - b.priority;

const _colScratch: MountainColumnOut = createMountainColumnOut();
const _sampleScratch: MountainSampleOut = createMountainSampleOut();

/**
 * Decoupled deterministic `32 m x 32 m` world-grid `SceneryProvider`.
 * Evaluates authoritative `TerrainFieldView` directly (never coupled to terrain LOD mesh tessellation),
 * so off-piste trees, shrubs, and rocks NEVER jump or pop when CDLOD rings morph underneath.
 * Preserves cross-fork biome fidelity, spatial thinning, dual-radius understory tucking,
 * `computeScenerySlopeSinkY`, landmark exclusions, and translation-only `WORLD_REBASED`.
 */
export class SceneryCellStreamer implements SceneryProvider {
  private readonly nowMs: () => number;
  private readonly halfExtent: number;
  private readonly cells = new Map<number, SceneryCellRecord>();
  private readonly recordPool: SceneryCellRecord[] = [];
  private readonly desiredKeysScratch = new Set<number>();
  private readonly staleKeysScratch: number[] = [];
  private readonly pendingJobsScratch: SceneryCellRecord[] = [];
  private readonly activeSegmentsScratch: TerrainSegmentView[] = [];
  private readonly candidateSpinesScratch: SpineView[] = [];
  private readonly groundGridScratch = new SpatialGrid<number>(8);
  private readonly canopyGridScratch = new SpatialGrid<number>(8);
  private readonly rngScratch = new SeededRng(1);
  private readonly envSignalScratch: SceneryEnvSignal = {
    minNormalY: 1,
    distFromTrail: 0,
    relElevation: 0,
    worldNoise01: 0.5,
    lod: 0,
    scenery: STAGE_SUNNY_BLUE.layout.scenery,
  };

  private readonly centerCell: [number, number] = [NaN, NaN];
  private _sceneryRevision = 0;
  private lastWorldSeed = -1;
  private lastCurrSegId = -1;
  private lastCurrSegSeed = -1;
  private lastCurrStageId = '';

  constructor(options: SceneryCellStreamerOptions = {}) {
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.halfExtent = Math.max(1, options.halfExtentCells ?? SCENERY_CELL_HALF_EXTENT);

    const gridSpan = this.halfExtent * 2 + 1;
    const poolSize = gridSpan * gridSpan + 24;
    for (let i = 0; i < poolSize; i++) {
      this.recordPool.push(this.createEmptyRecord());
    }
  }

  get sceneryRevision(): number {
    return this._sceneryRevision;
  }

  get activeCellCount(): number {
    return this.cells.size;
  }

  get queuedCellCount(): number {
    let pending = 0;
    for (const rec of this.cells.values()) {
      if (!rec.populated) pending++;
    }
    return pending;
  }

  /**
   * Reconciles active deterministic `32 m x 32 m` scenery cells around `(focusX, focusZ)`
   * forward-biased along `(camFwdX, camFwdZ)` within `budgetMs`. Zero hot-loop allocations.
   */
  step(
    trailWindow: TrailWindowView,
    terrainField: TerrainFieldView,
    focusX: number,
    focusZ: number,
    camFwdX = 0,
    camFwdZ = -1,
    budgetMs = DEFAULT_SCENERY_STREAM_BUDGET_MS,
  ): void {
    const startMs = this.nowMs();
    const clampedBudgetMs = Math.max(0.5, budgetMs);

    // Detect worldSeed or simulation reset across runs
    const curr = trailWindow.curr;
    if (
      this.lastWorldSeed !== -1 &&
      (terrainField.worldSeed !== this.lastWorldSeed ||
        curr.id < this.lastCurrSegId ||
        (curr.id === this.lastCurrSegId &&
          (curr.seed !== this.lastCurrSegSeed || curr.stageId !== this.lastCurrStageId)))
    ) {
      this.clearAll();
    }
    this.lastWorldSeed = terrainField.worldSeed;
    this.lastCurrSegId = curr.id;
    this.lastCurrSegSeed = curr.seed;
    this.lastCurrStageId = curr.stageId;

    const fwdLen = Math.hypot(camFwdX, camFwdZ);
    const fx = fwdLen > 1e-4 ? camFwdX / fwdLen : 0;
    const fz = fwdLen > 1e-4 ? camFwdZ / fwdLen : -1;

    const absFocusX = focusX + terrainField.originOffsetX;
    const absFocusZ = focusZ + terrainField.originOffsetZ;
    const biasAbsX = absFocusX + fx * SCENERY_FORWARD_SHIFT_M;
    const biasAbsZ = absFocusZ + fz * SCENERY_FORWARD_SHIFT_M;

    const centerCx = this.stabilizeCell(biasAbsX, 0);
    const centerCz = this.stabilizeCell(biasAbsZ, 1);

    // 1. Collect desired deterministic cell keys
    this.desiredKeysScratch.clear();
    const he = this.halfExtent;
    for (let cz = centerCz - he; cz <= centerCz + he; cz++) {
      for (let cx = centerCx - he; cx <= centerCx + he; cx++) {
        this.desiredKeysScratch.add(packSceneryCellKey(cx, cz));
      }
    }

    // 2. Prune stale cells
    this.staleKeysScratch.length = 0;
    for (const key of this.cells.keys()) {
      if (!this.desiredKeysScratch.has(key)) {
        this.staleKeysScratch.push(key);
      }
    }
    let revisionDirty = false;
    for (let i = 0; i < this.staleKeysScratch.length; i++) {
      const key = this.staleKeysScratch[i]!;
      const rec = this.cells.get(key);
      if (rec) {
        if (rec.populated && rec.itemCount > 0) {
          revisionDirty = true;
        }
        this.releaseRecord(rec);
        this.cells.delete(key);
      }
    }

    // 3. Enqueue missing cells and update priorities (closest to skier first)
    this.pendingJobsScratch.length = 0;
    for (let cz = centerCz - he; cz <= centerCz + he; cz++) {
      for (let cx = centerCx - he; cx <= centerCx + he; cx++) {
        const key = packSceneryCellKey(cx, cz);
        const dx = (cx + 0.5) * SCENERY_CELL_SIZE_M - absFocusX;
        const dz = (cz + 0.5) * SCENERY_CELL_SIZE_M - absFocusZ;
        const distSq = dx * dx + dz * dz;
        const dcx = cx - centerCx;
        const dcz = cz - centerCz;
        const distCellsSq = dcx * dcx + dcz * dcz;

        let rec = this.cells.get(key);
        if (!rec) {
          rec = this.acquireRecord(key, cx, cz);
          this.cells.set(key, rec);
        }
        rec.priority = distSq;
        rec.distCellsSq = distCellsSq;
        if (!rec.populated) {
          this.pendingJobsScratch.push(rec);
        }
      }
    }

    // 4. Populate unbuilt cells nearest-first within budget (always populating >= 1 cell if pending)
    if (this.pendingJobsScratch.length > 0) {
      this.pendingJobsScratch.sort(compareCellPriority);
      for (let i = 0; i < this.pendingJobsScratch.length; i++) {
        if (i > 0 && this.nowMs() - startMs >= clampedBudgetMs) {
          break;
        }
        const rec = this.pendingJobsScratch[i]!;
        this.populateCell(rec, terrainField, trailWindow);
        if (rec.itemCount > 0) {
          revisionDirty = true;
        }
      }
    }

    if (revisionDirty) {
      this._sceneryRevision++;
    }
  }

  /**
   * Translation-only floating-origin rebase handler: shifts cached cell origins with ZERO
   * heightfield re-evaluations and triggers a clean `InstancePools` static billboard repack.
   */
  handleWorldRebased(deltaX: number, deltaY: number, deltaZ: number): void {
    for (const rec of this.cells.values()) {
      if (!rec.populated) continue;
      rec.originX -= deltaX;
      rec.originY -= deltaY;
      rec.originZ -= deltaZ;
    }
    this._sceneryRevision++;
  }

  clearAll(): void {
    this.centerCell[0] = NaN;
    this.centerCell[1] = NaN;
    for (const rec of this.cells.values()) {
      this.releaseRecord(rec);
    }
    this.cells.clear();
    this._sceneryRevision++;
  }

  /**
   * Emits near-field cells first, followed by outer cells so static billboard packing prioritizes
   * foreground scenery if ever approaching `MAX_STATIC_BILLBOARDS`.
   */
  forEachActiveScenery(
    visitor: (
      originX: number,
      originY: number,
      originZ: number,
      item: TileSceneryItem,
    ) => boolean | void,
  ): void {
    const nearSq = NEAR_PRIORITY_RADIUS_CELLS * NEAR_PRIORITY_RADIUS_CELLS;

    for (const rec of this.cells.values()) {
      if (!rec.populated || rec.distCellsSq > nearSq) continue;
      const ox = rec.originX;
      const oy = rec.originY;
      const oz = rec.originZ;
      for (let i = 0; i < rec.itemCount; i++) {
        if (visitor(ox, oy, oz, rec.items[i]!) === false) return;
      }
    }

    for (const rec of this.cells.values()) {
      if (!rec.populated || rec.distCellsSq <= nearSq) continue;
      const ox = rec.originX;
      const oy = rec.originY;
      const oz = rec.originZ;
      for (let i = 0; i < rec.itemCount; i++) {
        if (visitor(ox, oy, oz, rec.items[i]!) === false) return;
      }
    }
  }

  private stabilizeCell(biasAbs: number, axis: 0 | 1): number {
    const raw = biasAbs / SCENERY_CELL_SIZE_M;
    const prev = this.centerCell[axis]!;
    if (Number.isNaN(prev) || Math.abs(raw - (prev + 0.5)) > 0.5 + SCENERY_HYSTERESIS_CELLS) {
      this.centerCell[axis] = Math.floor(raw);
    }
    return this.centerCell[axis]!;
  }

  private populateCell(
    rec: SceneryCellRecord,
    terrainField: TerrainFieldView,
    trailWindow: TrailWindowView,
  ): void {
    const cellSize = SCENERY_CELL_SIZE_M;
    const absOriginX = rec.absCellX * cellSize;
    const absOriginZ = rec.absCellZ * cellSize;
    const originX = absOriginX - terrainField.originOffsetX;
    const originZ = absOriginZ - terrainField.originOffsetZ;

    terrainField.collectSpinesInBounds(
      originX - 2,
      originX + cellSize + 2,
      originZ - 2,
      originZ + cellSize + 2,
      SPINE_BOUNDS_PAD_M,
      this.candidateSpinesScratch,
    );
    const spines = this.candidateSpinesScratch;

    const originY = terrainField.evaluateHeight(originX, originZ, spines);
    rec.originX = originX;
    rec.originY = originY;
    rec.originZ = originZ;
    rec.itemCount = 0;
    rec.populated = true;

    // Probe 5 anchor points (4 corners + center) to find peak biome density across straddling cells
    let maxDensity = 0;
    for (let p = 0; p < 5; p++) {
      const px = p === 4 ? originX + cellSize * 0.5 : originX + (p & 1) * cellSize;
      const pz = p === 4 ? originZ + cellSize * 0.5 : originZ + ((p >> 1) & 1) * cellSize;
      terrainField.evaluateColumn(px, pz, _colScratch, spines);
      const st = getStageDef(_colScratch.nearestStageId) ?? STAGE_SUNNY_BLUE;
      const d = computeStageSceneryDensity(st.layout.scenery);
      if (d > maxDensity) maxDensity = d;
    }

    const targetCount = Math.min(MAX_SCENERY_PER_CELL, Math.round(maxDensity * 22));
    if (targetCount <= 0) {
      return;
    }

    this.groundGridScratch.clear();
    this.canopyGridScratch.clear();
    this.insertActiveLandmarks(
      originX,
      originZ,
      trailWindow,
      originX + cellSize * 0.5,
      originZ + cellSize * 0.5,
      cellSize,
    );

    const cellSeed =
      (hashCoords2DU32(
        rec.absCellX,
        rec.absCellZ,
        (terrainField.worldSeed ^ 0x9e3779b9) >>> 0,
      ) >>>
        0) ||
      1;
    this.rngScratch.setState(cellSeed);

    const noiseSeed = (terrainField.worldSeed ^ 0x51a7) >>> 0;
    const maxAttempts = targetCount * 4;
    let effectiveSlotsUsed = 0;
    let attempts = 0;

    while (
      effectiveSlotsUsed < targetCount &&
      rec.itemCount < MAX_SCENERY_PER_CELL &&
      attempts < maxAttempts
    ) {
      attempts++;
      const localX = this.rngScratch.nextRange(0, cellSize);
      const localZ = this.rngScratch.nextRange(0, cellSize);
      const wx = originX + localX;
      const wz = originZ + localZ;

      terrainField.evaluate(wx, wz, _sampleScratch, spines);
      if (
        _sampleScratch.onPiste ||
        _sampleScratch.pisteWeight > SCENERY_PISTE_WEIGHT_MAX ||
        _sampleScratch.inChasmZone ||
        _sampleScratch.normalY < SCENERY_MIN_NORMAL_Y
      ) {
        continue;
      }

      const localStage = getStageDef(_sampleScratch.nearestStageId) ?? STAGE_SUNNY_BLUE;
      const sceneryCfg = localStage.layout.scenery;
      const groundR = sceneryCfg.groundMinRadius * 0.5;
      const canopyR = sceneryCfg.canopyMinRadius * 0.5;

      if (this.groundGridScratch.hasOverlap(localX, localZ, groundR)) {
        continue;
      }

      const canopyBlocked = this.canopyGridScratch.hasOverlap(localX, localZ, canopyR);
      const absWx = absOriginX + localX;
      const absWz = absOriginZ + localZ;
      const noise01 = clamp(
        fbm2D(absWx * 0.028, absWz * 0.028, noiseSeed, 2, 2.0, 0.5) * 0.5 + 0.5,
        0,
        1,
      );

      this.envSignalScratch.minNormalY = _sampleScratch.normalY;
      this.envSignalScratch.distFromTrail = Math.max(
        0,
        Math.abs(_sampleScratch.nearestSignedX) - _sampleScratch.nearestHalfWidth,
      );
      this.envSignalScratch.relElevation = _sampleScratch.heightY - _sampleScratch.macroY;
      this.envSignalScratch.worldNoise01 = noise01;
      this.envSignalScratch.lod = 0;
      this.envSignalScratch.scenery = sceneryCfg;

      const rules = sceneryCfg.tierRules ?? DEFAULT_SCENERY_TIER_RULES;
      const winner = selectWinningSceneryRule(
        rules,
        this.envSignalScratch,
        canopyBlocked,
        this.rngScratch.next(),
      );
      if (!winner) {
        continue;
      }

      // Count slot before spatial thinning so sparse biome halves stay proportional
      effectiveSlotsUsed++;
      const localDensity = computeStageSceneryDensity(sceneryCfg);
      if (
        maxDensity > 1e-6 &&
        localDensity < maxDensity &&
        !this.rngScratch.nextBool(localDensity / maxDensity)
      ) {
        continue;
      }

      const entryId = 1000 + rec.itemCount;
      this.groundGridScratch.insert(entryId, localX, localZ, groundR);
      if (winner.layer === 'canopy') {
        this.canopyGridScratch.insert(entryId, localX, localZ, canopyR);
      }

      const scaleT = this.rngScratch.next();
      const width = lerp(winner.widthRange[0], winner.widthRange[1], scaleT);
      const height = lerp(winner.heightRange[0], winner.heightRange[1], scaleT);
      const sinkY = computeScenerySlopeSinkY(winner.species, _sampleScratch.normalY, width);

      const item = rec.items[rec.itemCount++]!;
      item.localX = localX;
      item.localY = _sampleScratch.heightY - originY - sinkY;
      item.localZ = localZ;
      item.width = width;
      item.height = height;
      item.frame = speciesToBillboardFrame(winner.species);
      item.flipX = this.rngScratch.nextBool(0.5);
    }
  }

  private insertActiveLandmarks(
    originX: number,
    originZ: number,
    trailWindow: TrailWindowView,
    centerX: number,
    centerZ: number,
    cellSize: number,
  ): void {
    this.activeSegmentsScratch.length = 0;
    if (trailWindow.prev) this.activeSegmentsScratch.push(trailWindow.prev);
    this.activeSegmentsScratch.push(trailWindow.curr);
    if (trailWindow.nextLeft) this.activeSegmentsScratch.push(trailWindow.nextLeft);
    if (trailWindow.nextRight) this.activeSegmentsScratch.push(trailWindow.nextRight);

    const maxReach = cellSize * 0.75 + 16;
    for (let sIdx = 0; sIdx < this.activeSegmentsScratch.length; sIdx++) {
      const seg = this.activeSegmentsScratch[sIdx]!;
      const landmarks = seg.landmarks;
      for (let i = 0; i < landmarks.length; i++) {
        const lm = landmarks[i]!;
        const clearR = Math.max(2.5, lm.clearanceRadius);
        const dx = lm.worldX - centerX;
        const dz = lm.worldZ - centerZ;
        if (Math.abs(dx) > maxReach + clearR || Math.abs(dz) > maxReach + clearR) {
          continue;
        }
        this.groundGridScratch.insert(i, lm.worldX - originX, lm.worldZ - originZ, clearR);
      }
    }
  }

  private createEmptyRecord(): SceneryCellRecord {
    const items: TileSceneryItem[] = [];
    for (let i = 0; i < MAX_SCENERY_PER_CELL; i++) {
      items.push({
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
      absCellX: 0,
      absCellZ: 0,
      originX: 0,
      originY: 0,
      originZ: 0,
      items,
      itemCount: 0,
      populated: false,
      priority: 0,
      distCellsSq: 0,
    };
  }

  private acquireRecord(key: number, absCellX: number, absCellZ: number): SceneryCellRecord {
    const rec = this.recordPool.pop() ?? this.createEmptyRecord();
    rec.key = key;
    rec.absCellX = absCellX;
    rec.absCellZ = absCellZ;
    rec.originX = 0;
    rec.originY = 0;
    rec.originZ = 0;
    rec.itemCount = 0;
    rec.populated = false;
    rec.priority = 0;
    rec.distCellsSq = 0;
    return rec;
  }

  private releaseRecord(rec: SceneryCellRecord): void {
    rec.key = -1;
    rec.absCellX = 0;
    rec.absCellZ = 0;
    rec.itemCount = 0;
    rec.populated = false;
    rec.priority = 0;
    rec.distCellsSq = 0;
    this.recordPool.push(rec);
  }
}
