/// <reference types="vite/client" />
import * as THREE from 'three';
import treeSpritesUrl from './assets/treeSprites.png';
import type { GraphicsUtils } from './graphicsUtils';

export const ATLAS_WIDTH = 2048;
export const ATLAS_HEIGHT = 1024;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;
const CELL_SIZE = 256;
const CELL_PAD_PX = 8;

export type BillboardFrameName =
  | 'pine_green'
  | 'pine_frosted'
  | 'child_idle'
  | 'child_cheer'
  | 'bear_walk'
  | 'bear_telegraph'
  | 'child_blue'
  | 'snow_shrub'
  | 'alpine_rock'
  | 'rock_crag'
  | 'tree_swirling_evergreen'
  | 'tree_scalloped_pine'
  | 'tree_nordic_cone'
  | 'tree_zigzag_folly'
  | 'tree_tall_forest_pine'
  | 'tree_wide_snow_pine'
  | 'tree_layered_spruce'
  | 'tree_slender_fir';

export interface AtlasFrameRect {
  readonly col: number;
  readonly row: number;
  readonly uOffset: number;
  readonly vOffset: number;
  readonly uScale: number;
  readonly vScale: number;
}

export interface TreeFrameProportion {
  readonly aspect: number;
  readonly heightScale: number;
}

function makeFrameRect(col: number, row: number): AtlasFrameRect {
  const padU = CELL_PAD_PX / ATLAS_WIDTH;
  const padV = CELL_PAD_PX / ATLAS_HEIGHT;
  const cellW = 1 / ATLAS_COLS;
  const cellH = 1 / ATLAS_ROWS;
  const uOffset = col * cellW + padU;
  const uScale = cellW - padU * 2;
  // CanvasTexture uses flipY = true: row 0 sits at the top (v near 1).
  const vOffset = 1 - (row + 1) * cellH + padV;
  const vScale = cellH - padV * 2;
  return { col, row, uOffset, vOffset, uScale, vScale };
}

function makePixelFrameRect(
  col: number,
  row: number,
  pxX: number,
  pxY: number,
  pxW: number,
  pxH: number,
): AtlasFrameRect {
  return {
    col,
    row,
    uOffset: pxX / ATLAS_WIDTH,
    // CanvasTexture uses flipY = true: canvas y increases downward while UV v increases upward.
    vOffset: 1 - (pxY + pxH) / ATLAS_HEIGHT,
    uScale: pxW / ATLAS_WIDTH,
    vScale: pxH / ATLAS_HEIGHT,
  };
}

export const ATLAS_FRAMES: Readonly<Record<BillboardFrameName, AtlasFrameRect>> = {
  pine_green: makeFrameRect(0, 0),
  pine_frosted: makeFrameRect(1, 0),
  child_idle: makeFrameRect(2, 0),
  child_cheer: makeFrameRect(3, 0),
  bear_walk: makeFrameRect(0, 1),
  bear_telegraph: makeFrameRect(1, 1),
  child_blue: makeFrameRect(2, 1),
  snow_shrub: makeFrameRect(3, 1),
  alpine_rock: makeFrameRect(4, 0),
  rock_crag: makeFrameRect(5, 0),
  tree_swirling_evergreen: makePixelFrameRect(0, 2, 28, 520, 200, 496),
  tree_scalloped_pine: makePixelFrameRect(1, 2, 264, 657, 240, 359),
  tree_nordic_cone: makePixelFrameRect(2, 2, 520, 634, 240, 382),
  tree_zigzag_folly: makePixelFrameRect(3, 2, 800, 520, 192, 496),
  tree_tall_forest_pine: makePixelFrameRect(4, 2, 1047, 520, 210, 496),
  tree_wide_snow_pine: makePixelFrameRect(5, 2, 1288, 657, 240, 359),
  tree_layered_spruce: makePixelFrameRect(6, 2, 1544, 661, 240, 355),
  tree_slender_fir: makePixelFrameRect(7, 2, 1816, 520, 207, 496),
};

export const GREEN_TREE_FRAMES: readonly BillboardFrameName[] = [
  'pine_green',
  'tree_swirling_evergreen',
  'tree_nordic_cone',
  'tree_tall_forest_pine',
  'tree_layered_spruce',
];

export const FROSTED_TREE_FRAMES: readonly BillboardFrameName[] = [
  'pine_frosted',
  'tree_scalloped_pine',
  'tree_zigzag_folly',
  'tree_wide_snow_pine',
  'tree_slender_fir',
];

export const ALL_TREE_FRAMES: readonly BillboardFrameName[] = [
  ...GREEN_TREE_FRAMES,
  ...FROSTED_TREE_FRAMES,
];

export const TREE_FRAME_PROPORTIONS: Readonly<Partial<Record<BillboardFrameName, TreeFrameProportion>>> = {
  tree_swirling_evergreen: { aspect: 200 / 496, heightScale: 1.08 },
  tree_scalloped_pine: { aspect: 240 / 359, heightScale: 0.93 },
  tree_nordic_cone: { aspect: 240 / 382, heightScale: 0.9 },
  tree_zigzag_folly: { aspect: 192 / 496, heightScale: 1.05 },
  tree_tall_forest_pine: { aspect: 210 / 496, heightScale: 1.08 },
  tree_wide_snow_pine: { aspect: 240 / 359, heightScale: 0.93 },
  tree_layered_spruce: { aspect: 240 / 355, heightScale: 0.9 },
  tree_slender_fir: { aspect: 207 / 496, heightScale: 1.03 },
};

const GREEN_TREE_SET = new Set<string>(GREEN_TREE_FRAMES);
const FROSTED_TREE_SET = new Set<string>(FROSTED_TREE_FRAMES);
const ALL_TREE_SET = new Set<string>(ALL_TREE_FRAMES);

export function isGreenTreeFrame(frame: string): boolean {
  return GREEN_TREE_SET.has(frame);
}

export function isFrostedTreeFrame(frame: string): boolean {
  return FROSTED_TREE_SET.has(frame);
}

export function isTreeBillboardFrame(frame: string): boolean {
  return ALL_TREE_SET.has(frame);
}

/**
 * Propagates neighbor RGB values outward into transparent texels (`alpha === 0`)
 * while leaving alpha untouched (`0`) so bilinear mipmaps never bleed black fringes
 * along `alphaTest: 0.5` cutout sprite borders.
 */
export function dilateAtlasEdges(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  passes = 5,
): Uint8ClampedArray {
  const pixelCount = width * height;
  if (rgba.length < pixelCount * 4) {
    throw new Error('RGBA buffer too small for specified width and height');
  }

  let hasColor = new Uint8Array(pixelCount);
  let nextHasColor = new Uint8Array(pixelCount);
  let work = new Uint8ClampedArray(rgba);

  for (let i = 0; i < pixelCount; i++) {
    if ((rgba[i * 4 + 3] ?? 0) > 0) {
      hasColor[i] = 1;
    }
  }
  nextHasColor.set(hasColor);

  for (let pass = 0; pass < passes; pass++) {
    let anyChanged = false;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (hasColor[idx] === 1) continue;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const nIdx = ny * width + nx;
            if (hasColor[nIdx] === 1) {
              const base = nIdx * 4;
              rSum += rgba[base] ?? 0;
              gSum += rgba[base + 1] ?? 0;
              bSum += rgba[base + 2] ?? 0;
              count++;
            }
          }
        }

        if (count > 0) {
          const outBase = idx * 4;
          work[outBase] = Math.round(rSum / count);
          work[outBase + 1] = Math.round(gSum / count);
          work[outBase + 2] = Math.round(bSum / count);
          // Preserve transparent alpha = 0 so silhouette shape stays exact.
          work[outBase + 3] = 0;
          nextHasColor[idx] = 1;
          anyChanged = true;
        }
      }
    }

    rgba.set(work);
    const tmpFlags = hasColor;
    hasColor = nextHasColor;
    nextHasColor = tmpFlags;
    nextHasColor.set(hasColor);

    if (!anyChanged) break;
  }

  return rgba;
}

function drawPineSprite(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  frosted: boolean,
): void {
  const cx = ox + CELL_SIZE * 0.5;
  const bottom = oy + CELL_SIZE - 12;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Trunk
  ctx.fillStyle = '#6b4226';
  ctx.strokeStyle = '#1f1612';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.rect(cx - 14, bottom - 46, 28, 44);
  ctx.fill();
  ctx.stroke();

  const bodyDark = frosted ? '#1d4d4f' : '#164a37';
  const bodyLight = frosted ? '#2d7d7a' : '#257a55';
  const snowTint = frosted ? '#e0f7ff' : '#f4faff';

  const tiers = [
    { topY: oy + 128, botY: bottom - 34, halfW: 90 },
    { topY: oy + 76, botY: oy + 162, halfW: 72 },
    { topY: oy + 22, botY: oy + 112, halfW: 50 },
  ];

  for (const tier of tiers) {
    ctx.fillStyle = bodyDark;
    ctx.beginPath();
    ctx.moveTo(cx, tier.topY);
    ctx.lineTo(cx + tier.halfW, tier.botY);
    ctx.quadraticCurveTo(cx, tier.botY + 12, cx - tier.halfW, tier.botY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Sunlit left bough half
    ctx.fillStyle = bodyLight;
    ctx.beginPath();
    ctx.moveTo(cx, tier.topY + 4);
    ctx.lineTo(cx + 8, tier.botY);
    ctx.lineTo(cx - tier.halfW + 6, tier.botY - 4);
    ctx.closePath();
    ctx.fill();

    // Snow cap across top of bough
    ctx.fillStyle = snowTint;
    ctx.beginPath();
    ctx.moveTo(cx, tier.topY + 3);
    ctx.lineTo(cx + tier.halfW * 0.44, tier.topY + (tier.botY - tier.topY) * 0.42);
    ctx.quadraticCurveTo(
      cx,
      tier.topY + (tier.botY - tier.topY) * 0.34,
      cx - tier.halfW * 0.44,
      tier.topY + (tier.botY - tier.topY) * 0.42,
    );
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

function drawChildSprite(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  coatColor: string,
  scarfColor: string,
  cheering: boolean,
): void {
  const cx = ox + CELL_SIZE * 0.5;
  const bottom = oy + CELL_SIZE - 14;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#181825';
  ctx.lineWidth = 6;

  // Boots
  ctx.fillStyle = '#2b2d42';
  ctx.beginPath();
  ctx.roundRect(cx - 28, bottom - 26, 20, 24, 6);
  ctx.roundRect(cx + 8, bottom - 26, 20, 24, 6);
  ctx.fill();
  ctx.stroke();

  // Legs
  ctx.fillStyle = '#1d3557';
  ctx.beginPath();
  ctx.roundRect(cx - 26, bottom - 68, 18, 46, 6);
  ctx.roundRect(cx + 8, bottom - 68, 18, 46, 6);
  ctx.fill();
  ctx.stroke();

  // Arms (raised when cheering!)
  ctx.fillStyle = coatColor;
  if (cheering) {
    ctx.beginPath();
    ctx.moveTo(cx - 30, bottom - 116);
    ctx.lineTo(cx - 72, bottom - 178);
    ctx.lineTo(cx - 56, bottom - 188);
    ctx.lineTo(cx - 18, bottom - 128);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + 30, bottom - 116);
    ctx.lineTo(cx + 72, bottom - 178);
    ctx.lineTo(cx + 56, bottom - 188);
    ctx.lineTo(cx + 18, bottom - 128);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Mittens
    ctx.fillStyle = scarfColor;
    ctx.beginPath();
    ctx.arc(cx - 66, bottom - 184, 11, 0, Math.PI * 2);
    ctx.arc(cx + 66, bottom - 184, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.roundRect(cx - 52, bottom - 126, 20, 52, 8);
    ctx.roundRect(cx + 32, bottom - 126, 20, 52, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = scarfColor;
    ctx.beginPath();
    ctx.arc(cx - 42, bottom - 72, 10, 0, Math.PI * 2);
    ctx.arc(cx + 42, bottom - 72, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Parka torso
  ctx.fillStyle = coatColor;
  ctx.beginPath();
  ctx.roundRect(cx - 34, bottom - 134, 68, 72, 18);
  ctx.fill();
  ctx.stroke();

  // Scarf
  ctx.fillStyle = scarfColor;
  ctx.beginPath();
  ctx.roundRect(cx - 28, bottom - 142, 56, 18, 8);
  ctx.fill();
  ctx.stroke();

  // Head
  ctx.fillStyle = '#ffd7ba';
  ctx.beginPath();
  ctx.arc(cx, bottom - 166, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Eyes & smile
  ctx.fillStyle = '#181825';
  ctx.beginPath();
  ctx.arc(cx - 9, bottom - 168, 3.5, 0, Math.PI * 2);
  ctx.arc(cx + 9, bottom - 168, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, bottom - 160, 8, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  // Beanie + Pom-pom
  ctx.lineWidth = 6;
  ctx.fillStyle = scarfColor;
  ctx.beginPath();
  ctx.arc(cx, bottom - 178, 29, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, bottom - 210, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawBearSprite(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  telegraph: boolean,
): void {
  const cx = ox + CELL_SIZE * 0.5;
  const bottom = oy + CELL_SIZE - 14;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1b130e';
  ctx.lineWidth = 6;

  // Ears
  ctx.fillStyle = '#6f4528';
  ctx.beginPath();
  ctx.arc(cx - 38, bottom - 182, 16, 0, Math.PI * 2);
  ctx.arc(cx + 38, bottom - 182, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Legs
  ctx.fillStyle = '#5c3a21';
  ctx.beginPath();
  ctx.roundRect(cx - 46, bottom - 56, 30, 52, 10);
  ctx.roundRect(cx + 16, bottom - 56, 30, 52, 10);
  ctx.fill();
  ctx.stroke();

  // Chunky torso
  ctx.fillStyle = '#754829';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 100, 62, 68, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Belly patch
  ctx.fillStyle = '#c89f78';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 96, 36, 44, 0, 0, Math.PI * 2);
  ctx.fill();

  // Paws (raised in telegraph!)
  ctx.fillStyle = '#5c3a21';
  if (telegraph) {
    ctx.beginPath();
    ctx.ellipse(cx - 68, bottom - 142, 22, 18, -0.5, 0, Math.PI * 2);
    ctx.ellipse(cx + 68, bottom - 142, 22, 18, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.ellipse(cx - 58, bottom - 92, 18, 22, 0.2, 0, Math.PI * 2);
    ctx.ellipse(cx + 58, bottom - 92, 18, 22, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Head
  ctx.fillStyle = '#7c4d2b';
  ctx.beginPath();
  ctx.arc(cx, bottom - 162, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Snout
  ctx.fillStyle = '#e6ccb2';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 148, 22, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Nose
  ctx.fillStyle = '#1b130e';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 154, 9, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Eyes (glowing amber warning eyes during telegraph)
  ctx.fillStyle = telegraph ? '#ffaa33' : '#1b130e';
  ctx.beginPath();
  ctx.arc(cx - 15, bottom - 170, telegraph ? 6 : 4.5, 0, Math.PI * 2);
  ctx.arc(cx + 15, bottom - 170, telegraph ? 6 : 4.5, 0, Math.PI * 2);
  ctx.fill();

  if (telegraph) {
    // Roaring open mouth
    ctx.fillStyle = '#7f1d1d';
    ctx.beginPath();
    ctx.ellipse(cx, bottom - 140, 12, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawSnowShrubSprite(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const cx = ox + CELL_SIZE * 0.5;
  const bottom = oy + CELL_SIZE - 16;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1b3a2e';
  ctx.lineWidth = 6;

  ctx.fillStyle = '#2d6a4f';
  ctx.beginPath();
  ctx.arc(cx - 34, bottom - 34, 34, 0, Math.PI * 2);
  ctx.arc(cx + 34, bottom - 34, 34, 0, Math.PI * 2);
  ctx.arc(cx, bottom - 56, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Snow dusting
  ctx.fillStyle = '#f0f9ff';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 82, 34, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAlpineRockSprite(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const cx = ox + CELL_SIZE * 0.5;
  const bottom = oy + CELL_SIZE - 14;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 6;

  // Main low granite boulder silhouette
  ctx.fillStyle = '#475569';
  ctx.beginPath();
  ctx.moveTo(cx - 88, bottom - 6);
  ctx.lineTo(cx - 72, bottom - 76);
  ctx.lineTo(cx - 18, bottom - 112);
  ctx.lineTo(cx + 48, bottom - 96);
  ctx.lineTo(cx + 88, bottom - 44);
  ctx.lineTo(cx + 76, bottom);
  ctx.lineTo(cx - 78, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Sunlit left facet
  ctx.fillStyle = '#7c8ea3';
  ctx.beginPath();
  ctx.moveTo(cx - 84, bottom - 8);
  ctx.lineTo(cx - 68, bottom - 74);
  ctx.lineTo(cx - 18, bottom - 108);
  ctx.lineTo(cx - 4, bottom - 40);
  ctx.lineTo(cx - 30, bottom - 4);
  ctx.closePath();
  ctx.fill();

  // Companion small scree stone on right
  ctx.fillStyle = '#5b6c80';
  ctx.beginPath();
  ctx.moveTo(cx + 12, bottom);
  ctx.lineTo(cx + 28, bottom - 46);
  ctx.lineTo(cx + 74, bottom - 40);
  ctx.lineTo(cx + 94, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Snow cap atop boulder crown
  ctx.fillStyle = '#f0f9ff';
  ctx.beginPath();
  ctx.moveTo(cx - 56, bottom - 72);
  ctx.lineTo(cx - 18, bottom - 106);
  ctx.lineTo(cx + 38, bottom - 92);
  ctx.lineTo(cx + 22, bottom - 66);
  ctx.lineTo(cx - 14, bottom - 78);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawRockCragSprite(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const cx = ox + CELL_SIZE * 0.5;
  const bottom = oy + CELL_SIZE - 14;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 6;

  // Tall twin-spire alpine crag
  ctx.fillStyle = '#3b4a5e';
  ctx.beginPath();
  ctx.moveTo(cx - 76, bottom);
  ctx.lineTo(cx - 54, bottom - 118);
  ctx.lineTo(cx - 12, bottom - 196);
  ctx.lineTo(cx + 28, bottom - 142);
  ctx.lineTo(cx + 56, bottom - 164);
  ctx.lineTo(cx + 78, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Sunlit ridge face
  ctx.fillStyle = '#64748b';
  ctx.beginPath();
  ctx.moveTo(cx - 70, bottom - 4);
  ctx.lineTo(cx - 50, bottom - 114);
  ctx.lineTo(cx - 12, bottom - 190);
  ctx.lineTo(cx + 6, bottom - 116);
  ctx.lineTo(cx - 18, bottom - 4);
  ctx.closePath();
  ctx.fill();

  // Highlight snow streak along upper ridge
  ctx.fillStyle = '#e2f1ff';
  ctx.beginPath();
  ctx.moveTo(cx - 46, bottom - 114);
  ctx.lineTo(cx - 12, bottom - 188);
  ctx.lineTo(cx + 8, bottom - 148);
  ctx.lineTo(cx - 16, bottom - 134);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx + 28, bottom - 136);
  ctx.lineTo(cx + 54, bottom - 158);
  ctx.lineTo(cx + 62, bottom - 120);
  ctx.lineTo(cx + 38, bottom - 118);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * Generates the cartoon 2.5D sprite atlas texture (`2048x1024`) via offscreen canvas with RGB edge
 * dilation, draws immediate procedural pine fallbacks for the 8 bottom-half tree slots, and upgrades
 * those slots asynchronously when `treeSprites.png` finishes decoding (or falls back safely to a tiny
 * headless DataTexture when `document` is absent in Node Vitest).
 */
export function createCartoonSpriteAtlasTexture(gfx: GraphicsUtils): THREE.Texture {
  if (typeof document === 'undefined') {
    const w = 8;
    const h = 8;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 220;
      data[i * 4 + 1] = 240;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 255;
    }
    const fallback = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    fallback.name = 'CartoonBillboardAtlasFallback';
    fallback.colorSpace = THREE.SRGBColorSpace;
    fallback.minFilter = THREE.LinearFilter;
    fallback.magFilter = THREE.LinearFilter;
    fallback.generateMipmaps = false;
    fallback.needsUpdate = true;
    gfx.markAsCache(fallback, 'CartoonBillboardAtlasFallback');
    return fallback;
  }

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = ATLAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D context for CartoonBillboardAtlas');
  }

  ctx.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);

  drawPineSprite(ctx, 0 * CELL_SIZE, 0 * CELL_SIZE, false);
  drawPineSprite(ctx, 1 * CELL_SIZE, 0 * CELL_SIZE, true);
  drawChildSprite(ctx, 2 * CELL_SIZE, 0 * CELL_SIZE, '#ef476f', '#ffd166', false);
  drawChildSprite(ctx, 3 * CELL_SIZE, 0 * CELL_SIZE, '#ef476f', '#ffd166', true);
  drawBearSprite(ctx, 0 * CELL_SIZE, 1 * CELL_SIZE, false);
  drawBearSprite(ctx, 1 * CELL_SIZE, 1 * CELL_SIZE, true);
  drawChildSprite(ctx, 2 * CELL_SIZE, 1 * CELL_SIZE, '#06d6a0', '#ffbe0b', false);
  drawSnowShrubSprite(ctx, 3 * CELL_SIZE, 1 * CELL_SIZE);
  drawAlpineRockSprite(ctx, 4 * CELL_SIZE, 0 * CELL_SIZE);
  drawRockCragSprite(ctx, 5 * CELL_SIZE, 0 * CELL_SIZE);

  // Immediate procedural pine fallback inside each of the 8 bottom-half tree rects until treeSprites.png loads.
  for (const frame of ALL_TREE_FRAMES) {
    if (frame === 'pine_green' || frame === 'pine_frosted') continue;
    const rect = ATLAS_FRAMES[frame];
    const pxX = Math.round(rect.uOffset * ATLAS_WIDTH);
    const pxW = Math.round(rect.uScale * ATLAS_WIDTH);
    const pxH = Math.round(rect.vScale * ATLAS_HEIGHT);
    const pxY = Math.round((1 - rect.vOffset - rect.vScale) * ATLAS_HEIGHT);
    ctx.save();
    ctx.translate(pxX, pxY);
    ctx.scale(pxW / CELL_SIZE, pxH / CELL_SIZE);
    drawPineSprite(ctx, 0, 0, isFrostedTreeFrame(frame));
    ctx.restore();
  }

  const imgData = ctx.getImageData(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
  dilateAtlasEdges(imgData.data, ATLAS_WIDTH, ATLAS_HEIGHT, 6);
  ctx.putImageData(imgData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'CartoonBillboardAtlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  gfx.markAsCache(texture, 'CartoonBillboardAtlas');

  let disposed = false;
  texture.addEventListener('dispose', () => {
    disposed = true;
  });

  if (typeof Image !== 'undefined') {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (disposed) return;
      ctx.clearRect(0, 512, ATLAS_WIDTH, 512);
      ctx.drawImage(img, 0, 512, ATLAS_WIDTH, 512);
      // Re-dilate bottom strip after drawImage because 2D canvas premultiplied alpha zeroes transparent RGBs.
      const bottomData = ctx.getImageData(0, 512, ATLAS_WIDTH, 512);
      dilateAtlasEdges(bottomData.data, ATLAS_WIDTH, 512, 6);
      ctx.putImageData(bottomData, 0, 512);
      texture.needsUpdate = true;
    };
    img.onerror = () => {
      // Keep procedural fallback silhouettes silently if image decode fails.
    };
    img.src = treeSpritesUrl;
  }

  return texture;
}
