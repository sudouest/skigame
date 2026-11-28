import * as THREE from 'three';
import type { GraphicsUtils } from '../graphicsUtils';
import type { LandmarkModelDef } from '../landmarkRegistry';
import { createTexturedToonMaterial, type SharedToonMaterials } from '../toonMaterials';
import {
  type AtlasTileRect,
  buildMergedColoredGeometry,
  buildMergedTexturedGeometry,
  buildTaperedPostGeometry,
  type ColoredGeometryPart,
  createProceduralCanvasTexture,
  makeAtlasTile,
  type TexturedGeometryPart,
  type TileMappingSpec,
} from './proceduralModelUtils';

export type LanternPostVariant = 'single' | 'double';

export const LANTERN_POST_ATLAS_SIZE = 512;
export const LANTERN_POST_BASE_Y = -1.2;
export const LANTERN_POST_TOP_Y = 5.24;
export const LANTERN_ARM_Y = 4.72;
export const LANTERN_ARM_REACH_X = 2.16;
export const LANTERN_HANG_X = 1.88;
export const LANTERN_SCALE = 0.84;
export const LANTERN_BODY_CENTER_Y = 3.5544;

export interface LanternPostTuning {
  readonly postHeightM: number;
  readonly armLengthM: number;
  readonly lanternScale: number;
  readonly woodThicknessScale: number;
}

export const DEFAULT_LANTERN_POST_TUNING: LanternPostTuning = {
  postHeightM: LANTERN_POST_TOP_Y,
  armLengthM: LANTERN_ARM_REACH_X,
  lanternScale: LANTERN_SCALE,
  woodThicknessScale: 1.0,
};

function sanitizePositiveClamped(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Validates and clamps optional procedural lantern post tuning overrides while preserving
 * safe structural clearances.
 */
export function resolveLanternPostTuning(
  tuning?: Partial<LanternPostTuning>,
): LanternPostTuning {
  return {
    postHeightM: sanitizePositiveClamped(
      tuning?.postHeightM,
      DEFAULT_LANTERN_POST_TUNING.postHeightM,
      1.8,
      7.0,
    ),
    armLengthM: sanitizePositiveClamped(
      tuning?.armLengthM,
      DEFAULT_LANTERN_POST_TUNING.armLengthM,
      0.7,
      3.5,
    ),
    lanternScale: sanitizePositiveClamped(
      tuning?.lanternScale,
      DEFAULT_LANTERN_POST_TUNING.lanternScale,
      0.35,
      2.2,
    ),
    woodThicknessScale: sanitizePositiveClamped(
      tuning?.woodThicknessScale,
      DEFAULT_LANTERN_POST_TUNING.woodThicknessScale,
      0.35,
      2.2,
    ),
  };
}

export type LanternPostTileName =
  | 'woodVertical'
  | 'woodHorizontal'
  | 'woodEnd'
  | 'wroughtIron'
  | 'snowCap'
  | 'ironRoofPanel';

export type LanternPostAtlasTile = AtlasTileRect;

export const LANTERN_POST_ATLAS_TILES: Readonly<Record<LanternPostTileName, LanternPostAtlasTile>> = {
  // Top half (y: 0..256)
  woodVertical: makeAtlasTile(0, 0, 256, 256, LANTERN_POST_ATLAS_SIZE, 2),
  woodHorizontal: makeAtlasTile(256, 0, 256, 256, LANTERN_POST_ATLAS_SIZE, 2),
  // Row 2 (y: 256..384)
  woodEnd: makeAtlasTile(0, 256, 128, 128, LANTERN_POST_ATLAS_SIZE, 2),
  wroughtIron: makeAtlasTile(128, 256, 128, 128, LANTERN_POST_ATLAS_SIZE, 2),
  snowCap: makeAtlasTile(256, 256, 256, 128, LANTERN_POST_ATLAS_SIZE, 2),
  // Row 3 (y: 384..512)
  ironRoofPanel: makeAtlasTile(0, 384, 512, 128, LANTERN_POST_ATLAS_SIZE, 2),
};

/**
 * Paints the complete 512x512 hand-illustrated wooden lantern post & wrought-iron
 * lantern CanvasTexture atlas.
 */
export function drawLanternPostAtlas(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. woodVertical (0, 0, 256, 256) - warm golden honey-amber vertical post & brace grain
  {
    const t = LANTERN_POST_ATLAS_TILES.woodVertical;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px + t.pw, t.py);
    grad.addColorStop(0, '#945318');
    grad.addColorStop(0.24, '#d48e30');
    grad.addColorStop(0.56, '#e49f3c');
    grad.addColorStop(0.84, '#be7622');
    grad.addColorStop(1, '#7d4312');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#5c310e';
    ctx.lineWidth = 2.8;
    for (const [xOff, bow] of [
      [34, 6],
      [78, -5],
      [126, 7],
      [174, -6],
      [218, 5],
    ] as const) {
      const x = t.px + xOff;
      ctx.beginPath();
      ctx.moveTo(x, t.py);
      ctx.bezierCurveTo(x + bow, t.py + 88, x - bow, t.py + 168, x, t.py + t.ph);
      ctx.stroke();
    }

    // Check splits & twin oval grain knots matching illustrated timber look
    ctx.strokeStyle = '#472309';
    ctx.lineWidth = 2.6;
    for (const [kx, ky, rx, ry] of [
      [148, 86, 8, 17],
      [96, 186, 7, 14],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(t.px + kx, t.py + ky, rx, ry, 0.05, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = '#633410';
    ctx.lineWidth = 3.5;
    ctx.strokeRect(t.px + 2, t.py + 2, t.pw - 4, t.ph - 4);
  }

  // 2. woodHorizontal (256, 0, 256, 256) - matching golden honey-amber crossarm grain along U
  {
    const t = LANTERN_POST_ATLAS_TILES.woodHorizontal;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#985618');
    grad.addColorStop(0.24, '#d69032');
    grad.addColorStop(0.54, '#e6a23e');
    grad.addColorStop(0.84, '#bd7520');
    grad.addColorStop(1, '#7e4412');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#5e320e';
    ctx.lineWidth = 2.8;
    for (const [yOff, bow] of [
      [34, 6],
      [78, -5],
      [126, 7],
      [174, -6],
      [218, 5],
    ] as const) {
      const y = t.py + yOff;
      ctx.beginPath();
      ctx.moveTo(t.px, y);
      ctx.bezierCurveTo(t.px + 86, y + bow, t.px + 170, y - bow, t.px + t.pw, y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#482409';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(t.px + 132, t.py + 96, 17, 7, -0.06, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#633410';
    ctx.lineWidth = 3.5;
    ctx.strokeRect(t.px + 2, t.py + 2, t.pw - 4, t.ph - 4);
  }

  // 3. woodEnd (0, 256, 128, 128) - lighter honey-pine end-grain with growth rings & splits
  {
    const t = LANTERN_POST_ATLAS_TILES.woodEnd;
    ctx.fillStyle = '#e3be7c';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.5;

    ctx.strokeStyle = '#9e6428';
    ctx.lineWidth = 3.2;
    for (const r of [14, 28, 42, 54]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = '#593010';
    ctx.lineWidth = 2.8;
    for (const [ang, r0, r1] of [
      [-0.4, 8, 52],
      [1.85, 10, 48],
      [3.5, 14, 54],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }

    ctx.strokeStyle = '#6a3912';
    ctx.lineWidth = 6;
    ctx.strokeRect(t.px + 3, t.py + 3, t.pw - 6, t.ph - 6);
  }

  // 4. wroughtIron (128, 256, 128, 128) - forged charcoal-slate wrought iron
  {
    const t = LANTERN_POST_ATLAS_TILES.wroughtIron;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px + t.pw, t.py + t.ph);
    grad.addColorStop(0, '#444a57');
    grad.addColorStop(0.45, '#2f343e');
    grad.addColorStop(1, '#22252c');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#5a6272';
    ctx.lineWidth = 2.4;
    for (const [x0, y0, x1, y1] of [
      [18, 28, 66, 24],
      [44, 72, 106, 68],
      [22, 102, 74, 98],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(t.px + x0, t.py + y0);
      ctx.lineTo(t.px + x1, t.py + y1);
      ctx.stroke();
    }

    ctx.strokeStyle = '#181a20';
    ctx.lineWidth = 4;
    ctx.strokeRect(t.px + 2, t.py + 2, t.pw - 4, t.ph - 4);
  }

  // 5. snowCap (256, 256, 256, 128) - bright alpine snow mound fading to cool blue-grey lower rim
  {
    const t = LANTERN_POST_ATLAS_TILES.snowCap;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#f8fbff');
    grad.addColorStop(0.62, '#eef5fc');
    grad.addColorStop(1, '#c5d9e8');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#d3e4f2';
    ctx.lineWidth = 3.5;
    for (const [sx, sy, sw] of [
      [34, 42, 74],
      [138, 36, 82],
      [78, 86, 92],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(t.px + sx, t.py + sy);
      ctx.quadraticCurveTo(t.px + sx + sw * 0.5, t.py + sy - 8, t.px + sx + sw, t.py + sy + 2);
      ctx.stroke();
    }
  }

  // 6. ironRoofPanel (0, 384, 512, 128) - sloped dark slate-charcoal lantern hood plating
  {
    const t = LANTERN_POST_ATLAS_TILES.ironRoofPanel;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#4a505e');
    grad.addColorStop(0.55, '#353a44');
    grad.addColorStop(1, '#22252c');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#1b1d23';
    ctx.lineWidth = 4;
    for (let i = 1; i <= 3; i++) {
      const x = t.px + (i * t.pw) / 4;
      ctx.beginPath();
      ctx.moveTo(x, t.py);
      ctx.lineTo(x, t.py + t.ph);
      ctx.stroke();
    }

    ctx.strokeStyle = '#606878';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(t.px + 18, t.py + 22);
    ctx.lineTo(t.px + t.pw - 18, t.py + 22);
    ctx.stroke();
  }

  ctx.restore();
}

export interface LanternPostGeometries {
  readonly bodyGeo: THREE.BufferGeometry;
  readonly glowGeo: THREE.BufferGeometry;
  readonly glassGeo: THREE.BufferGeometry;
}

const POST_GROUP_TILES: Readonly<Record<number, LanternPostTileName | TileMappingSpec<LanternPostTileName>>> = {
  0: 'woodVertical',
  1: 'woodEnd',
};

const ARM_GROUP_TILES: Readonly<Record<number, LanternPostTileName | TileMappingSpec<LanternPostTileName>>> = {
  0: 'woodEnd',
  1: 'woodEnd',
  2: 'woodHorizontal',
  3: 'woodHorizontal',
  4: 'woodHorizontal',
  5: 'woodHorizontal',
};

const BRACE_GROUP_TILES: Readonly<Record<number, LanternPostTileName | TileMappingSpec<LanternPostTileName>>> = {
  0: 'woodVertical',
  1: 'woodVertical',
  2: 'woodEnd',
  3: 'woodEnd',
  4: 'woodVertical',
  5: 'woodVertical',
};

const ARM_POST_OVERLAP_M = 0.08;
const REF_ARM_REACH_X = 1.64;
const REF_BOLT_Y = 3.36;
const REF_LANTERN_BODY_CENTER_Y = 2.02;

function appendVerticalPostParts(
  parts: TexturedGeometryPart<LanternPostTileName>[],
  tuning: LanternPostTuning,
): void {
  const w = tuning.woodThicknessScale;
  const postTopY = tuning.postHeightM;

  // Grounded tapered square timber post (dips to y = -1.2m so steep 33 deg slopes never gap)
  parts.push({
    geometry: buildTaperedPostGeometry(
      0.43 * w,
      0.43 * w,
      0.37 * w,
      0.37 * w,
      LANTERN_POST_BASE_Y,
      postTopY,
    ),
    tile: 'woodVertical',
    groupTiles: POST_GROUP_TILES,
  });

  // Sculpted snow pillow crowning the vertical post top
  parts.push(
    {
      geometry: new THREE.SphereGeometry(0.2 * w, 10, 7),
      tile: 'snowCap',
      tx: 0,
      ty: postTopY + 0.075 * w,
      tz: 0,
      sx: 1.2,
      sy: 0.68,
      sz: 1.15,
    },
    {
      geometry: new THREE.SphereGeometry(0.145 * w, 8, 6),
      tile: 'snowCap',
      tx: -0.11 * w,
      ty: postTopY + 0.038 * w,
      tz: 0.065 * w,
      sx: 1.05,
      sy: 0.58,
      sz: 0.96,
    },
    {
      geometry: new THREE.SphereGeometry(0.13 * w, 8, 6),
      tile: 'snowCap',
      tx: 0.12 * w,
      ty: postTopY + 0.03 * w,
      tz: -0.05 * w,
      sx: 1.04,
      sy: 0.54,
      sz: 0.98,
    },
  );
}

function appendArmAndLanternParts(
  armSign: -1 | 1,
  includeSecondarySnowDab: boolean,
  tuning: LanternPostTuning,
  bodyParts: TexturedGeometryPart<LanternPostTileName>[],
  glowParts: ColoredGeometryPart[],
  glassParts: ColoredGeometryPart[],
): void {
  const w = tuning.woodThicknessScale;
  const s = tuning.lanternScale;
  const armThickness = 0.27 * w;
  const armY = tuning.postHeightM - (0.385 + armThickness * 0.5);
  const armTopY = armY + armThickness * 0.5;
  const armReachX = tuning.armLengthM;
  const armPostOverlap = ARM_POST_OVERLAP_M * w;
  const armTotalWidth = armReachX + armPostOverlap;
  const armCenterX = armReachX - armTotalWidth * 0.5;
  const tipInset = Math.min(LANTERN_ARM_REACH_X - LANTERN_HANG_X, armReachX * 0.22);
  const hangX = armReachX - tipInset;
  const lx = armSign * hangX;

  const boltY = armY - 0.04 * w;
  const boltLen = armThickness + 0.06;
  const boltRadius = 0.048 * Math.max(0.75, Math.min(1.25, (s + w) * 0.5));
  const ly = (baseY: number): number => boltY + (baseY - REF_BOLT_Y) * s;

  // 1. Horizontal timber crossarm extending from post core out to armReachX
  bodyParts.push({
    geometry: new THREE.BoxGeometry(armTotalWidth, armThickness, armThickness),
    tile: 'woodHorizontal',
    groupTiles: ARM_GROUP_TILES,
    tx: armSign * armCenterX,
    ty: armY,
    tz: 0,
  });

  // 2. Diagonal timber knee-brace tucked cleanly between post and crossarm
  const braceThick = 0.19 * w;
  const braceX0 = 0.105 * w;
  const maxBraceDrop = Math.max(0.35, armY - 0.55);
  const targetBraceX1 = Math.min(armReachX * (1.095 / REF_ARM_REACH_X), hangX - 0.265);
  const braceX1 = Math.max(braceX0 + 0.2, Math.min(targetBraceX1, braceX0 + maxBraceDrop));
  const braceDx = braceX1 - braceX0;
  const braceY1 = armY - 0.025;
  const braceY0 = braceY1 - braceDx;
  const braceLen = braceDx * Math.SQRT2;
  bodyParts.push({
    geometry: new THREE.BoxGeometry(braceThick, braceLen, braceThick),
    tile: 'woodVertical',
    groupTiles: BRACE_GROUP_TILES,
    tx: armSign * (braceX0 + braceX1) * 0.5,
    ty: (braceY0 + braceY1) * 0.5,
    tz: 0,
    rz: -armSign * Math.PI * 0.25,
  });

  // 3. Organic snow cushions resting along the top face of the crossarm
  const armRatio = armReachX / REF_ARM_REACH_X;
  const snowLenScale = Math.max(0.55, Math.min(1.5, armRatio));
  bodyParts.push(
    {
      geometry: new THREE.SphereGeometry(0.21, 10, 7),
      tile: 'snowCap',
      tx: armSign * 1.16 * armRatio,
      ty: armTopY + 0.05,
      tz: 0,
      sx: 1.56 * snowLenScale,
      sy: 0.48,
      sz: 0.8 * w,
    },
    {
      geometry: new THREE.SphereGeometry(0.155, 8, 6),
      tile: 'snowCap',
      tx: armSign * 0.92 * armRatio,
      ty: armTopY + 0.025,
      tz: 0.03 * w,
      sx: 1.28 * snowLenScale,
      sy: 0.42,
      sz: 0.74 * w,
    },
    {
      geometry: new THREE.SphereGeometry(0.145, 8, 6),
      tile: 'snowCap',
      tx: armSign * 1.38 * armRatio,
      ty: armTopY + 0.015,
      tz: -0.02 * w,
      sx: 1.15 * snowLenScale,
      sy: 0.4,
      sz: 0.72 * w,
    },
  );
  if (includeSecondarySnowDab) {
    bodyParts.push({
      geometry: new THREE.SphereGeometry(0.125, 8, 6),
      tile: 'snowCap',
      tx: armSign * 0.56 * armRatio,
      ty: armTopY + 0.015,
      tz: 0.015 * w,
      sx: 1.26 * snowLenScale,
      sy: 0.36,
      sz: 0.7 * w,
    });
  }

  // 4. Wrought-iron through-bolt & non-overlapping interlocking hanging chain rings
  bodyParts.push(
    {
      geometry: new THREE.CylinderGeometry(boltRadius, boltRadius, boltLen, 10),
      tile: 'wroughtIron',
      tx: lx,
      ty: boltY,
      tz: 0,
      rx: Math.PI * 0.5,
    },
    {
      geometry: new THREE.TorusGeometry(0.165 * s, 0.03 * s, 8, 16),
      tile: 'wroughtIron',
      tx: lx,
      ty: ly(3.2),
      tz: 0,
    },
    {
      geometry: new THREE.TorusGeometry(0.125 * s, 0.028 * s, 8, 14),
      tile: 'wroughtIron',
      tx: lx,
      ty: ly(2.98),
      tz: 0,
      ry: Math.PI * 0.5,
    },
    {
      geometry: new THREE.TorusGeometry(0.074 * s, 0.022 * s, 6, 12),
      tile: 'wroughtIron',
      tx: lx,
      ty: ly(2.838),
      tz: 0,
    },
  );

  // 5. Hanging square wrought-iron lantern hood (open-ended so eave box encloses base cleanly), snow crest, frame & base
  bodyParts.push(
    {
      geometry: new THREE.ConeGeometry(0.64 * s, 0.38 * s, 4, 1, true),
      tile: 'ironRoofPanel',
      tx: lx,
      ty: ly(2.63),
      tz: 0,
      ry: Math.PI * 0.25,
    },
    {
      geometry: new THREE.BoxGeometry(0.92 * s, 0.06 * s, 0.92 * s),
      tile: 'wroughtIron',
      tx: lx,
      ty: ly(2.43),
      tz: 0,
    },
    // Sculpted snow cap draped over the upper pyramidal hood while keeping top rings visible
    {
      geometry: new THREE.SphereGeometry(0.18 * s, 8, 6),
      tile: 'snowCap',
      tx: lx - 0.11 * s,
      ty: ly(2.74),
      tz: 0.09 * s,
      sx: 1.05,
      sy: 0.48,
      sz: 0.95,
    },
    {
      geometry: new THREE.SphereGeometry(0.18 * s, 8, 6),
      tile: 'snowCap',
      tx: lx + 0.11 * s,
      ty: ly(2.74),
      tz: -0.09 * s,
      sx: 1.05,
      sy: 0.48,
      sz: 0.95,
    },
    {
      geometry: new THREE.SphereGeometry(0.16 * s, 8, 6),
      tile: 'snowCap',
      tx: lx + 0.09 * s,
      ty: ly(2.72),
      tz: 0.11 * s,
      sx: 0.96,
      sy: 0.44,
      sz: 0.92,
    },
    {
      geometry: new THREE.SphereGeometry(0.16 * s, 8, 6),
      tile: 'snowCap',
      tx: lx - 0.09 * s,
      ty: ly(2.72),
      tz: -0.11 * s,
      sx: 0.96,
      sy: 0.44,
      sz: 0.92,
    },
    // Upper frame collar & lower base plate + step bevel
    {
      geometry: new THREE.BoxGeometry(0.78 * s, 0.065 * s, 0.78 * s),
      tile: 'wroughtIron',
      tx: lx,
      ty: ly(2.38),
      tz: 0,
    },
    {
      geometry: new THREE.BoxGeometry(0.78 * s, 0.08 * s, 0.78 * s),
      tile: 'wroughtIron',
      tx: lx,
      ty: ly(1.66),
      tz: 0,
    },
    {
      geometry: new THREE.BoxGeometry(0.64 * s, 0.05 * s, 0.64 * s),
      tile: 'wroughtIron',
      tx: lx,
      ty: ly(1.6),
      tz: 0,
    },
  );

  // 4 vertical corner wrought-iron posts
  for (const cx of [-0.34, 0.34] as const) {
    for (const cz of [-0.34, 0.34] as const) {
      bodyParts.push({
        geometry: new THREE.BoxGeometry(0.075 * s, 0.74 * s, 0.075 * s),
        tile: 'wroughtIron',
        tx: lx + cx * s,
        ty: ly(REF_LANTERN_BODY_CENTER_Y),
        tz: cz * s,
      });
    }
  }

  // 6. Crisp 2x2 dark iron mullions + interior ivory wax candle & glowing flame (unlit glowGeo)
  // Staggered bar thickness (0.044 vs 0.040) prevents coplanar quad overlap at cross-intersections.
  const mullionColor = '#252830';
  for (const side of [-1, 1] as const) {
    glowParts.push(
      // Front/back vertical & horizontal center bars
      {
        geometry: new THREE.BoxGeometry(0.052 * s, 0.68 * s, 0.044 * s),
        color: mullionColor,
        tx: lx,
        ty: ly(REF_LANTERN_BODY_CENTER_Y),
        tz: side * 0.352 * s,
      },
      {
        geometry: new THREE.BoxGeometry(0.68 * s, 0.052 * s, 0.04 * s),
        color: mullionColor,
        tx: lx,
        ty: ly(REF_LANTERN_BODY_CENTER_Y),
        tz: side * 0.352 * s,
      },
      // Left/right vertical & horizontal center bars
      {
        geometry: new THREE.BoxGeometry(0.044 * s, 0.68 * s, 0.052 * s),
        color: mullionColor,
        tx: lx + side * 0.352 * s,
        ty: ly(REF_LANTERN_BODY_CENTER_Y),
        tz: 0,
      },
      {
        geometry: new THREE.BoxGeometry(0.04 * s, 0.052 * s, 0.68 * s),
        color: mullionColor,
        tx: lx + side * 0.352 * s,
        ty: ly(REF_LANTERN_BODY_CENTER_Y),
        tz: 0,
      },
    );
  }

  // Wax candle saucer, body, melted wax drips, dark wick & teardrop flame
  glowParts.push(
    {
      geometry: new THREE.CylinderGeometry(0.165 * s, 0.14 * s, 0.04 * s, 10),
      color: '#2c3038',
      tx: lx,
      ty: ly(1.72),
      tz: 0,
    },
    {
      geometry: new THREE.CylinderGeometry(0.11 * s, 0.125 * s, 0.34 * s, 10),
      color: '#e8c682',
      tx: lx,
      ty: ly(1.9),
      tz: 0,
    },
    {
      geometry: new THREE.SphereGeometry(0.036 * s, 7, 5),
      color: '#f4dca2',
      tx: lx + 0.095 * s,
      ty: ly(2.02),
      tz: 0.045 * s,
      sx: 0.8,
      sy: 1.5,
      sz: 0.8,
    },
    {
      geometry: new THREE.SphereGeometry(0.032 * s, 7, 5),
      color: '#f4dca2',
      tx: lx - 0.085 * s,
      ty: ly(2.0),
      tz: 0.06 * s,
      sx: 0.78,
      sy: 1.35,
      sz: 0.78,
    },
    {
      geometry: new THREE.SphereGeometry(0.034 * s, 7, 5),
      color: '#f4dca2',
      tx: lx + 0.02 * s,
      ty: ly(2.03),
      tz: -0.1 * s,
      sx: 0.8,
      sy: 1.4,
      sz: 0.8,
    },
    {
      geometry: new THREE.CylinderGeometry(0.014 * s, 0.014 * s, 0.055 * s, 6),
      color: '#261b12',
      tx: lx,
      ty: ly(2.09),
      tz: 0,
    },
    {
      geometry: new THREE.SphereGeometry(0.068 * s, 8, 6),
      color: '#fef08a',
      tx: lx,
      ty: ly(2.155),
      tz: 0,
      sx: 0.85,
      sy: 1.05,
      sz: 0.85,
    },
    {
      geometry: new THREE.ConeGeometry(0.058 * s, 0.16 * s, 8),
      color: '#f59e0b',
      tx: lx,
      ty: ly(2.24),
      tz: 0,
    },
  );

  // 7. Open-ended 4-sided translucent warm glass panes inset strictly inside the iron cage
  glassParts.push({
    geometry: new THREE.CylinderGeometry(0.4596 * s, 0.4596 * s, 0.68 * s, 4, 1, true),
    color: '#fff4be',
    tx: lx,
    ty: ly(REF_LANTERN_BODY_CENTER_Y),
    tz: 0,
    ry: Math.PI * 0.25,
  });
}

/**
 * Builds the modular 3D single or double hanging wooden lantern post geometries:
 * textured wood/iron/snow (`bodyGeo`), unlit mullions & candle/flame (`glowGeo`),
 * and translucent glowing glass shell (`glassGeo`).
 */
export function buildLanternPostGeometries(
  variant: LanternPostVariant,
  tuning?: Partial<LanternPostTuning>,
): LanternPostGeometries {
  const resolved = resolveLanternPostTuning(tuning);
  const bodyParts: TexturedGeometryPart<LanternPostTileName>[] = [];
  const glowParts: ColoredGeometryPart[] = [];
  const glassParts: ColoredGeometryPart[] = [];

  appendVerticalPostParts(bodyParts, resolved);

  if (variant === 'double') {
    appendArmAndLanternParts(-1, false, resolved, bodyParts, glowParts, glassParts);
    appendArmAndLanternParts(1, false, resolved, bodyParts, glowParts, glassParts);
  } else {
    appendArmAndLanternParts(1, true, resolved, bodyParts, glowParts, glassParts);
  }

  const suffix = variant === 'double' ? 'Double' : 'Single';
  const bodyGeo = buildMergedTexturedGeometry(
    bodyParts,
    LANTERN_POST_ATLAS_TILES,
    `LanternPost${suffix}BodyGeo`,
    true,
  );
  const glowGeo = buildMergedColoredGeometry(
    glowParts,
    `LanternPost${suffix}GlowGeo`,
    false,
  );
  const glassGeo = buildMergedColoredGeometry(
    glassParts,
    `LanternPost${suffix}GlassGeo`,
    false,
  );

  return {
    bodyGeo,
    glowGeo,
    glassGeo,
  };
}

export interface LanternPostAssets {
  readonly atlasTexture: THREE.Texture;
  readonly toonMaterial: THREE.MeshToonMaterial;
  readonly glassMaterial: THREE.MeshBasicMaterial;
  readonly beaconGlowMaterial: THREE.MeshBasicMaterial;
  readonly outlineMaterial: THREE.Material | undefined;
  readonly single: LanternPostGeometries;
  readonly double: LanternPostGeometries;
}

/**
 * Builds, paints, and caches all shared GPU textures, materials, and geometries for both
 * single and double hanging lantern posts under `GraphicsUtils`.
 */
export function createLanternPostAssets(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  outlineMaterial?: THREE.Material,
): LanternPostAssets {
  const single = buildLanternPostGeometries('single');
  const double = buildLanternPostGeometries('double');
  for (const geo of [
    single.bodyGeo,
    single.glowGeo,
    single.glassGeo,
    double.bodyGeo,
    double.glowGeo,
    double.glassGeo,
  ]) {
    gfx.markAsCache(geo, geo.name);
  }

  const atlasTexture = createProceduralCanvasTexture(
    gfx,
    LANTERN_POST_ATLAS_SIZE,
    LANTERN_POST_ATLAS_SIZE,
    drawLanternPostAtlas,
    'LanternPostAtlasTex',
    [214, 146, 52, 255],
  );
  const toonMaterial = createTexturedToonMaterial(
    gfx,
    atlasTexture,
    materials.gradientMap,
    materials.sharedUniforms,
    'LanternPostToonMaterial',
  );
  const glassMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  glassMaterial.name = 'LanternPostGlassMaterial';
  gfx.markAsCache(glassMaterial, 'LanternPostGlassMaterial');

  return {
    atlasTexture,
    toonMaterial,
    glassMaterial,
    beaconGlowMaterial: materials.beaconGlowMaterial,
    outlineMaterial,
    single,
    double,
  };
}

/**
 * Instantiates a pooled single or double hanging lantern post with toon shading,
 * optional inverted-hull outlines, unlit wax candle/mullions, and translucent glass panes.
 */
export function createLanternPostObject(
  gfx: GraphicsUtils,
  assets: LanternPostAssets,
  variant: LanternPostVariant,
  index = 0,
): {
  readonly group: THREE.Group;
  readonly pivot: THREE.Group;
  readonly setSideFacing: (lateralX: number) => void;
} {
  const tag = variant === 'double' ? 'Double' : 'Single';
  const geos = variant === 'double' ? assets.double : assets.single;

  const group = new THREE.Group();
  group.name = `PooledDeliveryLantern${tag}_${index}`;

  const pivot = new THREE.Group();
  pivot.name = `LanternPost${tag}Pivot_${index}`;
  group.add(pivot);

  const bodyMesh = gfx.createMesh(
    geos.bodyGeo,
    assets.toonMaterial,
    `LanternPost${tag}Body_${index}`,
  );
  bodyMesh.castShadow = true;
  pivot.add(bodyMesh);

  if (assets.outlineMaterial) {
    const outlineMesh = gfx.createMesh(
      geos.bodyGeo,
      assets.outlineMaterial,
      `LanternPost${tag}Outline_${index}`,
    );
    outlineMesh.castShadow = false;
    pivot.add(outlineMesh);
  }

  const glowMesh = gfx.createMesh(
    geos.glowGeo,
    assets.beaconGlowMaterial,
    `LanternPost${tag}Glow_${index}`,
  );
  glowMesh.castShadow = false;
  pivot.add(glowMesh);

  const glassMesh = gfx.createMesh(
    geos.glassGeo,
    assets.glassMaterial,
    `LanternPost${tag}Glass_${index}`,
  );
  glassMesh.castShadow = false;
  glassMesh.receiveShadow = false;
  glassMesh.renderOrder = 1;
  pivot.add(glassMesh);

  const setSideFacing = (lateralX: number): void => {
    if (variant === 'single') {
      pivot.rotation.y = Number.isFinite(lateralX) && lateralX >= 0 ? Math.PI : 0;
    } else {
      pivot.rotation.y = 0;
    }
  };

  return { group, pivot, setSideFacing };
}

/**
 * Creates and registers pooled `LandmarkModelDef` descriptors for both the single-arm
 * (`proc:lantern:single`) and double-arm (`proc:lantern:double`) hanging lantern posts,
 * sharing one atlas texture and shared toon/glass materials across both variants.
 */
export function createLanternPostLandmarkDefs(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  outlineMaterial?: THREE.Material,
): { readonly single: LandmarkModelDef; readonly double: LandmarkModelDef } {
  const assets = createLanternPostAssets(gfx, materials, outlineMaterial);

  const single: LandmarkModelDef = {
    id: 'proc:lantern:single',
    poolCapacity: 12,
    yawPolicy: 'none',
    createInstance: (index) => {
      const obj = createLanternPostObject(gfx, assets, 'single', index);
      gfx.markAsCache(obj.group, obj.group.name);
      return {
        group: obj.group,
        configure: (lm) => obj.setSideFacing(lm.x),
      };
    },
  };

  const double: LandmarkModelDef = {
    id: 'proc:lantern:double',
    poolCapacity: 12,
    yawPolicy: 'none',
    createInstance: (index) => {
      const obj = createLanternPostObject(gfx, assets, 'double', index);
      gfx.markAsCache(obj.group, obj.group.name);
      return {
        group: obj.group,
      };
    },
  };

  return { single, double };
}
