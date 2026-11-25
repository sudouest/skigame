import * as THREE from 'three';
import { getStageDef, STAGE_SUNNY_BLUE } from '../../content/stages';
import type { StagePalette } from '../../content/types';
import { clamp, lerp } from '../../core/math';
import {
  createTerrainGridSampleOut,
  TERRAIN_FLAG_IN_CHASM,
  TERRAIN_FLAG_IN_DIVIDER,
  type TerrainFieldView,
  type TerrainGridSampleOut,
} from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';

export const CLIPMAP_TEX_SIZE = 256;
export const CLIPMAP_TEX_MASK = CLIPMAP_TEX_SIZE - 1;
export const CLIPMAP_COMMITTED_SIZE = 240;
export const CLIPMAP_GUARD_TEXELS = CLIPMAP_TEX_SIZE - CLIPMAP_COMMITTED_SIZE; // 16 total (8 per side)
export const CLIPMAP_GUARD_HALF = CLIPMAP_GUARD_TEXELS >> 1; // 8 texels per side
export const CLIPMAP_PATCH_QUADS = 16;
export const CLIPMAP_LAYERS = 5;
export const CLIPMAP_SPACINGS_M: readonly [number, number, number, number, number] = [
  0.5, 1.0, 2.0, 4.0, 8.0,
];
export const CLIPMAP_LAYER_TEXELS = CLIPMAP_TEX_SIZE * CLIPMAP_TEX_SIZE;
export const CLIPMAP_TOTAL_TEXELS = CLIPMAP_LAYER_TEXELS * CLIPMAP_LAYERS;
export const CLIPMAP_ANCHOR_RECENTER_THRESHOLD_M = 2048;
export const DEFAULT_CLIPMAP_STREAM_BUDGET_MS = 4.0;

/** 1 row/col (256 texels) per strip step keeps single-step latency well within frame budget. */
const MAX_SCROLL_STRIP_STEP = 1;
const REFINE_ROWS_PER_STEP = 1;
const MAX_DIRTY_TEXELS_PER_STEP = CLIPMAP_TEX_SIZE;
const BOOT_EXACT_CORE_TEXELS = 48;
const BOOT_L1_CORE_TEXELS = 40;
const BOOT_COARSE_CORE_TEXELS = 32;
/** Max texel lag each layer tolerates before `TerrainClipmap.effectiveRanges[L]` starts shrinking. */
const LAYER_SHRINK_LAG_TEXELS: readonly [number, number, number, number, number] = [
  39, 30, 29, 27, 23,
];
const COARSE_EMERGENCY_MARGIN_TEXELS = 2;
const L0_URGENT_LAG_TEXELS = 18;
const NEAR_SKIER_REFINE_RADIUS_L0 = 28;
const NEAR_SKIER_REFINE_RADIUS_L1 = 56;
const NEAR_SKIER_REFINE_RADIUS_L2 = 36;
const MAX_DIRTY_RECT_QUEUE = 64;
const ROW_BITMASK_WORDS_PER_LAYER = CLIPMAP_TEX_SIZE >>> 5; // 8 x Uint32 = 256 bits

type FastSampleGridField = TerrainFieldView & {
  sampleColumnGrid(
    originAbsX: number,
    originAbsZ: number,
    cols: number,
    rows: number,
    stepM: number,
    blockOriginY: number,
    out: TerrainGridSampleOut,
    skipNormals?: boolean,
  ): void;
};

interface ParsedStageColors {
  readonly snow: THREE.Color;
  readonly shadowSnow: THREE.Color;
  readonly bank: THREE.Color;
  readonly ice: THREE.Color;
  readonly powder: THREE.Color;
  readonly cliff: THREE.Color;
  readonly chasmFloor: THREE.Color;
}

interface QueuedDirtyRect {
  layer: number;
  minTx: number;
  maxTx: number;
  minTz: number;
  maxTz: number;
  nextTz: number;
}

const _dividerTint = new THREE.Color('#dbeafe');

/**
 * Converts a linear [0, 1] RGB channel to sRGB [0, 1] before Uint8 quantization
 * for `SRGBColorSpace` textures (`GL_SRGB8_ALPHA8`) so hardware sRGB decode never double-gammas.
 */
export function linearToSRGBChannel(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const SRGB_LUT_MAX = 4095;
const LINEAR_TO_SRGB_U8 = (() => {
  const lut = new Uint8Array(SRGB_LUT_MAX + 1);
  for (let i = 0; i <= SRGB_LUT_MAX; i++) {
    lut[i] = Math.round(linearToSRGBChannel(i / SRGB_LUT_MAX) * 255);
  }
  return lut;
})();

function linearToSRGBByte(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  return LINEAR_TO_SRGB_U8[(c * SRGB_LUT_MAX + 0.5) | 0]!;
}

/**
 * Inverse sRGB transfer (sRGB [0, 1] -> linear [0, 1]), useful for inspection and tests.
 */
export function srgbToLinearChannel(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function wrapTexel(t: number): number {
  return (t | 0) & CLIPMAP_TEX_MASK;
}

function buildPaletteColors(palette: StagePalette): ParsedStageColors {
  return {
    snow: new THREE.Color(palette.snowColor),
    shadowSnow: new THREE.Color(palette.shadowSnowTint),
    bank: new THREE.Color(palette.bankTint),
    ice: new THREE.Color(palette.iceTint),
    powder: new THREE.Color(palette.powderTint),
    cliff: new THREE.Color(palette.cliffColor),
    chasmFloor: new THREE.Color(palette.chasmFloorColor ?? palette.cliffColor),
  };
}

/** Center-outward row order `[128, 127, 129, 126, ...]` so near-skier rows refine first. */
const REFINEMENT_ROW_ORDER = (() => {
  const order = new Int16Array(CLIPMAP_TEX_SIZE);
  let ptr = 0;
  const mid = CLIPMAP_TEX_SIZE >> 1;
  order[ptr++] = mid;
  for (let d = 1; d <= mid; d++) {
    if (mid - d >= 0) order[ptr++] = mid - d;
    if (mid + d < CLIPMAP_TEX_SIZE) order[ptr++] = mid + d;
  }
  return order;
})();

export interface ClipmapDataStoreOptions {
  readonly nowMs?: () => number;
}

/**
 * Toroidal 5-layer `256 x 256 x 5` `DataArrayTexture` store (~5.00 MiB VRAM) + CPU mirrors
 * for De-Risked Synchronous Option 3A CDLOD terrain:
 * - `heightTex` (`R32F`, `NearestFilter`, `ClampToEdgeWrapping`): `absHeight - clipmapAnchorAbsY`
 * - `normalMaskTex` (`RGBA8`, `LinearFilter`, `RepeatWrapping`): `nx*0.5+0.5, nz*0.5+0.5, pisteWeight, iceWeight`
 * - `albedoTex` (`SRGB8_ALPHA8`, `LinearFilter`, `RepeatWrapping`): sRGB-encoded snow/bank/chasm RGB + linear `powderWeight`
 * - `flowElevTex` (`RGBA8`, `LinearFilter`, `RepeatWrapping`): `flowXZ*0.5+0.5, norm((h - macroY + 40)/80), aoCavity`
 *
 * Strictly obeys `three@0.181.0` WebGL2 rules:
 * - Sets `needsUpdate = true` BEFORE `renderer.initTexture(tex)` on initial upload and `webglcontextrestored`.
 * - Uploads incremental toroidal strips via raw `gl.texSubImage3D` (never `copyTextureToTexture` or scratch `THREE.Texture`s).
 * - Uses ONE shared global `clipmapAnchorAbsY` re-anchored across all 5 layers simultaneously at `> 2048 m`.
 * - Tracks per-layer refined rows in a 256-bit toroidal bitmask so scrolling mid-refinement never skips rows.
 * - Zero texel re-evaluations and zero GPU uploads on fractional `WORLD_REBASED`.
 */
export class ClipmapDataStore {
  readonly heightData: Float32Array;
  readonly normalMaskData: Uint8Array;
  readonly albedoData: Uint8Array;
  readonly flowElevData: Uint8Array;

  readonly heightTex: THREE.DataArrayTexture;
  readonly normalMaskTex: THREE.DataArrayTexture;
  readonly albedoTex: THREE.DataArrayTexture;
  readonly flowElevTex: THREE.DataArrayTexture;

  private readonly nowMs: () => number;
  private readonly defaultColors: ParsedStageColors;
  private readonly stageColorById = new Map<string, ParsedStageColors>();
  private readonly stageColorTable: ParsedStageColors[] = [];
  private stageTableRef: readonly string[] | null = null;
  private stageTableLen = 0;

  // Per-layer toroidal window origins in exact float64 integer texel coordinates
  private readonly absOriginTexelX = new Float64Array(CLIPMAP_LAYERS);
  private readonly absOriginTexelZ = new Float64Array(CLIPMAP_LAYERS);
  private readonly targetMinTexelX = new Float64Array(CLIPMAP_LAYERS);
  private readonly targetMinTexelZ = new Float64Array(CLIPMAP_LAYERS);
  private readonly loadedMinTexelX = new Float64Array(CLIPMAP_LAYERS);
  private readonly loadedMinTexelZ = new Float64Array(CLIPMAP_LAYERS);
  private readonly layerInitialized = new Uint8Array(CLIPMAP_LAYERS);
  private readonly bootedLayersScratch = new Uint8Array(CLIPMAP_LAYERS);
  /** 256-bit toroidal bitmask per layer tracking which modZ rows have exact sampleColumnGrid data. */
  private readonly refinedRowMask = new Uint32Array(CLIPMAP_LAYERS * ROW_BITMASK_WORDS_PER_LAYER);
  private readonly unrefinedRowCount = new Int16Array(CLIPMAP_LAYERS);
  private readonly layerMinRelY = new Float32Array(CLIPMAP_LAYERS);
  private readonly layerMaxRelY = new Float32Array(CLIPMAP_LAYERS);

  // Pre-allocated scratch buffers (zero hot-loop heap allocations)
  private readonly coarse17Scratch: TerrainGridSampleOut = createTerrainGridSampleOut(17, 17);
  private readonly bootCoreScratch: TerrainGridSampleOut = createTerrainGridSampleOut(
    BOOT_EXACT_CORE_TEXELS,
    BOOT_EXACT_CORE_TEXELS,
  );
  private readonly stripScratch: TerrainGridSampleOut = createTerrainGridSampleOut(
    CLIPMAP_TEX_SIZE,
    MAX_SCROLL_STRIP_STEP,
  );
  private readonly scratchFloatUpload = new Float32Array(CLIPMAP_LAYER_TEXELS);
  private readonly scratchRgbaUpload = new Uint8Array(CLIPMAP_LAYER_TEXELS * 4);
  private readonly dirtyQueue: QueuedDirtyRect[] = [];
  private dirtyQueueCount = 0;
  private framesSinceDirtyWork = 0;

  private _anchorAbsY = 0;
  private anchorInitialized = false;
  private gpuInitialized = false;
  private lastWorldSeed = -1;
  private lastFieldRevision = -1;

  // Telemetry / verification counters
  private _gpuUploadCount = 0;
  private _fullUploadCount = 0;
  private _dirtyStripUploadCount = 0;
  private _texelsEvaluatedCount = 0;
  private _reanchorCount = 0;

  constructor(gfx: GraphicsUtils, options: ClipmapDataStoreOptions = {}) {
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.defaultColors = buildPaletteColors(STAGE_SUNNY_BLUE.palette);

    this.heightData = new Float32Array(CLIPMAP_TOTAL_TEXELS);
    this.normalMaskData = new Uint8Array(CLIPMAP_TOTAL_TEXELS * 4);
    this.albedoData = new Uint8Array(CLIPMAP_TOTAL_TEXELS * 4);
    this.flowElevData = new Uint8Array(CLIPMAP_TOTAL_TEXELS * 4);

    // Initialize neutral defaults so even before first sync, normals are +Y and AO is 1.0
    for (let i = 0; i < CLIPMAP_TOTAL_TEXELS; i++) {
      const o4 = i * 4;
      this.normalMaskData[o4] = 128;
      this.normalMaskData[o4 + 1] = 128;
      this.normalMaskData[o4 + 2] = 0;
      this.normalMaskData[o4 + 3] = 0;

      this.albedoData[o4] = 248;
      this.albedoData[o4 + 1] = 251;
      this.albedoData[o4 + 2] = 255;
      this.albedoData[o4 + 3] = 255;

      this.flowElevData[o4] = 128;
      this.flowElevData[o4 + 1] = 0;
      this.flowElevData[o4 + 2] = 128;
      this.flowElevData[o4 + 3] = 212; // ~1.0 AO
    }

    this.heightTex = new THREE.DataArrayTexture(
      this.heightData,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_LAYERS,
    );
    this.heightTex.name = 'ClipmapHeightArrayTex';
    this.heightTex.format = THREE.RedFormat;
    this.heightTex.type = THREE.FloatType;
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.generateMipmaps = false;
    this.heightTex.colorSpace = THREE.NoColorSpace;
    this.heightTex.unpackAlignment = 1;
    gfx.markAsCache(this.heightTex, 'ClipmapHeightArrayTex');

    this.normalMaskTex = new THREE.DataArrayTexture(
      this.normalMaskData,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_LAYERS,
    );
    this.normalMaskTex.name = 'ClipmapNormalMaskArrayTex';
    this.normalMaskTex.format = THREE.RGBAFormat;
    this.normalMaskTex.type = THREE.UnsignedByteType;
    this.normalMaskTex.minFilter = THREE.LinearFilter;
    this.normalMaskTex.magFilter = THREE.LinearFilter;
    this.normalMaskTex.wrapS = THREE.RepeatWrapping;
    this.normalMaskTex.wrapT = THREE.RepeatWrapping;
    this.normalMaskTex.generateMipmaps = false;
    this.normalMaskTex.colorSpace = THREE.NoColorSpace;
    this.normalMaskTex.unpackAlignment = 1;
    gfx.markAsCache(this.normalMaskTex, 'ClipmapNormalMaskArrayTex');

    this.albedoTex = new THREE.DataArrayTexture(
      this.albedoData,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_LAYERS,
    );
    this.albedoTex.name = 'ClipmapAlbedoArrayTex';
    this.albedoTex.format = THREE.RGBAFormat;
    this.albedoTex.type = THREE.UnsignedByteType;
    this.albedoTex.minFilter = THREE.LinearFilter;
    this.albedoTex.magFilter = THREE.LinearFilter;
    this.albedoTex.wrapS = THREE.RepeatWrapping;
    this.albedoTex.wrapT = THREE.RepeatWrapping;
    this.albedoTex.generateMipmaps = false;
    this.albedoTex.colorSpace = THREE.SRGBColorSpace;
    this.albedoTex.unpackAlignment = 1;
    gfx.markAsCache(this.albedoTex, 'ClipmapAlbedoArrayTex');

    this.flowElevTex = new THREE.DataArrayTexture(
      this.flowElevData,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_TEX_SIZE,
      CLIPMAP_LAYERS,
    );
    this.flowElevTex.name = 'ClipmapFlowElevArrayTex';
    this.flowElevTex.format = THREE.RGBAFormat;
    this.flowElevTex.type = THREE.UnsignedByteType;
    this.flowElevTex.minFilter = THREE.LinearFilter;
    this.flowElevTex.magFilter = THREE.LinearFilter;
    this.flowElevTex.wrapS = THREE.RepeatWrapping;
    this.flowElevTex.wrapT = THREE.RepeatWrapping;
    this.flowElevTex.generateMipmaps = false;
    this.flowElevTex.colorSpace = THREE.NoColorSpace;
    this.flowElevTex.unpackAlignment = 1;
    gfx.markAsCache(this.flowElevTex, 'ClipmapFlowElevArrayTex');

    for (let i = 0; i < MAX_DIRTY_RECT_QUEUE; i++) {
      this.dirtyQueue.push({
        layer: 0,
        minTx: 0,
        maxTx: 0,
        minTz: 0,
        maxTz: 0,
        nextTz: 0,
      });
    }

    for (let L = 0; L < CLIPMAP_LAYERS; L++) {
      this.layerMinRelY[L] = -120;
      this.layerMaxRelY[L] = 120;
      this.unrefinedRowCount[L] = CLIPMAP_TEX_SIZE;
    }
  }

  get clipmapAnchorAbsY(): number {
    return this._anchorAbsY;
  }

  get gpuUploadCount(): number {
    return this._gpuUploadCount;
  }

  get fullUploadCount(): number {
    return this._fullUploadCount;
  }

  get dirtyStripUploadCount(): number {
    return this._dirtyStripUploadCount;
  }

  get texelsEvaluatedCount(): number {
    return this._texelsEvaluatedCount;
  }

  get reanchorCount(): number {
    return this._reanchorCount;
  }

  get isGpuInitialized(): boolean {
    return this.gpuInitialized;
  }

  get pendingWorkCount(): number {
    let total = this.dirtyQueueCount;
    for (let L = 0; L < CLIPMAP_LAYERS; L++) {
      if (!this.layerInitialized[L]) {
        total += CLIPMAP_TEX_SIZE;
        continue;
      }
      total += Math.abs(this.targetMinTexelX[L]! - this.loadedMinTexelX[L]!);
      total += Math.abs(this.targetMinTexelZ[L]! - this.loadedMinTexelZ[L]!);
      total += Math.max(0, this.unrefinedRowCount[L]!);
    }
    return total;
  }

  isLayerInitialized(layer: number): boolean {
    return this.layerInitialized[layer]! !== 0;
  }

  getUnrefinedRowCount(layer: number): number {
    return this.unrefinedRowCount[layer]!;
  }

  isToroidalRowRefined(layer: number, absTz: number): boolean {
    const modZ = wrapTexel(absTz);
    const word = this.refinedRowMask[layer * ROW_BITMASK_WORDS_PER_LAYER + (modZ >>> 5)]!;
    return (word & (1 << (modZ & 31))) !== 0;
  }

  getAbsOriginTexelX(layer: number): number {
    return this.absOriginTexelX[layer]!;
  }

  getAbsOriginTexelZ(layer: number): number {
    return this.absOriginTexelZ[layer]!;
  }

  getLoadedMinTexelX(layer: number): number {
    return this.loadedMinTexelX[layer]!;
  }

  getLoadedMinTexelZ(layer: number): number {
    return this.loadedMinTexelZ[layer]!;
  }

  getLayerMinRelY(layer: number): number {
    return this.layerMinRelY[layer]!;
  }

  getLayerMaxRelY(layer: number): number {
    return this.layerMaxRelY[layer]!;
  }

  getCommittedHalfSpanM(layer: number): number {
    return CLIPMAP_COMMITTED_SIZE * 0.5 * CLIPMAP_SPACINGS_M[layer]!;
  }

  /**
   * Returns true iff the inclusive texel rectangle `[minTx..maxTx] x [minTz..maxTz]`
   * lies strictly inside the committed non-apron domain of layer `L`.
   */
  isRectCommitted(
    layer: number,
    minTx: number,
    maxTx: number,
    minTz: number,
    maxTz: number,
  ): boolean {
    if (!this.layerInitialized[layer]) return false;
    const loX = this.loadedMinTexelX[layer]! + CLIPMAP_GUARD_HALF;
    const hiX = this.loadedMinTexelX[layer]! + CLIPMAP_TEX_SIZE - CLIPMAP_GUARD_HALF - 1;
    const loZ = this.loadedMinTexelZ[layer]! + CLIPMAP_GUARD_HALF;
    const hiZ = this.loadedMinTexelZ[layer]! + CLIPMAP_TEX_SIZE - CLIPMAP_GUARD_HALF - 1;
    return minTx >= loX && maxTx <= hiX && minTz >= loZ && maxTz <= hiZ;
  }

  /**
   * Reads the absolute world height stored in layer `L`'s CPU mirror at integer texel `(absTx, absTz)`.
   */
  sampleMirrorHeightAbs(layer: number, absTx: number, absTz: number): number {
    const idx =
      layer * CLIPMAP_LAYER_TEXELS + wrapTexel(absTz) * CLIPMAP_TEX_SIZE + wrapTexel(absTx);
    return this.heightData[idx]! + this._anchorAbsY;
  }

  /**
   * Bilinearly samples the absolute world height from layer `L`'s CPU mirror at `(absX, absZ)`.
   */
  sampleMirrorHeightBilinearAbs(layer: number, absX: number, absZ: number): number {
    const invS = 1 / CLIPMAP_SPACINGS_M[layer]!;
    const fx = absX * invS;
    const fz = absZ * invS;
    const tx0 = Math.floor(fx);
    const tz0 = Math.floor(fz);
    const u = fx - tx0;
    const v = fz - tz0;

    const h00 = this.sampleMirrorHeightAbs(layer, tx0, tz0);
    const h10 = this.sampleMirrorHeightAbs(layer, tx0 + 1, tz0);
    const h01 = this.sampleMirrorHeightAbs(layer, tx0, tz0 + 1);
    const h11 = this.sampleMirrorHeightAbs(layer, tx0 + 1, tz0 + 1);
    const hA = h00 + (h10 - h00) * u;
    const hB = h01 + (h11 - h01) * u;
    return hA + (hB - hA) * v;
  }

  /**
   * Reads the quantized sRGB [0..255] RGB + linear alpha from layer `L`'s `albedoData` mirror.
   */
  readMirrorAlbedoBytes(
    layer: number,
    absTx: number,
    absTz: number,
    out: [number, number, number, number],
  ): [number, number, number, number] {
    const o4 =
      (layer * CLIPMAP_LAYER_TEXELS + wrapTexel(absTz) * CLIPMAP_TEX_SIZE + wrapTexel(absTx)) * 4;
    out[0] = this.albedoData[o4]!;
    out[1] = this.albedoData[o4 + 1]!;
    out[2] = this.albedoData[o4 + 2]!;
    out[3] = this.albedoData[o4 + 3]!;
    return out;
  }

  /**
   * Marks all layers uninitialized so the next `update()` cold-boots cleanly on sim reset.
   */
  reset(): void {
    this.layerInitialized.fill(0);
    this.refinedRowMask.fill(0);
    this.unrefinedRowCount.fill(CLIPMAP_TEX_SIZE);
    this.dirtyQueueCount = 0;
    this.framesSinceDirtyWork = 0;
    this.anchorInitialized = false;
    this.lastWorldSeed = -1;
    this.lastFieldRevision = -1;
    for (let L = 0; L < CLIPMAP_LAYERS; L++) {
      this.layerMinRelY[L] = -120;
      this.layerMaxRelY[L] = 120;
    }
  }

  /**
   * Restores all 4 GPU `DataArrayTexture`s instantaneously from CPU mirrors after `webglcontextrestored`
   * without re-evaluating any terrain samples.
   */
  handleContextRestored(renderer: THREE.WebGLRenderer | null): void {
    this.gpuInitialized = false;
    if (renderer) {
      this.ensureGpuTexturesInitialized(renderer);
    }
  }

  /**
   * Explicitly allocates/uploads all 4 `DataArrayTexture`s using `needsUpdate = true` BEFORE
   * `renderer.initTexture(tex)` (mandatory `three@0.181.0` `#21` S1 guard).
   */
  ensureGpuTexturesInitialized(renderer: THREE.WebGLRenderer | null): void {
    if (!renderer || this.gpuInitialized) return;
    this.heightTex.needsUpdate = true;
    renderer.initTexture(this.heightTex);
    this.normalMaskTex.needsUpdate = true;
    renderer.initTexture(this.normalMaskTex);
    this.albedoTex.needsUpdate = true;
    renderer.initTexture(this.albedoTex);
    this.flowElevTex.needsUpdate = true;
    renderer.initTexture(this.flowElevTex);
    this.gpuInitialized = true;
    this._fullUploadCount++;
    this._gpuUploadCount += 4;
  }

  /**
   * Synchronizes all 5 toroidal clipmap rings against `(focusX, focusY, focusZ)` and `terrainField`:
   * - Zero texel evaluations & zero GPU uploads when `(absFocusX, absFocusZ)` stays inside its snapped
   *   16-texel cell (including across fractional `WORLD_REBASED`!).
   * - Re-anchors ONE global `clipmapAnchorAbsY` across all 5 layers if `|focusAbsY - anchor| > 2048 m`.
   * - Invalidates only clipped dirty rects on `fieldRevision` bumps (preserving non-booted layers on
   *   partial teleports) and calls `ackDirtyRects?.()`.
   * - Streams newly revealed 1-row/1-col strips and center-outward bitmask refinement within `budgetMs`.
   */
  update(
    terrainField: TerrainFieldView,
    focusX: number,
    focusY: number,
    focusZ: number,
    renderer: THREE.WebGLRenderer | null,
    budgetMs = DEFAULT_CLIPMAP_STREAM_BUDGET_MS,
  ): void {
    const startMs = this.nowMs();
    const clampedBudgetMs = Math.max(0.5, budgetMs);

    this.syncStageColorTable(terrainField.stageIdTable);

    if (this.lastWorldSeed !== -1 && terrainField.worldSeed !== this.lastWorldSeed) {
      this.reset();
    }
    this.lastWorldSeed = terrainField.worldSeed;

    const absFocusX = focusX + terrainField.originOffsetX;
    const absFocusY = focusY + terrainField.originOffsetY;
    const absFocusZ = focusZ + terrainField.originOffsetZ;

    // 1. Maintain ONE shared global clipmapAnchorAbsY across all 5 layers
    if (!this.anchorInitialized) {
      const groundY = terrainField.evaluateHeight(focusX, focusZ) + terrainField.originOffsetY;
      this._anchorAbsY = Math.round(Number.isFinite(groundY) ? groundY : absFocusY);
      this.anchorInitialized = true;
    } else if (Math.abs(absFocusY - this._anchorAbsY) > CLIPMAP_ANCHOR_RECENTER_THRESHOLD_M) {
      this.reanchorAllLayers(Math.round(absFocusY), renderer);
    }

    // 2. Compute exact float64 16-texel snapped ring origins for all 5 layers
    for (let L = 0; L < CLIPMAP_LAYERS; L++) {
      const s = CLIPMAP_SPACINGS_M[L]!;
      const snapSpanM = CLIPMAP_PATCH_QUADS * s;
      const originTx = Math.floor(absFocusX / snapSpanM) * CLIPMAP_PATCH_QUADS;
      const originTz = Math.floor(absFocusZ / snapSpanM) * CLIPMAP_PATCH_QUADS;
      this.absOriginTexelX[L] = originTx;
      this.absOriginTexelZ[L] = originTz;
      // Center the 256-texel window on [originTx + 8] so focus stays within [-8, +8] texels of center
      this.targetMinTexelX[L] = originTx - 120;
      this.targetMinTexelZ[L] = originTz - 120;
    }

    // 3. Cold boot or partial/full teleport (>= 128 texel jump) per layer
    let bootedCount = 0;
    this.bootedLayersScratch.fill(0);
    for (let L = 0; L < CLIPMAP_LAYERS; L++) {
      const dx = Math.abs(this.targetMinTexelX[L]! - this.loadedMinTexelX[L]!);
      const dz = Math.abs(this.targetMinTexelZ[L]! - this.loadedMinTexelZ[L]!);
      if (!this.layerInitialized[L] || dx >= 128 || dz >= 128) {
        this.coldSeedLayer(L, terrainField);
        // Stamp an exact core around the skier on EVERY cold-booted layer (48x48 on L0, 24x24 on L1..L4)
        // so coarse 16-texel interpolation chords can NEVER float over the skier even after a teleport!
        this.fillBootExactCore(L, terrainField);
        this.bootedLayersScratch[L] = 1;
        bootedCount++;
      }
    }

    if (bootedCount > 0) {
      // Remove stale dirty rects ONLY for layers that just cold-booted; preserve & ingest for un-booted layers!
      this.pruneDirtyQueueForLayers(this.bootedLayersScratch);
      if (this.lastFieldRevision !== -1 && terrainField.fieldRevision !== this.lastFieldRevision) {
        this.ingestDirtyRects(terrainField, this.bootedLayersScratch);
      }
      this.lastFieldRevision = terrainField.fieldRevision;
      terrainField.ackDirtyRects?.();

      if (renderer) {
        if (!this.gpuInitialized) {
          this.ensureGpuTexturesInitialized(renderer);
        } else {
          // Upload ONLY layers that actually cold-booted via raw texSubImage3D
          for (let L = 0; L < CLIPMAP_LAYERS; L++) {
            if (!this.bootedLayersScratch[L]) continue;
            this.uploadToroidalRect(
              renderer,
              L,
              this.loadedMinTexelX[L]!,
              this.loadedMinTexelZ[L]!,
              CLIPMAP_TEX_SIZE,
              CLIPMAP_TEX_SIZE,
              false,
            );
          }
        }
      }
      return;
    }

    // Ensure GPU textures exist if renderer just became available
    if (renderer && !this.gpuInitialized) {
      this.ensureGpuTexturesInitialized(renderer);
    }

    // 4. Handle TerrainFieldView.fieldRevision & dirtyRects invalidation
    if (terrainField.fieldRevision !== this.lastFieldRevision) {
      this.ingestDirtyRects(terrainField, null);
      this.lastFieldRevision = terrainField.fieldRevision;
      terrainField.ackDirtyRects?.();
    }

    let didAnyWork = false;
    let didDirtyWork = false;
    let coarseDribbleUsed = 0;
    const hasBudget = (): boolean => !didAnyWork || this.nowMs() - startMs < clampedBudgetMs;

    // 5. Anti-pileup 1-strip-per-iteration budget scheduler:
    //    (1a) STRICT emergency coarse-pyramid guard (L4 -> L1): triggers whenever any coarse layer
    //         approaches SHRINK_LAG[L] - 2 (L4>=21, L3>=25, L2>=27, L1>=28). L0 can NEVER starve this!
    //    (1b) Smooth coarse dribble (1 strip/frame): whenever ANY coarse layer L4..L1 has lag > 0,
    //         service 1 strip on the highest-pressure coarse layer (ties broken coarsest-first) BEFORE
    //         L0 takes the rest of the frame budget. Prevents 16-texel snap harmonic pileups across
    //         128 m multiples so L4..L1 drain smoothly to 0 well before their next snap!
    //    (1c) Anti-starvation dirty-rect guarantee if queued >= 2 frames
    //    (1d) Urgent near-field L0 scroll whenever L0 lag >= 18 (< 39 shrink threshold -> effR[0] >= 24m)
    //    (2) Guaranteed 1 dirty-rect slice per frame when pending (fork terrain never stays stale in L1..L4)
    //    (3) Near-skier exact-row guard on L0 (±14 m) so skier never skis onto an unrefined coarse chord
    //    (4) Steady coarsest-first scroll drain (L4 -> L3 -> L2 -> L1 -> L0) for all remaining lag > 0
    //    (5) Drain remaining dirty-rect queue
    //    (6) Progressive skier-centered refinement: L0 near-band -> L1 (±56m) / L2 (±72m) -> full L0..L4
    while (hasBudget()) {
      // (1a) STRICT emergency coarse-pyramid protection (L4 -> L1): L0 can NEVER preempt this!
      let urgentCoarseLayer = -1;
      for (let L = CLIPMAP_LAYERS - 1; L >= 1; L--) {
        const lagX = Math.abs(this.targetMinTexelX[L]! - this.loadedMinTexelX[L]!);
        const lagZ = Math.abs(this.targetMinTexelZ[L]! - this.loadedMinTexelZ[L]!);
        const lag = lagX > lagZ ? lagX : lagZ;
        if (lag >= LAYER_SHRINK_LAG_TEXELS[L]! - COARSE_EMERGENCY_MARGIN_TEXELS) {
          urgentCoarseLayer = L;
          break;
        }
      }
      if (urgentCoarseLayer !== -1) {
        this.scrollLayerOneStrip(urgentCoarseLayer, terrainField, renderer);
        didAnyWork = true;
        coarseDribbleUsed++;
        continue;
      }

      // (1b) Smooth coarse dribble (1-2 strips/frame) so 16-texel snaps drain steadily without piling up!
      let totalCoarseLag = 0;
      let bestCoarse = -1;
      let bestPressure = 0;
      for (let L = CLIPMAP_LAYERS - 1; L >= 1; L--) {
        const lagX = Math.abs(this.targetMinTexelX[L]! - this.loadedMinTexelX[L]!);
        const lagZ = Math.abs(this.targetMinTexelZ[L]! - this.loadedMinTexelZ[L]!);
        const lag = lagX > lagZ ? lagX : lagZ;
        if (lag === 0) continue;
        totalCoarseLag += lagX + lagZ;
        const pressure = lag / LAYER_SHRINK_LAG_TEXELS[L]!;
        if (pressure > bestPressure) {
          bestPressure = pressure;
          bestCoarse = L;
        }
      }
      const dribbleCap = totalCoarseLag > 24 ? 2 : 1;
      if (bestCoarse !== -1 && coarseDribbleUsed < dribbleCap) {
        this.scrollLayerOneStrip(bestCoarse, terrainField, renderer);
        didAnyWork = true;
        coarseDribbleUsed++;
        continue;
      }

      // (1c) Anti-starvation dirty-rect guarantee if queued >= 2 frames
      if (this.dirtyQueueCount > 0 && !didDirtyWork && this.framesSinceDirtyWork >= 2) {
        this.stepDirtyRectQueue(terrainField, renderer);
        didAnyWork = true;
        didDirtyWork = true;
        this.framesSinceDirtyWork = 0;
        continue;
      }

      // (1d) Urgent near-field L0 scroll before L0 approaches its 39-texel shrink threshold
      const l0LagX = Math.abs(this.targetMinTexelX[0]! - this.loadedMinTexelX[0]!);
      const l0LagZ = Math.abs(this.targetMinTexelZ[0]! - this.loadedMinTexelZ[0]!);
      if (Math.max(l0LagX, l0LagZ) >= L0_URGENT_LAG_TEXELS) {
        this.scrollLayerOneStrip(0, terrainField, renderer);
        didAnyWork = true;
        continue;
      }

      // (2) Guaranteed 1 dirty-rect slice per frame before steady scrolling / refinement
      if (this.dirtyQueueCount > 0 && !didDirtyWork) {
        this.stepDirtyRectQueue(terrainField, renderer);
        didAnyWork = true;
        didDirtyWork = true;
        this.framesSinceDirtyWork = 0;
        continue;
      }

      // (3) Near-skier exact-row guard on L0 (±14 m) before steady outer-edge scrolling
      if (
        this.unrefinedRowCount[0]! > 0 &&
        this.stepRefineNearSkierRow(0, absFocusZ, NEAR_SKIER_REFINE_RADIUS_L0, terrainField, renderer)
      ) {
        didAnyWork = true;
        continue;
      }

      // (4) Steady coarsest-first scroll drain (L4 -> L3 -> L2 -> L1 -> L0)
      let steadyScrollLayer = -1;
      for (let L = CLIPMAP_LAYERS - 1; L >= 0; L--) {
        if (
          this.loadedMinTexelZ[L]! !== this.targetMinTexelZ[L]! ||
          this.loadedMinTexelX[L]! !== this.targetMinTexelX[L]!
        ) {
          steadyScrollLayer = L;
          break;
        }
      }
      if (steadyScrollLayer !== -1) {
        this.scrollLayerOneStrip(steadyScrollLayer, terrainField, renderer);
        didAnyWork = true;
        continue;
      }

      // (5) Drain remaining dirty rects
      if (this.dirtyQueueCount > 0) {
        this.stepDirtyRectQueue(terrainField, renderer);
        didAnyWork = true;
        didDirtyWork = true;
        this.framesSinceDirtyWork = 0;
        continue;
      }

      // (6a) Near-field L1 & L2 exact-row bands (±56 m / ±72 m) keeping nearby presents & landmarks exact
      if (
        this.unrefinedRowCount[1]! > 0 &&
        this.stepRefineNearSkierRow(1, absFocusZ, NEAR_SKIER_REFINE_RADIUS_L1, terrainField, renderer)
      ) {
        didAnyWork = true;
        continue;
      }
      if (
        this.unrefinedRowCount[2]! > 0 &&
        this.stepRefineNearSkierRow(2, absFocusZ, NEAR_SKIER_REFINE_RADIUS_L2, terrainField, renderer)
      ) {
        didAnyWork = true;
        continue;
      }

      // (6b) Progressive skier-centered refinement (L0 -> L4, 1 row/step, never skips rows!)
      let refinedAny = false;
      for (let L = 0; L < CLIPMAP_LAYERS; L++) {
        if (this.unrefinedRowCount[L]! > 0) {
          this.stepRefineLayer(L, absFocusZ, terrainField, renderer);
          didAnyWork = true;
          refinedAny = true;
          break;
        }
      }
      if (!refinedAny) {
        break;
      }
    }

    if (this.dirtyQueueCount > 0 && !didDirtyWork) {
      this.framesSinceDirtyWork++;
    } else if (this.dirtyQueueCount === 0) {
      this.framesSinceDirtyWork = 0;
    }
  }

  /**
   * Scrolls a single 1-row or 1-col toroidal strip on `layer`, choosing whichever axis (Z or X)
   * currently has greater texel lag so neither axis can fall behind during diagonal skiing.
   */
  private scrollLayerOneStrip(
    layer: number,
    terrainField: TerrainFieldView,
    renderer: THREE.WebGLRenderer | null,
  ): void {
    const lagZ = Math.abs(this.targetMinTexelZ[layer]! - this.loadedMinTexelZ[layer]!);
    const lagX = Math.abs(this.targetMinTexelX[layer]! - this.loadedMinTexelX[layer]!);
    if (lagZ >= lagX && lagZ > 0) {
      this.scrollLayerZ(layer, terrainField, renderer);
    } else if (lagX > 0) {
      this.scrollLayerX(layer, terrainField, renderer);
    }
  }

  /**
   * Synchronously fills an exact texel rectangle `[minTx, minTx + cols) x [minTz, minTz + rows)`
   * in layer `L` via `terrainField.sampleColumnGrid`, updates Laplacian AO, and uploads to GPU.
   */
  fillRectExact(
    layer: number,
    minTx: number,
    minTz: number,
    cols: number,
    rows: number,
    terrainField: TerrainFieldView,
    renderer: THREE.WebGLRenderer | null,
  ): void {
    if (cols <= 0 || rows <= 0) return;
    this.syncStageColorTable(terrainField.stageIdTable);

    const s = CLIPMAP_SPACINGS_M[layer]!;
    const clampedCols = Math.min(cols, CLIPMAP_TEX_SIZE);
    const maxBatchRows = Math.max(1, Math.floor(MAX_DIRTY_TEXELS_PER_STEP / clampedCols));

    for (let rOff = 0; rOff < rows; rOff += maxBatchRows) {
      const batchRows = Math.min(maxBatchRows, rows - rOff);
      const tz0 = minTz + rOff;
      (terrainField as FastSampleGridField).sampleColumnGrid(
        minTx * s,
        tz0 * s,
        clampedCols,
        batchRows,
        s,
        this._anchorAbsY,
        this.stripScratch,
        true,
      );
      this._texelsEvaluatedCount += clampedCols * batchRows;
      this.writeGridToMirror(layer, minTx, tz0, clampedCols, batchRows, this.stripScratch, true);
      if (clampedCols === CLIPMAP_TEX_SIZE) {
        for (let r = 0; r < batchRows; r++) {
          this.markRowRefined(layer, wrapTexel(tz0 + r));
        }
      }
    }

    this.recomputeLaplacianAoAndNormalsRect(
      layer,
      minTx - 1,
      minTz - 1,
      clampedCols + 2,
      rows + 2,
      true,
    );
    this.uploadToroidalRect(
      renderer,
      layer,
      minTx - 1,
      minTz - 1,
      Math.min(CLIPMAP_TEX_SIZE, clampedCols + 2),
      Math.min(CLIPMAP_TEX_SIZE, rows + 2),
      false,
    );
  }

  private clearRefinedRowsForLayer(layer: number): void {
    const base = layer * ROW_BITMASK_WORDS_PER_LAYER;
    for (let w = 0; w < ROW_BITMASK_WORDS_PER_LAYER; w++) {
      this.refinedRowMask[base + w] = 0;
    }
    this.unrefinedRowCount[layer] = CLIPMAP_TEX_SIZE;
  }

  private markRowRefined(layer: number, modZ: number): void {
    const wordIdx = layer * ROW_BITMASK_WORDS_PER_LAYER + (modZ >>> 5);
    const bit = 1 << (modZ & 31);
    const prev = this.refinedRowMask[wordIdx]!;
    if ((prev & bit) === 0) {
      this.refinedRowMask[wordIdx] = prev | bit;
      this.unrefinedRowCount[layer] = Math.max(0, this.unrefinedRowCount[layer]! - 1);
    }
  }

  private reanchorAllLayers(newAnchorAbsY: number, renderer: THREE.WebGLRenderer | null): void {
    const deltaY = this._anchorAbsY - newAnchorAbsY;
    this._anchorAbsY = newAnchorAbsY;
    this._reanchorCount++;

    const heights = this.heightData;
    for (let i = 0; i < heights.length; i++) {
      heights[i] = heights[i]! + deltaY;
    }
    for (let L = 0; L < CLIPMAP_LAYERS; L++) {
      this.layerMinRelY[L] = this.layerMinRelY[L]! + deltaY;
      this.layerMaxRelY[L] = this.layerMaxRelY[L]! + deltaY;
    }

    if (renderer) {
      if (!this.gpuInitialized) {
        this.ensureGpuTexturesInitialized(renderer);
      } else {
        for (let L = 0; L < CLIPMAP_LAYERS; L++) {
          this.uploadToroidalRect(renderer, L, 0, 0, CLIPMAP_TEX_SIZE, CLIPMAP_TEX_SIZE, true);
        }
      }
    }
  }

  /**
   * Evaluates a 17x17 coarse grid (hitting every 16-texel patch corner) and bilinearly upsamples
   * across all 256x256 texels of layer `L`, preventing any uninitialized zero-height texels on Frame 0.
   */
  private coldSeedLayer(layer: number, terrainField: TerrainFieldView): void {
    const minTx = this.targetMinTexelX[layer]!;
    const minTz = this.targetMinTexelZ[layer]!;
    this.loadedMinTexelX[layer] = minTx;
    this.loadedMinTexelZ[layer] = minTz;
    this.layerInitialized[layer] = 1;
    this.clearRefinedRowsForLayer(layer);

    const s = CLIPMAP_SPACINGS_M[layer]!;
    const coarseStepM = CLIPMAP_PATCH_QUADS * s;
    const coarse = this.coarse17Scratch;
    terrainField.sampleColumnGrid(
      minTx * s,
      minTz * s,
      17,
      17,
      coarseStepM,
      this._anchorAbsY,
      coarse,
    );
    this._texelsEvaluatedCount += 17 * 17;

    // Precompute linear RGB albedo at the 17x17 coarse knots for artifact-free linear upsampling
    const coarseR = this.scratchFloatUpload; // reuse top slice safely
    let minRelY = Infinity;
    let maxRelY = -Infinity;
    for (let i = 0; i < 17 * 17; i++) {
      const h = coarse.heights[i]!;
      if (h < minRelY) minRelY = h;
      if (h > maxRelY) maxRelY = h;
      const base3 = i * 3;
      this.computeLinearAlbedoForSample(coarse, i, coarseR, base3);
    }
    this.layerMinRelY[layer] = Number.isFinite(minRelY) ? minRelY - 24 : -120;
    this.layerMaxRelY[layer] = Number.isFinite(maxRelY) ? maxRelY + 24 : 120;

    const layerBase = layer * CLIPMAP_LAYER_TEXELS;
    const hData = this.heightData;
    const nmData = this.normalMaskData;
    const albData = this.albedoData;
    const feData = this.flowElevData;

    for (let gz = 0; gz < CLIPMAP_TEX_SIZE; gz++) {
      const cz = gz >> 4;
      const fz = (gz & 15) * (1 / 16);
      const row0 = cz * 17;
      const row1 = (cz + 1) * 17;
      const dstRow = layerBase + wrapTexel(minTz + gz) * CLIPMAP_TEX_SIZE;

      for (let gx = 0; gx < CLIPMAP_TEX_SIZE; gx++) {
        const cx = gx >> 4;
        const fx = (gx & 15) * (1 / 16);
        const i00 = row0 + cx;
        const i10 = i00 + 1;
        const i01 = row1 + cx;
        const i11 = i01 + 1;

        const w00 = (1 - fx) * (1 - fz);
        const w10 = fx * (1 - fz);
        const w01 = (1 - fx) * fz;
        const w11 = fx * fz;

        const h =
          coarse.heights[i00]! * w00 +
          coarse.heights[i10]! * w10 +
          coarse.heights[i01]! * w01 +
          coarse.heights[i11]! * w11;
        const mac =
          coarse.macroY[i00]! * w00 +
          coarse.macroY[i10]! * w10 +
          coarse.macroY[i01]! * w01 +
          coarse.macroY[i11]! * w11;

        const nx =
          coarse.normals[i00 * 3]! * w00 +
          coarse.normals[i10 * 3]! * w10 +
          coarse.normals[i01 * 3]! * w01 +
          coarse.normals[i11 * 3]! * w11;
        const nz =
          coarse.normals[i00 * 3 + 2]! * w00 +
          coarse.normals[i10 * 3 + 2]! * w10 +
          coarse.normals[i01 * 3 + 2]! * w01 +
          coarse.normals[i11 * 3 + 2]! * w11;

        const pisteW =
          coarse.pisteWeight[i00]! * w00 +
          coarse.pisteWeight[i10]! * w10 +
          coarse.pisteWeight[i01]! * w01 +
          coarse.pisteWeight[i11]! * w11;
        const iceW =
          coarse.iceWeight[i00]! * w00 +
          coarse.iceWeight[i10]! * w10 +
          coarse.iceWeight[i01]! * w01 +
          coarse.iceWeight[i11]! * w11;
        const powderW =
          Math.max(coarse.powderWeight[i00]!, coarse.dividerMask[i00]!) * w00 +
          Math.max(coarse.powderWeight[i10]!, coarse.dividerMask[i10]!) * w10 +
          Math.max(coarse.powderWeight[i01]!, coarse.dividerMask[i01]!) * w01 +
          Math.max(coarse.powderWeight[i11]!, coarse.dividerMask[i11]!) * w11;

        const flowX =
          coarse.flowXZ[i00 * 2]! * w00 +
          coarse.flowXZ[i10 * 2]! * w10 +
          coarse.flowXZ[i01 * 2]! * w01 +
          coarse.flowXZ[i11 * 2]! * w11;
        const flowZ =
          coarse.flowXZ[i00 * 2 + 1]! * w00 +
          coarse.flowXZ[i10 * 2 + 1]! * w10 +
          coarse.flowXZ[i01 * 2 + 1]! * w01 +
          coarse.flowXZ[i11 * 2 + 1]! * w11;

        const rLin =
          coarseR[i00 * 3]! * w00 +
          coarseR[i10 * 3]! * w10 +
          coarseR[i01 * 3]! * w01 +
          coarseR[i11 * 3]! * w11;
        const gLin =
          coarseR[i00 * 3 + 1]! * w00 +
          coarseR[i10 * 3 + 1]! * w10 +
          coarseR[i01 * 3 + 1]! * w01 +
          coarseR[i11 * 3 + 1]! * w11;
        const bLin =
          coarseR[i00 * 3 + 2]! * w00 +
          coarseR[i10 * 3 + 2]! * w10 +
          coarseR[i01 * 3 + 2]! * w01 +
          coarseR[i11 * 3 + 2]! * w11;

        const dstIdx = dstRow + wrapTexel(minTx + gx);
        const o4 = dstIdx * 4;

        hData[dstIdx] = h;

        nmData[o4] = Math.round((clamp(nx, -1, 1) * 0.5 + 0.5) * 255);
        nmData[o4 + 1] = Math.round((clamp(nz, -1, 1) * 0.5 + 0.5) * 255);
        nmData[o4 + 2] = Math.round(clamp(pisteW, 0, 1) * 255);
        nmData[o4 + 3] = Math.round(clamp(iceW, 0, 1) * 255);

        albData[o4] = linearToSRGBByte(rLin);
        albData[o4 + 1] = linearToSRGBByte(gLin);
        albData[o4 + 2] = linearToSRGBByte(bLin);
        albData[o4 + 3] = Math.round(clamp(powderW, 0, 1) * 255);

        const relElev = h - mac;
        const chasmAo = relElev < -4 ? clamp((-relElev - 4) / 28, 0, 1) * 0.22 : 0;
        const baseAo = clamp(1.0 - chasmAo, 0.62, 1.06);

        feData[o4] = Math.round((clamp(flowX, -1, 1) * 0.5 + 0.5) * 255);
        feData[o4 + 1] = Math.round((clamp(flowZ, -1, 1) * 0.5 + 0.5) * 255);
        feData[o4 + 2] = Math.round(clamp((relElev + 40) / 80, 0, 1) * 255);
        feData[o4 + 3] = Math.round(clamp((baseAo - 0.5) / 0.6, 0, 1) * 255);
      }
    }

    this.recomputeLaplacianAoAndNormalsRect(
      layer,
      minTx + 1,
      minTz + 1,
      CLIPMAP_TEX_SIZE - 2,
      CLIPMAP_TEX_SIZE - 2,
      false,
    );
  }

  /**
   * Immediately stamps an exact core around the skier on cold-boot / teleport:
   * - `L0`: `48 x 48` (`24 m x 24 m`) so feet, ski tracks, and shadows have `< 1 cm` parity immediately.
   * - `L1..L4`: `40 x 40` (L1/L2) / `32 x 32` (L3/L4) biased slightly downhill (`-Z`) while covering
   *   the full 16-texel snap cell so coarse interpolation chords never float over the skier or near presents.
   */
  private fillBootExactCore(layer: number, terrainField: TerrainFieldView): void {
    const s = CLIPMAP_SPACINGS_M[layer]!;
    const coreSize =
      layer === 0
        ? BOOT_EXACT_CORE_TEXELS
        : layer <= 2
          ? BOOT_L1_CORE_TEXELS
          : BOOT_COARSE_CORE_TEXELS;
    const marginX = (coreSize - CLIPMAP_PATCH_QUADS) >> 1;
    // Bias Z slightly downhill (-Z) on L1..L4 while keeping the full [0..16] snap cell covered (+2 margin uphill)
    const marginZDown = layer === 0 ? marginX : coreSize - CLIPMAP_PATCH_QUADS - 2;
    const minTx = this.absOriginTexelX[layer]! - marginX;
    const minTz = this.absOriginTexelZ[layer]! - marginZDown;
    (terrainField as FastSampleGridField).sampleColumnGrid(
      minTx * s,
      minTz * s,
      coreSize,
      coreSize,
      s,
      this._anchorAbsY,
      this.bootCoreScratch,
      true,
    );
    this._texelsEvaluatedCount += coreSize * coreSize;
    this.writeGridToMirror(layer, minTx, minTz, coreSize, coreSize, this.bootCoreScratch, true);
    this.recomputeLaplacianAoAndNormalsRect(
      layer,
      minTx - 1,
      minTz - 1,
      coreSize + 2,
      coreSize + 2,
      true,
    );
  }

  private scrollLayerZ(
    layer: number,
    terrainField: TerrainFieldView,
    renderer: THREE.WebGLRenderer | null,
  ): void {
    const oldMinZ = this.loadedMinTexelZ[layer]!;
    const targetZ = this.targetMinTexelZ[layer]!;
    const delta = targetZ - oldMinZ;
    const step = clamp(delta, -MAX_SCROLL_STRIP_STEP, MAX_SCROLL_STRIP_STEP);
    if (step === 0) return;

    const minTx = this.loadedMinTexelX[layer]!;
    const stripRows = Math.abs(step);
    const stripMinTz = step > 0 ? oldMinZ + CLIPMAP_TEX_SIZE : oldMinZ + step;
    this.loadedMinTexelZ[layer] = oldMinZ + step;

    const s = CLIPMAP_SPACINGS_M[layer]!;
    (terrainField as FastSampleGridField).sampleColumnGrid(
      minTx * s,
      stripMinTz * s,
      CLIPMAP_TEX_SIZE,
      stripRows,
      s,
      this._anchorAbsY,
      this.stripScratch,
      true,
    );
    this._texelsEvaluatedCount += CLIPMAP_TEX_SIZE * stripRows;
    this.writeGridToMirror(
      layer,
      minTx,
      stripMinTz,
      CLIPMAP_TEX_SIZE,
      stripRows,
      this.stripScratch,
      true,
    );
    for (let r = 0; r < stripRows; r++) {
      this.markRowRefined(layer, wrapTexel(stripMinTz + r));
    }

    // Recompute AO & mirror-derived normals for the newly revealed strip + 1 interior neighbor row
    const loadedMinZ = this.loadedMinTexelZ[layer]!;
    const uploadMinZ = Math.max(loadedMinZ, stripMinTz - 1);
    const uploadMaxZ = Math.min(loadedMinZ + CLIPMAP_TEX_SIZE - 1, stripMinTz + stripRows);
    const uploadRows = uploadMaxZ - uploadMinZ + 1;
    this.recomputeLaplacianAoAndNormalsRect(
      layer,
      minTx,
      uploadMinZ,
      CLIPMAP_TEX_SIZE,
      uploadRows,
      true,
    );
    this.uploadToroidalRect(renderer, layer, minTx, uploadMinZ, CLIPMAP_TEX_SIZE, uploadRows, false);
  }

  private scrollLayerX(
    layer: number,
    terrainField: TerrainFieldView,
    renderer: THREE.WebGLRenderer | null,
  ): void {
    const oldMinX = this.loadedMinTexelX[layer]!;
    const targetX = this.targetMinTexelX[layer]!;
    const delta = targetX - oldMinX;
    const step = clamp(delta, -MAX_SCROLL_STRIP_STEP, MAX_SCROLL_STRIP_STEP);
    if (step === 0) return;

    const minTz = this.loadedMinTexelZ[layer]!;
    const stripCols = Math.abs(step);
    const stripMinTx = step > 0 ? oldMinX + CLIPMAP_TEX_SIZE : oldMinX + step;
    this.loadedMinTexelX[layer] = oldMinX + step;

    const s = CLIPMAP_SPACINGS_M[layer]!;
    // Strip scratch has capacity 256 * 1 = 256; stripCols = 1, rows = 256 -> exact fit!
    (terrainField as FastSampleGridField).sampleColumnGrid(
      stripMinTx * s,
      minTz * s,
      stripCols,
      CLIPMAP_TEX_SIZE,
      s,
      this._anchorAbsY,
      this.stripScratch,
      true,
    );
    this._texelsEvaluatedCount += stripCols * CLIPMAP_TEX_SIZE;
    this.writeGridToMirror(
      layer,
      stripMinTx,
      minTz,
      stripCols,
      CLIPMAP_TEX_SIZE,
      this.stripScratch,
      true,
    );

    const loadedMinX = this.loadedMinTexelX[layer]!;
    const uploadMinX = Math.max(loadedMinX, stripMinTx - 1);
    const uploadMaxX = Math.min(loadedMinX + CLIPMAP_TEX_SIZE - 1, stripMinTx + stripCols);
    const uploadCols = uploadMaxX - uploadMinX + 1;
    this.recomputeLaplacianAoAndNormalsRect(
      layer,
      uploadMinX,
      minTz,
      uploadCols,
      CLIPMAP_TEX_SIZE,
      true,
    );
    this.uploadToroidalRect(renderer, layer, uploadMinX, minTz, uploadCols, CLIPMAP_TEX_SIZE, false);
  }

  /**
   * Scans the 256-bit toroidal refined-row bitmask outward from the skier's live row inside
   * `[loadedMinTexelZ[layer], loadedMinTexelZ[layer] + 255]` so near-skier rows always refine first
   * and scrolling mid-refinement NEVER skips coarse-seeded rows.
   */
  private stepRefineLayer(
    layer: number,
    absFocusZ: number,
    terrainField: TerrainFieldView,
    renderer: THREE.WebGLRenderer | null,
  ): void {
    if (this.unrefinedRowCount[layer]! <= 0) return;

    const minTx = this.loadedMinTexelX[layer]!;
    const minTz = this.loadedMinTexelZ[layer]!;
    const s = CLIPMAP_SPACINGS_M[layer]!;
    const maskBase = layer * ROW_BITMASK_WORDS_PER_LAYER;
    const centerOff = clamp(
      Math.round(absFocusZ / s - minTz),
      0,
      CLIPMAP_TEX_SIZE - 1,
    );
    let refinedThisStep = 0;

    for (let i = 0; i < CLIPMAP_TEX_SIZE && refinedThisStep < REFINE_ROWS_PER_STEP; i++) {
      // Map REFINEMENT_ROW_ORDER (centered on 128) to live skier centerOff, wrapping cleanly into [0..255]
      const rel = (centerOff + (REFINEMENT_ROW_ORDER[i]! - (CLIPMAP_TEX_SIZE >> 1))) & CLIPMAP_TEX_MASK;
      const absTz = minTz + rel;
      const modZ = wrapTexel(absTz);
      const word = this.refinedRowMask[maskBase + (modZ >>> 5)]!;
      if ((word & (1 << (modZ & 31))) !== 0) continue;

      (terrainField as FastSampleGridField).sampleColumnGrid(
        minTx * s,
        absTz * s,
        CLIPMAP_TEX_SIZE,
        1,
        s,
        this._anchorAbsY,
        this.stripScratch,
        true,
      );
      this._texelsEvaluatedCount += CLIPMAP_TEX_SIZE;
      this.writeGridToMirror(layer, minTx, absTz, CLIPMAP_TEX_SIZE, 1, this.stripScratch, true);
      this.markRowRefined(layer, modZ);

      const uploadMinZ = Math.max(minTz, absTz - 1);
      const uploadMaxZ = Math.min(minTz + CLIPMAP_TEX_SIZE - 1, absTz + 1);
      const uploadRows = uploadMaxZ - uploadMinZ + 1;
      this.recomputeLaplacianAoAndNormalsRect(
        layer,
        minTx,
        uploadMinZ,
        CLIPMAP_TEX_SIZE,
        uploadRows,
        true,
      );
      this.uploadToroidalRect(renderer, layer, minTx, uploadMinZ, CLIPMAP_TEX_SIZE, uploadRows, false);
      refinedThisStep++;
    }

    // Defensive sync if all 256 bits were already set
    if (refinedThisStep === 0) {
      this.unrefinedRowCount[layer] = 0;
    }
  }

  /**
   * Refines the single closest unrefined row within `±radiusTexels` of `absFocusZ` on `layer`.
   * Returns true if a row was refined, false if all rows within the near-skier band are already exact.
   */
  private stepRefineNearSkierRow(
    layer: number,
    absFocusZ: number,
    radiusTexels: number,
    terrainField: TerrainFieldView,
    renderer: THREE.WebGLRenderer | null,
  ): boolean {
    if (this.unrefinedRowCount[layer]! <= 0) return false;

    const minTx = this.loadedMinTexelX[layer]!;
    const minTz = this.loadedMinTexelZ[layer]!;
    const maxTz = minTz + CLIPMAP_TEX_SIZE - 1;
    const s = CLIPMAP_SPACINGS_M[layer]!;
    const maskBase = layer * ROW_BITMASK_WORDS_PER_LAYER;
    const focusTz = Math.round(absFocusZ / s);

    for (let d = 0; d <= radiusTexels; d++) {
      const signCount = d === 0 ? 1 : 2;
      for (let k = 0; k < signCount; k++) {
        // Check downhill (-Z) slightly before uphill (+Z)
        const absTz = k === 0 ? focusTz - d : focusTz + d;
        if (absTz < minTz || absTz > maxTz) continue;
        const modZ = wrapTexel(absTz);
        const word = this.refinedRowMask[maskBase + (modZ >>> 5)]!;
        if ((word & (1 << (modZ & 31))) !== 0) continue;

        (terrainField as FastSampleGridField).sampleColumnGrid(
          minTx * s,
          absTz * s,
          CLIPMAP_TEX_SIZE,
          1,
          s,
          this._anchorAbsY,
          this.stripScratch,
          true,
        );
        this._texelsEvaluatedCount += CLIPMAP_TEX_SIZE;
        this.writeGridToMirror(layer, minTx, absTz, CLIPMAP_TEX_SIZE, 1, this.stripScratch, true);
        this.markRowRefined(layer, modZ);

        const uploadMinZ = Math.max(minTz, absTz - 1);
        const uploadMaxZ = Math.min(maxTz, absTz + 1);
        const uploadRows = uploadMaxZ - uploadMinZ + 1;
        this.recomputeLaplacianAoAndNormalsRect(
          layer,
          minTx,
          uploadMinZ,
          CLIPMAP_TEX_SIZE,
          uploadRows,
          true,
        );
        this.uploadToroidalRect(
          renderer,
          layer,
          minTx,
          uploadMinZ,
          CLIPMAP_TEX_SIZE,
          uploadRows,
          false,
        );
        return true;
      }
    }
    return false;
  }

  private pruneDirtyQueueForLayers(bootedMask: Uint8Array): void {
    let i = 0;
    while (i < this.dirtyQueueCount) {
      if (bootedMask[this.dirtyQueue[i]!.layer]) {
        this.removeDirtyQueueIndex(i);
      } else {
        i++;
      }
    }
  }

  private ingestDirtyRects(
    terrainField: TerrainFieldView,
    skipLayersMask: Uint8Array | null,
  ): void {
    const rects = terrainField.dirtyRects;
    if (rects.length === 0) {
      // Full topology reset without narrow dirty rects -> schedule center-outward re-refinement
      for (let L = 0; L < CLIPMAP_LAYERS; L++) {
        if (skipLayersMask && skipLayersMask[L]) continue;
        if (this.layerInitialized[L]) {
          this.clearRefinedRowsForLayer(L);
        }
      }
      return;
    }

    for (let r = 0; r < rects.length; r++) {
      const rect = rects[r]!;
      for (let L = 0; L < CLIPMAP_LAYERS; L++) {
        if (!this.layerInitialized[L]) continue;
        if (skipLayersMask && skipLayersMask[L]) continue;
        const s = CLIPMAP_SPACINGS_M[L]!;
        const loX = this.loadedMinTexelX[L]!;
        const hiX = loX + CLIPMAP_TEX_SIZE - 1;
        const loZ = this.loadedMinTexelZ[L]!;
        const hiZ = loZ + CLIPMAP_TEX_SIZE - 1;

        const minTx = Math.max(loX, Math.floor(rect.minAbsX / s) - 1);
        const maxTx = Math.min(hiX, Math.ceil(rect.maxAbsX / s) + 1);
        const minTz = Math.max(loZ, Math.floor(rect.minAbsZ / s) - 1);
        const maxTz = Math.min(hiZ, Math.ceil(rect.maxAbsZ / s) + 1);

        if (minTx > maxTx || minTz > maxTz) continue;

        if (this.dirtyQueueCount < MAX_DIRTY_RECT_QUEUE) {
          const slot = this.dirtyQueue[this.dirtyQueueCount++]!;
          slot.layer = L;
          slot.minTx = minTx;
          slot.maxTx = maxTx;
          slot.minTz = minTz;
          slot.maxTz = maxTz;
          slot.nextTz = minTz;
        } else {
          // Queue saturated: trigger full center-outward re-refinement for this layer
          this.clearRefinedRowsForLayer(L);
        }
      }
    }
  }

  private stepDirtyRectQueue(
    terrainField: TerrainFieldView,
    renderer: THREE.WebGLRenderer | null,
  ): void {
    if (this.dirtyQueueCount <= 0) return;

    // Pick finest-layer entry first
    let bestIdx = 0;
    let bestLayer = this.dirtyQueue[0]!.layer;
    for (let i = 1; i < this.dirtyQueueCount; i++) {
      const l = this.dirtyQueue[i]!.layer;
      if (l < bestLayer) {
        bestLayer = l;
        bestIdx = i;
      }
    }

    const entry = this.dirtyQueue[bestIdx]!;
    const L = entry.layer;
    // Re-clip against current loaded toroidal window in case layer scrolled since enqueue
    const loX = this.loadedMinTexelX[L]!;
    const hiX = loX + CLIPMAP_TEX_SIZE - 1;
    const loZ = this.loadedMinTexelZ[L]!;
    const hiZ = loZ + CLIPMAP_TEX_SIZE - 1;

    const minTx = Math.max(loX, entry.minTx);
    const maxTx = Math.min(hiX, entry.maxTx);
    const curTz = Math.max(loZ, entry.nextTz);
    const maxTz = Math.min(hiZ, entry.maxTz);

    if (minTx > maxTx || curTz > maxTz) {
      this.removeDirtyQueueIndex(bestIdx);
      return;
    }

    // Cap dirty-rect step cleanly to <= 256 texels to stay inside frame budget
    const cols = maxTx - minTx + 1;
    const maxRows = Math.max(1, Math.floor(MAX_DIRTY_TEXELS_PER_STEP / cols));
    const batchRows = Math.min(maxRows, maxTz - curTz + 1);
    const s = CLIPMAP_SPACINGS_M[L]!;

    (terrainField as FastSampleGridField).sampleColumnGrid(
      minTx * s,
      curTz * s,
      cols,
      batchRows,
      s,
      this._anchorAbsY,
      this.stripScratch,
      true,
    );
    this._texelsEvaluatedCount += cols * batchRows;
    this.writeGridToMirror(L, minTx, curTz, cols, batchRows, this.stripScratch, true);

    const uploadMinX = Math.max(loX, minTx - 1);
    const uploadMaxX = Math.min(hiX, maxTx + 1);
    const uploadMinZ = Math.max(loZ, curTz - 1);
    const uploadMaxZ = Math.min(hiZ, curTz + batchRows);
    const uploadCols = uploadMaxX - uploadMinX + 1;
    const uploadRows = uploadMaxZ - uploadMinZ + 1;
    this.recomputeLaplacianAoAndNormalsRect(L, uploadMinX, uploadMinZ, uploadCols, uploadRows, true);
    this.uploadToroidalRect(renderer, L, uploadMinX, uploadMinZ, uploadCols, uploadRows, false);

    entry.nextTz = curTz + batchRows;
    if (entry.nextTz > maxTz) {
      this.removeDirtyQueueIndex(bestIdx);
    }
  }

  private removeDirtyQueueIndex(idx: number): void {
    const lastIdx = this.dirtyQueueCount - 1;
    if (idx !== lastIdx) {
      const a = this.dirtyQueue[idx]!;
      const b = this.dirtyQueue[lastIdx]!;
      a.layer = b.layer;
      a.minTx = b.minTx;
      a.maxTx = b.maxTx;
      a.minTz = b.minTz;
      a.maxTz = b.maxTz;
      a.nextTz = b.nextTz;
    }
    this.dirtyQueueCount--;
  }

  private writeGridToMirror(
    layer: number,
    minTx: number,
    minTz: number,
    cols: number,
    rows: number,
    grid: TerrainGridSampleOut,
    skipNormals = false,
  ): void {
    const layerBase = layer * CLIPMAP_LAYER_TEXELS;
    const hData = this.heightData;
    const nmData = this.normalMaskData;
    const albData = this.albedoData;
    const feData = this.flowElevData;
    const rgbScratch = this.scratchFloatUpload; // first 3 floats used as zero-alloc RGB out

    let minY = this.layerMinRelY[layer]!;
    let maxY = this.layerMaxRelY[layer]!;

    for (let r = 0; r < rows; r++) {
      const modZ = wrapTexel(minTz + r);
      const dstRow = layerBase + modZ * CLIPMAP_TEX_SIZE;
      const srcRow = r * cols;

      for (let c = 0; c < cols; c++) {
        const srcIdx = srcRow + c;
        const dstIdx = dstRow + wrapTexel(minTx + c);
        const o4 = dstIdx * 4;

        const h = grid.heights[srcIdx]!;
        const mac = grid.macroY[srcIdx]!;
        hData[dstIdx] = h;
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;

        const pisteW = clamp(grid.pisteWeight[srcIdx]!, 0, 1);
        const iceW = clamp(grid.iceWeight[srcIdx]!, 0, 1);
        const divW = clamp(grid.dividerMask[srcIdx]!, 0, 1);
        const powderW = clamp(Math.max(grid.powderWeight[srcIdx]!, divW), 0, 1);

        if (!skipNormals) {
          const nx = clamp(grid.normals[srcIdx * 3]!, -1, 1);
          const nz = clamp(grid.normals[srcIdx * 3 + 2]!, -1, 1);
          nmData[o4] = Math.round((nx * 0.5 + 0.5) * 255);
          nmData[o4 + 1] = Math.round((nz * 0.5 + 0.5) * 255);
        }
        nmData[o4 + 2] = Math.round(pisteW * 255);
        nmData[o4 + 3] = Math.round(iceW * 255);

        this.computeLinearAlbedoForSample(grid, srcIdx, rgbScratch, 0);
        albData[o4] = linearToSRGBByte(rgbScratch[0]!);
        albData[o4 + 1] = linearToSRGBByte(rgbScratch[1]!);
        albData[o4 + 2] = linearToSRGBByte(rgbScratch[2]!);
        albData[o4 + 3] = (powderW * 255 + 0.5) | 0;

        const fx = clamp(grid.flowXZ[srcIdx * 2]!, -1, 1);
        const fz = clamp(grid.flowXZ[srcIdx * 2 + 1]!, -1, 1);
        const relElev = h - mac;
        const chasmAo = relElev < -4 ? clamp((-relElev - 4) / 28, 0, 1) * 0.22 : 0;
        const baseAo = clamp(1.0 - chasmAo, 0.62, 1.06);

        feData[o4] = ((fx * 0.5 + 0.5) * 255 + 0.5) | 0;
        feData[o4 + 1] = ((fz * 0.5 + 0.5) * 255 + 0.5) | 0;
        feData[o4 + 2] = (clamp((relElev + 40) / 80, 0, 1) * 255 + 0.5) | 0;
        feData[o4 + 3] = (clamp((baseAo - 0.5) / 0.6, 0, 1) * 255 + 0.5) | 0;
      }
    }

    this.layerMinRelY[layer] = minY;
    this.layerMaxRelY[layer] = maxY;
  }

  /**
   * Computes CPU-baked 4-neighbor Laplacian + chasm cavity AO and (when `updateNormals` is true)
   * exact mirror-derived central-difference normals directly from `heightData` with ZERO extra
   * `MountainField` evaluations, clamping strictly inside the loaded toroidal window so seams never leak.
   */
  private recomputeLaplacianAoAndNormalsRect(
    layer: number,
    minTx: number,
    minTz: number,
    cols: number,
    rows: number,
    updateNormals: boolean,
  ): void {
    const winMinX = this.loadedMinTexelX[layer]!;
    const winMaxX = winMinX + CLIPMAP_TEX_SIZE - 1;
    const winMinZ = this.loadedMinTexelZ[layer]!;
    const winMaxZ = winMinZ + CLIPMAP_TEX_SIZE - 1;

    const startX = Math.max(updateNormals ? winMinX : winMinX + 1, minTx);
    const endX = Math.min(updateNormals ? winMaxX : winMaxX - 1, minTx + cols - 1);
    const startZ = Math.max(updateNormals ? winMinZ : winMinZ + 1, minTz);
    const endZ = Math.min(updateNormals ? winMaxZ : winMaxZ - 1, minTz + rows - 1);
    if (startX > endX || startZ > endZ) return;

    const layerBase = layer * CLIPMAP_LAYER_TEXELS;
    const hData = this.heightData;
    const nmData = this.normalMaskData;
    const feData = this.flowElevData;
    const invSpacing = 1 / CLIPMAP_SPACINGS_M[layer]!;
    const inv2Spacing = 0.5 * invSpacing;

    for (let tz = startZ; tz <= endZ; tz++) {
      const interiorZ = tz > winMinZ && tz < winMaxZ;
      const zC = wrapTexel(tz) * CLIPMAP_TEX_SIZE;
      const zD = wrapTexel(interiorZ || tz === winMaxZ ? tz - 1 : tz) * CLIPMAP_TEX_SIZE;
      const zU = wrapTexel(interiorZ || tz === winMinZ ? tz + 1 : tz) * CLIPMAP_TEX_SIZE;
      const invSpanZ = interiorZ ? inv2Spacing : invSpacing;

      for (let tx = startX; tx <= endX; tx++) {
        const interiorX = tx > winMinX && tx < winMaxX;
        const xC = wrapTexel(tx);
        const xL = wrapTexel(interiorX || tx === winMaxX ? tx - 1 : tx);
        const xR = wrapTexel(interiorX || tx === winMinX ? tx + 1 : tx);

        const idxC = layerBase + zC + xC;
        const hC = hData[idxC]!;
        const hL = hData[layerBase + zC + xL]!;
        const hR = hData[layerBase + zC + xR]!;
        const hD = hData[layerBase + zD + xC]!;
        const hU = hData[layerBase + zU + xC]!;
        const o4 = idxC * 4;

        if (interiorX && interiorZ) {
          const avgN = (hL + hR + hD + hU) * 0.25;
          const laplacian = (avgN - hC) * invSpacing;
          const relElev = feData[o4 + 2]! * (80 / 255) - 40;
          const chasmAo = relElev < -4 ? clamp((-relElev - 4) / 28, 0, 1) * 0.22 : 0;
          const cavityAo = clamp(laplacian * 0.65, -0.06, 0.24);
          const terrainAO = clamp(1.0 - cavityAo - chasmAo, 0.62, 1.06);
          feData[o4 + 3] = (clamp((terrainAO - 0.5) / 0.6, 0, 1) * 255 + 0.5) | 0;
        }

        if (updateNormals) {
          const invSpanX = interiorX ? inv2Spacing : invSpacing;
          const dHx = (hR - hL) * invSpanX;
          const dHz = (hU - hD) * invSpanZ;
          const invLen = 1 / Math.sqrt(dHx * dHx + 1 + dHz * dHz);
          nmData[o4] = ((clamp(-dHx * invLen, -1, 1) * 0.5 + 0.5) * 255 + 0.5) | 0;
          nmData[o4 + 1] = ((clamp(-dHz * invLen, -1, 1) * 0.5 + 0.5) * 255 + 0.5) | 0;
        }
      }
    }
  }

  /**
   * Computes stage-blended snow / ice / powder / bank / divider / chasm linear RGB for sample `idx`.
   */
  private computeLinearAlbedoForSample(
    grid: TerrainGridSampleOut,
    idx: number,
    outBuf: Float32Array,
    outOffset: number,
  ): void {
    const primColors = this.stageColorTable[grid.primaryStageIdx[idx]!] ?? this.defaultColors;
    const pisteW = clamp(grid.pisteWeight[idx]!, 0, 1);
    const iceW = clamp(grid.iceWeight[idx]!, 0, 1);
    const powderW = clamp(grid.powderWeight[idx]!, 0, 1);
    const divW = clamp(grid.dividerMask[idx]!, 0, 1);
    const offDist = grid.offPisteDist[idx]!;
    const flags = grid.flags[idx]!;
    const inDivider = (flags & TERRAIN_FLAG_IN_DIVIDER) !== 0;
    const inChasm = (flags & TERRAIN_FLAG_IN_CHASM) !== 0;
    const relElev = grid.heights[idx]! - grid.macroY[idx]!;

    const secWeight = grid.secondaryStageWeightU8[idx]! * (1 / 255);
    const secIdx = grid.secondaryStageIdx[idx]!;

    this.evalStageLinearRgb(
      primColors,
      pisteW,
      iceW,
      powderW,
      divW,
      inDivider,
      inChasm,
      offDist,
      relElev,
      outBuf,
      outOffset,
    );

    if (secWeight > 1e-3 && secIdx !== grid.primaryStageIdx[idx]!) {
      const r0 = outBuf[outOffset]!;
      const g0 = outBuf[outOffset + 1]!;
      const b0 = outBuf[outOffset + 2]!;
      const secColors = this.stageColorTable[secIdx] ?? this.defaultColors;
      this.evalStageLinearRgb(
        secColors,
        pisteW,
        iceW,
        powderW,
        divW,
        inDivider,
        inChasm,
        offDist,
        relElev,
        outBuf,
        outOffset,
      );
      outBuf[outOffset] = lerp(r0, outBuf[outOffset]!, secWeight);
      outBuf[outOffset + 1] = lerp(g0, outBuf[outOffset + 1]!, secWeight);
      outBuf[outOffset + 2] = lerp(b0, outBuf[outOffset + 2]!, secWeight);
    }
  }

  private evalStageLinearRgb(
    c: ParsedStageColors,
    pisteW: number,
    iceW: number,
    powderW: number,
    divW: number,
    inDivider: boolean,
    inChasm: boolean,
    offDist: number,
    relElev: number,
    outBuf: Float32Array,
    outOffset: number,
  ): void {
    // Piste linear RGB
    let pr = c.snow.r;
    let pg = c.snow.g;
    let pb = c.snow.b;

    if (pisteW > 1e-4) {
      const iceRatio = clamp(iceW / pisteW, 0, 1);
      if (iceRatio > 1e-4) {
        pr = lerp(pr, c.ice.r, iceRatio);
        pg = lerp(pg, c.ice.g, iceRatio);
        pb = lerp(pb, c.ice.b, iceRatio);
      }
      const pistePowder = clamp(powderW - (1 - pisteW), 0, 1);
      if (pistePowder > 1e-4) {
        pr = lerp(pr, c.powder.r, pistePowder);
        pg = lerp(pg, c.powder.g, pistePowder);
        pb = lerp(pb, c.powder.b, pistePowder);
      }
      const divBlend = inDivider ? Math.max(divW, 0.7) : divW;
      if (divBlend > 1e-4) {
        const dr = lerp(c.bank.r, _dividerTint.r, 0.35);
        const dg = lerp(c.bank.g, _dividerTint.g, 0.35);
        const db = lerp(c.bank.b, _dividerTint.b, 0.35);
        pr = lerp(pr, dr, divBlend);
        pg = lerp(pg, dg, divBlend);
        pb = lerp(pb, db, divBlend);
      }
    }

    // Off-piste bank + chasm linear RGB
    const bankRatio = clamp(offDist / 28, 0, 1);
    let or = lerp(c.bank.r, c.shadowSnow.r, bankRatio * 0.55);
    let og = lerp(c.bank.g, c.shadowSnow.g, bankRatio * 0.55);
    let ob = lerp(c.bank.b, c.shadowSnow.b, bankRatio * 0.55);

    if (inChasm) {
      const chasmT = clamp(Math.max(0, -relElev) / 32, 0, 1);
      or = lerp(or, c.chasmFloor.r, chasmT);
      og = lerp(og, c.chasmFloor.g, chasmT);
      ob = lerp(ob, c.chasmFloor.b, chasmT);
    }

    outBuf[outOffset] = lerp(or, pr, pisteW);
    outBuf[outOffset + 1] = lerp(og, pg, pisteW);
    outBuf[outOffset + 2] = lerp(ob, pb, pisteW);
  }

  /**
   * Uploads a toroidal rectangle `[tx0, tx0 + w) x [tz0, tz0 + h)` on `layer` directly via raw
   * WebGL2 `gl.texSubImage3D`, hitting the zero-copy fast path whenever `w === 256`, splitting
   * cleanly across `255 -> 0` wrap boundaries with zero heap allocations, and restoring GL state.
   */
  private uploadToroidalRect(
    renderer: THREE.WebGLRenderer | null,
    layer: number,
    tx0: number,
    tz0: number,
    w: number,
    h: number,
    heightOnly: boolean,
  ): void {
    const cw = Math.min(CLIPMAP_TEX_SIZE, Math.max(0, w));
    const ch = Math.min(CLIPMAP_TEX_SIZE, Math.max(0, h));
    if (cw === 0 || ch === 0) return;

    this._dirtyStripUploadCount++;
    if (!renderer) return;

    const gl = renderer.getContext() as WebGL2RenderingContext | null;
    if (!gl || typeof gl.texSubImage3D !== 'function') return;

    if (!this.gpuInitialized) {
      this.ensureGpuTexturesInitialized(renderer);
      return;
    }

    const hHandle = (renderer.properties.get(this.heightTex) as { __webglTexture?: WebGLTexture })
      .__webglTexture;
    const nmHandle = (
      renderer.properties.get(this.normalMaskTex) as { __webglTexture?: WebGLTexture }
    ).__webglTexture;
    const albHandle = (renderer.properties.get(this.albedoTex) as { __webglTexture?: WebGLTexture })
      .__webglTexture;
    const feHandle = (
      renderer.properties.get(this.flowElevTex) as { __webglTexture?: WebGLTexture }
    ).__webglTexture;

    if (!hHandle || (!heightOnly && (!nmHandle || !albHandle || !feHandle))) {
      this.gpuInitialized = false;
      this.ensureGpuTexturesInitialized(renderer);
      return;
    }

    // Full-width / full-height toroidal spans start cleanly at 0 so row uploads stay zero-copy!
    const modX = cw === CLIPMAP_TEX_SIZE ? 0 : wrapTexel(tx0);
    const w1 = cw === CLIPMAP_TEX_SIZE ? CLIPMAP_TEX_SIZE : Math.min(cw, CLIPMAP_TEX_SIZE - modX);
    const w2 = cw - w1;
    const modZ = ch === CLIPMAP_TEX_SIZE ? 0 : wrapTexel(tz0);
    const h1 = ch === CLIPMAP_TEX_SIZE ? CLIPMAP_TEX_SIZE : Math.min(ch, CLIPMAP_TEX_SIZE - modZ);
    const h2 = ch - h1;

    const prevBinding = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY) as WebGLTexture | null;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);

    this.uploadFloatSubRects(gl, hHandle, this.heightData, layer, modX, w1, w2, modZ, h1, h2);
    if (!heightOnly) {
      this.uploadRgbaSubRects(gl, nmHandle!, this.normalMaskData, layer, modX, w1, w2, modZ, h1, h2);
      this.uploadRgbaSubRects(gl, albHandle!, this.albedoData, layer, modX, w1, w2, modZ, h1, h2);
      this.uploadRgbaSubRects(gl, feHandle!, this.flowElevData, layer, modX, w1, w2, modZ, h1, h2);
    }

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, prevBinding);
  }

  private uploadFloatSubRects(
    gl: WebGL2RenderingContext,
    handle: WebGLTexture,
    mirror: Float32Array,
    layer: number,
    modX: number,
    w1: number,
    w2: number,
    modZ: number,
    h1: number,
    h2: number,
  ): void {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, handle);
    const layerBase = layer * CLIPMAP_LAYER_TEXELS;

    for (let zi = 0; zi < 2; zi++) {
      const dstZ = zi === 0 ? modZ : 0;
      const subH = zi === 0 ? h1 : h2;
      if (subH <= 0) continue;

      for (let xi = 0; xi < 2; xi++) {
        const dstX = xi === 0 ? modX : 0;
        const subW = xi === 0 ? w1 : w2;
        if (subW <= 0) continue;

        if (subW === CLIPMAP_TEX_SIZE) {
          const srcStart = layerBase + dstZ * CLIPMAP_TEX_SIZE;
          const elemCount = CLIPMAP_TEX_SIZE * subH;
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            0,
            dstZ,
            layer,
            CLIPMAP_TEX_SIZE,
            subH,
            1,
            gl.RED,
            gl.FLOAT,
            mirror.subarray(srcStart, srcStart + elemCount),
            0,
          );
        } else {
          const scratch = this.scratchFloatUpload;
          for (let r = 0; r < subH; r++) {
            const srcOff = layerBase + (dstZ + r) * CLIPMAP_TEX_SIZE + dstX;
            const dstOff = r * subW;
            for (let c = 0; c < subW; c++) {
              scratch[dstOff + c] = mirror[srcOff + c]!;
            }
          }
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            dstX,
            dstZ,
            layer,
            subW,
            subH,
            1,
            gl.RED,
            gl.FLOAT,
            scratch.subarray(0, subW * subH),
            0,
          );
        }
        this._gpuUploadCount++;
      }
    }
  }

  private uploadRgbaSubRects(
    gl: WebGL2RenderingContext,
    handle: WebGLTexture,
    mirror: Uint8Array,
    layer: number,
    modX: number,
    w1: number,
    w2: number,
    modZ: number,
    h1: number,
    h2: number,
  ): void {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, handle);
    const layerBase4 = layer * CLIPMAP_LAYER_TEXELS * 4;

    for (let zi = 0; zi < 2; zi++) {
      const dstZ = zi === 0 ? modZ : 0;
      const subH = zi === 0 ? h1 : h2;
      if (subH <= 0) continue;

      for (let xi = 0; xi < 2; xi++) {
        const dstX = xi === 0 ? modX : 0;
        const subW = xi === 0 ? w1 : w2;
        if (subW <= 0) continue;

        if (subW === CLIPMAP_TEX_SIZE) {
          const srcStart = layerBase4 + dstZ * CLIPMAP_TEX_SIZE * 4;
          const byteCount = CLIPMAP_TEX_SIZE * subH * 4;
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            0,
            dstZ,
            layer,
            CLIPMAP_TEX_SIZE,
            subH,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            mirror.subarray(srcStart, srcStart + byteCount),
            0,
          );
        } else {
          const scratch = this.scratchRgbaUpload;
          const rowBytes = subW * 4;
          for (let r = 0; r < subH; r++) {
            const srcOff = layerBase4 + ((dstZ + r) * CLIPMAP_TEX_SIZE + dstX) * 4;
            const dstOff = r * rowBytes;
            for (let b = 0; b < rowBytes; b++) {
              scratch[dstOff + b] = mirror[srcOff + b]!;
            }
          }
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            dstX,
            dstZ,
            layer,
            subW,
            subH,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            scratch.subarray(0, subW * subH * 4),
            0,
          );
        }
        this._gpuUploadCount++;
      }
    }
  }

  private syncStageColorTable(stageIdTable: readonly string[]): void {
    if (this.stageTableRef === stageIdTable && this.stageTableLen === stageIdTable.length) {
      return;
    }
    this.stageTableRef = stageIdTable;
    this.stageTableLen = stageIdTable.length;
    this.stageColorTable.length = stageIdTable.length;

    for (let i = 0; i < stageIdTable.length; i++) {
      const id = stageIdTable[i]!;
      let cached = this.stageColorById.get(id);
      if (!cached) {
        const def = getStageDef(id);
        cached = def ? buildPaletteColors(def.palette) : this.defaultColors;
        this.stageColorById.set(id, cached);
      }
      this.stageColorTable[i] = cached;
    }
  }
}
