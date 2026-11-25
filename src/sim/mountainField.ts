import { clamp, lerp, smoothstep, smootherstep } from '../core/math';
import { fbm2D, smoothRidgedNoise2D } from '../core/noise';
import { getAllStages, getStageDef, STAGE_SUNNY_BLUE } from '../content/stages';
import type {
  LandscapeProfile,
  PisteSurfaceType,
  SideLandscapeSpec,
} from '../content/types';
import {
  createMountainColumnOut,
  createMountainSampleOut,
  createPisteHeightOut,
  createSpineFrameOut,
  createSpineProjectionOut,
  TERRAIN_FLAG_IN_CHASM,
  TERRAIN_FLAG_IN_DIVIDER,
  TERRAIN_FLAG_ON_PISTE,
  type MountainColumnOut,
  type MountainSampleOut,
  type MountainSpineSource,
  type PisteHeightOut,
  type SpineCorridorSideView,
  type SpineFrameOut,
  type SpineProjectionOut,
  type SpineView,
  type TerrainDirtyRect,
  type TerrainFieldView,
  type TerrainGridSampleOut,
  type WorldDirtyRect,
} from './contracts';
import { MACRO_LEAF_EXTENSION_M, MACRO_NODE_STEP_M } from './trailSpine';

const PISTE_LONG_HANDOFF_M = 14;
const PISTE_AABB_PAD_M = 64;
const PISTE_GRID_AABB_PAD_M = 28;
const PISTE_BARRIER_EPS = 1e-6;

const MACRO_R0_SQ = 8.5 * 8.5;
const MACRO_LOCAL_R0_SQ = 36 * 36;
const MACRO_DOWN_EXT_R0_SQ = 48 * 48;
const MACRO_EDGE_SMOOTH_SQ = 4;
const MACRO_WIN_IN_M = 120;
const MACRO_WIN_OUT_M = 240;
const MACRO_WIN_OUT_SQ = MACRO_WIN_OUT_M * MACRO_WIN_OUT_M;
const MACRO_FAR_BLEND_START_M = 130;
const MACRO_FAR_BLEND_START_SQ = MACRO_FAR_BLEND_START_M * MACRO_FAR_BLEND_START_M;
const MACRO_FAR_BLEND_END_M = 190;
const MACRO_FAR_R0_SQ = 72 * 72;
const MACRO_FAR_WIN_IN_OFFSET_M = 60;
const MACRO_FAR_WIN_OUT_OFFSET_M = 200;
const CLEARANCE_AABB_PAD_M = 96;

const OUTER_RIM_START_M = 110;
const OUTER_RIM_END_M = 200;
const OUTER_RIM_SATURATE_DIST_M = OUTER_RIM_END_M + 32;
const GRID_SKIP_PROJ_EDGE_DIST_M = 36;
const ALPINE_UNDULATION_AMP_M = 3.2;
const ALPINE_UNDULATION_FREQ = 0.0085;
const CORRIDOR_SMAX_EPS_SQ = 0.02;

const NORMAL_SAMPLE_EPS_M = 0.5;
const ROCK_SLOPE_NORMAL_Y_THRESHOLD = 0.72;
const MAX_ACCUMULATED_DIRTY_RECTS = 32;

interface SpineClearanceEntry {
  readonly spine: SpineView;
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly downExt: Float32Array | null;
  downExtActive: boolean;
}

/**
 * Model 3 Continuous Terrain Heightfield (`TerrainFieldView` & `MountainFieldView`):
 * - Inverse-barrier partition-of-unity piste blending inside injective piste support (Jacobian >= 0.60)
 * - Compact-support inverse-distance macro sheet over coarse 16m spine nodes + open-leaf extensions
 * - Subtle zero-mean C^2 off-piste alpine undulation faded to 0 on piste
 * - Medial-safe curvature-clamped 2D side corridor kernels with dynamic cross-spine clearance masking,
 *   normalized opposing-relief blending (|A|/R <= 0.82), and flat-topped outer valley rim (0 inside 110m)
 * - Vectorized rebase-invariant `sampleColumnGrid` + monotonic `fieldRevision` & `dirtyRects`
 * Zero Three.js/DOM dependencies and zero hot-loop heap allocations.
 */
export class MountainField implements TerrainFieldView {
  worldSeed = 1;
  originOffsetX = 0;
  originOffsetY = 0;
  originOffsetZ = 0;

  private _fieldRevision = 1;
  private readonly _dirtyRects: TerrainDirtyRect[] = [];
  private readonly _stageIdTable: string[] = [];
  private readonly stageIdToIndex = new Map<string, number>();

  private readonly spineSource: MountainSpineSource;
  private readonly clearScaleCache = new Map<number, SpineClearanceEntry>();
  private readonly activeIdsScratch = new Set<number>();
  private readonly addedIdsScratch = new Set<number>();
  private readonly addedSpinesScratch: SpineView[] = [];
  private readonly removedSpinesScratch: SpineView[] = [];
  private clearSyncedSpineCount = -1;
  private clearSyncedFirstId = -1;
  private clearSyncedLastId = -1;
  private topologySyncedRevision = -1;

  // Pre-allocated scratch buffers (zero hot-loop heap allocations)
  private readonly projScratch: SpineProjectionOut = createSpineProjectionOut();
  private readonly nearestProjScratch: SpineProjectionOut = createSpineProjectionOut();
  private readonly altProjScratch: SpineProjectionOut = createSpineProjectionOut();
  private readonly pisteScratch: PisteHeightOut = createPisteHeightOut();
  private readonly frameScratch: SpineFrameOut = createSpineFrameOut();
  private readonly heightColumnScratch: MountainColumnOut = createMountainColumnOut();
  private readonly gridSampleScratch: MountainSampleOut = createMountainSampleOut();
  private readonly stageIdsScratch: string[] = [];
  private readonly stageWeightsScratch: number[] = [];
  private readonly evalSpinesScratch: SpineView[] = [];
  private readonly gridSpinesScratch: SpineView[] = [];
  private readonly singleSpineScratch: SpineView[] = [];
  private readonly stripPisteSpinesScratch: SpineView[] = [];
  private readonly stripNearSpinesScratch: SpineView[] = [];
  private readonly stripNearSpineIdxScratch: number[] = [];
  private readonly stripNearDownClearScratch: (Float32Array | null)[] = [];
  private readonly stripCorridorSpinesScratch: SpineView[] = [];
  private readonly stripCorridorClearScratch: (SpineClearanceEntry | undefined)[] = [];
  private readonly stripCorridorLandscapeScratch: LandscapeProfile[] = [];
  private readonly gridStageWeightsScratch = new Float64Array(256);
  private readonly gridStageTouchedScratch = new Int32Array(256);

  // Persistent flat macro-node cache (rebuilt only on topology revision / rebase; zero per-strip allocs)
  private macroCacheRevision = -1;
  private macroCacheOriginX = NaN;
  private macroCacheOriginY = NaN;
  private macroCacheOriginZ = NaN;
  private macroCacheSpineCount = -1;
  private macroCacheFirstId = -1;
  private macroCacheLastId = -1;
  private macroCacheValid = false;
  private macroCacheAllCount = 0;
  private macroNodeCap = 0;
  private macroNodeX = new Float64Array(0);
  private macroNodeY = new Float64Array(0);
  private macroNodeZ = new Float64Array(0);
  private macroNodeHw = new Float32Array(0);
  private macroNodeScale = new Float32Array(0);
  private macroNodeFwdX = new Float32Array(0);
  private macroNodeFwdZ = new Float32Array(0);
  private macroSpineStart = new Int32Array(0);
  private macroSpineEnd = new Int32Array(0);
  private macroSpineStageIdx = new Uint8Array(0);
  private macroSpineMinX = new Float64Array(0);
  private macroSpineMaxX = new Float64Array(0);
  private macroSpineMinZ = new Float64Array(0);
  private macroSpineMaxZ = new Float64Array(0);
  private readonly farDownClearScratch: (Float32Array | null)[] = [];
  private farHintSpineIdx = 0;
  private interiorSinglePisteSpine: SpineView | null = null;

  // Scratch result structs for split TurboFan-friendly grid evaluation helpers (zero allocs)
  private readonly gridPass1Out = {
    isFullPiste: false,
    hasPiste: false,
    finalPisteH: 0,
    totalPisteW: 0,
    oneMinusReliefPisteW: 1,
    dominantPisteSpine: null as SpineView | null,
    dominantPisteS: 0,
    dominantPisteSignedX: 0,
    dominantPisteInDivider: false,
    dominantPisteDividerMask: 0,
    pisteNearCount: 0,
    bestProjSpine: null as SpineView | null,
    bestProjDistSq: Infinity,
  };
  private readonly gridMacroOut = {
    macroY: 0,
    sumW: 0,
    downhillAccX: 0,
    downhillAccZ: 0,
    minNodeDistSq: Infinity,
    minEdgeDist: Infinity,
    closestSpineIdx: -1,
    closestSpineDistSq: Infinity,
    secondClosestSpineIdx: -1,
    secondClosestDistSq: Infinity,
    touchedStages: 0,
  };
  private readonly gridReliefOut = {
    offPisteRelief: 0,
    chasmD: 0,
    chasmRelief: 0,
    maxChasmWipeoutDepth: 0,
  };
  // Scratch buffers for vectorized 1D strip fast path (256-wide row/col clipmap strips, zero heap allocs)
  private readonly stripIsFullPiste = new Uint8Array(256);
  private readonly stripHasPiste = new Uint8Array(256);
  private readonly stripFinalPisteH = new Float64Array(256);
  private readonly stripTotalPisteW = new Float64Array(256);
  private readonly stripOneMinusRelief = new Float64Array(256);
  private readonly stripDomSpine: (SpineView | null)[] = new Array(256).fill(null);
  private readonly stripDomS = new Float64Array(256);
  private readonly stripDomSignedX = new Float64Array(256);
  private readonly stripDomHalfW = new Float32Array(256);
  private readonly stripDomSpineY = new Float64Array(256);
  private readonly stripDomFwdX = new Float32Array(256);
  private readonly stripDomFwdZ = new Float32Array(256);
  private readonly stripDomInDiv = new Uint8Array(256);
  private readonly stripDomDivMask = new Float32Array(256);
  private readonly stripBestProjSpine: (SpineView | null)[] = new Array(256).fill(null);
  private readonly stripBestProjDistSq = new Float64Array(256);
  private readonly stripBestProjSignedX = new Float64Array(256);
  private readonly stripBestProjHalfW = new Float32Array(256);
  private readonly stripBestProjFwdX = new Float32Array(256);
  private readonly stripBestProjFwdZ = new Float32Array(256);
  private readonly stripHasPisteCand = new Uint8Array(256);

  // Vectorized Pass 2B (corridor kernel) strip accumulators
  private readonly stripPosD = new Float64Array(256);
  private readonly stripPosW = new Float64Array(256);
  private readonly stripNegD = new Float64Array(256);
  private readonly stripNegW = new Float64Array(256);
  private readonly stripChasmD = new Float64Array(256);
  private readonly stripChasmW = new Float64Array(256);
  private readonly stripMaxChasmDepth = new Float32Array(256);
  private readonly stripSideD = new Float64Array(256);
  private readonly stripSideAmp = new Float64Array(256);
  private readonly stripRimD = new Float64Array(256);
  private readonly stripRimAmp = new Float64Array(256);
  private readonly stripAlpineNoise = new Float32Array(256);
  private readonly stripOuterRimNoise = new Float32Array(256);
  private readonly stripSideModKnot = new Float32Array(256);
  private readonly stripRimModKnot = new Float32Array(256);

  // Vectorized Macro knot outputs along 1D strip
  private readonly stripKnotMacroY = new Float64Array(256);
  private readonly stripKnotMinEdge = new Float64Array(256);
  private readonly stripKnotDhX = new Float64Array(256);
  private readonly stripKnotDhZ = new Float64Array(256);
  private readonly stripKnotSumW = new Float64Array(256);
  private readonly stripKnotClosestIdx = new Int32Array(256);
  private readonly stripKnotSecondIdx = new Int32Array(256);
  private readonly stripKnotSecondDistSq = new Float64Array(256);
  private readonly stripKnotSecStageIdx = new Int32Array(256);
  private readonly stripKnotSecStageW = new Float32Array(256);
  private readonly stripKnotValid = new Uint8Array(256);

  // Per-strip constant-axis pre-filtered near macro node arrays (eliminates out-of-band nodes once per strip!)
  private stripNearNodeCap = 0;
  private stripNearNodeVar = new Float64Array(0);
  private stripNearNodeY = new Float64Array(0);
  private stripNearNodeConstSq = new Float64Array(0);
  private stripNearNodeHw = new Float32Array(0);
  private stripNearNodeScale = new Float32Array(0);
  private stripNearNodeFwdX = new Float32Array(0);
  private stripNearNodeFwdZ = new Float32Array(0);
  private stripNearNodeIsDown = new Uint8Array(0);
  private stripNearSpStart = new Int32Array(64);
  private stripNearSpEnd = new Int32Array(64);
  private stripNearSpGlobalIdx = new Int32Array(64);
  private stripNearSpMinVar = new Float64Array(64);
  private stripNearSpMaxVar = new Float64Array(64);
  private stripNearSpCount = 0;
  // Accumulators for sphere-traced Pass 1 across a 1D strip (zero heap allocs)
  private readonly stripFullCount = new Uint8Array(256);
  private readonly stripFullHSum = new Float64Array(256);
  private readonly stripBarrierWSum = new Float64Array(256);
  private readonly stripBarrierHSum = new Float64Array(256);
  private readonly stripOneMinusTotalW = new Float64Array(256);
  private readonly stripMaxPisteW = new Float64Array(256);
  private readonly stripDomAbsX = new Float64Array(256);
  private readonly pass1BestProjScratch: SpineProjectionOut = createSpineProjectionOut();

  constructor(spineSource: MountainSpineSource) {
    this.spineSource = spineSource;
    const stages = getAllStages();
    for (let i = 0; i < stages.length; i++) {
      this.internStageId(stages[i]!.id);
    }
    this.spineSource.addTopologyListener?.((isReset, worldDirtyRects) => {
      this.handleTopologyChange(isReset, worldDirtyRects);
    });
    this.syncClearanceIfNeeded(this.spineSource.elevationSpines);
  }

  get fieldRevision(): number {
    return this._fieldRevision;
  }

  get dirtyRects(): readonly TerrainDirtyRect[] {
    return this._dirtyRects;
  }

  get stageIdTable(): readonly string[] {
    return this._stageIdTable;
  }

  ackDirtyRects(): void {
    this._dirtyRects.length = 0;
  }

  setWorldSeed(seed: number): void {
    this.worldSeed = seed >>> 0;
  }

  setOriginOffset(ox: number, oz: number, oy?: number): void {
    this.originOffsetX = ox;
    if (oy !== undefined) {
      this.originOffsetY = oy;
    }
    this.originOffsetZ = oz;
  }

  collectSpinesInBounds(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    padM: number,
    outSpines: SpineView[],
  ): void {
    this.spineSource.collectSpinesInBounds(minX, maxX, minZ, maxZ, padM, outSpines);
  }

  evaluateHeight(wx: number, wz: number, candidateSpines?: readonly SpineView[]): number {
    return this.evaluateColumnCore(wx, wz, this.heightColumnScratch, candidateSpines, false, true).heightY;
  }

  evaluateColumn(
    wx: number,
    wz: number,
    out: MountainColumnOut,
    candidateSpines?: readonly SpineView[],
  ): MountainColumnOut {
    return this.evaluateColumnCore(wx, wz, out, candidateSpines, true, false);
  }

  evaluateSample(
    wx: number,
    wz: number,
    out: MountainSampleOut,
    candidateSpines?: readonly SpineView[],
  ): MountainSampleOut {
    return this.evaluate(wx, wz, out, candidateSpines);
  }

  evaluate(
    wx: number,
    wz: number,
    out: MountainSampleOut,
    candidateSpines?: readonly SpineView[],
  ): MountainSampleOut {
    this.evaluateColumnCore(wx, wz, out, candidateSpines, true, true);
    this.populateNormalAndSurface(wx, wz, out, candidateSpines);
    return out;
  }

  /**
   * Vectorized rebase-invariant grid evaluator for GPU textures, Jolt SetHeights, and CDLOD strips.
   * Accepts integer-snapped absolute (originAbsX, originAbsZ) and explicit float64 blockOriginY.
   * Optional `skipNormals` omits finite-difference normal taps when callers derive normals directly
   * from their own toroidal height mirror (preserving full `TerrainFieldView` API compatibility).
   */
  sampleColumnGrid(
    originAbsX: number,
    originAbsZ: number,
    cols: number,
    rows: number,
    stepM: number,
    blockOriginY: number,
    out: TerrainGridSampleOut,
    skipNormals = false,
  ): void {
    if (cols <= 0 || rows <= 0) return;

    const baseWx = originAbsX - this.originOffsetX;
    const baseWz = originAbsZ - this.originOffsetZ;
    const maxWx = baseWx + (cols - 1) * stepM;
    const maxWz = baseWz + (rows - 1) * stepM;

    const allSpines = this.spineSource.elevationSpines;
    this.syncClearanceIfNeeded(allSpines);

    // Pre-filter candidate spines ONCE per strip with tight AABB bounds & cached clearance/landscape lookups.
    const epsPad = skipNormals ? 0 : NORMAL_SAMPLE_EPS_M;
    const qMinX = baseWx - epsPad;
    const qMaxX = maxWx + epsPad;
    const qMinZ = baseWz - epsPad;
    const qMaxZ = maxWz + epsPad;

    this.prepareStripSpineCaches(allSpines, qMinX, qMaxX, qMinZ, qMaxZ);

    // Vectorized 1D clipmap strip fast path (256x1 or 1x256 with skipNormals=true):
    // - Loop-inverted Pass 1 (piste AABB range-clamped) & Pass 2B (corridor kernel disc-clamped, 100% exact!)
    // - Constant-axis pre-filtered Pass 2A + strided off-piste macro sheet (exact on-piste, <3mm off-piste on L0/L1!)
    if (
      skipNormals &&
      this.macroCacheValid &&
      ((rows === 1 && cols > 1 && cols <= 256) || (cols === 1 && rows > 1 && rows <= 256))
    ) {
      this.sampleStrip1DFast(
        baseWx,
        baseWz,
        rows === 1 ? cols : rows,
        rows === 1,
        stepM,
        blockOriginY,
        allSpines,
        out,
      );
      return;
    }

    const colOut = this.gridSampleScratch;
    const oy = this.originOffsetY;
    const needPerPointTap =
      !skipNormals &&
      !(cols > 1 && rows > 1 && stepM <= 4.0);
    const reuseXForNormal = !skipNormals && cols > 1 && stepM <= 2.0;
    const reuseZForNormal = !skipNormals && rows > 1 && stepM <= 2.0;

    for (let r = 0; r < rows; r++) {
      const wz = baseWz + r * stepM;
      const rowOff = r * cols;
      for (let c = 0; c < cols; c++) {
        const wx = baseWx + c * stepM;
        const idx = rowOff + c;

        // Fast grid column evaluation: skipMacroOnFullPiste=true (matching evaluate()),
        // strip-filtered spines, zero Map.get() lookups, and accelerated exact far-field.
        this.evaluateGridColumnCore(wx, wz, colOut, allSpines, true);

        const relH = colOut.heightY + oy - blockOriginY;
        out.heights[idx] = relH;
        out.macroY[idx] = colOut.macroY + oy - blockOriginY;

        if (skipNormals) {
          const idx3 = idx * 3;
          out.normals[idx3] = 0;
          out.normals[idx3 + 1] = 1;
          out.normals[idx3 + 2] = 0;
        } else if (needPerPointTap && !reuseXForNormal && !reuseZForNormal) {
          // Fast 2-tap forward-diff normal (stepM > 2m on 1D strips, or stepM > 4m coarse 17x17 grids)
          this.populateFastForwardNormal(wx, wz, colOut.heightY, allSpines, out.normals, idx * 3);
        }

        const pw = clamp(colOut.pisteWeight, 0, 1);
        out.pisteWeight[idx] = pw;
        if (pw > 0) {
          if (colOut.pisteSurfaceType === 'ice') {
            out.iceWeight[idx] = pw;
            out.powderWeight[idx] = 1 - pw;
          } else if (colOut.pisteSurfaceType === 'powder') {
            out.iceWeight[idx] = 0;
            out.powderWeight[idx] = 1;
          } else {
            out.iceWeight[idx] = 0;
            out.powderWeight[idx] = 1 - pw;
          }
        } else {
          out.iceWeight[idx] = 0;
          out.powderWeight[idx] = 1;
        }
        out.dividerMask[idx] = clamp(colOut.dividerMask * pw, 0, 1);

        const idx2 = idx * 2;
        const flowLen = Math.hypot(colOut.downhillX, colOut.downhillZ);
        if (flowLen > 1e-6) {
          out.flowXZ[idx2] = colOut.downhillX / flowLen;
          out.flowXZ[idx2 + 1] = colOut.downhillZ / flowLen;
        } else {
          out.flowXZ[idx2] = 0;
          out.flowXZ[idx2 + 1] = -1;
        }

        out.offPisteDist[idx] = Math.max(0, Math.abs(colOut.nearestSignedX) - colOut.nearestHalfWidth);

        const primIdx = this.internStageId(colOut.nearestStageId);
        const secIdx =
          colOut.secondaryStageId !== null
            ? this.internStageId(colOut.secondaryStageId)
            : primIdx;
        out.primaryStageIdx[idx] = primIdx;
        out.secondaryStageIdx[idx] = secIdx;
        out.secondaryStageWeightU8[idx] = Math.round(clamp(colOut.secondaryStageWeight, 0, 1) * 255);

        let flags = 0;
        if (colOut.onPiste) flags |= TERRAIN_FLAG_ON_PISTE;
        if (colOut.inDivider) flags |= TERRAIN_FLAG_IN_DIVIDER;
        if (colOut.inChasmZone) flags |= TERRAIN_FLAG_IN_CHASM;
        out.flags[idx] = flags;
      }
    }

    if (skipNormals) return;

    // Zero-extra-eval grid finite-difference normals for 2D grids (stepM <= 4.0m)
    if (cols > 1 && rows > 1 && stepM <= 4.0) {
      const heights = out.heights;
      const normals = out.normals;
      const invStep = 1 / stepM;
      const inv2Step = 0.5 * invStep;
      for (let r = 0; r < rows; r++) {
        const rD = r > 0 ? r - 1 : 0;
        const rU = r < rows - 1 ? r + 1 : rows - 1;
        const invSpanZ = rD !== r && rU !== r ? inv2Step : invStep;
        const rowOff = r * cols;
        const rowDOff = rD * cols;
        const rowUOff = rU * cols;
        for (let c = 0; c < cols; c++) {
          const cL = c > 0 ? c - 1 : 0;
          const cR = c < cols - 1 ? c + 1 : cols - 1;
          const invSpanX = cL !== c && cR !== c ? inv2Step : invStep;
          const dHx = (heights[rowOff + cR]! - heights[rowOff + cL]!) * invSpanX;
          const dHz = (heights[rowUOff + c]! - heights[rowDOff + c]!) * invSpanZ;
          const invLen = 1 / Math.hypot(-dHx, 1, -dHz);
          const idx3 = (rowOff + c) * 3;
          normals[idx3] = -dHx * invLen;
          normals[idx3 + 1] = invLen;
          normals[idx3 + 2] = -dHz * invLen;
        }
      }
      return;
    }

    // 1-tap perpendicular forward-diff normals for 1D fine strips (reusing strip-axis heights!)
    if (reuseXForNormal && rows === 1) {
      const heights = out.heights;
      const normals = out.normals;
      const invStep = 1 / stepM;
      const inv2Step = 0.5 * invStep;
      const invEps = 1 / NORMAL_SAMPLE_EPS_M;
      const wz = baseWz;
      for (let c = 0; c < cols; c++) {
        const cL = c > 0 ? c - 1 : 0;
        const cR = c < cols - 1 ? c + 1 : cols - 1;
        const invSpanX = cL !== c && cR !== c ? inv2Step : invStep;
        const dHx = (heights[cR]! - heights[cL]!) * invSpanX;
        const h0 = heights[c]! + blockOriginY - oy;
        const hU = this.evaluateGridColumnCore(
          baseWx + c * stepM,
          wz + NORMAL_SAMPLE_EPS_M,
          this.heightColumnScratch,
          allSpines,
          false,
        ).heightY;
        const dHz = (hU - h0) * invEps;
        const invLen = 1 / Math.hypot(-dHx, 1, -dHz);
        const idx3 = c * 3;
        normals[idx3] = -dHx * invLen;
        normals[idx3 + 1] = invLen;
        normals[idx3 + 2] = -dHz * invLen;
      }
    } else if (reuseZForNormal && cols === 1) {
      const heights = out.heights;
      const normals = out.normals;
      const invStep = 1 / stepM;
      const inv2Step = 0.5 * invStep;
      const invEps = 1 / NORMAL_SAMPLE_EPS_M;
      const wx = baseWx;
      for (let r = 0; r < rows; r++) {
        const rD = r > 0 ? r - 1 : 0;
        const rU = r < rows - 1 ? r + 1 : rows - 1;
        const invSpanZ = rD !== r && rU !== r ? inv2Step : invStep;
        const dHz = (heights[rU]! - heights[rD]!) * invSpanZ;
        const h0 = heights[r]! + blockOriginY - oy;
        const hR = this.evaluateGridColumnCore(
          wx + NORMAL_SAMPLE_EPS_M,
          baseWz + r * stepM,
          this.heightColumnScratch,
          allSpines,
          false,
        ).heightY;
        const dHx = (hR - h0) * invEps;
        const invLen = 1 / Math.hypot(-dHx, 1, -dHz);
        const idx3 = r * 3;
        normals[idx3] = -dHx * invLen;
        normals[idx3 + 1] = invLen;
        normals[idx3 + 2] = -dHz * invLen;
      }
    }
  }

  private populateFastForwardNormal(
    wx: number,
    wz: number,
    h0: number,
    allSpines: readonly SpineView[],
    outNormals: Float32Array,
    idx3: number,
  ): void {
    let hR: number;
    let hU: number;
    const singleSp = this.interiorSinglePisteSpine;
    if (singleSp !== null) {
      const p = this.projScratch;
      const ph = this.pisteScratch;
      singleSp.projectXZ(wx + NORMAL_SAMPLE_EPS_M, wz, p);
      singleSp.evaluatePisteHeight(p.s, p.signedX, ph);
      hR = ph.heightY;
      singleSp.projectXZ(wx, wz + NORMAL_SAMPLE_EPS_M, p);
      singleSp.evaluatePisteHeight(p.s, p.signedX, ph);
      hU = ph.heightY;
    } else {
      hR = this.evaluateGridColumnCore(
        wx + NORMAL_SAMPLE_EPS_M,
        wz,
        this.heightColumnScratch,
        allSpines,
        false,
      ).heightY;
      hU = this.evaluateGridColumnCore(
        wx,
        wz + NORMAL_SAMPLE_EPS_M,
        this.heightColumnScratch,
        allSpines,
        false,
      ).heightY;
    }
    const invEps = 1 / NORMAL_SAMPLE_EPS_M;
    const dHx = (hR - h0) * invEps;
    const dHz = (hU - h0) * invEps;
    const invLen = 1 / Math.hypot(-dHx, 1, -dHz);
    outNormals[idx3] = -dHx * invLen;
    outNormals[idx3 + 1] = invLen;
    outNormals[idx3 + 2] = -dHz * invLen;
  }

  private ensureMacroCache(allSpines: readonly SpineView[]): void {
    const n = allSpines.length;
    const firstId = n > 0 ? allSpines[0]!.id : -1;
    const lastId = n > 0 ? allSpines[n - 1]!.id : -1;
    if (
      this.macroCacheRevision === this._fieldRevision &&
      this.macroCacheOriginX === this.originOffsetX &&
      this.macroCacheOriginY === this.originOffsetY &&
      this.macroCacheOriginZ === this.originOffsetZ &&
      this.macroCacheSpineCount === n &&
      this.macroCacheFirstId === firstId &&
      this.macroCacheLastId === lastId
    ) {
      return;
    }

    this.macroCacheRevision = this._fieldRevision;
    this.macroCacheOriginX = this.originOffsetX;
    this.macroCacheOriginY = this.originOffsetY;
    this.macroCacheOriginZ = this.originOffsetZ;
    this.macroCacheSpineCount = n;
    this.macroCacheFirstId = firstId;
    this.macroCacheLastId = lastId;
    this.macroCacheAllCount = n;

    if (n === 0) {
      this.macroCacheValid = false;
      return;
    }

    // Count total active macro nodes across all spines and verify all spines have macroNodes
    let totalNodes = 0;
    for (let i = 0; i < n; i++) {
      const sp = allSpines[i]!;
      const mn = sp.macroNodes;
      if (mn === undefined) {
        this.macroCacheValid = false;
        return;
      }
      totalNodes += mn.count;
      if (mn.useUpstreamExt) totalNodes += mn.upExtCount;
      if (mn.useDownstreamExt) totalNodes += mn.downExtCount;
    }

    if (this.macroSpineStart.length < n) {
      const cap = Math.max(64, n * 2);
      this.macroSpineStart = new Int32Array(cap);
      this.macroSpineEnd = new Int32Array(cap);
      this.macroSpineStageIdx = new Uint8Array(cap);
      this.macroSpineMinX = new Float64Array(cap);
      this.macroSpineMaxX = new Float64Array(cap);
      this.macroSpineMinZ = new Float64Array(cap);
      this.macroSpineMaxZ = new Float64Array(cap);
    }
    if (this.macroNodeCap < totalNodes) {
      const cap = Math.max(2048, totalNodes * 2);
      this.macroNodeCap = cap;
      this.macroNodeX = new Float64Array(cap);
      this.macroNodeY = new Float64Array(cap);
      this.macroNodeZ = new Float64Array(cap);
      this.macroNodeHw = new Float32Array(cap);
      this.macroNodeScale = new Float32Array(cap);
      this.macroNodeFwdX = new Float32Array(cap);
      this.macroNodeFwdZ = new Float32Array(cap);
    }

    const nX = this.macroNodeX;
    const nY = this.macroNodeY;
    const nZ = this.macroNodeZ;
    const nHw = this.macroNodeHw;
    const nSc = this.macroNodeScale;
    const nFx = this.macroNodeFwdX;
    const nFz = this.macroNodeFwdZ;
    const sStart = this.macroSpineStart;
    const sEnd = this.macroSpineEnd;
    const sStage = this.macroSpineStageIdx;
    const sMinXArr = this.macroSpineMinX;
    const sMaxXArr = this.macroSpineMaxX;
    const sMinZArr = this.macroSpineMinZ;
    const sMaxZArr = this.macroSpineMaxZ;
    const farClear = this.farDownClearScratch;
    farClear.length = n;

    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const sp = allSpines[i]!;
      const mn = sp.macroNodes!;
      const clearEntry = this.clearScaleCache.get(sp.id);
      const downExtClear = clearEntry?.downExt ?? null;
      farClear[i] = downExtClear;
      sStage[i] = this.internStageId(sp.stageId);
      sStart[i] = ptr;

      let sMinX = sp.boundsMinX;
      let sMaxX = sp.boundsMaxX;
      let sMinZ = sp.boundsMinZ;
      let sMaxZ = sp.boundsMaxZ;

      // Interior nodes
      const cnt = mn.count;
      for (let j = 0; j < cnt; j++) {
        nX[ptr] = mn.posX[j]!;
        nY[ptr] = mn.posY[j]!;
        nZ[ptr] = mn.posZ[j]!;
        nHw[ptr] = mn.halfWidth[j]!;
        nSc[ptr] = 1;
        nFx[ptr] = mn.fwdX[j]!;
        nFz[ptr] = mn.fwdZ[j]!;
        ptr++;
      }

      // Upstream extension nodes
      if (mn.useUpstreamExt) {
        if (mn.upBoundsMinX <= mn.upBoundsMaxX) {
          if (mn.upBoundsMinX < sMinX) sMinX = mn.upBoundsMinX;
          if (mn.upBoundsMaxX > sMaxX) sMaxX = mn.upBoundsMaxX;
          if (mn.upBoundsMinZ < sMinZ) sMinZ = mn.upBoundsMinZ;
          if (mn.upBoundsMaxZ > sMaxZ) sMaxZ = mn.upBoundsMaxZ;
        }
        const uCnt = mn.upExtCount;
        const uHw = mn.upExtHalfWidth;
        const uFx = mn.upExtFwdX;
        const uFz = mn.upExtFwdZ;
        for (let j = 0; j < uCnt; j++) {
          nX[ptr] = mn.upExtX[j]!;
          nY[ptr] = mn.upExtY[j]!;
          nZ[ptr] = mn.upExtZ[j]!;
          nHw[ptr] = uHw;
          nSc[ptr] = 1;
          nFx[ptr] = uFx;
          nFz[ptr] = uFz;
          ptr++;
        }
      }

      // Downstream extension nodes (skip zero-clearance ghost nodes upfront!)
      if (mn.useDownstreamExt) {
        if (mn.downBoundsMinX <= mn.downBoundsMaxX) {
          if (mn.downBoundsMinX < sMinX) sMinX = mn.downBoundsMinX;
          if (mn.downBoundsMaxX > sMaxX) sMaxX = mn.downBoundsMaxX;
          if (mn.downBoundsMinZ < sMinZ) sMinZ = mn.downBoundsMinZ;
          if (mn.downBoundsMaxZ > sMaxZ) sMaxZ = mn.downBoundsMaxZ;
        }
        const dCnt = mn.downExtCount;
        const dHw = mn.downExtHalfWidth;
        const dFx = mn.downExtFwdX;
        const dFz = mn.downExtFwdZ;
        for (let j = 0; j < dCnt; j++) {
          const extScale = downExtClear ? downExtClear[j]! : 1;
          if (extScale <= 0) continue;
          nX[ptr] = mn.downExtX[j]!;
          nY[ptr] = mn.downExtY[j]!;
          nZ[ptr] = mn.downExtZ[j]!;
          nHw[ptr] = dHw;
          nSc[ptr] = extScale;
          nFx[ptr] = dFx;
          nFz[ptr] = dFz;
          ptr++;
        }
      }

      sEnd[i] = ptr;
      sMinXArr[i] = sMinX;
      sMaxXArr[i] = sMaxX;
      sMinZArr[i] = sMinZ;
      sMaxZArr[i] = sMaxZ;
    }

    this.macroCacheValid = true;
  }

  private prepareStripSpineCaches(
    allSpines: readonly SpineView[],
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): void {
    this.ensureMacroCache(allSpines);

    const pisteList = this.stripPisteSpinesScratch;
    const nearList = this.stripNearSpinesScratch;
    const nearIdxList = this.stripNearSpineIdxScratch;
    const nearClear = this.stripNearDownClearScratch;
    const corrList = this.stripCorridorSpinesScratch;
    const corrClear = this.stripCorridorClearScratch;
    const corrLand = this.stripCorridorLandscapeScratch;

    pisteList.length = 0;
    nearList.length = 0;
    nearIdxList.length = 0;
    nearClear.length = 0;
    corrList.length = 0;
    corrClear.length = 0;
    corrLand.length = 0;

    const n = allSpines.length;
    if (!this.macroCacheValid) return;

    const pisteMinX = minX - PISTE_GRID_AABB_PAD_M;
    const pisteMaxX = maxX + PISTE_GRID_AABB_PAD_M;
    const pisteMinZ = minZ - PISTE_GRID_AABB_PAD_M;
    const pisteMaxZ = maxZ + PISTE_GRID_AABB_PAD_M;

    const nearMinX = minX - MACRO_WIN_OUT_M;
    const nearMaxX = maxX + MACRO_WIN_OUT_M;
    const nearMinZ = minZ - MACRO_WIN_OUT_M;
    const nearMaxZ = maxZ + MACRO_WIN_OUT_M;

    const sMinXArr = this.macroSpineMinX;
    const sMaxXArr = this.macroSpineMaxX;
    const sMinZArr = this.macroSpineMinZ;
    const sMaxZArr = this.macroSpineMaxZ;
    const farClear = this.farDownClearScratch;

    for (let i = 0; i < n; i++) {
      const sp = allSpines[i]!;
      if (
        sp.boundsMaxX >= pisteMinX &&
        sp.boundsMinX <= pisteMaxX &&
        sp.boundsMaxZ >= pisteMinZ &&
        sp.boundsMinZ <= pisteMaxZ
      ) {
        pisteList.push(sp);
      }

      if (
        sMaxXArr[i]! >= nearMinX &&
        sMinXArr[i]! <= nearMaxX &&
        sMaxZArr[i]! >= nearMinZ &&
        sMinZArr[i]! <= nearMaxZ
      ) {
        nearList.push(sp);
        nearIdxList.push(i);
        nearClear.push(farClear[i] ?? null);
      }

      const cl = sp.corridorLeft;
      const cr = sp.corridorRight;
      if (cl && cr) {
        const hitLeft =
          cl.boundsMinX <= cl.boundsMaxX &&
          cl.boundsMaxX >= minX &&
          cl.boundsMinX <= maxX &&
          cl.boundsMaxZ >= minZ &&
          cl.boundsMinZ <= maxZ;
        const hitRight =
          cr.boundsMinX <= cr.boundsMaxX &&
          cr.boundsMaxX >= minX &&
          cr.boundsMinX <= maxX &&
          cr.boundsMaxZ >= minZ &&
          cr.boundsMinZ <= maxZ;
        if (hitLeft || hitRight) {
          corrList.push(sp);
          corrClear.push(this.clearScaleCache.get(sp.id));
          corrLand.push(this.resolveLandscape(sp));
        }
      }
    }

    if (this.farHintSpineIdx >= n) {
      this.farHintSpineIdx = 0;
    }
  }

  /**
   * Builds per-strip constant-axis-filtered near macro node arrays (eliminating all nodes with
   * `|constCoord - nodeConst| >= MACRO_WIN_OUT_M` ONCE per strip instead of 256 times).
   */
  private buildStripNearNodes(constCoord: number, isRow: boolean): void {
    const nearSpines = this.stripNearSpinesScratch;
    const nearIdxList = this.stripNearSpineIdxScratch;
    const nearClear = this.stripNearDownClearScratch;
    const spCount = nearSpines.length;

    if (this.stripNearSpStart.length < spCount) {
      const cap = Math.max(64, spCount * 2);
      this.stripNearSpStart = new Int32Array(cap);
      this.stripNearSpEnd = new Int32Array(cap);
      this.stripNearSpGlobalIdx = new Int32Array(cap);
      this.stripNearSpMinVar = new Float64Array(cap);
      this.stripNearSpMaxVar = new Float64Array(cap);
    }

    // Upper-bound node count across near spines
    let maxNodes = 0;
    for (let i = 0; i < spCount; i++) {
      const mn = nearSpines[i]!.macroNodes!;
      maxNodes += mn.count + (mn.useUpstreamExt ? mn.upExtCount : 0) + (mn.useDownstreamExt ? mn.downExtCount : 0);
    }
    if (this.stripNearNodeCap < maxNodes) {
      const cap = Math.max(1024, maxNodes * 2);
      this.stripNearNodeCap = cap;
      this.stripNearNodeVar = new Float64Array(cap);
      this.stripNearNodeY = new Float64Array(cap);
      this.stripNearNodeConstSq = new Float64Array(cap);
      this.stripNearNodeHw = new Float32Array(cap);
      this.stripNearNodeScale = new Float32Array(cap);
      this.stripNearNodeFwdX = new Float32Array(cap);
      this.stripNearNodeFwdZ = new Float32Array(cap);
      this.stripNearNodeIsDown = new Uint8Array(cap);
    }

    const nVar = this.stripNearNodeVar;
    const nY = this.stripNearNodeY;
    const nCSq = this.stripNearNodeConstSq;
    const nHw = this.stripNearNodeHw;
    const nSc = this.stripNearNodeScale;
    const nFx = this.stripNearNodeFwdX;
    const nFz = this.stripNearNodeFwdZ;
    const nDown = this.stripNearNodeIsDown;
    const spStart = this.stripNearSpStart;
    const spEnd = this.stripNearSpEnd;
    const spGIdx = this.stripNearSpGlobalIdx;
    const spMinVar = this.stripNearSpMinVar;
    const spMaxVar = this.stripNearSpMaxVar;

    let ptr = 0;
    let outSp = 0;

    for (let i = 0; i < spCount; i++) {
      const sp = nearSpines[i]!;
      const mn = sp.macroNodes!;
      const start = ptr;
      let vMin = Infinity;
      let vMax = -Infinity;

      // Interior nodes
      const bMinC = isRow ? sp.boundsMinZ : sp.boundsMinX;
      const bMaxC = isRow ? sp.boundsMaxZ : sp.boundsMaxX;
      if (constCoord >= bMinC - MACRO_WIN_OUT_M && constCoord <= bMaxC + MACRO_WIN_OUT_M) {
        const cnt = mn.count;
        const varArr = isRow ? mn.posX : mn.posZ;
        const constArr = isRow ? mn.posZ : mn.posX;
        const ys = mn.posY;
        const hws = mn.halfWidth;
        const fxs = mn.fwdX;
        const fzs = mn.fwdZ;
        for (let j = 0; j < cnt; j++) {
          const dc = constCoord - constArr[j]!;
          const dcSq = dc * dc;
          if (dcSq >= MACRO_WIN_OUT_SQ) continue;
          const v = varArr[j]!;
          if (v < vMin) vMin = v;
          if (v > vMax) vMax = v;
          nVar[ptr] = v;
          nY[ptr] = ys[j]!;
          nCSq[ptr] = dcSq;
          nHw[ptr] = hws[j]!;
          nSc[ptr] = 1;
          nFx[ptr] = fxs[j]!;
          nFz[ptr] = fzs[j]!;
          nDown[ptr] = 0;
          ptr++;
        }
      }

      // Upstream extension nodes
      if (mn.useUpstreamExt) {
        const uMinC = isRow ? mn.upBoundsMinZ : mn.upBoundsMinX;
        const uMaxC = isRow ? mn.upBoundsMaxZ : mn.upBoundsMaxX;
        if (constCoord >= uMinC - MACRO_WIN_OUT_M && constCoord <= uMaxC + MACRO_WIN_OUT_M) {
          const cnt = mn.upExtCount;
          const varArr = isRow ? mn.upExtX : mn.upExtZ;
          const constArr = isRow ? mn.upExtZ : mn.upExtX;
          const ys = mn.upExtY;
          const hw = mn.upExtHalfWidth;
          const fx = mn.upExtFwdX;
          const fz = mn.upExtFwdZ;
          for (let j = 0; j < cnt; j++) {
            const dc = constCoord - constArr[j]!;
            const dcSq = dc * dc;
            if (dcSq >= MACRO_WIN_OUT_SQ) continue;
            const v = varArr[j]!;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
            nVar[ptr] = v;
            nY[ptr] = ys[j]!;
            nCSq[ptr] = dcSq;
            nHw[ptr] = hw;
            nSc[ptr] = 1;
            nFx[ptr] = fx;
            nFz[ptr] = fz;
            nDown[ptr] = 0;
            ptr++;
          }
        }
      }

      // Downstream extension nodes
      if (mn.useDownstreamExt) {
        const dMinC = isRow ? mn.downBoundsMinZ : mn.downBoundsMinX;
        const dMaxC = isRow ? mn.downBoundsMaxZ : mn.downBoundsMaxX;
        if (constCoord >= dMinC - MACRO_WIN_OUT_M && constCoord <= dMaxC + MACRO_WIN_OUT_M) {
          const dClear = nearClear[i] ?? null;
          const cnt = mn.downExtCount;
          const varArr = isRow ? mn.downExtX : mn.downExtZ;
          const constArr = isRow ? mn.downExtZ : mn.downExtX;
          const ys = mn.downExtY;
          const hw = mn.downExtHalfWidth;
          const fx = mn.downExtFwdX;
          const fz = mn.downExtFwdZ;
          for (let j = 0; j < cnt; j++) {
            const sc = dClear ? dClear[j]! : 1;
            if (sc <= 0) continue;
            const dc = constCoord - constArr[j]!;
            const dcSq = dc * dc;
            if (dcSq >= MACRO_WIN_OUT_SQ) continue;
            const v = varArr[j]!;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
            nVar[ptr] = v;
            nY[ptr] = ys[j]!;
            nCSq[ptr] = dcSq;
            nHw[ptr] = hw;
            nSc[ptr] = sc;
            nFx[ptr] = fx;
            nFz[ptr] = fz;
            nDown[ptr] = 1;
            ptr++;
          }
        }
      }

      if (ptr > start) {
        spStart[outSp] = start;
        spEnd[outSp] = ptr;
        spGIdx[outSp] = nearIdxList[i]!;
        spMinVar[outSp] = vMin;
        spMaxVar[outSp] = vMax;
        outSp++;
      }
    }

    this.stripNearSpCount = outSp;
  }

  private evalStripNearMacroAtPoint(varCoord: number): void {
    const mOut = this.gridMacroOut;
    let sumW = 0;
    let weightedMacroY = 0;
    let downhillAccX = 0;
    let downhillAccZ = 0;
    let minNodeDistSq = Infinity;
    let minEdgeDist = Infinity;
    let closestSpineIdx = -1;
    let closestSpineDistSq = Infinity;
    let secondClosestSpineIdx = -1;
    let secondClosestDistSq = Infinity;
    let touchedStages = 0;

    const nVar = this.stripNearNodeVar;
    const nY = this.stripNearNodeY;
    const nCSq = this.stripNearNodeConstSq;
    const nHw = this.stripNearNodeHw;
    const nSc = this.stripNearNodeScale;
    const nFx = this.stripNearNodeFwdX;
    const nFz = this.stripNearNodeFwdZ;
    const nDown = this.stripNearNodeIsDown;
    const spStart = this.stripNearSpStart;
    const spEnd = this.stripNearSpEnd;
    const spGIdx = this.stripNearSpGlobalIdx;
    const spMinVar = this.stripNearSpMinVar;
    const spMaxVar = this.stripNearSpMaxVar;
    const spCount = this.stripNearSpCount;
    const stageIdxArr = this.macroSpineStageIdx;
    const stageW = this.gridStageWeightsScratch;
    const stageTouched = this.gridStageTouchedScratch;

    for (let i = 0; i < spCount; i++) {
      if (varCoord < spMinVar[i]! - MACRO_WIN_OUT_M || varCoord > spMaxVar[i]! + MACRO_WIN_OUT_M) {
        continue;
      }
      const start = spStart[i]!;
      const end = spEnd[i]!;
      let spineBlendW = 0;
      let spineLocalW = 0;
      let spineLocalY = 0;
      let spineDhX = 0;
      let spineDhZ = 0;
      let spineMinRSq = Infinity;

      for (let j = start; j < end; j++) {
        const dv = varCoord - nVar[j]!;
        const rSq = dv * dv + nCSq[j]!;
        if (rSq < spineMinRSq) spineMinRSq = rSq;
        if (rSq >= MACRO_WIN_OUT_SQ) continue;
        const r = Math.sqrt(rSq);
        const rawEdge = r - nHw[j]!;
        if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
        let win = 1;
        if (r > MACRO_WIN_IN_M) {
          const u = (r - MACRO_WIN_IN_M) * (1 / (MACRO_WIN_OUT_M - MACRO_WIN_IN_M));
          win = 1 - u * u * u * (u * (u * 6 - 15) + 10);
        }
        let wBlend: number;
        let wLocal: number;
        if (nDown[j] === 0) {
          const smoothEdge =
            rawEdge >= 16
              ? rawEdge + 1 / rawEdge
              : 0.5 * (rawEdge + Math.sqrt(rawEdge * rawEdge + MACRO_EDGE_SMOOTH_SQ));
          const seSq = smoothEdge * smoothEdge;
          wBlend = win / (seSq + MACRO_R0_SQ);
          wLocal = wBlend / (seSq + MACRO_LOCAL_R0_SQ);
        } else {
          const invD2 = 1 / (rSq + MACRO_DOWN_EXT_R0_SQ);
          wBlend = win * nSc[j]! * invD2;
          wLocal = wBlend * invD2;
        }
        spineBlendW += wBlend;
        spineLocalW += wLocal;
        spineLocalY += wLocal * nY[j]!;
        spineDhX += wLocal * nFx[j]!;
        spineDhZ += wLocal * nFz[j]!;
      }

      const gIdx = spGIdx[i]!;
      if (spineBlendW > 0 && spineLocalW > 1e-24) {
        const scale = spineBlendW / spineLocalW;
        sumW += spineBlendW;
        weightedMacroY += spineLocalY * scale;
        downhillAccX += spineDhX * scale;
        downhillAccZ += spineDhZ * scale;
        const sIdx = stageIdxArr[gIdx]!;
        if (stageW[sIdx] === 0) {
          stageTouched[touchedStages++] = sIdx;
        }
        stageW[sIdx] = stageW[sIdx]! + spineBlendW;
      }

      if (spineMinRSq < minNodeDistSq) minNodeDistSq = spineMinRSq;
      if (spineMinRSq < closestSpineDistSq) {
        secondClosestSpineIdx = closestSpineIdx;
        secondClosestDistSq = closestSpineDistSq;
        closestSpineIdx = gIdx;
        closestSpineDistSq = spineMinRSq;
      } else if (spineMinRSq < secondClosestDistSq) {
        secondClosestSpineIdx = gIdx;
        secondClosestDistSq = spineMinRSq;
      }
    }

    mOut.sumW = sumW;
    mOut.macroY = sumW > 1e-12 ? weightedMacroY / sumW : 0;
    mOut.downhillAccX = downhillAccX;
    mOut.downhillAccZ = downhillAccZ;
    mOut.minNodeDistSq = minNodeDistSq;
    mOut.minEdgeDist = minEdgeDist;
    mOut.closestSpineIdx = closestSpineIdx;
    mOut.closestSpineDistSq = closestSpineDistSq;
    mOut.secondClosestSpineIdx = secondClosestSpineIdx;
    mOut.secondClosestDistSq = secondClosestDistSq;
    mOut.touchedStages = touchedStages;
  }

  /**
   * Vectorized 1D clipmap strip evaluator (`256 x 1` or `1 x 256`, `skipNormals = true`):
   * - Exact per-texel Pass 1 (piste, AABB range-clamped) and Pass 2B (corridor kernels, loop-inverted disc-clamped)
   * - Exact per-texel alpine undulation & outer valley rim noise
   * - Strided low-frequency macro sheet (`2 m` knots on L0/L1, `4 m` on L2, `16 m` on L3, `32 m` on L4)
   *   strictly on off-piste texels (0.000 m exact on piste, < 3 mm off-piste on L0/L1)
   */
  private sampleStrip1DFast(
    baseWx: number,
    baseWz: number,
    len: number,
    isRow: boolean,
    stepM: number,
    blockOriginY: number,
    allSpines: readonly SpineView[],
    out: TerrainGridSampleOut,
  ): void {
    const oy = this.originOffsetY;
    const ox = this.originOffsetX;
    const oz = this.originOffsetZ;
    const invStep = 1 / stepM;
    const baseVar = isRow ? baseWx : baseWz;
    const constCoord = isRow ? baseWz : baseWx;

    // ── Pass 1: Sphere-traced exact Piste pass (100% mathematically exact via triangle inequality!) ──
    const isFull = this.stripIsFullPiste;
    const hasPisteArr = this.stripHasPiste;
    const finalPisteHArr = this.stripFinalPisteH;
    const totalPisteWArr = this.stripTotalPisteW;
    const oneMinusRelArr = this.stripOneMinusRelief;
    const domSpineArr = this.stripDomSpine;
    const domSArr = this.stripDomS;
    const domSignedXArr = this.stripDomSignedX;
    const domHalfWArr = this.stripDomHalfW;
    const domSpineYArr = this.stripDomSpineY;
    const domFwdXArr = this.stripDomFwdX;
    const domFwdZArr = this.stripDomFwdZ;
    const domInDivArr = this.stripDomInDiv;
    const domDivMaskArr = this.stripDomDivMask;
    const fullCountArr = this.stripFullCount;
    const fullHSumArr = this.stripFullHSum;
    const barrierWSumArr = this.stripBarrierWSum;
    const barrierHSumArr = this.stripBarrierHSum;
    const oneMinusTotArr = this.stripOneMinusTotalW;
    const maxPisteWArr = this.stripMaxPisteW;
    const domAbsXArr = this.stripDomAbsX;

    for (let t = 0; t < len; t++) {
      isFull[t] = 0;
      hasPisteArr[t] = 0;
      totalPisteWArr[t] = 0;
      oneMinusRelArr[t] = 1;
      domSpineArr[t] = null;
      fullCountArr[t] = 0;
      fullHSumArr[t] = 0;
      barrierWSumArr[t] = 0;
      barrierHSumArr[t] = 0;
      oneMinusTotArr[t] = 1;
      maxPisteWArr[t] = 0;
      domAbsXArr[t] = Infinity;
    }

    // Safe Euclidean cutoff for sphere-tracing: hypot(PISTE_LONG_HANDOFF_M + 1, maxHalfWidth(22) + 15.5) = 40.4m -> 43m
    const PISTE_SPHERE_SKIP_M = 43.0;
    const pisteSpines = this.stripPisteSpinesScratch;
    const proj = this.projScratch;
    const pisteOut = this.pisteScratch;
    let pisteDirtyMin = len;
    let pisteDirtyMax = -1;

    for (let i = 0; i < pisteSpines.length; i++) {
      const sp = pisteSpines[i]!;
      const cMin = isRow ? sp.boundsMinZ - PISTE_GRID_AABB_PAD_M : sp.boundsMinX - PISTE_GRID_AABB_PAD_M;
      const cMax = isRow ? sp.boundsMaxZ + PISTE_GRID_AABB_PAD_M : sp.boundsMaxX + PISTE_GRID_AABB_PAD_M;
      if (constCoord < cMin || constCoord > cMax) continue;
      const vMin = isRow ? sp.boundsMinX - PISTE_GRID_AABB_PAD_M : sp.boundsMinZ - PISTE_GRID_AABB_PAD_M;
      const vMax = isRow ? sp.boundsMaxX + PISTE_GRID_AABB_PAD_M : sp.boundsMaxZ + PISTE_GRID_AABB_PAD_M;
      let t0 = Math.floor((vMin - baseVar) * invStep);
      let t1 = Math.ceil((vMax - baseVar) * invStep);
      if (t0 < 0) t0 = 0;
      if (t1 >= len) t1 = len - 1;
      if (t0 > t1) continue;

      const landscape = this.resolveLandscape(sp);
      const blendW = 14.5;

      for (let t = t0; t <= t1; t++) {
        const wx = isRow ? baseWx + t * stepM : baseWx;
        const wz = isRow ? baseWz : baseWz + t * stepM;
        sp.projectXZ(wx, wz, proj);

        const dSq = proj.distSq;
        if (dSq > PISTE_SPHERE_SKIP_M * PISTE_SPHERE_SKIP_M) {
          // Exact triangle-inequality skip along the strip axis!
          const skipSteps = Math.floor((Math.sqrt(dSq) - PISTE_SPHERE_SKIP_M) * invStep);
          if (skipSteps > 0) t += skipSteps;
          continue;
        }

        const absLongExt = Math.abs(proj.longExt);
        if (absLongExt >= PISTE_LONG_HANDOFF_M + 1.0) {
          const skipLong = Math.floor((absLongExt - (PISTE_LONG_HANDOFF_M + 1.5)) * invStep);
          if (skipLong > 0) t += skipLong;
          continue;
        }

        const absSignedX = Math.abs(proj.signedX);
        const maxSupportX = proj.halfWidth + blendW + 1.0;
        if (absSignedX >= maxSupportX) {
          // Safe lateral triangle-inequality skip (accounts for max |d(halfWidth)/ds| <= 0.15)
          const skipLat = Math.floor((absSignedX - maxSupportX - 1.0) / (1.18 * stepM));
          if (skipLat > 0) t += skipLat;
          continue;
        }

        const longMask = absLongExt <= 0 ? 1 : 1 - smootherstep(0, PISTE_LONG_HANDOFF_M, absLongExt);
        if (longMask <= 0) continue;

        let reliefW: number;
        let pisteW: number;
        if (absSignedX <= proj.halfWidth) {
          reliefW = longMask;
          pisteW = longMask;
        } else {
          const sideSpec = proj.signedX < 0 ? landscape.left : landscape.right;
          const reliefBlendW = clamp(sideSpec.transitionWidth * 0.72, 9.5, 11.0);
          reliefW =
            (1 - smoothstep(proj.halfWidth, proj.halfWidth + reliefBlendW, absSignedX)) * longMask;
          pisteW =
            (1 - smoothstep(proj.halfWidth, proj.halfWidth + blendW, absSignedX)) * longMask;
        }
        if (reliefW > 1e-7) {
          oneMinusRelArr[t] = oneMinusRelArr[t]! * (1 - reliefW);
        }

        if (pisteW > 1e-7) {
          if (t < pisteDirtyMin) pisteDirtyMin = t;
          if (t > pisteDirtyMax) pisteDirtyMax = t;

          const extDeltaY =
            proj.longExt !== 0 ? proj.longExt * Math.tan(clamp(proj.pitchRad, -1.2, 1.2)) : 0;
          sp.evaluatePisteHeight(proj.s, proj.signedX, pisteOut);
          const pisteH = pisteOut.heightY + extDeltaY;

          const coreW =
            (1 - smootherstep(proj.halfWidth * 0.25, proj.halfWidth + blendW, absSignedX)) *
            longMask;
          if (coreW >= 1 - 1e-9) {
            fullCountArr[t] = fullCountArr[t]! + 1;
            fullHSumArr[t] = fullHSumArr[t]! + pisteH;
          } else {
            const phi = pisteW / (1 - coreW + PISTE_BARRIER_EPS);
            barrierWSumArr[t] = barrierWSumArr[t]! + phi;
            barrierHSumArr[t] = barrierHSumArr[t]! + phi * pisteH;
          }
          oneMinusTotArr[t] = oneMinusTotArr[t]! * (1 - pisteW);

          const prevMaxW = maxPisteWArr[t]!;
          const betterWeight = pisteW > prevMaxW + 1e-6;
          const tiedCloser = Math.abs(pisteW - prevMaxW) <= 1e-6 && absSignedX < domAbsXArr[t]!;
          if (betterWeight || tiedCloser) {
            maxPisteWArr[t] = pisteW;
            domAbsXArr[t] = absSignedX;
            domSpineArr[t] = sp;
            domSArr[t] = proj.s;
            domSignedXArr[t] = proj.signedX;
            domHalfWArr[t] = proj.halfWidth;
            domSpineYArr[t] = proj.spineY;
            domFwdXArr[t] = proj.forwardX;
            domFwdZArr[t] = proj.forwardZ;
            domInDivArr[t] = pisteOut.inDivider ? 1 : 0;
            domDivMaskArr[t] = pisteOut.dividerMask;
          }
        }
      }
    }

    for (let t = pisteDirtyMin; t <= pisteDirtyMax; t++) {
      const tw = clamp(1 - oneMinusTotArr[t]!, 0, 1);
      totalPisteWArr[t] = tw;
      const fc = fullCountArr[t]!;
      const bw = barrierWSumArr[t]!;
      if (fc > 0 || bw > 1e-12) {
        hasPisteArr[t] = 1;
        finalPisteHArr[t] = fc > 0 ? fullHSumArr[t]! / fc : barrierHSumArr[t]! / bw;
      }
      if (tw >= 1 - 1e-6 && domSpineArr[t] !== null) {
        isFull[t] = 1;
      }
    }

    // ── Pass 2A + Far-Field: Constant-axis pre-filtered & strided smooth macro sheet ──
    // Knot spacing: 4m (L0/L1), 8m (L2/L3), 16m (L4) strictly off-piste (0.000m exact on-piste!)
    const macroStride = stepM <= 0.5 ? 8 : stepM <= 2.0 ? 4 : 2;
    this.buildStripNearNodes(constCoord, isRow);

    const kMacroY = this.stripKnotMacroY;
    const kMinEdge = this.stripKnotMinEdge;
    const kDhX = this.stripKnotDhX;
    const kDhZ = this.stripKnotDhZ;
    const kSumW = this.stripKnotSumW;
    const kClosest = this.stripKnotClosestIdx;
    const kSecond = this.stripKnotSecondIdx;
    const kSecondDSq = this.stripKnotSecondDistSq;
    const kSecStage = this.stripKnotSecStageIdx;
    const kSecW = this.stripKnotSecStageW;
    const kValid = this.stripKnotValid;

    const mOut = this.gridMacroOut;
    const stageW = this.gridStageWeightsScratch;
    const stageTouched = this.gridStageTouchedScratch;
    const spineStageIdx = this.macroSpineStageIdx;

    // Evaluate only knots bordering at least one off-piste texel
    for (let t = 0; t < len; t += macroStride) {
      this.evalMacroKnotIfNeeded(
        t,
        macroStride,
        len,
        baseWx,
        baseWz,
        stepM,
        isRow,
        isFull,
        kValid,
        kMacroY,
        kMinEdge,
        kDhX,
        kDhZ,
        kSumW,
        kClosest,
        kSecond,
        kSecondDSq,
        kSecStage,
        kSecW,
        mOut,
        stageW,
        stageTouched,
        spineStageIdx,
      );
    }
    const lastIdx = len - 1;
    if (lastIdx % macroStride !== 0) {
      this.evalMacroKnotIfNeeded(
        lastIdx,
        macroStride,
        len,
        baseWx,
        baseWz,
        stepM,
        isRow,
        isFull,
        kValid,
        kMacroY,
        kMinEdge,
        kDhX,
        kDhZ,
        kSumW,
        kClosest,
        kSecond,
        kSecondDSq,
        kSecStage,
        kSecW,
        mOut,
        stageW,
        stageTouched,
        spineStageIdx,
      );
    }

    // ── Pass 2B: Loop-inverted disc-clamped exact Corridor Kernels ──
    const posD = this.stripPosD;
    const posW = this.stripPosW;
    const negD = this.stripNegD;
    const negW = this.stripNegW;
    const chasmD = this.stripChasmD;
    const chasmW = this.stripChasmW;
    const maxChasmDepth = this.stripMaxChasmDepth;

    for (let t = 0; t < len; t++) {
      posD[t] = 0;
      posW[t] = 0;
      negD[t] = 0;
      negW[t] = 0;
      chasmD[t] = 0;
      chasmW[t] = 0;
      maxChasmDepth[t] = 0;
    }

    const corrSpines = this.stripCorridorSpinesScratch;
    const corrClear = this.stripCorridorClearScratch;
    const corrLand = this.stripCorridorLandscapeScratch;
    const sideDArr = this.stripSideD;
    const sideAmpArr = this.stripSideAmp;
    const rimDArr = this.stripRimD;
    const rimAmpArr = this.stripRimAmp;

    for (let i = 0; i < corrSpines.length; i++) {
      const sp = corrSpines[i]!;
      const clearEntry = corrClear[i];
      const landscape = corrLand[i]!;

      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const side = sideIdx === 0 ? sp.corridorLeft! : sp.corridorRight!;
        const sMinC = isRow ? side.boundsMinZ : side.boundsMinX;
        const sMaxC = isRow ? side.boundsMaxZ : side.boundsMaxX;
        if (constCoord < sMinC || constCoord > sMaxC) continue;
        const sMinV = isRow ? side.boundsMinX : side.boundsMinZ;
        const sMaxV = isRow ? side.boundsMaxX : side.boundsMaxZ;
        let bStart = Math.floor((sMinV - baseVar) * invStep);
        let bEnd = Math.ceil((sMaxV - baseVar) * invStep);
        if (bStart < 0) bStart = 0;
        if (bEnd >= len) bEnd = len - 1;
        if (bStart > bEnd) continue;

        const clearArr = sideIdx === 0 ? clearEntry?.left : clearEntry?.right;
        const count = side.count;
        const varArr = isRow ? side.posX : side.posZ;
        const constArr = isRow ? side.posZ : side.posX;
        const invRSqs = side.invRadiusSq;
        const radii = side.radius;
        const kWeights = side.kernelWeight;
        const amps = side.ampMag;

        let dirtyMin = len;
        let dirtyMax = -1;
        for (let t = bStart; t <= bEnd; t++) {
          sideDArr[t] = 0;
          sideAmpArr[t] = 0;
          rimDArr[t] = 0;
          rimAmpArr[t] = 0;
        }

        for (let k = 0; k < count; k++) {
          const cScale = clearArr ? clearArr[k]! : 1;
          const kw = kWeights[k]!;
          if (cScale <= 0 || kw <= 0) continue;
          const dc = constCoord - constArr[k]!;
          const dcSq = dc * dc;
          const invR2 = invRSqs[k]!;
          if (dcSq * invR2 >= 1) continue;

          const r = radii[k]!;
          const remSq = r * r - dcSq;
          if (remSq <= 0) continue;
          const halfV = Math.sqrt(remSq);
          const kv = varArr[k]!;
          let t0 = Math.ceil((kv - halfV - baseVar) * invStep);
          let t1 = Math.floor((kv + halfV - baseVar) * invStep);
          if (t0 < bStart) t0 = bStart;
          if (t1 > bEnd) t1 = bEnd;
          if (t0 > t1) continue;

          if (t0 < dirtyMin) dirtyMin = t0;
          if (t1 > dirtyMax) dirtyMax = t1;

          const kwScale = kw * cScale;
          const a = amps[k]!;
          if (a >= 0) {
            for (let t = t0; t <= t1; t++) {
              if (isFull[t] !== 0) continue;
              const dv = baseVar + t * stepM - kv;
              const q = (dv * dv + dcSq) * invR2;
              if (q >= 1) continue;
              const u = 1 - q;
              const kern = kwScale * (u * u * u);
              sideDArr[t] = sideDArr[t]! + kern;
              sideAmpArr[t] = sideAmpArr[t]! + kern * a;
            }
          } else {
            const negA = -a;
            for (let t = t0; t <= t1; t++) {
              if (isFull[t] !== 0) continue;
              const dv = baseVar + t * stepM - kv;
              const q = (dv * dv + dcSq) * invR2;
              if (q >= 1) continue;
              const u = 1 - q;
              const kern = kwScale * (u * u * u);
              rimDArr[t] = rimDArr[t]! + kern;
              rimAmpArr[t] = rimAmpArr[t]! + kern * negA;
            }
          }
        }

        if (dirtyMin <= dirtyMax) {
          const spec = sideIdx === 0 ? landscape.left : landscape.right;
          const isChasm = spec.archetype === 'chasm';
          const chasmDepth = spec.archetype === 'chasm' ? spec.chasmWipeoutDepth : 0;
          // Modulation noise wavelength is 30-66m; striding 2m on L0, 4m on L1/L2, 8m on L3 keeps < 2cm error!
          const modStride = stepM <= 1.0 ? 4 : stepM <= 4.0 ? 2 : 1;
          const sModArr = this.stripSideModKnot;
          const rModArr = this.stripRimModKnot;
          if (modStride > 1) {
            // Evaluate low-frequency modulation only at strided knots overlapping active corridor texels
            const kFirst = dirtyMin - (dirtyMin % modStride);
            for (let k = kFirst; k <= dirtyMax + modStride; k += modStride) {
              const kt = k < len ? k : lastIdx;
              const wx = isRow ? baseWx + kt * stepM : baseWx;
              const wz = isRow ? baseWz : baseWz + kt * stepM;
              const absX = wx + ox;
              const absZ = wz + oz;
              // Check if any texel in [kt - modStride + 1 .. kt + modStride - 1] needs side/rim mod
              const lo = kt - modStride + 1 > dirtyMin ? kt - modStride + 1 : dirtyMin;
              const hi = kt + modStride - 1 < dirtyMax ? kt + modStride - 1 : dirtyMax;
              let needSide = false;
              let needRim = false;
              for (let u = lo; u <= hi; u++) {
                if (sideDArr[u]! > 1e-7) needSide = true;
                if (rimDArr[u]! > 1e-7) needRim = true;
                if (needSide && needRim) break;
              }
              if (needSide) {
                sModArr[kt] = this.evaluateSideModulation(spec, absX, absZ);
              }
              if (needRim) {
                rModArr[kt] =
                  0.78 +
                  0.22 *
                    smoothRidgedNoise2D(
                      absX * spec.noiseFrequency,
                      absZ * spec.noiseFrequency,
                      202,
                      2,
                      2.0,
                      0.5,
                    );
              }
              if (kt === lastIdx) break;
            }
          }

          for (let t = dirtyMin; t <= dirtyMax; t++) {
            const sd = sideDArr[t]!;
            const rd = rimDArr[t]!;
            if (sd <= 1e-7 && rd <= 1e-7) continue;
            if (modStride === 1) {
              const wx = isRow ? baseWx + t * stepM : baseWx;
              const wz = isRow ? baseWz : baseWz + t * stepM;
              const absX = wx + ox;
              const absZ = wz + oz;
              if (sd > 1e-7) {
                const mod = this.evaluateSideModulation(spec, absX, absZ);
                const signedW = sideAmpArr[t]! * mod;
                if (signedW >= 0) {
                  posD[t] = posD[t]! + sd;
                  posW[t] = posW[t]! + signedW;
                } else {
                  negD[t] = negD[t]! + sd;
                  negW[t] = negW[t]! + signedW;
                }
                if (isChasm) {
                  chasmD[t] = chasmD[t]! + sd;
                  chasmW[t] = chasmW[t]! + signedW;
                  if (chasmDepth > maxChasmDepth[t]!) {
                    maxChasmDepth[t] = chasmDepth;
                  }
                }
              }
              if (rd > 1e-7) {
                const rimMod =
                  0.78 +
                  0.22 *
                    smoothRidgedNoise2D(
                      absX * spec.noiseFrequency,
                      absZ * spec.noiseFrequency,
                      202,
                      2,
                      2.0,
                      0.5,
                    );
                posD[t] = posD[t]! + rd;
                posW[t] = posW[t]! + rimAmpArr[t]! * rimMod;
              }
            } else {
              const k0 = t - (t % modStride);
              const k1 = k0 + modStride < len ? k0 + modStride : lastIdx;
              const span = k1 - k0;
              const frac = span > 0 ? (t - k0) / span : 0;
              if (sd > 1e-7) {
                const mod = frac === 0 ? sModArr[k0]! : lerp(sModArr[k0]!, sModArr[k1]!, frac);
                const signedW = sideAmpArr[t]! * mod;
                if (signedW >= 0) {
                  posD[t] = posD[t]! + sd;
                  posW[t] = posW[t]! + signedW;
                } else {
                  negD[t] = negD[t]! + sd;
                  negW[t] = negW[t]! + signedW;
                }
                if (isChasm) {
                  chasmD[t] = chasmD[t]! + sd;
                  chasmW[t] = chasmW[t]! + signedW;
                  if (chasmDepth > maxChasmDepth[t]!) {
                    maxChasmDepth[t] = chasmDepth;
                  }
                }
              }
              if (rd > 1e-7) {
                const rimMod = frac === 0 ? rModArr[k0]! : lerp(rModArr[k0]!, rModArr[k1]!, frac);
                posD[t] = posD[t]! + rd;
                posW[t] = posW[t]! + rimAmpArr[t]! * rimMod;
              }
            }
          }
        }
      }
    }

    // Pre-evaluate ultra-low-frequency alpine undulation (118m wavelength) & outer rim (100m wavelength)
    // at strided knots (2m on L0, 4m on L1/L2, 8m on L3, 16m on L4 -> < 1cm interpolation error!)
    const bgStride = stepM <= 1.0 ? 4 : 2;
    const alpineArr = this.stripAlpineNoise;
    const outerRimArr = this.stripOuterRimNoise;
    for (let k = 0; k < len; k += bgStride) {
      this.evalBgNoiseKnot(
        k,
        bgStride,
        len,
        macroStride,
        lastIdx,
        baseWx,
        baseWz,
        ox,
        oz,
        stepM,
        isRow,
        isFull,
        kMinEdge,
        alpineArr,
        outerRimArr,
      );
    }
    if (lastIdx % bgStride !== 0) {
      this.evalBgNoiseKnot(
        lastIdx,
        bgStride,
        len,
        macroStride,
        lastIdx,
        baseWx,
        baseWz,
        ox,
        oz,
        stepM,
        isRow,
        isFull,
        kMinEdge,
        alpineArr,
        outerRimArr,
      );
    }

    // ── Final Assembly into TerrainGridSampleOut ──
    for (let t = 0; t < len; t++) {
      const idx3 = t * 3;
      out.normals[idx3] = 0;
      out.normals[idx3 + 1] = 1;
      out.normals[idx3 + 2] = 0;

      if (isFull[t] !== 0) {
        const domSp = domSpineArr[t]!;
        const heightY = finalPisteHArr[t]!;
        const macroY = domSpineYArr[t]!;
        const pw = clamp(totalPisteWArr[t]!, 0, 1);

        out.heights[t] = heightY + oy - blockOriginY;
        out.macroY[t] = macroY + oy - blockOriginY;
        out.pisteWeight[t] = pw;

        const surf = domSp.evaluatePisteSurface(domSArr[t]!, domSignedXArr[t]!);
        if (surf === 'ice') {
          out.iceWeight[t] = pw;
          out.powderWeight[t] = 1 - pw;
        } else if (surf === 'powder') {
          out.iceWeight[t] = 0;
          out.powderWeight[t] = 1;
        } else {
          out.iceWeight[t] = 0;
          out.powderWeight[t] = 1 - pw;
        }
        out.dividerMask[t] = clamp(domDivMaskArr[t]! * pw, 0, 1);

        const idx2 = t * 2;
        const fx = domFwdXArr[t]!;
        const fz = domFwdZArr[t]!;
        const fLenSq = fx * fx + fz * fz;
        if (fLenSq > 1e-12) {
          const invF = 1 / Math.sqrt(fLenSq);
          out.flowXZ[idx2] = fx * invF;
          out.flowXZ[idx2 + 1] = fz * invF;
        } else {
          out.flowXZ[idx2] = 0;
          out.flowXZ[idx2 + 1] = -1;
        }

        out.offPisteDist[t] = Math.max(0, Math.abs(domSignedXArr[t]!) - domHalfWArr[t]!);
        const primIdx = this.internStageId(domSp.stageId);
        out.primaryStageIdx[t] = primIdx;
        out.secondaryStageIdx[t] = primIdx;
        out.secondaryStageWeightU8[t] = 0;

        let flags = TERRAIN_FLAG_ON_PISTE;
        if (domInDivArr[t] !== 0) flags |= TERRAIN_FLAG_IN_DIVIDER;
        out.flags[t] = flags;
        continue;
      }

      // Interpolate smooth macro sheet between bounding strided knots [k0, k1]
      const k0 = t - (t % macroStride);
      const k1 = k0 + macroStride < len ? k0 + macroStride : lastIdx;
      const span = k1 - k0;
      const frac = span > 0 ? (t - k0) / span : 0;

      const macroY = frac === 0 ? kMacroY[k0]! : lerp(kMacroY[k0]!, kMacroY[k1]!, frac);
      const minEdgeDist = frac === 0 ? kMinEdge[k0]! : lerp(kMinEdge[k0]!, kMinEdge[k1]!, frac);
      const dhAccX = frac === 0 ? kDhX[k0]! : lerp(kDhX[k0]!, kDhX[k1]!, frac);
      const dhAccZ = frac === 0 ? kDhZ[k0]! : lerp(kDhZ[k0]!, kDhZ[k1]!, frac);
      const kNear = frac < 0.5 ? k0 : k1;

      const td = posD[t]! + negD[t]!;
      const denom = 0.5 * (1 + td + Math.sqrt((td - 1) * (td - 1) + CORRIDOR_SMAX_EPS_SQ));
      const corridorDH = td > 1e-7 ? (posW[t]! + negW[t]!) / denom : 0;
      const reliefOffMask = clamp(oneMinusRelArr[t]!, 0, 1);
      const reliefFade = reliefOffMask * reliefOffMask;
      const chD = chasmD[t]!;
      const chRelief = chD > 1e-7 ? (chasmW[t]! / denom) * reliefFade : 0;

      const b0 = t - (t % bgStride);
      const b1 = b0 + bgStride < len ? b0 + bgStride : lastIdx;
      const bSpan = b1 - b0;
      const bFrac = bSpan > 0 ? (t - b0) / bSpan : 0;
      const alpineUndulation =
        bFrac === 0 ? alpineArr[b0]! : lerp(alpineArr[b0]!, alpineArr[b1]!, bFrac);
      const outerRim =
        minEdgeDist <= OUTER_RIM_START_M
          ? 0
          : bFrac === 0
            ? outerRimArr[b0]!
            : lerp(outerRimArr[b0]!, outerRimArr[b1]!, bFrac);
      const offPisteRelief = (corridorDH + alpineUndulation + outerRim) * reliefFade;

      const totalPisteW = totalPisteWArr[t]!;
      const pisteTargetH = hasPisteArr[t] !== 0 ? finalPisteHArr[t]! : macroY;
      const heightBlendW =
        totalPisteW >= 1 - 1e-9
          ? 1
          : totalPisteW <= 0
            ? 0
            : (0.31 * totalPisteW) / (1 - 0.69 * totalPisteW);
      const heightY = lerp(macroY, pisteTargetH, heightBlendW) + offPisteRelief;

      out.heights[t] = heightY + oy - blockOriginY;
      out.macroY[t] = macroY + oy - blockOriginY;

      const domSp = domSpineArr[t] ?? null;
      const cIdx = kClosest[kNear]!;
      const closestSp = cIdx >= 0 ? allSpines[cIdx]! : allSpines[0]!;
      const nearestSpine = domSp ?? closestSp;
      let offPisteDist: number;
      let fallbackFwdX = 0;
      let fallbackFwdZ = -1;

      if (domSp !== null) {
        offPisteDist = Math.max(0, Math.abs(domSignedXArr[t]!) - domHalfWArr[t]!);
        fallbackFwdX = domFwdXArr[t]!;
        fallbackFwdZ = domFwdZArr[t]!;
      } else {
        // Off-piste clipmap strip: minEdgeDist from exact macro nodes is within ~1m of exact distance
        // over the 28m visual bank-tint gradient, avoiding 150-250 redundant projectXZ calls per strip!
        offPisteDist = minEdgeDist < 1e6 ? minEdgeDist : 100;
      }

      const pw = clamp(heightBlendW, 0, 1);
      out.pisteWeight[t] = pw;
      const onPiste = heightBlendW >= 0.5;
      let divMask = 0;
      let inDiv = false;
      if (totalPisteW > 0 && domSp !== null) {
        const surf = domSp.evaluatePisteSurface(domSArr[t]!, domSignedXArr[t]!);
        if (surf === 'ice') {
          out.iceWeight[t] = pw;
          out.powderWeight[t] = 1 - pw;
        } else if (surf === 'powder') {
          out.iceWeight[t] = 0;
          out.powderWeight[t] = 1;
        } else {
          out.iceWeight[t] = 0;
          out.powderWeight[t] = 1 - pw;
        }
        inDiv = domInDivArr[t] !== 0;
        divMask = domDivMaskArr[t]!;
      } else {
        out.iceWeight[t] = 0;
        out.powderWeight[t] = 1;
      }
      out.dividerMask[t] = clamp(divMask * pw, 0, 1);

      const idx2 = t * 2;
      const dLenSq = dhAccX * dhAccX + dhAccZ * dhAccZ;
      if (dLenSq > 1e-12) {
        const invD = 1 / Math.sqrt(dLenSq);
        out.flowXZ[idx2] = dhAccX * invD;
        out.flowXZ[idx2 + 1] = dhAccZ * invD;
      } else {
        const fLenSq = fallbackFwdX * fallbackFwdX + fallbackFwdZ * fallbackFwdZ;
        if (fLenSq > 1e-12) {
          const invF = 1 / Math.sqrt(fLenSq);
          out.flowXZ[idx2] = fallbackFwdX * invF;
          out.flowXZ[idx2 + 1] = fallbackFwdZ * invF;
        } else {
          out.flowXZ[idx2] = 0;
          out.flowXZ[idx2 + 1] = -1;
        }
      }

      out.offPisteDist[t] = offPisteDist;

      const primIdx =
        domSp !== null || nearestSpine !== closestSp
          ? this.internStageId(nearestSpine.stageId)
          : cIdx >= 0
            ? spineStageIdx[cIdx]!
            : this.internStageId(nearestSpine.stageId);
      const secIdx = kSecStage[kNear]!;
      const secW = secIdx >= 0 && secIdx !== primIdx ? kSecW[kNear]! : 0;
      out.primaryStageIdx[t] = primIdx;
      out.secondaryStageIdx[t] = secW > 0 ? secIdx : primIdx;
      out.secondaryStageWeightU8[t] = (secW * 255 + 0.5) | 0;

      const inChasmZone = !onPiste && chD > 0.05 && maxChasmDepth[t]! > 0 && chRelief < -3.0;
      let flags = 0;
      if (onPiste) flags |= TERRAIN_FLAG_ON_PISTE;
      if (inDiv) flags |= TERRAIN_FLAG_IN_DIVIDER;
      if (inChasmZone) flags |= TERRAIN_FLAG_IN_CHASM;
      out.flags[t] = flags;
    }
  }

  private evalBgNoiseKnot(
    k: number,
    bgStride: number,
    len: number,
    macroStride: number,
    lastIdx: number,
    baseWx: number,
    baseWz: number,
    ox: number,
    oz: number,
    stepM: number,
    isRow: boolean,
    isFull: Uint8Array,
    kMinEdge: Float64Array,
    alpineArr: Float32Array,
    outerRimArr: Float32Array,
  ): void {
    const lo = k - bgStride + 1 > 0 ? k - bgStride + 1 : 0;
    const hi = k + bgStride - 1 < len ? k + bgStride - 1 : len - 1;
    let need = false;
    for (let u = lo; u <= hi; u++) {
      if (isFull[u] === 0) {
        need = true;
        break;
      }
    }
    if (!need) {
      alpineArr[k] = 0;
      outerRimArr[k] = 0;
      return;
    }
    const wx = isRow ? baseWx + k * stepM : baseWx;
    const wz = isRow ? baseWz : baseWz + k * stepM;
    const absX = wx + ox;
    const absZ = wz + oz;
    alpineArr[k] =
      ALPINE_UNDULATION_AMP_M *
      fbm2D(absX * ALPINE_UNDULATION_FREQ, absZ * ALPINE_UNDULATION_FREQ, 404, 2, 2.0, 0.5);

    const m0 = k - (k % macroStride);
    const m1 = m0 + macroStride < len ? m0 + macroStride : lastIdx;
    const mSpan = m1 - m0;
    const mFrac = mSpan > 0 ? (k - m0) / mSpan : 0;
    const edgeDist = mFrac === 0 ? kMinEdge[m0]! : lerp(kMinEdge[m0]!, kMinEdge[m1]!, mFrac);
    outerRimArr[k] = this.evaluateOuterValleyRim(edgeDist, absX, absZ);
  }

  private evalMacroKnotIfNeeded(
    t: number,
    stride: number,
    len: number,
    baseWx: number,
    baseWz: number,
    stepM: number,
    isRow: boolean,
    isFull: Uint8Array,
    kValid: Uint8Array,
    kMacroY: Float64Array,
    kMinEdge: Float64Array,
    kDhX: Float64Array,
    kDhZ: Float64Array,
    kSumW: Float64Array,
    kClosest: Int32Array,
    kSecond: Int32Array,
    kSecondDSq: Float64Array,
    kSecStage: Int32Array,
    kSecW: Float32Array,
    mOut: typeof this.gridMacroOut,
    stageW: Float64Array,
    stageTouched: Int32Array,
    spineStageIdx: Uint8Array,
  ): void {
    // Check if any texel in [t - stride + 1 .. t + stride - 1] is off-piste
    const lo = t - stride + 1 > 0 ? t - stride + 1 : 0;
    const hi = t + stride - 1 < len ? t + stride - 1 : len - 1;
    let needKnot = false;
    for (let u = lo; u <= hi; u++) {
      if (isFull[u] === 0) {
        needKnot = true;
        break;
      }
    }
    if (!needKnot) {
      kValid[t] = 0;
      return;
    }

    const wx = isRow ? baseWx + t * stepM : baseWx;
    const wz = isRow ? baseWz : baseWz + t * stepM;
    this.evalStripNearMacroAtPoint(isRow ? wx : wz);
    if (mOut.minNodeDistSq > MACRO_FAR_BLEND_START_SQ || mOut.sumW <= 1e-12) {
      this.evalGridFarMacro(wx, wz, true);
    }

    kValid[t] = 1;
    kMacroY[t] = mOut.macroY;
    kMinEdge[t] = mOut.minEdgeDist;
    kDhX[t] = mOut.downhillAccX;
    kDhZ[t] = mOut.downhillAccZ;
    kSumW[t] = mOut.sumW;
    kClosest[t] = mOut.closestSpineIdx;
    kSecond[t] = mOut.secondClosestSpineIdx;
    kSecondDSq[t] = mOut.secondClosestDistSq;

    const primIdx = mOut.closestSpineIdx >= 0 ? spineStageIdx[mOut.closestSpineIdx]! : 0;
    const touched = mOut.touchedStages;
    let bestSecIdx = -1;
    let bestSecW = 0;
    for (let i = 0; i < touched; i++) {
      const sIdx = stageTouched[i]!;
      const sw = stageW[sIdx]!;
      stageW[sIdx] = 0;
      if (sIdx !== primIdx && sw > bestSecW) {
        bestSecW = sw;
        bestSecIdx = sIdx;
      }
    }
    if (bestSecIdx >= 0 && bestSecW > 1e-12 && mOut.sumW > 1e-12) {
      kSecStage[t] = bestSecIdx;
      kSecW[t] = clamp(bestSecW / mOut.sumW, 0, 1);
    } else {
      kSecStage[t] = -1;
      kSecW[t] = 0;
    }
  }

  private evalGridPistePass(wx: number, wz: number): void {
    const p1 = this.gridPass1Out;
    let fullCount = 0;
    let fullHSum = 0;
    let barrierWSum = 0;
    let barrierHSum = 0;
    let oneMinusTotalPisteW = 1;
    let oneMinusReliefPisteW = 1;
    let maxPisteW = 0;
    let dominantAbsX = Infinity;
    let dominantPisteSpine: SpineView | null = null;
    let dominantPisteS = 0;
    let dominantPisteSignedX = 0;
    let dominantPisteInDivider = false;
    let dominantPisteDividerMask = 0;
    let pisteNearCount = 0;
    let bestProjSpine: SpineView | null = null;
    let bestProjDistSq = Infinity;

    const pisteSpines = this.stripPisteSpinesScratch;
    const pCount = pisteSpines.length;
    const proj = this.projScratch;
    for (let i = 0; i < pCount; i++) {
      const sp = pisteSpines[i]!;
      if (
        wx < sp.boundsMinX - PISTE_GRID_AABB_PAD_M ||
        wx > sp.boundsMaxX + PISTE_GRID_AABB_PAD_M ||
        wz < sp.boundsMinZ - PISTE_GRID_AABB_PAD_M ||
        wz > sp.boundsMaxZ + PISTE_GRID_AABB_PAD_M
      ) {
        continue;
      }

      sp.projectXZ(wx, wz, proj);
      if (proj.distSq < bestProjDistSq) {
        bestProjDistSq = proj.distSq;
        bestProjSpine = sp;
        this.copyProjection(proj, this.pass1BestProjScratch);
      }

      const absLongExt = Math.abs(proj.longExt);
      if (absLongExt >= PISTE_LONG_HANDOFF_M + 1.0) continue;

      const blendW = 14.5;
      const absSignedX = Math.abs(proj.signedX);
      if (absSignedX >= proj.halfWidth + blendW + 1.0) continue;
      pisteNearCount++;

      const longMask = absLongExt <= 0 ? 1 : 1 - smootherstep(0, PISTE_LONG_HANDOFF_M, absLongExt);
      if (longMask <= 0) continue;

      let reliefW: number;
      let pisteW: number;
      if (absSignedX <= proj.halfWidth) {
        reliefW = longMask;
        pisteW = longMask;
      } else {
        const landscape = this.resolveLandscape(sp);
        const sideSpec = proj.signedX < 0 ? landscape.left : landscape.right;
        const reliefBlendW = clamp(sideSpec.transitionWidth * 0.72, 9.5, 11.0);
        reliefW =
          (1 - smoothstep(proj.halfWidth, proj.halfWidth + reliefBlendW, absSignedX)) * longMask;
        pisteW =
          (1 - smoothstep(proj.halfWidth, proj.halfWidth + blendW, absSignedX)) * longMask;
      }
      if (reliefW > 1e-7) {
        oneMinusReliefPisteW *= 1 - reliefW;
      }

      if (pisteW > 1e-7) {
        const extDeltaY =
          proj.longExt !== 0 ? proj.longExt * Math.tan(clamp(proj.pitchRad, -1.2, 1.2)) : 0;
        sp.evaluatePisteHeight(proj.s, proj.signedX, this.pisteScratch);
        const pisteH = this.pisteScratch.heightY + extDeltaY;

        const coreW =
          (1 - smootherstep(proj.halfWidth * 0.25, proj.halfWidth + blendW, absSignedX)) *
          longMask;
        if (coreW >= 1 - 1e-9) {
          fullCount++;
          fullHSum += pisteH;
        } else {
          const phi = pisteW / (1 - coreW + PISTE_BARRIER_EPS);
          barrierWSum += phi;
          barrierHSum += phi * pisteH;
        }
        oneMinusTotalPisteW *= 1 - pisteW;

        const betterWeight = pisteW > maxPisteW + 1e-6;
        const tiedCloser = Math.abs(pisteW - maxPisteW) <= 1e-6 && absSignedX < dominantAbsX;
        if (betterWeight || tiedCloser) {
          maxPisteW = pisteW;
          dominantAbsX = absSignedX;
          dominantPisteSpine = sp;
          dominantPisteS = proj.s;
          dominantPisteSignedX = proj.signedX;
          dominantPisteInDivider = this.pisteScratch.inDivider;
          dominantPisteDividerMask = this.pisteScratch.dividerMask;
          this.copyProjection(proj, this.nearestProjScratch);
        }
      }
    }

    const totalPisteW = clamp(1 - oneMinusTotalPisteW, 0, 1);
    p1.totalPisteW = totalPisteW;
    p1.hasPiste = fullCount > 0 || barrierWSum > 1e-12;
    p1.finalPisteH =
      fullCount > 0
        ? fullHSum / fullCount
        : barrierWSum > 1e-12
          ? barrierHSum / barrierWSum
          : 0;
    p1.isFullPiste = totalPisteW >= 1 - 1e-6;
    p1.oneMinusReliefPisteW = oneMinusReliefPisteW;
    p1.dominantPisteSpine = dominantPisteSpine;
    p1.dominantPisteS = dominantPisteS;
    p1.dominantPisteSignedX = dominantPisteSignedX;
    p1.dominantPisteInDivider = dominantPisteInDivider;
    p1.dominantPisteDividerMask = dominantPisteDividerMask;
    p1.pisteNearCount = pisteNearCount;
    p1.bestProjSpine = bestProjSpine;
    p1.bestProjDistSq = bestProjDistSq;
  }

  private evalGridNearMacro(wx: number, wz: number, includeMetadata: boolean): void {
    const mOut = this.gridMacroOut;
    let sumW = 0;
    let weightedMacroY = 0;
    let downhillAccX = 0;
    let downhillAccZ = 0;
    let minNodeDistSq = Infinity;
    let minEdgeDist = Infinity;
    let closestSpineIdx = -1;
    let closestSpineDistSq = Infinity;
    let secondClosestSpineIdx = -1;
    let secondClosestDistSq = Infinity;
    let touchedStages = 0;

    const nearSpines = this.stripNearSpinesScratch;
    const nearIdxList = this.stripNearSpineIdxScratch;
    const nearClear = this.stripNearDownClearScratch;
    const stageIdxArr = this.macroSpineStageIdx;
    const stageW = this.gridStageWeightsScratch;
    const stageTouched = this.gridStageTouchedScratch;
    const nCountSp = nearSpines.length;

    for (let i = 0; i < nCountSp; i++) {
      const sp = nearSpines[i]!;
      const spGlobalIdx = nearIdxList[i]!;
      const mn = sp.macroNodes!;
      let spineBlendW = 0;
      let spineLocalW = 0;
      let spineLocalY = 0;
      let spineDhX = 0;
      let spineDhZ = 0;
      let spineMinRSq = Infinity;

      const aabbDx =
        wx < sp.boundsMinX ? sp.boundsMinX - wx : wx > sp.boundsMaxX ? wx - sp.boundsMaxX : 0;
      const aabbDz =
        wz < sp.boundsMinZ ? sp.boundsMinZ - wz : wz > sp.boundsMaxZ ? wz - sp.boundsMaxZ : 0;
      if (aabbDx * aabbDx + aabbDz * aabbDz <= MACRO_WIN_OUT_SQ) {
        const nCount = mn.count;
        const xs = mn.posX;
        const ys = mn.posY;
        const zs = mn.posZ;
        const hws = mn.halfWidth;
        const fwdX = mn.fwdX;
        const fwdZ = mn.fwdZ;
        for (let j = 0; j < nCount; j++) {
          const dx = wx - xs[j]!;
          const dz = wz - zs[j]!;
          const rSq = dx * dx + dz * dz;
          if (rSq < spineMinRSq) spineMinRSq = rSq;
          if (rSq >= MACRO_WIN_OUT_SQ) continue;
          const r = Math.sqrt(rSq);
          const rawEdge = r - hws[j]!;
          if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
          const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
          const smoothEdge = 0.5 * (rawEdge + Math.sqrt(rawEdge * rawEdge + MACRO_EDGE_SMOOTH_SQ));
          const seSq = smoothEdge * smoothEdge;
          const wBlend = win / (seSq + MACRO_R0_SQ);
          const wLocal = wBlend / (seSq + MACRO_LOCAL_R0_SQ);
          spineBlendW += wBlend;
          spineLocalW += wLocal;
          spineLocalY += wLocal * ys[j]!;
          if (includeMetadata) {
            spineDhX += wLocal * fwdX[j]!;
            spineDhZ += wLocal * fwdZ[j]!;
          }
        }
      }

      if (mn.useUpstreamExt) {
        const uDx =
          wx < mn.upBoundsMinX
            ? mn.upBoundsMinX - wx
            : wx > mn.upBoundsMaxX
              ? wx - mn.upBoundsMaxX
              : 0;
        const uDz =
          wz < mn.upBoundsMinZ
            ? mn.upBoundsMinZ - wz
            : wz > mn.upBoundsMaxZ
              ? wz - mn.upBoundsMaxZ
              : 0;
        if (uDx * uDx + uDz * uDz <= MACRO_WIN_OUT_SQ) {
          const uCount = mn.upExtCount;
          const ux = mn.upExtX;
          const uy = mn.upExtY;
          const uz = mn.upExtZ;
          const uHw = mn.upExtHalfWidth;
          let uLocalW = 0;
          for (let j = 0; j < uCount; j++) {
            const dx = wx - ux[j]!;
            const dz = wz - uz[j]!;
            const rSq = dx * dx + dz * dz;
            if (rSq < spineMinRSq) spineMinRSq = rSq;
            if (rSq >= MACRO_WIN_OUT_SQ) continue;
            const r = Math.sqrt(rSq);
            const rawEdge = r - uHw;
            if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
            const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
            const smoothEdge = 0.5 * (rawEdge + Math.sqrt(rawEdge * rawEdge + MACRO_EDGE_SMOOTH_SQ));
            const seSq = smoothEdge * smoothEdge;
            const wBlend = win / (seSq + MACRO_R0_SQ);
            const wLocal = wBlend / (seSq + MACRO_LOCAL_R0_SQ);
            spineBlendW += wBlend;
            uLocalW += wLocal;
            spineLocalY += wLocal * uy[j]!;
          }
          if (uLocalW > 0) {
            spineLocalW += uLocalW;
            if (includeMetadata) {
              spineDhX += uLocalW * mn.upExtFwdX;
              spineDhZ += uLocalW * mn.upExtFwdZ;
            }
          }
        }
      }

      if (mn.useDownstreamExt) {
        const dDx =
          wx < mn.downBoundsMinX
            ? mn.downBoundsMinX - wx
            : wx > mn.downBoundsMaxX
              ? wx - mn.downBoundsMaxX
              : 0;
        const dDz =
          wz < mn.downBoundsMinZ
            ? mn.downBoundsMinZ - wz
            : wz > mn.downBoundsMaxZ
              ? wz - mn.downBoundsMaxZ
              : 0;
        if (dDx * dDx + dDz * dDz <= MACRO_WIN_OUT_SQ) {
          const dClear = nearClear[i] ?? null;
          const dCount = mn.downExtCount;
          const dxArr = mn.downExtX;
          const dyArr = mn.downExtY;
          const dzArr = mn.downExtZ;
          const dHw = mn.downExtHalfWidth;
          let dLocalW = 0;
          for (let j = 0; j < dCount; j++) {
            const extScale = dClear ? dClear[j]! : 1;
            if (extScale <= 0) continue;
            const dx = wx - dxArr[j]!;
            const dz = wz - dzArr[j]!;
            const rSq = dx * dx + dz * dz;
            if (rSq < spineMinRSq) spineMinRSq = rSq;
            if (rSq >= MACRO_WIN_OUT_SQ) continue;
            const r = Math.sqrt(rSq);
            const rawEdge = r - dHw;
            if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
            const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
            const invD2 = 1 / (rSq + MACRO_DOWN_EXT_R0_SQ);
            const wBlend = win * extScale * invD2;
            const wLocal = wBlend * invD2;
            spineBlendW += wBlend;
            dLocalW += wLocal;
            spineLocalY += wLocal * dyArr[j]!;
          }
          if (dLocalW > 0) {
            spineLocalW += dLocalW;
            if (includeMetadata) {
              spineDhX += dLocalW * mn.downExtFwdX;
              spineDhZ += dLocalW * mn.downExtFwdZ;
            }
          }
        }
      }

      if (spineBlendW > 0 && spineLocalW > 1e-24) {
        const scale = spineBlendW / spineLocalW;
        sumW += spineBlendW;
        weightedMacroY += spineLocalY * scale;
        if (includeMetadata) {
          downhillAccX += spineDhX * scale;
          downhillAccZ += spineDhZ * scale;
          const sIdx = stageIdxArr[spGlobalIdx]!;
          if (stageW[sIdx] === 0) {
            stageTouched[touchedStages++] = sIdx;
          }
          stageW[sIdx] = stageW[sIdx]! + spineBlendW;
        }
      }

      if (spineMinRSq < minNodeDistSq) minNodeDistSq = spineMinRSq;
      if (spineMinRSq < closestSpineDistSq) {
        secondClosestSpineIdx = closestSpineIdx;
        secondClosestDistSq = closestSpineDistSq;
        closestSpineIdx = spGlobalIdx;
        closestSpineDistSq = spineMinRSq;
      } else if (spineMinRSq < secondClosestDistSq) {
        secondClosestSpineIdx = spGlobalIdx;
        secondClosestDistSq = spineMinRSq;
      }
    }

    mOut.sumW = sumW;
    mOut.macroY = sumW > 1e-12 ? weightedMacroY / sumW : 0;
    mOut.downhillAccX = downhillAccX;
    mOut.downhillAccZ = downhillAccZ;
    mOut.minNodeDistSq = minNodeDistSq;
    mOut.minEdgeDist = minEdgeDist;
    mOut.closestSpineIdx = closestSpineIdx;
    mOut.closestSpineDistSq = closestSpineDistSq;
    mOut.secondClosestSpineIdx = secondClosestSpineIdx;
    mOut.secondClosestDistSq = secondClosestDistSq;
    mOut.touchedStages = touchedStages;
  }

  private evalGridFarMacro(wx: number, wz: number, includeMetadata: boolean): void {
    const mOut = this.gridMacroOut;
    const allCount = this.macroCacheAllCount;
    const sStart = this.macroSpineStart;
    const sEnd = this.macroSpineEnd;
    const sMinX = this.macroSpineMinX;
    const sMaxX = this.macroSpineMaxX;
    const sMinZ = this.macroSpineMinZ;
    const sMaxZ = this.macroSpineMaxZ;
    const nX = this.macroNodeX;
    const nY = this.macroNodeY;
    const nZ = this.macroNodeZ;
    const nHw = this.macroNodeHw;
    const nSc = this.macroNodeScale;
    const nFx = this.macroNodeFwdX;
    const nFz = this.macroNodeFwdZ;

    // 1. Exact global trueMinSq (skip completely if Pass 2A already found a node < 240m!)
    let trueMinSq = mOut.minNodeDistSq < MACRO_WIN_OUT_SQ ? mOut.minNodeDistSq : Infinity;
    if (trueMinSq >= MACRO_WIN_OUT_SQ) {
      const hintIdx = this.farHintSpineIdx < allCount ? this.farHintSpineIdx : 0;
      for (let pass = 0; pass < 2; pass++) {
        const iStart = pass === 0 ? hintIdx : 0;
        const iEnd = pass === 0 ? hintIdx + 1 : allCount;
        for (let i = iStart; i < iEnd; i++) {
          if (pass === 1 && i === hintIdx) continue;
          const x0 = sMinX[i]!;
          const x1 = sMaxX[i]!;
          const z0 = sMinZ[i]!;
          const z1 = sMaxZ[i]!;
          const cDx = wx < x0 ? x0 - wx : wx > x1 ? wx - x1 : 0;
          const cDz = wz < z0 ? z0 - wz : wz > z1 ? wz - z1 : 0;
          if (cDx * cDx + cDz * cDz >= trueMinSq) continue;

          const start = sStart[i]!;
          const end = sEnd[i]!;
          for (let j = start; j < end; j++) {
            const dx = wx - nX[j]!;
            const dz = wz - nZ[j]!;
            const rSq = dx * dx + dz * dz;
            if (rSq < trueMinSq) {
              trueMinSq = rSq;
              this.farHintSpineIdx = i;
            }
          }
        }
      }
    }

    // 2. Single flat-TypedArray accumulation loop over spines within farWinOut
    const trueMinDist = Math.sqrt(trueMinSq);
    const farWinIn = trueMinDist + MACRO_FAR_WIN_IN_OFFSET_M;
    const farWinInSq = farWinIn * farWinIn;
    const farWinOut = trueMinDist + MACRO_FAR_WIN_OUT_OFFSET_M;
    const farWinOutSq = farWinOut * farWinOut;
    const needEdgeDist = trueMinDist < OUTER_RIM_SATURATE_DIST_M;

    let minEdgeDist = mOut.minEdgeDist;
    if (!needEdgeDist && minEdgeDist > OUTER_RIM_END_M) {
      minEdgeDist = OUTER_RIM_END_M;
    }

    let farSumW = 0;
    let farWeightedY = 0;
    let farDownhillX = 0;
    let farDownhillZ = 0;
    let closestSpineIdx = mOut.closestSpineIdx;
    let closestSpineDistSq = mOut.closestSpineDistSq;
    let secondClosestSpineIdx = mOut.secondClosestSpineIdx;
    let secondClosestDistSq = mOut.secondClosestDistSq;
    const needFarStage = includeMetadata && mOut.sumW <= 1e-12;
    let touchedStages = mOut.touchedStages;
    const stageIdxArr = this.macroSpineStageIdx;
    const stageW = this.gridStageWeightsScratch;
    const stageTouched = this.gridStageTouchedScratch;

    for (let i = 0; i < allCount; i++) {
      const x0 = sMinX[i]!;
      const x1 = sMaxX[i]!;
      const z0 = sMinZ[i]!;
      const z1 = sMaxZ[i]!;
      const cDx = wx < x0 ? x0 - wx : wx > x1 ? wx - x1 : 0;
      const cDz = wz < z0 ? z0 - wz : wz > z1 ? wz - z1 : 0;
      if (cDx * cDx + cDz * cDz >= farWinOutSq) continue;

      const start = sStart[i]!;
      const end = sEnd[i]!;
      let spineFarW = 0;
      let spineMinRSq = Infinity;

      if (!needEdgeDist) {
        for (let j = start; j < end; j++) {
          const dx = wx - nX[j]!;
          const dz = wz - nZ[j]!;
          const rSq = dx * dx + dz * dz;
          if (rSq < spineMinRSq) spineMinRSq = rSq;
          if (rSq >= farWinOutSq) continue;
          const win =
            rSq <= farWinInSq ? 1 : 1 - smootherstep(farWinIn, farWinOut, Math.sqrt(rSq));
          const w = (win * nSc[j]!) / (rSq + MACRO_FAR_R0_SQ);
          farSumW += w;
          farWeightedY += w * nY[j]!;
          spineFarW += w;
          if (includeMetadata) {
            farDownhillX += w * nFx[j]!;
            farDownhillZ += w * nFz[j]!;
          }
        }
      } else {
        for (let j = start; j < end; j++) {
          const dx = wx - nX[j]!;
          const dz = wz - nZ[j]!;
          const rSq = dx * dx + dz * dz;
          if (rSq < spineMinRSq) spineMinRSq = rSq;
          if (rSq >= farWinOutSq) continue;
          const r = Math.sqrt(rSq);
          const edgeD = r - nHw[j]!;
          if (edgeD < minEdgeDist) minEdgeDist = edgeD > 0 ? edgeD : 0;
          const win = rSq <= farWinInSq ? 1 : 1 - smootherstep(farWinIn, farWinOut, r);
          const w = (win * nSc[j]!) / (rSq + MACRO_FAR_R0_SQ);
          farSumW += w;
          farWeightedY += w * nY[j]!;
          spineFarW += w;
          if (includeMetadata) {
            farDownhillX += w * nFx[j]!;
            farDownhillZ += w * nFz[j]!;
          }
        }
      }

      if (spineMinRSq < closestSpineDistSq) {
        secondClosestSpineIdx = closestSpineIdx;
        secondClosestDistSq = closestSpineDistSq;
        closestSpineIdx = i;
        closestSpineDistSq = spineMinRSq;
      } else if (spineMinRSq < secondClosestDistSq) {
        secondClosestSpineIdx = i;
        secondClosestDistSq = spineMinRSq;
      }
      if (needFarStage && spineFarW > 0) {
        const sIdx = stageIdxArr[i]!;
        if (stageW[sIdx] === 0) {
          stageTouched[touchedStages++] = sIdx;
        }
        stageW[sIdx] = stageW[sIdx]! + spineFarW;
      }
    }

    const farMacroY = farSumW > 1e-24 ? farWeightedY / farSumW : 0;
    if (mOut.sumW <= 1e-12) {
      mOut.macroY = farMacroY;
      mOut.sumW = farSumW;
      if (includeMetadata) {
        mOut.downhillAccX = farDownhillX;
        mOut.downhillAccZ = farDownhillZ;
      }
    } else {
      const farT = smootherstep(MACRO_FAR_BLEND_START_M, MACRO_FAR_BLEND_END_M, trueMinDist);
      mOut.macroY = lerp(mOut.macroY, farMacroY, farT);
      if (includeMetadata && farT > 0 && farSumW > 1e-24) {
        const invNear = 1 / mOut.sumW;
        const invFar = 1 / farSumW;
        mOut.downhillAccX = lerp(mOut.downhillAccX * invNear, farDownhillX * invFar, farT);
        mOut.downhillAccZ = lerp(mOut.downhillAccZ * invNear, farDownhillZ * invFar, farT);
      }
    }

    mOut.minEdgeDist = minEdgeDist;
    mOut.closestSpineIdx = closestSpineIdx;
    mOut.closestSpineDistSq = closestSpineDistSq;
    mOut.secondClosestSpineIdx = secondClosestSpineIdx;
    mOut.secondClosestDistSq = secondClosestDistSq;
    mOut.touchedStages = touchedStages;
  }

  private evalGridCorridorRelief(
    wx: number,
    wz: number,
    absX: number,
    absZ: number,
    minEdgeDist: number,
    oneMinusReliefPisteW: number,
  ): void {
    const rOut = this.gridReliefOut;
    let posD = 0;
    let posW = 0;
    let negD = 0;
    let negW = 0;
    let chasmD = 0;
    let chasmW = 0;
    let maxChasmWipeoutDepth = 0;

    const corrSpines = this.stripCorridorSpinesScratch;
    const corrClear = this.stripCorridorClearScratch;
    const corrLand = this.stripCorridorLandscapeScratch;
    const cCount = corrSpines.length;

    for (let i = 0; i < cCount; i++) {
      const sp = corrSpines[i]!;
      const left = sp.corridorLeft!;
      const right = sp.corridorRight!;

      const inLeft =
        wx >= left.boundsMinX &&
        wx <= left.boundsMaxX &&
        wz >= left.boundsMinZ &&
        wz <= left.boundsMaxZ;
      const inRight =
        wx >= right.boundsMinX &&
        wx <= right.boundsMaxX &&
        wz >= right.boundsMinZ &&
        wz <= right.boundsMaxZ;
      if (!inLeft && !inRight) continue;

      const clearEntry = corrClear[i];
      const landscape = corrLand[i]!;

      if (inLeft) {
        const clearArr = clearEntry?.left;
        const count = left.count;
        const xs = left.posX;
        const zs = left.posZ;
        const invRSqs = left.invRadiusSq;
        const kWeights = left.kernelWeight;
        const amps = left.ampMag;
        let sideD = 0;
        let sideAmp = 0;
        let rimD = 0;
        let rimAmp = 0;
        for (let k = 0; k < count; k++) {
          const dx = wx - xs[k]!;
          const dz = wz - zs[k]!;
          const q = (dx * dx + dz * dz) * invRSqs[k]!;
          if (q >= 1) continue;
          const cScale = clearArr ? clearArr[k]! : 1;
          const kw = kWeights[k]!;
          if (cScale <= 0 || kw <= 0) continue;
          const u = 1 - q;
          const kern = kw * cScale * (u * u * u);
          const a = amps[k]!;
          if (a >= 0) {
            sideD += kern;
            sideAmp += kern * a;
          } else {
            rimD += kern;
            rimAmp += kern * -a;
          }
        }
        if (sideD > 1e-7) {
          const spec = landscape.left;
          const mod = this.evaluateSideModulation(spec, absX, absZ);
          const signedW = sideAmp * mod;
          if (signedW >= 0) {
            posD += sideD;
            posW += signedW;
          } else {
            negD += sideD;
            negW += signedW;
          }
          if (spec.archetype === 'chasm') {
            chasmD += sideD;
            chasmW += signedW;
            if (spec.chasmWipeoutDepth > maxChasmWipeoutDepth) {
              maxChasmWipeoutDepth = spec.chasmWipeoutDepth;
            }
          }
        }
        if (rimD > 1e-7) {
          const spec = landscape.left;
          const rimMod =
            0.78 +
            0.22 *
              smoothRidgedNoise2D(
                absX * spec.noiseFrequency,
                absZ * spec.noiseFrequency,
                202,
                2,
                2.0,
                0.5,
              );
          posD += rimD;
          posW += rimAmp * rimMod;
        }
      }

      if (inRight) {
        const clearArr = clearEntry?.right;
        const count = right.count;
        const xs = right.posX;
        const zs = right.posZ;
        const invRSqs = right.invRadiusSq;
        const kWeights = right.kernelWeight;
        const amps = right.ampMag;
        let sideD = 0;
        let sideAmp = 0;
        let rimD = 0;
        let rimAmp = 0;
        for (let k = 0; k < count; k++) {
          const dx = wx - xs[k]!;
          const dz = wz - zs[k]!;
          const q = (dx * dx + dz * dz) * invRSqs[k]!;
          if (q >= 1) continue;
          const cScale = clearArr ? clearArr[k]! : 1;
          const kw = kWeights[k]!;
          if (cScale <= 0 || kw <= 0) continue;
          const u = 1 - q;
          const kern = kw * cScale * (u * u * u);
          const a = amps[k]!;
          if (a >= 0) {
            sideD += kern;
            sideAmp += kern * a;
          } else {
            rimD += kern;
            rimAmp += kern * -a;
          }
        }
        if (sideD > 1e-7) {
          const spec = landscape.right;
          const mod = this.evaluateSideModulation(spec, absX, absZ);
          const signedW = sideAmp * mod;
          if (signedW >= 0) {
            posD += sideD;
            posW += signedW;
          } else {
            negD += sideD;
            negW += signedW;
          }
          if (spec.archetype === 'chasm') {
            chasmD += sideD;
            chasmW += signedW;
            if (spec.chasmWipeoutDepth > maxChasmWipeoutDepth) {
              maxChasmWipeoutDepth = spec.chasmWipeoutDepth;
            }
          }
        }
        if (rimD > 1e-7) {
          const spec = landscape.right;
          const rimMod =
            0.78 +
            0.22 *
              smoothRidgedNoise2D(
                absX * spec.noiseFrequency,
                absZ * spec.noiseFrequency,
                202,
                2,
                2.0,
                0.5,
              );
          posD += rimD;
          posW += rimAmp * rimMod;
        }
      }
    }

    const totalD = posD + negD;
    const denom =
      0.5 * (1 + totalD + Math.sqrt((totalD - 1) * (totalD - 1) + CORRIDOR_SMAX_EPS_SQ));
    const corridorDH = totalD > 1e-7 ? (posW + negW) / denom : 0;
    const reliefOffMask = clamp(oneMinusReliefPisteW, 0, 1);
    const reliefFade = reliefOffMask * reliefOffMask;
    const alpineUndulation =
      ALPINE_UNDULATION_AMP_M *
      fbm2D(absX * ALPINE_UNDULATION_FREQ, absZ * ALPINE_UNDULATION_FREQ, 404, 2, 2.0, 0.5);
    const outerRim = this.evaluateOuterValleyRim(minEdgeDist, absX, absZ);

    rOut.offPisteRelief = (corridorDH + alpineUndulation + outerRim) * reliefFade;
    rOut.chasmD = chasmD;
    rOut.chasmRelief = chasmD > 1e-7 ? (chasmW / denom) * reliefFade : 0;
    rOut.maxChasmWipeoutDepth = maxChasmWipeoutDepth;
  }

  /**
   * High-throughput modular grid column evaluator used exclusively by `sampleColumnGrid`.
   * Split into compact V8-TurboFan-friendly passes with cached flat macro nodes, Pass-1
   * projection reuse, integer stage weights, and `skipMacroOnFullPiste = true`.
   */
  private evaluateGridColumnCore(
    wx: number,
    wz: number,
    out: MountainColumnOut,
    allSpines: readonly SpineView[],
    includeMetadata: boolean,
  ): MountainColumnOut {
    this.interiorSinglePisteSpine = null;
    if (allSpines.length === 0) {
      return this.populateEmptyFallback(wx, wz, out);
    }
    if (!this.macroCacheValid) {
      return this.evaluateColumnCore(wx, wz, out, allSpines, includeMetadata, true);
    }

    this.evalGridPistePass(wx, wz);
    const p1 = this.gridPass1Out;

    if (p1.isFullPiste && p1.dominantPisteSpine !== null) {
      if (!includeMetadata) {
        out.heightY = p1.finalPisteH;
        return out;
      }
      const domSp = p1.dominantPisteSpine;
      const np = this.nearestProjScratch;
      if (
        p1.pisteNearCount === 1 &&
        Math.abs(p1.dominantPisteSignedX) <= np.halfWidth - 0.75 &&
        p1.dominantPisteS >= 1.0 &&
        p1.dominantPisteS <= domSp.length - 1.0
      ) {
        this.interiorSinglePisteSpine = domSp;
      }
      out.heightY = p1.finalPisteH;
      out.macroY = np.spineY;
      out.pisteWeight = p1.totalPisteW;
      out.onPiste = true;
      out.pisteSurfaceType = domSp.evaluatePisteSurface(p1.dominantPisteS, p1.dominantPisteSignedX);
      out.inDivider = p1.dominantPisteInDivider;
      out.dividerMask = p1.dominantPisteDividerMask;
      out.inChasmZone = false;
      out.chasmWipeoutDepth = 0;
      out.chasmRelief = 0;
      out.chasmDepthBelowSpine = 0;
      out.nearestSpineY = np.spineY;
      out.nearestSegmentId = domSp.id;
      out.nearestStageId = domSp.stageId;
      out.secondaryStageId = null;
      out.secondaryStageWeight = 0;
      out.nearestS = p1.dominantPisteS;
      out.nearestSignedX = p1.dominantPisteSignedX;
      out.nearestHalfWidth = np.halfWidth;
      out.downhillX = np.forwardX;
      out.downhillY = np.forwardY;
      out.downhillZ = np.forwardZ;
      return out;
    }

    this.evalGridNearMacro(wx, wz, includeMetadata);
    const mOut = this.gridMacroOut;
    if (mOut.minNodeDistSq > MACRO_FAR_BLEND_START_SQ || mOut.sumW <= 1e-12) {
      this.evalGridFarMacro(wx, wz, includeMetadata);
    }

    let offPisteRelief = 0;
    let chasmD = 0;
    let chasmRelief = 0;
    let maxChasmWipeoutDepth = 0;
    if (!p1.isFullPiste) {
      const absX = wx + this.originOffsetX;
      const absZ = wz + this.originOffsetZ;
      this.evalGridCorridorRelief(
        wx,
        wz,
        absX,
        absZ,
        mOut.minEdgeDist,
        p1.oneMinusReliefPisteW,
      );
      offPisteRelief = this.gridReliefOut.offPisteRelief;
      chasmD = this.gridReliefOut.chasmD;
      chasmRelief = this.gridReliefOut.chasmRelief;
      maxChasmWipeoutDepth = this.gridReliefOut.maxChasmWipeoutDepth;
    }

    const macroY = mOut.macroY;
    const pisteTargetH = p1.hasPiste ? p1.finalPisteH : macroY;
    const totalPisteW = p1.totalPisteW;
    const heightBlendW =
      totalPisteW >= 1 - 1e-9
        ? 1
        : totalPisteW <= 0
          ? 0
          : (0.31 * totalPisteW) / (1 - 0.69 * totalPisteW);
    const heightY = lerp(macroY, pisteTargetH, heightBlendW) + offPisteRelief;

    if (!includeMetadata) {
      out.heightY = heightY;
      return out;
    }

    const closestSp = mOut.closestSpineIdx >= 0 ? allSpines[mOut.closestSpineIdx]! : allSpines[0]!;
    const secondSp = mOut.secondClosestSpineIdx >= 0 ? allSpines[mOut.secondClosestSpineIdx]! : null;
    let nearestSpine: SpineView = p1.dominantPisteSpine ?? closestSp;
    let nearestSignedX: number;
    let nearestHalfWidth: number;
    let nearestSpineY: number;
    let nearestS: number;
    let fallbackFwdX = 0;
    let fallbackFwdZ = -1;

    if (p1.dominantPisteSpine !== null) {
      const np = this.nearestProjScratch;
      nearestSignedX = np.signedX;
      nearestHalfWidth = np.halfWidth;
      nearestSpineY = np.spineY;
      nearestS = np.s;
      fallbackFwdX = np.forwardX;
      fallbackFwdZ = np.forwardZ;
    } else if (mOut.minEdgeDist > GRID_SKIP_PROJ_EDGE_DIST_M && mOut.sumW > 1e-12) {
      nearestHalfWidth = 14;
      nearestSignedX = mOut.minEdgeDist + 14;
      nearestSpineY = macroY;
      nearestS = 0;
    } else if (
      p1.bestProjSpine !== null &&
      p1.bestProjSpine.id === nearestSpine.id &&
      (secondSp === null ||
        secondSp.id === nearestSpine.id ||
        Math.sqrt(p1.bestProjDistSq) + 16 < Math.sqrt(mOut.secondClosestDistSq))
    ) {
      // Reuse exact Pass-1 projection without re-running projectXZ!
      const bp = this.pass1BestProjScratch;
      nearestSignedX = bp.signedX;
      nearestHalfWidth = bp.halfWidth;
      nearestSpineY = bp.spineY;
      nearestS = bp.s;
      fallbackFwdX = bp.forwardX;
      fallbackFwdZ = bp.forwardZ;
    } else {
      nearestSpine.projectXZ(wx, wz, this.nearestProjScratch);
      if (secondSp !== null && secondSp.id !== nearestSpine.id) {
        secondSp.projectXZ(wx, wz, this.altProjScratch);
        if (this.altProjScratch.distSq < this.nearestProjScratch.distSq) {
          nearestSpine = secondSp;
          this.copyProjection(this.altProjScratch, this.nearestProjScratch);
        }
      }
      const np = this.nearestProjScratch;
      nearestSignedX = np.signedX;
      nearestHalfWidth = np.halfWidth;
      nearestSpineY = np.spineY;
      nearestS = np.s;
      fallbackFwdX = np.forwardX;
      fallbackFwdZ = np.forwardZ;
    }

    const dLen = Math.hypot(mOut.downhillAccX, mOut.downhillAccZ);
    let dhX = fallbackFwdX;
    let dhZ = fallbackFwdZ;
    if (dLen > 1e-6) {
      const invD = 1 / dLen;
      dhX = mOut.downhillAccX * invD;
      dhZ = mOut.downhillAccZ * invD;
    }

    // Resolve secondary stage from integer-indexed scratch & zero touched entries for next texel!
    const primStageIdx = this.internStageId(nearestSpine.stageId);
    const stageW = this.gridStageWeightsScratch;
    const stageTouched = this.gridStageTouchedScratch;
    const touchedCount = mOut.touchedStages;
    let bestSecIdx = -1;
    let bestSecW = 0;
    for (let i = 0; i < touchedCount; i++) {
      const sIdx = stageTouched[i]!;
      const sw = stageW[sIdx]!;
      stageW[sIdx] = 0;
      if (sIdx !== primStageIdx && sw > bestSecW) {
        bestSecW = sw;
        bestSecIdx = sIdx;
      }
    }
    let secondaryStageId: string | null = null;
    let secondaryStageWeight = 0;
    if (bestSecIdx >= 0 && bestSecW > 1e-12 && mOut.sumW > 1e-12) {
      secondaryStageId = this._stageIdTable[bestSecIdx] ?? null;
      secondaryStageWeight = clamp(bestSecW / mOut.sumW, 0, 1);
    }

    const onPiste = heightBlendW >= 0.5;
    let pisteSurfaceType: PisteSurfaceType = 'powder';
    let inDivider = false;
    let dividerMask = 0;
    if (totalPisteW > 0 && p1.dominantPisteSpine !== null) {
      pisteSurfaceType = p1.dominantPisteSpine.evaluatePisteSurface(
        p1.dominantPisteS,
        p1.dominantPisteSignedX,
      );
      inDivider = p1.dominantPisteInDivider;
      dividerMask = p1.dominantPisteDividerMask;
    }

    const inChasmZone =
      !onPiste && chasmD > 0.05 && maxChasmWipeoutDepth > 0 && chasmRelief < -3.0;

    out.heightY = heightY;
    out.macroY = macroY;
    out.pisteWeight = heightBlendW;
    out.onPiste = onPiste;
    out.pisteSurfaceType = pisteSurfaceType;
    out.inDivider = inDivider;
    out.dividerMask = dividerMask;
    out.inChasmZone = inChasmZone;
    out.chasmWipeoutDepth = inChasmZone ? maxChasmWipeoutDepth : 0;
    out.chasmRelief = chasmRelief;
    out.chasmDepthBelowSpine = Math.max(0, macroY - heightY);
    out.nearestSpineY = nearestSpineY;
    out.nearestSegmentId = nearestSpine.id;
    out.nearestStageId = nearestSpine.stageId;
    out.secondaryStageId = secondaryStageId;
    out.secondaryStageWeight = secondaryStageWeight;
    out.nearestS = nearestS;
    out.nearestSignedX = nearestSignedX;
    out.nearestHalfWidth = nearestHalfWidth;
    out.downhillX = dhX;
    out.downhillY = 0;
    out.downhillZ = dhZ;
    return out;
  }

  private populateNormalAndSurface(
    wx: number,
    wz: number,
    out: MountainSampleOut,
    candidateSpines: readonly SpineView[] | undefined,
  ): void {
    let hL: number;
    let hR: number;
    let hD: number;
    let hU: number;
    const singleSp = this.interiorSinglePisteSpine;
    if (singleSp !== null) {
      // Exact interior-piste central-difference fast path (skips 4x evaluateColumnCore overhead)
      const p = this.projScratch;
      const ph = this.pisteScratch;
      singleSp.projectXZ(wx - NORMAL_SAMPLE_EPS_M, wz, p);
      singleSp.evaluatePisteHeight(p.s, p.signedX, ph);
      hL = ph.heightY;
      singleSp.projectXZ(wx + NORMAL_SAMPLE_EPS_M, wz, p);
      singleSp.evaluatePisteHeight(p.s, p.signedX, ph);
      hR = ph.heightY;
      singleSp.projectXZ(wx, wz - NORMAL_SAMPLE_EPS_M, p);
      singleSp.evaluatePisteHeight(p.s, p.signedX, ph);
      hD = ph.heightY;
      singleSp.projectXZ(wx, wz + NORMAL_SAMPLE_EPS_M, p);
      singleSp.evaluatePisteHeight(p.s, p.signedX, ph);
      hU = ph.heightY;
    } else {
      let evalSpines = candidateSpines;
      if (!evalSpines || evalSpines.length === 0) {
        this.collectSpinesInBounds(
          wx - NORMAL_SAMPLE_EPS_M,
          wx + NORMAL_SAMPLE_EPS_M,
          wz - NORMAL_SAMPLE_EPS_M,
          wz + NORMAL_SAMPLE_EPS_M,
          310,
          this.evalSpinesScratch,
        );
        evalSpines = this.evalSpinesScratch;
      }
      hL = this.evaluateHeight(wx - NORMAL_SAMPLE_EPS_M, wz, evalSpines);
      hR = this.evaluateHeight(wx + NORMAL_SAMPLE_EPS_M, wz, evalSpines);
      hD = this.evaluateHeight(wx, wz - NORMAL_SAMPLE_EPS_M, evalSpines);
      hU = this.evaluateHeight(wx, wz + NORMAL_SAMPLE_EPS_M, evalSpines);
    }

    const span = 2 * NORMAL_SAMPLE_EPS_M;
    const dHx = (hR - hL) / span;
    const dHz = (hU - hD) / span;
    const invLen = 1 / Math.hypot(-dHx, 1, -dHz);

    out.normalX = -dHx * invLen;
    out.normalY = invLen;
    out.normalZ = -dHz * invLen;
    out.surfaceType =
      !out.onPiste && out.normalY < ROCK_SLOPE_NORMAL_Y_THRESHOLD ? 'rock' : out.pisteSurfaceType;
  }

  private handleTopologyChange(
    isReset: boolean,
    worldDirtyRects: readonly WorldDirtyRect[],
  ): void {
    this._fieldRevision++;
    if (isReset) {
      this._dirtyRects.length = 0;
      const spines = this.spineSource.elevationSpines;
      if (spines.length > 0) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < spines.length; i++) {
          const sp = spines[i]!;
          if (sp.boundsMinX < minX) minX = sp.boundsMinX;
          if (sp.boundsMaxX > maxX) maxX = sp.boundsMaxX;
          if (sp.boundsMinZ < minZ) minZ = sp.boundsMinZ;
          if (sp.boundsMaxZ > maxZ) maxZ = sp.boundsMaxZ;
          const mn = sp.macroNodes;
          if (mn !== undefined) {
            if (mn.useUpstreamExt && mn.upBoundsMinX <= mn.upBoundsMaxX) {
              if (mn.upBoundsMinX < minX) minX = mn.upBoundsMinX;
              if (mn.upBoundsMaxX > maxX) maxX = mn.upBoundsMaxX;
              if (mn.upBoundsMinZ < minZ) minZ = mn.upBoundsMinZ;
              if (mn.upBoundsMaxZ > maxZ) maxZ = mn.upBoundsMaxZ;
            }
            if (mn.useDownstreamExt && mn.downBoundsMinX <= mn.downBoundsMaxX) {
              if (mn.downBoundsMinX < minX) minX = mn.downBoundsMinX;
              if (mn.downBoundsMaxX > maxX) maxX = mn.downBoundsMaxX;
              if (mn.downBoundsMinZ < minZ) minZ = mn.downBoundsMinZ;
              if (mn.downBoundsMaxZ > maxZ) maxZ = mn.downBoundsMaxZ;
            }
          }
          const cl = sp.corridorLeft;
          if (cl !== undefined && cl.boundsMinX <= cl.boundsMaxX) {
            if (cl.boundsMinX < minX) minX = cl.boundsMinX;
            if (cl.boundsMaxX > maxX) maxX = cl.boundsMaxX;
            if (cl.boundsMinZ < minZ) minZ = cl.boundsMinZ;
            if (cl.boundsMaxZ > maxZ) maxZ = cl.boundsMaxZ;
          }
          const cr = sp.corridorRight;
          if (cr !== undefined && cr.boundsMinX <= cr.boundsMaxX) {
            if (cr.boundsMinX < minX) minX = cr.boundsMinX;
            if (cr.boundsMaxX > maxX) maxX = cr.boundsMaxX;
            if (cr.boundsMinZ < minZ) minZ = cr.boundsMinZ;
            if (cr.boundsMaxZ > maxZ) maxZ = cr.boundsMaxZ;
          }
        }
        this._dirtyRects.push({
          minAbsX: minX - MACRO_WIN_OUT_M + this.originOffsetX,
          maxAbsX: maxX + MACRO_WIN_OUT_M + this.originOffsetX,
          minAbsZ: minZ - MACRO_WIN_OUT_M + this.originOffsetZ,
          maxAbsZ: maxZ + MACRO_WIN_OUT_M + this.originOffsetZ,
        });
      }
    } else {
      for (let i = 0; i < worldDirtyRects.length; i++) {
        const r = worldDirtyRects[i]!;
        this.pushDirtyRect(
          r.minX + this.originOffsetX,
          r.maxX + this.originOffsetX,
          r.minZ + this.originOffsetZ,
          r.maxZ + this.originOffsetZ,
        );
      }
    }
    this.rebuildClearanceCache(this.spineSource.elevationSpines, isReset);
  }

  private pushDirtyRect(
    minAbsX: number,
    maxAbsX: number,
    minAbsZ: number,
    maxAbsZ: number,
  ): void {
    if (this._dirtyRects.length >= MAX_ACCUMULATED_DIRTY_RECTS) {
      let uMinX = minAbsX;
      let uMaxX = maxAbsX;
      let uMinZ = minAbsZ;
      let uMaxZ = maxAbsZ;
      for (let i = 0; i < this._dirtyRects.length; i++) {
        const cur = this._dirtyRects[i]!;
        if (cur.minAbsX < uMinX) uMinX = cur.minAbsX;
        if (cur.maxAbsX > uMaxX) uMaxX = cur.maxAbsX;
        if (cur.minAbsZ < uMinZ) uMinZ = cur.minAbsZ;
        if (cur.maxAbsZ > uMaxZ) uMaxZ = cur.maxAbsZ;
      }
      this._dirtyRects.length = 0;
      this._dirtyRects.push({
        minAbsX: uMinX,
        maxAbsX: uMaxX,
        minAbsZ: uMinZ,
        maxAbsZ: uMaxZ,
      });
      return;
    }
    this._dirtyRects.push({ minAbsX, maxAbsX, minAbsZ, maxAbsZ });
  }

  private syncClearanceIfNeeded(allSpines: readonly SpineView[]): void {
    const count = allSpines.length;
    const firstId = count > 0 ? allSpines[0]!.id : -1;
    const lastId = count > 0 ? allSpines[count - 1]!.id : -1;
    if (
      this.topologySyncedRevision === this._fieldRevision &&
      this.clearSyncedSpineCount === count &&
      this.clearSyncedFirstId === firstId &&
      this.clearSyncedLastId === lastId
    ) {
      return;
    }
    this.rebuildClearanceCache(allSpines, false);
  }

  private rebuildClearanceCache(allSpines: readonly SpineView[], forceFull: boolean): void {
    this.topologySyncedRevision = this._fieldRevision;
    this.clearSyncedSpineCount = allSpines.length;
    this.clearSyncedFirstId = allSpines.length > 0 ? allSpines[0]!.id : -1;
    this.clearSyncedLastId = allSpines.length > 0 ? allSpines[allSpines.length - 1]!.id : -1;

    this.activeIdsScratch.clear();
    this.addedIdsScratch.clear();
    this.addedSpinesScratch.length = 0;
    this.removedSpinesScratch.length = 0;

    for (let i = 0; i < allSpines.length; i++) {
      this.activeIdsScratch.add(allSpines[i]!.id);
    }
    for (const [id, entry] of this.clearScaleCache.entries()) {
      if (!this.activeIdsScratch.has(id)) {
        this.removedSpinesScratch.push(entry.spine);
        this.clearScaleCache.delete(id);
      }
    }

    let needFullRebuild = forceFull;
    for (let i = 0; i < allSpines.length; i++) {
      const sp = allSpines[i]!;
      const left = sp.corridorLeft;
      const right = sp.corridorRight;
      if (!left || !right) continue;
      const mn = sp.macroNodes;
      const downLen = mn ? mn.downExtCount : 0;
      const downActive = mn ? mn.useDownstreamExt : false;

      let entry = this.clearScaleCache.get(sp.id);
      if (!entry) {
        entry = {
          spine: sp,
          left: new Float32Array(left.count),
          right: new Float32Array(right.count),
          downExt: downLen > 0 ? new Float32Array(downLen) : null,
          downExtActive: downActive,
        };
        this.clearScaleCache.set(sp.id, entry);
        this.addedSpinesScratch.push(sp);
        this.addedIdsScratch.add(sp.id);
      } else if (entry.left.length !== left.count || entry.right.length !== right.count) {
        entry = {
          spine: sp,
          left: new Float32Array(left.count),
          right: new Float32Array(right.count),
          downExt: downLen > 0 ? new Float32Array(downLen) : null,
          downExtActive: downActive,
        };
        this.clearScaleCache.set(sp.id, entry);
        needFullRebuild = true;
      } else if (downActive && !entry.downExtActive && entry.downExt && mn) {
        // Open-leaf extension just re-enabled on a ghost spine: compute its cross-spine clearance
        entry.downExtActive = true;
        this.computeDownExtClearance(sp, mn, entry.downExt, allSpines);
      } else {
        entry.downExtActive = downActive;
      }
    }

    if (needFullRebuild) {
      for (let i = 0; i < allSpines.length; i++) {
        const sp = allSpines[i]!;
        const left = sp.corridorLeft;
        const right = sp.corridorRight;
        if (!left || !right) continue;
        const entry = this.clearScaleCache.get(sp.id)!;
        this.computeSideClearance(sp, left, entry.left, allSpines);
        this.computeSideClearance(sp, right, entry.right, allSpines);
        if (entry.downExt && sp.macroNodes?.useDownstreamExt) {
          this.computeDownExtClearance(sp, sp.macroNodes, entry.downExt, allSpines);
        }
      }
      return;
    }

    // 1. Newly added spines: compute full clearance against allSpines
    for (let i = 0; i < this.addedSpinesScratch.length; i++) {
      const sp = this.addedSpinesScratch[i]!;
      const left = sp.corridorLeft;
      const right = sp.corridorRight;
      if (!left || !right) continue;
      const entry = this.clearScaleCache.get(sp.id)!;
      this.computeSideClearance(sp, left, entry.left, allSpines);
      this.computeSideClearance(sp, right, entry.right, allSpines);
      if (entry.downExt && sp.macroNodes?.useDownstreamExt) {
        this.computeDownExtClearance(sp, sp.macroNodes, entry.downExt, allSpines);
      }
    }

    // 2. Existing spines: recompute only if corridor/downExt AABB overlapped a removed spine;
    //    otherwise incrementally multiply in any newly added spine whose AABB overlaps.
    const remCount = this.removedSpinesScratch.length;
    const addCount = this.addedSpinesScratch.length;
    if (remCount === 0 && addCount === 0) return;

    for (let i = 0; i < allSpines.length; i++) {
      const sp = allSpines[i]!;
      if (this.addedIdsScratch.has(sp.id)) continue;
      const left = sp.corridorLeft;
      const right = sp.corridorRight;
      if (!left || !right) continue;
      const entry = this.clearScaleCache.get(sp.id)!;

      this.updateExistingSideClearance(sp, left, entry.left, allSpines);
      this.updateExistingSideClearance(sp, right, entry.right, allSpines);
      if (entry.downExt && sp.macroNodes?.useDownstreamExt) {
        this.updateExistingDownExtClearance(sp, sp.macroNodes, entry.downExt, allSpines);
      }
    }
  }

  private updateExistingDownExtClearance(
    owner: SpineView,
    mn: NonNullable<SpineView['macroNodes']>,
    outClear: Float32Array,
    allSpines: readonly SpineView[],
  ): void {
    if (mn.downBoundsMinX > mn.downBoundsMaxX) return;
    for (let r = 0; r < this.removedSpinesScratch.length; r++) {
      if (this.downExtOverlapsSpineBounds(mn, this.removedSpinesScratch[r]!)) {
        this.computeDownExtClearance(owner, mn, outClear, allSpines);
        return;
      }
    }
    for (let a = 0; a < this.addedSpinesScratch.length; a++) {
      const added = this.addedSpinesScratch[a]!;
      if (added.id === owner.id) continue;
      if (this.downExtOverlapsSpineBounds(mn, added)) {
        this.applyOtherToDownExtClearance(mn, outClear, added);
      }
    }
  }

  private downExtOverlapsSpineBounds(
    mn: NonNullable<SpineView['macroNodes']>,
    other: SpineView,
  ): boolean {
    const pad = 175;
    return !(
      mn.downBoundsMaxX < other.boundsMinX - pad ||
      mn.downBoundsMinX > other.boundsMaxX + pad ||
      mn.downBoundsMaxZ < other.boundsMinZ - pad ||
      mn.downBoundsMinZ > other.boundsMaxZ + pad
    );
  }

  private computeDownExtClearance(
    owner: SpineView,
    mn: NonNullable<SpineView['macroNodes']>,
    outClear: Float32Array,
    allSpines: readonly SpineView[],
  ): void {
    outClear.fill(1.0);
    if (allSpines.length <= 1 || mn.downBoundsMinX > mn.downBoundsMaxX) return;
    for (let j = 0; j < allSpines.length; j++) {
      const other = allSpines[j]!;
      if (other.id === owner.id) continue;
      if (!this.downExtOverlapsSpineBounds(mn, other)) continue;
      this.applyOtherToDownExtClearance(mn, outClear, other);
    }
  }

  private applyOtherToDownExtClearance(
    mn: NonNullable<SpineView['macroNodes']>,
    outClear: Float32Array,
    other: SpineView,
  ): void {
    const xs = mn.downExtX;
    const zs = mn.downExtZ;
    const pad = 175;
    for (let k = 0; k < mn.downExtCount; k++) {
      const cur = outClear[k]!;
      if (cur <= 1e-4) continue;
      const nx = xs[k]!;
      const nz = zs[k]!;
      if (
        nx < other.boundsMinX - pad ||
        nx > other.boundsMaxX + pad ||
        nz < other.boundsMinZ - pad ||
        nz > other.boundsMaxZ + pad
      ) {
        continue;
      }
      other.projectXZ(nx, nz, this.projScratch);
      if (Math.abs(this.projScratch.longExt) > 120) continue;
      const d = Math.sqrt(this.projScratch.distSq);
      const hi = this.projScratch.halfWidth + 145;
      if (d >= hi) continue;
      const lo = this.projScratch.halfWidth + 65;
      const atten = smootherstep(lo, hi, d);
      const next = cur * atten;
      outClear[k] = next < 1e-4 ? 0 : next;
    }
  }

  private updateExistingSideClearance(
    owner: SpineView,
    side: SpineCorridorSideView,
    outClear: Float32Array,
    allSpines: readonly SpineView[],
  ): void {
    if (side.boundsMinX > side.boundsMaxX) return;
    for (let r = 0; r < this.removedSpinesScratch.length; r++) {
      const rem = this.removedSpinesScratch[r]!;
      if (this.sideOverlapsSpineBounds(side, rem)) {
        this.computeSideClearance(owner, side, outClear, allSpines);
        return;
      }
    }
    for (let a = 0; a < this.addedSpinesScratch.length; a++) {
      const added = this.addedSpinesScratch[a]!;
      if (added.id === owner.id) continue;
      if (this.sideOverlapsSpineBounds(side, added)) {
        this.applyOtherSpineClearance(side, outClear, added);
      }
    }
  }

  private sideOverlapsSpineBounds(side: SpineCorridorSideView, other: SpineView): boolean {
    return !(
      side.boundsMaxX < other.boundsMinX - CLEARANCE_AABB_PAD_M ||
      side.boundsMinX > other.boundsMaxX + CLEARANCE_AABB_PAD_M ||
      side.boundsMaxZ < other.boundsMinZ - CLEARANCE_AABB_PAD_M ||
      side.boundsMinZ > other.boundsMaxZ + CLEARANCE_AABB_PAD_M
    );
  }

  private computeSideClearance(
    owner: SpineView,
    side: SpineCorridorSideView,
    outClear: Float32Array,
    allSpines: readonly SpineView[],
  ): void {
    outClear.fill(1.0);
    if (allSpines.length <= 1 || side.boundsMinX > side.boundsMaxX) return;

    for (let j = 0; j < allSpines.length; j++) {
      const other = allSpines[j]!;
      if (other.id === owner.id) continue;
      if (!this.sideOverlapsSpineBounds(side, other)) continue;
      this.applyOtherSpineClearance(side, outClear, other);
    }
  }

  private applyOtherSpineClearance(
    side: SpineCorridorSideView,
    outClear: Float32Array,
    other: SpineView,
  ): void {
    for (let k = 0; k < side.count; k++) {
      const curClear = outClear[k]!;
      if (curClear <= 1e-4) continue;
      const bx = side.posX[k]!;
      const bz = side.posZ[k]!;
      const rCap = side.radius[k]!;
      const pad = rCap + 12;
      if (
        bx < other.boundsMinX - pad ||
        bx > other.boundsMaxX + pad ||
        bz < other.boundsMinZ - pad ||
        bz > other.boundsMaxZ + pad
      ) {
        continue;
      }

      other.projectXZ(bx, bz, this.projScratch);
      const absLong = Math.abs(this.projScratch.longExt);
      if (absLong > rCap + 12) continue;

      const dOther = Math.sqrt(this.projScratch.distSq);
      const hwOther = this.projScratch.halfWidth;
      // Full +6m shoulder margin beside other spines; tangential touch (0m extra) past seam ends.
      // Fade corridor walls/chasms cleanly out before reaching another spine's piste shoulder so
      // corridor relief never stacks on top of an inter-spine hillside!
      const sideMask = 1 - smootherstep(0, 16, absLong);
      const sideMargin = 6.0 * (1 - smootherstep(0, 12, absLong));
      const hi = hwOther + rCap + sideMargin + 16.0 * sideMask;
      if (dOther >= hi) continue;

      const lo = hwOther + rCap * 0.88;
      const atten = smootherstep(lo, hi, dOther);
      const nextClear = curClear * atten;
      outClear[k] = nextClear < 1e-4 ? 0 : nextClear;
    }
  }

  private evaluateColumnCore(
    wx: number,
    wz: number,
    out: MountainColumnOut,
    candidateSpines: readonly SpineView[] | undefined,
    includeMetadata: boolean,
    skipMacroOnFullPiste: boolean,
  ): MountainColumnOut {
    this.interiorSinglePisteSpine = null;
    const allSpines = this.spineSource.elevationSpines;
    const spines = candidateSpines && candidateSpines.length > 0 ? candidateSpines : allSpines;

    if (spines.length === 0) {
      return this.populateEmptyFallback(wx, wz, out);
    }

    this.syncClearanceIfNeeded(allSpines);

    const absX = wx + this.originOffsetX;
    const absZ = wz + this.originOffsetZ;

    // ── Pass 1: Injective Piste Support + Inverse-Barrier Partition-of-Unity Blending ──
    let fullCount = 0;
    let fullHSum = 0;
    let barrierWSum = 0;
    let barrierHSum = 0;
    let oneMinusTotalPisteW = 1;
    let oneMinusReliefPisteW = 1;
    let maxPisteW = 0;
    let dominantAbsX = Infinity;
    let dominantPisteSpine: SpineView | null = null;
    let dominantPisteS = 0;
    let dominantPisteSignedX = 0;
    let dominantPisteInDivider = false;
    let dominantPisteDividerMask = 0;
    let pisteNearCount = 0;

    for (let i = 0; i < spines.length; i++) {
      const sp = spines[i]!;
      if (
        wx < sp.boundsMinX - PISTE_AABB_PAD_M ||
        wx > sp.boundsMaxX + PISTE_AABB_PAD_M ||
        wz < sp.boundsMinZ - PISTE_AABB_PAD_M ||
        wz > sp.boundsMaxZ + PISTE_AABB_PAD_M
      ) {
        continue;
      }

      sp.projectXZ(wx, wz, this.projScratch);
      const proj = this.projScratch;
      const absLongExt = Math.abs(proj.longExt);
      if (absLongExt >= PISTE_LONG_HANDOFF_M + 1.0) continue;

      const blendW = 14.5;
      const absSignedX = Math.abs(proj.signedX);
      if (absSignedX >= proj.halfWidth + blendW + 1.0) continue;
      pisteNearCount++;

      const longMask = absLongExt <= 0 ? 1 : 1 - smootherstep(0, PISTE_LONG_HANDOFF_M, absLongExt);
      if (longMask <= 0) continue;

      let reliefW: number;
      let pisteW: number;
      if (absSignedX <= proj.halfWidth) {
        reliefW = longMask;
        pisteW = longMask;
      } else {
        const landscape = this.resolveLandscape(sp);
        const sideSpec = proj.signedX < 0 ? landscape.left : landscape.right;
        const reliefBlendW = clamp(sideSpec.transitionWidth * 0.72, 9.5, 11.0);
        reliefW =
          (1 - smoothstep(proj.halfWidth, proj.halfWidth + reliefBlendW, absSignedX)) * longMask;
        pisteW =
          (1 - smoothstep(proj.halfWidth, proj.halfWidth + blendW, absSignedX)) * longMask;
      }
      if (reliefW > 1e-7) {
        oneMinusReliefPisteW *= 1 - reliefW;
      }

      if (pisteW > 1e-7) {
        const extDeltaY =
          proj.longExt !== 0 ? proj.longExt * Math.tan(clamp(proj.pitchRad, -1.2, 1.2)) : 0;
        sp.evaluatePisteHeight(proj.s, proj.signedX, this.pisteScratch);
        const pisteH = this.pisteScratch.heightY + extDeltaY;

        // Interior-core barrier weight: strictly C^2 smooth everywhere, exact lock on inner core (|x| <= 0.25*hw)
        // so an overlapping foreign corridor edge never pulls an active centerline (0 pull on deepForeignSpine).
        const coreW =
          (1 - smootherstep(proj.halfWidth * 0.25, proj.halfWidth + blendW, absSignedX)) *
          longMask;
        if (coreW >= 1 - 1e-9) {
          fullCount++;
          fullHSum += pisteH;
        } else {
          const phi = pisteW / (1 - coreW + PISTE_BARRIER_EPS);
          barrierWSum += phi;
          barrierHSum += phi * pisteH;
        }
        oneMinusTotalPisteW *= 1 - pisteW;

        const betterWeight = pisteW > maxPisteW + 1e-6;
        const tiedCloser = Math.abs(pisteW - maxPisteW) <= 1e-6 && absSignedX < dominantAbsX;
        if (betterWeight || tiedCloser) {
          maxPisteW = pisteW;
          dominantAbsX = absSignedX;
          dominantPisteSpine = sp;
          dominantPisteS = proj.s;
          dominantPisteSignedX = proj.signedX;
          dominantPisteInDivider = this.pisteScratch.inDivider;
          dominantPisteDividerMask = this.pisteScratch.dividerMask;
          this.copyProjection(proj, this.nearestProjScratch);
        }
      }
    }

    const totalPisteW = clamp(1 - oneMinusTotalPisteW, 0, 1);
    const hasPiste = fullCount > 0 || barrierWSum > 1e-12;
    const finalPisteH =
      fullCount > 0
        ? fullHSum / fullCount
        : barrierWSum > 1e-12
          ? barrierHSum / barrierWSum
          : 0;
    const isFullPiste = totalPisteW >= 1 - 1e-6;

    if (isFullPiste && dominantPisteSpine !== null) {
      if (!includeMetadata) {
        out.heightY = finalPisteH;
        return out;
      }
      const np = this.nearestProjScratch;
      if (
        pisteNearCount === 1 &&
        Math.abs(dominantPisteSignedX) <= np.halfWidth - 0.75 &&
        dominantPisteS >= 1.0 &&
        dominantPisteS <= dominantPisteSpine.length - 1.0
      ) {
        this.interiorSinglePisteSpine = dominantPisteSpine;
      }
      if (skipMacroOnFullPiste) {
        out.heightY = finalPisteH;
        out.macroY = np.spineY;
        out.pisteWeight = totalPisteW;
        out.onPiste = true;
        out.pisteSurfaceType = dominantPisteSpine.evaluatePisteSurface(
          dominantPisteS,
          dominantPisteSignedX,
        );
        out.inDivider = dominantPisteInDivider;
        out.dividerMask = dominantPisteDividerMask;
        out.inChasmZone = false;
        out.chasmWipeoutDepth = 0;
        out.chasmRelief = 0;
        out.chasmDepthBelowSpine = 0;
        out.nearestSpineY = np.spineY;
        out.nearestSegmentId = dominantPisteSpine.id;
        out.nearestStageId = dominantPisteSpine.stageId;
        out.secondaryStageId = null;
        out.secondaryStageWeight = 0;
        out.nearestS = dominantPisteS;
        out.nearestSignedX = dominantPisteSignedX;
        out.nearestHalfWidth = np.halfWidth;
        out.downhillX = np.forwardX;
        out.downhillY = np.forwardY;
        out.downhillZ = np.forwardZ;
        return out;
      }
    }

    // ── Pass 2A: Inverse-Distance Macro Sheet over Coarse 16m Spine Nodes (Zero Caustics) ──
    let sumW = 0;
    let weightedMacroY = 0;
    let downhillAccX = 0;
    let downhillAccY = 0;
    let downhillAccZ = 0;
    let stageCount = 0;
    let minNodeDistSq = Infinity;
    let minEdgeDist = Infinity;

    let closestSpine: SpineView | null = null;
    let closestSpineDistSq = Infinity;
    let secondClosestSpine: SpineView | null = null;
    let secondClosestDistSq = Infinity;

    for (let i = 0; i < spines.length; i++) {
      const sp = spines[i]!;
      const mn = sp.macroNodes;
      let spineBlendW = 0;
      let spineLocalW = 0;
      let spineLocalY = 0;
      let spineDhX = 0;
      let spineDhY = 0;
      let spineDhZ = 0;
      let spineMinRSq = Infinity;

      if (mn !== undefined) {
        // Interior coarse 16m nodes
        const aabbDx =
          wx < sp.boundsMinX ? sp.boundsMinX - wx : wx > sp.boundsMaxX ? wx - sp.boundsMaxX : 0;
        const aabbDz =
          wz < sp.boundsMinZ ? sp.boundsMinZ - wz : wz > sp.boundsMaxZ ? wz - sp.boundsMaxZ : 0;
        if (aabbDx * aabbDx + aabbDz * aabbDz <= MACRO_WIN_OUT_SQ) {
          const nCount = mn.count;
          const xs = mn.posX;
          const ys = mn.posY;
          const zs = mn.posZ;
          const hws = mn.halfWidth;
          for (let j = 0; j < nCount; j++) {
            const dx = wx - xs[j]!;
            const dz = wz - zs[j]!;
            const rSq = dx * dx + dz * dz;
            if (rSq < spineMinRSq) spineMinRSq = rSq;
            if (rSq >= MACRO_WIN_OUT_SQ) continue;
            const r = Math.sqrt(rSq);
            const rawEdge = r - hws[j]!;
            if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
            const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
            // Dual-order inverse-distance sheet:
            // - wBlend = win / (edge^2 + r0^2) integrates to ~1/edge (linear inter-spine blend + tight shoulder lock)
            // - wLocal = wBlend / (edge^2 + r0^2) localizes each spine's mean elevation tightly along curved runs
            const smoothEdge = 0.5 * (rawEdge + Math.sqrt(rawEdge * rawEdge + MACRO_EDGE_SMOOTH_SQ));
            const seSq = smoothEdge * smoothEdge;
            const wBlend = win / (seSq + MACRO_R0_SQ);
            const wLocal = wBlend / (seSq + MACRO_LOCAL_R0_SQ);
            spineBlendW += wBlend;
            spineLocalW += wLocal;
            spineLocalY += wLocal * ys[j]!;
            if (includeMetadata) {
              spineDhX += wLocal * mn.fwdX[j]!;
              spineDhY += wLocal * mn.fwdY[j]!;
              spineDhZ += wLocal * mn.fwdZ[j]!;
            }
          }
        }

        // Open-leaf upstream straight-tangent nodes (root / standalone spine)
        if (mn.useUpstreamExt) {
          const uDx =
            wx < mn.upBoundsMinX
              ? mn.upBoundsMinX - wx
              : wx > mn.upBoundsMaxX
                ? wx - mn.upBoundsMaxX
                : 0;
          const uDz =
            wz < mn.upBoundsMinZ
              ? mn.upBoundsMinZ - wz
              : wz > mn.upBoundsMaxZ
                ? wz - mn.upBoundsMaxZ
                : 0;
          if (uDx * uDx + uDz * uDz <= MACRO_WIN_OUT_SQ) {
            const uCount = mn.upExtCount;
            const ux = mn.upExtX;
            const uy = mn.upExtY;
            const uz = mn.upExtZ;
            const uHw = mn.upExtHalfWidth;
            for (let j = 0; j < uCount; j++) {
              const dx = wx - ux[j]!;
              const dz = wz - uz[j]!;
              const rSq = dx * dx + dz * dz;
              if (rSq < spineMinRSq) spineMinRSq = rSq;
              if (rSq >= MACRO_WIN_OUT_SQ) continue;
              const r = Math.sqrt(rSq);
              const rawEdge = r - uHw;
              if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
              const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
              const smoothEdge = 0.5 * (rawEdge + Math.sqrt(rawEdge * rawEdge + MACRO_EDGE_SMOOTH_SQ));
              const seSq = smoothEdge * smoothEdge;
              const wBlend = win / (seSq + MACRO_R0_SQ);
              const wLocal = wBlend / (seSq + MACRO_LOCAL_R0_SQ);
              spineBlendW += wBlend;
              spineLocalW += wLocal;
              spineLocalY += wLocal * uy[j]!;
              if (includeMetadata) {
                spineDhX += wLocal * mn.upExtFwdX;
                spineDhY += wLocal * mn.upExtFwdY;
                spineDhZ += wLocal * mn.upExtFwdZ;
              }
            }
          }
        }

        // Open-leaf downstream straight-tangent nodes (horizon2 leaves / standalone spine)
        // Attenuated by downExtClear whenever a ghost extension approaches another spine's piste!
        if (mn.useDownstreamExt) {
          const dDx =
            wx < mn.downBoundsMinX
              ? mn.downBoundsMinX - wx
              : wx > mn.downBoundsMaxX
                ? wx - mn.downBoundsMaxX
                : 0;
          const dDz =
            wz < mn.downBoundsMinZ
              ? mn.downBoundsMinZ - wz
              : wz > mn.downBoundsMaxZ
                ? wz - mn.downBoundsMaxZ
                : 0;
          if (dDx * dDx + dDz * dDz <= MACRO_WIN_OUT_SQ) {
            const dClear = this.clearScaleCache.get(sp.id)?.downExt;
            const dCount = mn.downExtCount;
            const dxArr = mn.downExtX;
            const dyArr = mn.downExtY;
            const dzArr = mn.downExtZ;
            const dHw = mn.downExtHalfWidth;
            for (let j = 0; j < dCount; j++) {
              const extScale = dClear ? dClear[j]! : 1;
              if (extScale <= 0) continue;
              const dx = wx - dxArr[j]!;
              const dz = wz - dzArr[j]!;
              const rSq = dx * dx + dz * dz;
              if (rSq < spineMinRSq) spineMinRSq = rSq;
              if (rSq >= MACRO_WIN_OUT_SQ) continue;
              const r = Math.sqrt(rSq);
              const rawEdge = r - dHw;
              if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
              const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
              // Soft-core downExt kernel prevents any residual ghost extension node from creating
              // a localized floating pillar beside a neighboring lower spine.
              const invD2 = 1 / (rSq + MACRO_DOWN_EXT_R0_SQ);
              const wBlend = win * extScale * invD2;
              const wLocal = wBlend * invD2;
              spineBlendW += wBlend;
              spineLocalW += wLocal;
              spineLocalY += wLocal * dyArr[j]!;
              if (includeMetadata) {
                spineDhX += wLocal * mn.downExtFwdX;
                spineDhY += wLocal * mn.downExtFwdY;
                spineDhZ += wLocal * mn.downExtFwdZ;
              }
            }
          }
        }
      } else {
        // Fallback for custom mock SpineView without precomputed macroNodes
        const nodeCount = Math.max(4, Math.round(sp.length / MACRO_NODE_STEP_M));
        const step = sp.length / nodeCount;
        const extCount = Math.floor(MACRO_LEAF_EXTENSION_M / MACRO_NODE_STEP_M);

        sp.sampleSpineFrame(0, this.frameScratch);
        for (let j = 0; j < extCount; j++) {
          const ds = -((j + 0.5) * MACRO_NODE_STEP_M);
          const px = this.frameScratch.posX + this.frameScratch.forwardX * ds;
          const py = this.frameScratch.posY + this.frameScratch.forwardY * ds;
          const pz = this.frameScratch.posZ + this.frameScratch.forwardZ * ds;
          const dx = wx - px;
          const dz = wz - pz;
          const rSq = dx * dx + dz * dz;
          if (rSq < spineMinRSq) spineMinRSq = rSq;
          if (rSq >= MACRO_WIN_OUT_SQ) continue;
          const r = Math.sqrt(rSq);
          const rawEdge = r - this.frameScratch.halfWidth;
          if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
          const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
          const smoothEdge = 0.5 * (rawEdge + Math.sqrt(rawEdge * rawEdge + MACRO_EDGE_SMOOTH_SQ));
          const seSq = smoothEdge * smoothEdge;
          const wBlend = win / (seSq + MACRO_R0_SQ);
          const wLocal = wBlend / (seSq + MACRO_LOCAL_R0_SQ);
          spineBlendW += wBlend;
          spineLocalW += wLocal;
          spineLocalY += wLocal * py;
          if (includeMetadata) {
            spineDhX += wLocal * this.frameScratch.forwardX;
            spineDhY += wLocal * this.frameScratch.forwardY;
            spineDhZ += wLocal * this.frameScratch.forwardZ;
          }
        }
        for (let j = 0; j < nodeCount; j++) {
          sp.sampleSpineFrame((j + 0.5) * step, this.frameScratch);
          const dx = wx - this.frameScratch.posX;
          const dz = wz - this.frameScratch.posZ;
          const rSq = dx * dx + dz * dz;
          if (rSq < spineMinRSq) spineMinRSq = rSq;
          if (rSq >= MACRO_WIN_OUT_SQ) continue;
          const r = Math.sqrt(rSq);
          const rawEdge = r - this.frameScratch.halfWidth;
          if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
          const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
          const smoothEdge = 0.5 * (rawEdge + Math.sqrt(rawEdge * rawEdge + MACRO_EDGE_SMOOTH_SQ));
          const seSq = smoothEdge * smoothEdge;
          const wBlend = win / (seSq + MACRO_R0_SQ);
          const wLocal = wBlend / (seSq + MACRO_LOCAL_R0_SQ);
          spineBlendW += wBlend;
          spineLocalW += wLocal;
          spineLocalY += wLocal * this.frameScratch.posY;
          if (includeMetadata) {
            spineDhX += wLocal * this.frameScratch.forwardX;
            spineDhY += wLocal * this.frameScratch.forwardY;
            spineDhZ += wLocal * this.frameScratch.forwardZ;
          }
        }
        sp.sampleSpineFrame(sp.length, this.frameScratch);
        for (let j = 0; j < extCount; j++) {
          const ds = (j + 0.5) * MACRO_NODE_STEP_M;
          const px = this.frameScratch.posX + this.frameScratch.forwardX * ds;
          const py = this.frameScratch.posY + this.frameScratch.forwardY * ds;
          const pz = this.frameScratch.posZ + this.frameScratch.forwardZ * ds;
          const dx = wx - px;
          const dz = wz - pz;
          const rSq = dx * dx + dz * dz;
          if (rSq < spineMinRSq) spineMinRSq = rSq;
          if (rSq >= MACRO_WIN_OUT_SQ) continue;
          const r = Math.sqrt(rSq);
          const rawEdge = r - this.frameScratch.halfWidth;
          if (rawEdge < minEdgeDist) minEdgeDist = rawEdge > 0 ? rawEdge : 0;
          const win = r <= MACRO_WIN_IN_M ? 1 : 1 - smootherstep(MACRO_WIN_IN_M, MACRO_WIN_OUT_M, r);
          const invD2 = 1 / (rSq + MACRO_DOWN_EXT_R0_SQ);
          const wBlend = win * invD2;
          const wLocal = wBlend * invD2;
          spineBlendW += wBlend;
          spineLocalW += wLocal;
          spineLocalY += wLocal * py;
          if (includeMetadata) {
            spineDhX += wLocal * this.frameScratch.forwardX;
            spineDhY += wLocal * this.frameScratch.forwardY;
            spineDhZ += wLocal * this.frameScratch.forwardZ;
          }
        }
      }

      if (spineBlendW > 0 && spineLocalW > 1e-24) {
        const scale = spineBlendW / spineLocalW;
        sumW += spineBlendW;
        weightedMacroY += spineLocalY * scale;
        if (includeMetadata) {
          downhillAccX += spineDhX * scale;
          downhillAccY += spineDhY * scale;
          downhillAccZ += spineDhZ * scale;
          stageCount = this.accumulateStageWeight(sp.stageId, spineBlendW, stageCount);
        }
      }

      if (spineMinRSq < minNodeDistSq) {
        minNodeDistSq = spineMinRSq;
      }
      if (spineMinRSq < closestSpineDistSq) {
        secondClosestSpine = closestSpine;
        secondClosestDistSq = closestSpineDistSq;
        closestSpine = sp;
        closestSpineDistSq = spineMinRSq;
      } else if (spineMinRSq < secondClosestDistSq) {
        secondClosestSpine = sp;
        secondClosestDistSq = spineMinRSq;
      }
    }

    // Smooth far-field handoff over [130, 190]m (well before near window [120, 240]m tail collapses).
    // Always evaluate over allSpines so tile candidateSpines never crop the far-field sheet across tile seams.
    const minNodeDist = Math.sqrt(minNodeDistSq);
    let macroY: number;
    if (minNodeDist > MACRO_FAR_BLEND_START_M || sumW <= 1e-12) {
      let farSumW = 0;
      let farWeightedY = 0;
      let farDownhillX = 0;
      let farDownhillY = 0;
      let farDownhillZ = 0;
      const farSpines = allSpines.length > 0 ? allSpines : spines;

      // Exact global trueMinDist across all nodes + active extensions with exact branch-and-bound AABB skips
      let trueMinSq = Infinity;
      for (let i = 0; i < farSpines.length; i++) {
        const sp = farSpines[i]!;
        const mn = sp.macroNodes;
        if (mn !== undefined) {
          const aabbDx =
            wx < sp.boundsMinX ? sp.boundsMinX - wx : wx > sp.boundsMaxX ? wx - sp.boundsMaxX : 0;
          const aabbDz =
            wz < sp.boundsMinZ ? sp.boundsMinZ - wz : wz > sp.boundsMaxZ ? wz - sp.boundsMaxZ : 0;
          if (aabbDx * aabbDx + aabbDz * aabbDz < trueMinSq) {
            const xs = mn.posX;
            const zs = mn.posZ;
            for (let j = 0; j < mn.count; j++) {
              const dx = wx - xs[j]!;
              const dz = wz - zs[j]!;
              const rSq = dx * dx + dz * dz;
              if (rSq < trueMinSq) trueMinSq = rSq;
            }
          }
          if (mn.useUpstreamExt) {
            const uDx =
              wx < mn.upBoundsMinX
                ? mn.upBoundsMinX - wx
                : wx > mn.upBoundsMaxX
                  ? wx - mn.upBoundsMaxX
                  : 0;
            const uDz =
              wz < mn.upBoundsMinZ
                ? mn.upBoundsMinZ - wz
                : wz > mn.upBoundsMaxZ
                  ? wz - mn.upBoundsMaxZ
                  : 0;
            if (uDx * uDx + uDz * uDz < trueMinSq) {
              const ux = mn.upExtX;
              const uz = mn.upExtZ;
              for (let j = 0; j < mn.upExtCount; j++) {
                const dx = wx - ux[j]!;
                const dz = wz - uz[j]!;
                const rSq = dx * dx + dz * dz;
                if (rSq < trueMinSq) trueMinSq = rSq;
              }
            }
          }
          if (mn.useDownstreamExt) {
            const dDx =
              wx < mn.downBoundsMinX
                ? mn.downBoundsMinX - wx
                : wx > mn.downBoundsMaxX
                  ? wx - mn.downBoundsMaxX
                  : 0;
            const dDz =
              wz < mn.downBoundsMinZ
                ? mn.downBoundsMinZ - wz
                : wz > mn.downBoundsMaxZ
                  ? wz - mn.downBoundsMaxZ
                  : 0;
            if (dDx * dDx + dDz * dDz < trueMinSq) {
              const dClear = this.clearScaleCache.get(sp.id)?.downExt;
              const dxArr = mn.downExtX;
              const dzArr = mn.downExtZ;
              for (let j = 0; j < mn.downExtCount; j++) {
                if (dClear && dClear[j]! <= 0) continue;
                const dx = wx - dxArr[j]!;
                const dz = wz - dzArr[j]!;
                const rSq = dx * dx + dz * dz;
                if (rSq < trueMinSq) trueMinSq = rSq;
              }
            }
          }
        } else {
          const nodeCount = Math.max(4, Math.round(sp.length / MACRO_NODE_STEP_M));
          const step = sp.length / nodeCount;
          const extCount = Math.floor(MACRO_LEAF_EXTENSION_M / MACRO_NODE_STEP_M);
          sp.sampleSpineFrame(0, this.frameScratch);
          for (let j = 0; j < extCount; j++) {
            const ds = -((j + 0.5) * MACRO_NODE_STEP_M);
            const dx = wx - (this.frameScratch.posX + this.frameScratch.forwardX * ds);
            const dz = wz - (this.frameScratch.posZ + this.frameScratch.forwardZ * ds);
            const rSq = dx * dx + dz * dz;
            if (rSq < trueMinSq) trueMinSq = rSq;
          }
          for (let j = 0; j < nodeCount; j++) {
            sp.sampleSpineFrame((j + 0.5) * step, this.frameScratch);
            const dx = wx - this.frameScratch.posX;
            const dz = wz - this.frameScratch.posZ;
            const rSq = dx * dx + dz * dz;
            if (rSq < trueMinSq) trueMinSq = rSq;
          }
          sp.sampleSpineFrame(sp.length, this.frameScratch);
          for (let j = 0; j < extCount; j++) {
            const ds = (j + 0.5) * MACRO_NODE_STEP_M;
            const dx = wx - (this.frameScratch.posX + this.frameScratch.forwardX * ds);
            const dz = wz - (this.frameScratch.posZ + this.frameScratch.forwardZ * ds);
            const rSq = dx * dx + dz * dz;
            if (rSq < trueMinSq) trueMinSq = rSq;
          }
        }
      }
      const trueMinDist = Math.sqrt(trueMinSq);

      const farWinIn = trueMinDist + MACRO_FAR_WIN_IN_OFFSET_M;
      const farWinOut = trueMinDist + MACRO_FAR_WIN_OUT_OFFSET_M;
      const farWinOutSq = farWinOut * farWinOut;

      for (let i = 0; i < farSpines.length; i++) {
        const sp = farSpines[i]!;
        const mn = sp.macroNodes;
        let spineFarW = 0;
        let spineMinRSq = Infinity;
        if (mn !== undefined) {
          const aabbDx =
            wx < sp.boundsMinX ? sp.boundsMinX - wx : wx > sp.boundsMaxX ? wx - sp.boundsMaxX : 0;
          const aabbDz =
            wz < sp.boundsMinZ ? sp.boundsMinZ - wz : wz > sp.boundsMaxZ ? wz - sp.boundsMaxZ : 0;
          if (aabbDx * aabbDx + aabbDz * aabbDz < farWinOutSq) {
            const nCount = mn.count;
            const xs = mn.posX;
            const ys = mn.posY;
            const zs = mn.posZ;
            const hws = mn.halfWidth;
            for (let j = 0; j < nCount; j++) {
              const dx = wx - xs[j]!;
              const dz = wz - zs[j]!;
              const rSq = dx * dx + dz * dz;
              if (rSq < spineMinRSq) spineMinRSq = rSq;
              if (rSq >= farWinOutSq) continue;
              const r = Math.sqrt(rSq);
              const edgeD = r - hws[j]!;
              if (edgeD < minEdgeDist) minEdgeDist = edgeD > 0 ? edgeD : 0;
              const win = r <= farWinIn ? 1 : 1 - smootherstep(farWinIn, farWinOut, r);
              const w = win / (rSq + MACRO_FAR_R0_SQ);
              farSumW += w;
              farWeightedY += w * ys[j]!;
              spineFarW += w;
              if (includeMetadata) {
                farDownhillX += w * mn.fwdX[j]!;
                farDownhillY += w * mn.fwdY[j]!;
                farDownhillZ += w * mn.fwdZ[j]!;
              }
            }
          }
          if (mn.useUpstreamExt) {
            const uDx =
              wx < mn.upBoundsMinX
                ? mn.upBoundsMinX - wx
                : wx > mn.upBoundsMaxX
                  ? wx - mn.upBoundsMaxX
                  : 0;
            const uDz =
              wz < mn.upBoundsMinZ
                ? mn.upBoundsMinZ - wz
                : wz > mn.upBoundsMaxZ
                  ? wz - mn.upBoundsMaxZ
                  : 0;
            if (uDx * uDx + uDz * uDz < farWinOutSq) {
              const ux = mn.upExtX;
              const uy = mn.upExtY;
              const uz = mn.upExtZ;
              for (let j = 0; j < mn.upExtCount; j++) {
                const dx = wx - ux[j]!;
                const dz = wz - uz[j]!;
                const rSq = dx * dx + dz * dz;
                if (rSq < spineMinRSq) spineMinRSq = rSq;
                if (rSq >= farWinOutSq) continue;
                const r = Math.sqrt(rSq);
                const edgeD = r - mn.upExtHalfWidth;
                if (edgeD < minEdgeDist) minEdgeDist = edgeD > 0 ? edgeD : 0;
                const win = r <= farWinIn ? 1 : 1 - smootherstep(farWinIn, farWinOut, r);
                const w = win / (rSq + MACRO_FAR_R0_SQ);
                farSumW += w;
                farWeightedY += w * uy[j]!;
                spineFarW += w;
                if (includeMetadata) {
                  farDownhillX += w * mn.upExtFwdX;
                  farDownhillY += w * mn.upExtFwdY;
                  farDownhillZ += w * mn.upExtFwdZ;
                }
              }
            }
          }
          if (mn.useDownstreamExt) {
            const dDx =
              wx < mn.downBoundsMinX
                ? mn.downBoundsMinX - wx
                : wx > mn.downBoundsMaxX
                  ? wx - mn.downBoundsMaxX
                  : 0;
            const dDz =
              wz < mn.downBoundsMinZ
                ? mn.downBoundsMinZ - wz
                : wz > mn.downBoundsMaxZ
                  ? wz - mn.downBoundsMaxZ
                  : 0;
            if (dDx * dDx + dDz * dDz < farWinOutSq) {
              const dClear = this.clearScaleCache.get(sp.id)?.downExt;
              const dxArr = mn.downExtX;
              const dyArr = mn.downExtY;
              const dzArr = mn.downExtZ;
              for (let j = 0; j < mn.downExtCount; j++) {
                const extScale = dClear ? dClear[j]! : 1;
                if (extScale <= 0) continue;
                const dx = wx - dxArr[j]!;
                const dz = wz - dzArr[j]!;
                const rSq = dx * dx + dz * dz;
                if (rSq < spineMinRSq) spineMinRSq = rSq;
                if (rSq >= farWinOutSq) continue;
                const r = Math.sqrt(rSq);
                const edgeD = r - mn.downExtHalfWidth;
                if (edgeD < minEdgeDist) minEdgeDist = edgeD > 0 ? edgeD : 0;
                const win = r <= farWinIn ? 1 : 1 - smootherstep(farWinIn, farWinOut, r);
                const w = (win * extScale) / (rSq + MACRO_FAR_R0_SQ);
                farSumW += w;
                farWeightedY += w * dyArr[j]!;
                spineFarW += w;
                if (includeMetadata) {
                  farDownhillX += w * mn.downExtFwdX;
                  farDownhillY += w * mn.downExtFwdY;
                  farDownhillZ += w * mn.downExtFwdZ;
                }
              }
            }
          }
        } else {
          const nodeCount = Math.max(4, Math.round(sp.length / MACRO_NODE_STEP_M));
          const step = sp.length / nodeCount;
          const extCount = Math.floor(MACRO_LEAF_EXTENSION_M / MACRO_NODE_STEP_M);
          sp.sampleSpineFrame(0, this.frameScratch);
          for (let j = 0; j < extCount; j++) {
            const ds = -((j + 0.5) * MACRO_NODE_STEP_M);
            const px = this.frameScratch.posX + this.frameScratch.forwardX * ds;
            const py = this.frameScratch.posY + this.frameScratch.forwardY * ds;
            const pz = this.frameScratch.posZ + this.frameScratch.forwardZ * ds;
            const dx = wx - px;
            const dz = wz - pz;
            const rSq = dx * dx + dz * dz;
            if (rSq < spineMinRSq) spineMinRSq = rSq;
            if (rSq >= farWinOutSq) continue;
            const r = Math.sqrt(rSq);
            const edgeD = r - this.frameScratch.halfWidth;
            if (edgeD < minEdgeDist) minEdgeDist = edgeD > 0 ? edgeD : 0;
            const win = r <= farWinIn ? 1 : 1 - smootherstep(farWinIn, farWinOut, r);
            const w = win / (rSq + MACRO_FAR_R0_SQ);
            farSumW += w;
            farWeightedY += w * py;
            spineFarW += w;
            if (includeMetadata) {
              farDownhillX += w * this.frameScratch.forwardX;
              farDownhillY += w * this.frameScratch.forwardY;
              farDownhillZ += w * this.frameScratch.forwardZ;
            }
          }
          for (let j = 0; j < nodeCount; j++) {
            sp.sampleSpineFrame((j + 0.5) * step, this.frameScratch);
            const dx = wx - this.frameScratch.posX;
            const dz = wz - this.frameScratch.posZ;
            const rSq = dx * dx + dz * dz;
            if (rSq < spineMinRSq) spineMinRSq = rSq;
            if (rSq >= farWinOutSq) continue;
            const r = Math.sqrt(rSq);
            const edgeD = r - this.frameScratch.halfWidth;
            if (edgeD < minEdgeDist) minEdgeDist = edgeD > 0 ? edgeD : 0;
            const win = r <= farWinIn ? 1 : 1 - smootherstep(farWinIn, farWinOut, r);
            const w = win / (rSq + MACRO_FAR_R0_SQ);
            farSumW += w;
            farWeightedY += w * this.frameScratch.posY;
            spineFarW += w;
            if (includeMetadata) {
              farDownhillX += w * this.frameScratch.forwardX;
              farDownhillY += w * this.frameScratch.forwardY;
              farDownhillZ += w * this.frameScratch.forwardZ;
            }
          }
          sp.sampleSpineFrame(sp.length, this.frameScratch);
          for (let j = 0; j < extCount; j++) {
            const ds = (j + 0.5) * MACRO_NODE_STEP_M;
            const px = this.frameScratch.posX + this.frameScratch.forwardX * ds;
            const py = this.frameScratch.posY + this.frameScratch.forwardY * ds;
            const pz = this.frameScratch.posZ + this.frameScratch.forwardZ * ds;
            const dx = wx - px;
            const dz = wz - pz;
            const rSq = dx * dx + dz * dz;
            if (rSq < spineMinRSq) spineMinRSq = rSq;
            if (rSq >= farWinOutSq) continue;
            const r = Math.sqrt(rSq);
            const edgeD = r - this.frameScratch.halfWidth;
            if (edgeD < minEdgeDist) minEdgeDist = edgeD > 0 ? edgeD : 0;
            const win = r <= farWinIn ? 1 : 1 - smootherstep(farWinIn, farWinOut, r);
            const w = win / (rSq + MACRO_FAR_R0_SQ);
            farSumW += w;
            farWeightedY += w * py;
            spineFarW += w;
            if (includeMetadata) {
              farDownhillX += w * this.frameScratch.forwardX;
              farDownhillY += w * this.frameScratch.forwardY;
              farDownhillZ += w * this.frameScratch.forwardZ;
            }
          }
        }

        if (spineMinRSq < closestSpineDistSq) {
          secondClosestSpine = closestSpine;
          secondClosestDistSq = closestSpineDistSq;
          closestSpine = sp;
          closestSpineDistSq = spineMinRSq;
        } else if (spineMinRSq < secondClosestDistSq) {
          secondClosestSpine = sp;
          secondClosestDistSq = spineMinRSq;
        }
        if (includeMetadata && sumW <= 1e-12 && spineFarW > 0) {
          stageCount = this.accumulateStageWeight(sp.stageId, spineFarW, stageCount);
        }
      }

      const farMacroY = farSumW > 1e-24 ? farWeightedY / farSumW : 0;
      if (sumW <= 1e-12) {
        macroY = farMacroY;
        sumW = farSumW;
        if (includeMetadata) {
          downhillAccX = farDownhillX;
          downhillAccY = farDownhillY;
          downhillAccZ = farDownhillZ;
        }
      } else {
        const farT = smootherstep(MACRO_FAR_BLEND_START_M, MACRO_FAR_BLEND_END_M, trueMinDist);
        macroY = lerp(weightedMacroY / sumW, farMacroY, farT);
        if (includeMetadata && farT > 0 && farSumW > 1e-24) {
          const invNear = 1 / sumW;
          const invFar = 1 / farSumW;
          downhillAccX = lerp(downhillAccX * invNear, farDownhillX * invFar, farT);
          downhillAccY = lerp(downhillAccY * invNear, farDownhillY * invFar, farT);
          downhillAccZ = lerp(downhillAccZ * invNear, farDownhillZ * invFar, farT);
        }
      }
    } else {
      macroY = weightedMacroY / sumW;
    }

    // ── Pass 2B: Medial-Safe Curvature-Clamped Off-Piste Corridor Kernels ──
    let offPisteRelief = 0;
    let chasmD = 0;
    let chasmRelief = 0;
    let maxChasmWipeoutDepth = 0;

    if (!isFullPiste) {
      let posD = 0;
      let posW = 0;
      let negD = 0;
      let negW = 0;
      let chasmW = 0;

      for (let i = 0; i < spines.length; i++) {
        const sp = spines[i]!;
        const left = sp.corridorLeft;
        const right = sp.corridorRight;
        if (!left || !right) continue;

        const inLeft =
          wx >= left.boundsMinX &&
          wx <= left.boundsMaxX &&
          wz >= left.boundsMinZ &&
          wz <= left.boundsMaxZ;
        const inRight =
          wx >= right.boundsMinX &&
          wx <= right.boundsMaxX &&
          wz >= right.boundsMinZ &&
          wz <= right.boundsMaxZ;
        if (!inLeft && !inRight) continue;

        const clearEntry = this.clearScaleCache.get(sp.id);
        const landscape = this.resolveLandscape(sp);

        // Left side corridor kernel chain
        if (inLeft) {
          const clearArr = clearEntry?.left;
          const count = left.count;
          const xs = left.posX;
          const zs = left.posZ;
          const invRSqs = left.invRadiusSq;
          const kWeights = left.kernelWeight;
          const amps = left.ampMag;
          let sideD = 0;
          let sideAmp = 0;
          let rimD = 0;
          let rimAmp = 0;
          for (let k = 0; k < count; k++) {
            const cScale = clearArr ? clearArr[k]! : 1;
            const kw = kWeights[k]!;
            if (cScale <= 0 || kw <= 0) continue;
            const dx = wx - xs[k]!;
            const dz = wz - zs[k]!;
            const q = (dx * dx + dz * dz) * invRSqs[k]!;
            if (q >= 1) continue;
            const u = 1 - q;
            const kern = kw * cScale * (u * u * u);
            const a = amps[k]!;
            if (a >= 0) {
              sideD += kern;
              sideAmp += kern * a;
            } else {
              rimD += kern;
              rimAmp += kern * -a;
            }
          }
          if (sideD > 1e-7) {
            const spec = landscape.left;
            const mod = this.evaluateSideModulation(spec, absX, absZ);
            const signedW = sideAmp * mod;
            if (signedW >= 0) {
              posD += sideD;
              posW += signedW;
            } else {
              negD += sideD;
              negW += signedW;
            }
            if (spec.archetype === 'chasm') {
              chasmD += sideD;
              chasmW += signedW;
              if (spec.chasmWipeoutDepth > maxChasmWipeoutDepth) {
                maxChasmWipeoutDepth = spec.chasmWipeoutDepth;
              }
            }
          }
          if (rimD > 1e-7) {
            const spec = landscape.left;
            const rimMod =
              0.78 +
              0.22 *
                smoothRidgedNoise2D(
                  absX * spec.noiseFrequency,
                  absZ * spec.noiseFrequency,
                  202,
                  2,
                  2.0,
                  0.5,
                );
            posD += rimD;
            posW += rimAmp * rimMod;
          }
        }

        // Right side corridor kernel chain
        if (inRight) {
          const clearArr = clearEntry?.right;
          const count = right.count;
          const xs = right.posX;
          const zs = right.posZ;
          const invRSqs = right.invRadiusSq;
          const kWeights = right.kernelWeight;
          const amps = right.ampMag;
          let sideD = 0;
          let sideAmp = 0;
          let rimD = 0;
          let rimAmp = 0;
          for (let k = 0; k < count; k++) {
            const cScale = clearArr ? clearArr[k]! : 1;
            const kw = kWeights[k]!;
            if (cScale <= 0 || kw <= 0) continue;
            const dx = wx - xs[k]!;
            const dz = wz - zs[k]!;
            const q = (dx * dx + dz * dz) * invRSqs[k]!;
            if (q >= 1) continue;
            const u = 1 - q;
            const kern = kw * cScale * (u * u * u);
            const a = amps[k]!;
            if (a >= 0) {
              sideD += kern;
              sideAmp += kern * a;
            } else {
              rimD += kern;
              rimAmp += kern * -a;
            }
          }
          if (sideD > 1e-7) {
            const spec = landscape.right;
            const mod = this.evaluateSideModulation(spec, absX, absZ);
            const signedW = sideAmp * mod;
            if (signedW >= 0) {
              posD += sideD;
              posW += signedW;
            } else {
              negD += sideD;
              negW += signedW;
            }
            if (spec.archetype === 'chasm') {
              chasmD += sideD;
              chasmW += signedW;
              if (spec.chasmWipeoutDepth > maxChasmWipeoutDepth) {
                maxChasmWipeoutDepth = spec.chasmWipeoutDepth;
              }
            }
          }
          if (rimD > 1e-7) {
            const spec = landscape.right;
            const rimMod =
              0.78 +
              0.22 *
                smoothRidgedNoise2D(
                  absX * spec.noiseFrequency,
                  absZ * spec.noiseFrequency,
                  202,
                  2,
                  2.0,
                  0.5,
                );
            posD += rimD;
            posW += rimAmp * rimMod;
          }
        }
      }

      // Smooth C^inf normalized opposing blend (bounds worst-case slope <= 62-64 deg everywhere)
      const totalD = posD + negD;
      const denom =
        0.5 * (1 + totalD + Math.sqrt((totalD - 1) * (totalD - 1) + CORRIDOR_SMAX_EPS_SQ));
      const corridorDH = totalD > 1e-7 ? (posW + negW) / denom : 0;
      const reliefOffMask = clamp(oneMinusReliefPisteW, 0, 1);
      // Quadratic relief fade over the full 9.5-11.5m shoulder keeps canyonWalls & chasms smooth at piste edges
      const reliefFade = reliefOffMask * reliefOffMask;
      chasmRelief = chasmD > 1e-7 ? (chasmW / denom) * reliefFade : 0;

      // Subtle zero-mean C^2 alpine undulation + flat-topped outer valley rim (strictly 0 inside 110m).
      const alpineUndulation =
        ALPINE_UNDULATION_AMP_M *
        fbm2D(absX * ALPINE_UNDULATION_FREQ, absZ * ALPINE_UNDULATION_FREQ, 404, 2, 2.0, 0.5);
      const outerRim = this.evaluateOuterValleyRim(minEdgeDist, absX, absZ);
      offPisteRelief = (corridorDH + alpineUndulation + outerRim) * reliefFade;
    }

    const pisteTargetH = hasPiste ? finalPisteH : macroY;
    // Rational C^1/C^2 piste-to-macro blend: p(w) = (K*w) / (1 - (1-K)*w) with K = 0.31.
    // Preserves exact p(1)=1, p(0)=0, p'(0)=p'(1)=0 C^1 tangency at both edges while cutting
    // shoulder slope amplification on sloped inter-spine hillsides from 1.6875x down to ~1.28x!
    const heightBlendW =
      totalPisteW >= 1 - 1e-9
        ? 1
        : totalPisteW <= 0
          ? 0
          : (0.31 * totalPisteW) / (1 - 0.69 * totalPisteW);
    const heightY = lerp(macroY, pisteTargetH, heightBlendW) + offPisteRelief;

    if (!includeMetadata) {
      out.heightY = heightY;
      return out;
    }

    // Resolve exact nearest spine projection for off-piste metadata (at most 1-2 projections!)
    let nearestSpine: SpineView = dominantPisteSpine ?? closestSpine ?? spines[0]!;
    if (dominantPisteSpine === null) {
      nearestSpine.projectXZ(wx, wz, this.nearestProjScratch);
      if (secondClosestSpine !== null && secondClosestSpine.id !== nearestSpine.id) {
        secondClosestSpine.projectXZ(wx, wz, this.altProjScratch);
        if (this.altProjScratch.distSq < this.nearestProjScratch.distSq) {
          nearestSpine = secondClosestSpine;
          this.copyProjection(this.altProjScratch, this.nearestProjScratch);
        }
      }
    }

    const np = this.nearestProjScratch;
    const dLen = Math.hypot(downhillAccX, downhillAccY, downhillAccZ);
    let dhX = np.forwardX;
    let dhY = np.forwardY;
    let dhZ = np.forwardZ;
    if (dLen > 1e-6) {
      const invD = 1 / dLen;
      dhX = downhillAccX * invD;
      dhY = downhillAccY * invD;
      dhZ = downhillAccZ * invD;
    }

    let secondaryStageId: string | null = null;
    let secondaryStageWeight = 0;
    let bestSecW = 0;
    for (let i = 0; i < stageCount; i++) {
      const sid = this.stageIdsScratch[i]!;
      if (sid === nearestSpine.stageId) continue;
      const sw = this.stageWeightsScratch[i]!;
      if (sw > bestSecW) {
        bestSecW = sw;
        secondaryStageId = sid;
      }
    }
    if (secondaryStageId !== null && bestSecW > 1e-12 && sumW > 1e-12) {
      secondaryStageWeight = clamp(bestSecW / sumW, 0, 1);
    } else {
      secondaryStageId = null;
      secondaryStageWeight = 0;
    }

    const onPiste = heightBlendW >= 0.5;
    let pisteSurfaceType: PisteSurfaceType = 'powder';
    let inDivider = false;
    let dividerMask = 0;
    if (totalPisteW > 0 && dominantPisteSpine !== null) {
      pisteSurfaceType = dominantPisteSpine.evaluatePisteSurface(
        dominantPisteS,
        dominantPisteSignedX,
      );
      inDivider = dominantPisteInDivider;
      dividerMask = dominantPisteDividerMask;
    }

    const inChasmZone =
      !onPiste && chasmD > 0.05 && maxChasmWipeoutDepth > 0 && chasmRelief < -3.0;

    out.heightY = heightY;
    out.macroY = macroY;
    out.pisteWeight = heightBlendW;
    out.onPiste = onPiste;
    out.pisteSurfaceType = pisteSurfaceType;
    out.inDivider = inDivider;
    out.dividerMask = dividerMask;
    out.inChasmZone = inChasmZone;
    out.chasmWipeoutDepth = inChasmZone ? maxChasmWipeoutDepth : 0;
    out.chasmRelief = chasmRelief;
    out.chasmDepthBelowSpine = Math.max(0, macroY - heightY);
    out.nearestSpineY = np.spineY;
    out.nearestSegmentId = nearestSpine.id;
    out.nearestStageId = nearestSpine.stageId;
    out.secondaryStageId = secondaryStageId;
    out.secondaryStageWeight = secondaryStageWeight;
    out.nearestS = np.s;
    out.nearestSignedX = np.signedX;
    out.nearestHalfWidth = np.halfWidth;
    out.downhillX = dhX;
    out.downhillY = dhY;
    out.downhillZ = dhZ;
    return out;
  }

  private evaluateSideModulation(side: SideLandscapeSpec, absX: number, absZ: number): number {
    const nx = absX * side.noiseFrequency;
    const nz = absZ * side.noiseFrequency;
    switch (side.archetype) {
      case 'canyonWalls':
        return 0.74 + 0.26 * smoothRidgedNoise2D(nx, nz, 202, 3, 2.0, 0.5);
      case 'alpineBowl':
        return 0.65 + 0.2 * fbm2D(nx, nz, 101, 3, 2.0, 0.5);
      case 'chasm':
        return -(0.88 + 0.12 * smoothRidgedNoise2D(nx, nz, 202, 2, 2.0, 0.5));
      case 'rollingHills':
      default:
        return 0.8 * fbm2D(nx, nz, 101, 3, 2.0, 0.5);
    }
  }

  private evaluateOuterValleyRim(minEdgeDist: number, absX: number, absZ: number): number {
    if (minEdgeDist <= OUTER_RIM_START_M) return 0;
    const t = smootherstep(OUTER_RIM_START_M, OUTER_RIM_END_M, minEdgeDist);
    const nRidged = smoothRidgedNoise2D(absX * 0.01, absZ * 0.01, 303, 3, 2.0, 0.5);
    return t * (38 + 14 * nRidged);
  }

  private populateEmptyFallback(wx: number, wz: number, out: MountainColumnOut): MountainColumnOut {
    const absX = wx + this.originOffsetX;
    const absZ = wz + this.originOffsetZ;
    const funnel = this.evaluateOuterValleyRim(OUTER_RIM_END_M, absX, absZ);
    out.heightY = funnel;
    out.macroY = 0;
    out.pisteWeight = 0;
    out.onPiste = false;
    out.pisteSurfaceType = 'powder';
    out.inDivider = false;
    out.dividerMask = 0;
    out.inChasmZone = false;
    out.chasmWipeoutDepth = 0;
    out.chasmRelief = 0;
    out.chasmDepthBelowSpine = 0;
    out.nearestSpineY = 0;
    out.nearestSegmentId = -1;
    out.nearestStageId = 'sunny-blue';
    out.secondaryStageId = null;
    out.secondaryStageWeight = 0;
    out.nearestS = 0;
    out.nearestSignedX = 0;
    out.nearestHalfWidth = 14;
    out.downhillX = 0;
    out.downhillY = 0;
    out.downhillZ = -1;
    return out;
  }

  private internStageId(stageId: string): number {
    const existing = this.stageIdToIndex.get(stageId);
    if (existing !== undefined) return existing;
    const nextIdx = Math.min(255, this._stageIdTable.length);
    this._stageIdTable.push(stageId);
    this.stageIdToIndex.set(stageId, nextIdx);
    return nextIdx;
  }

  private resolveLandscape(spine: SpineView): LandscapeProfile {
    return spine.landscape ?? getStageDef(spine.stageId)?.landscape ?? STAGE_SUNNY_BLUE.landscape;
  }

  private accumulateStageWeight(stageId: string, weight: number, count: number): number {
    for (let i = 0; i < count; i++) {
      if (this.stageIdsScratch[i] === stageId) {
        this.stageWeightsScratch[i] = this.stageWeightsScratch[i]! + weight;
        return count;
      }
    }
    this.stageIdsScratch[count] = stageId;
    this.stageWeightsScratch[count] = weight;
    return count + 1;
  }

  private copyProjection(src: SpineProjectionOut, dst: SpineProjectionOut): void {
    dst.s = src.s;
    dst.signedX = src.signedX;
    dst.longExt = src.longExt;
    dst.distSq = src.distSq;
    dst.spineX = src.spineX;
    dst.spineY = src.spineY;
    dst.spineZ = src.spineZ;
    dst.forwardX = src.forwardX;
    dst.forwardY = src.forwardY;
    dst.forwardZ = src.forwardZ;
    dst.rightX = src.rightX;
    dst.rightZ = src.rightZ;
    dst.pitchRad = src.pitchRad;
    dst.halfWidth = src.halfWidth;
    dst.dividerHalfWidth = src.dividerHalfWidth;
  }
}
