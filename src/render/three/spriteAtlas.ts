import * as THREE from 'three';
import type { GraphicsUtils } from './graphicsUtils';

export const ATLAS_WIDTH = 1024;
export const ATLAS_HEIGHT = 512;
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
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
  | 'snow_shrub';

export interface AtlasFrameRect {
  readonly col: number;
  readonly row: number;
  readonly uOffset: number;
  readonly vOffset: number;
  readonly uScale: number;
  readonly vScale: number;
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

export const ATLAS_FRAMES: Readonly<Record<BillboardFrameName, AtlasFrameRect>> = {
  pine_green: makeFrameRect(0, 0),
  pine_frosted: makeFrameRect(1, 0),
  child_idle: makeFrameRect(2, 0),
  child_cheer: makeFrameRect(3, 0),
  bear_walk: makeFrameRect(0, 1),
  bear_telegraph: makeFrameRect(1, 1),
  child_blue: makeFrameRect(2, 1),
  snow_shrub: makeFrameRect(3, 1),
};

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

/**
 * Generates the cartoon 2.5D sprite atlas texture via offscreen canvas with RGB edge dilation,
 * or falls back safely to a tiny headless DataTexture when `document` is absent (Node Vitest).
 */
export function createCartoonSpriteAtlasTexture(gfx: GraphicsUtils): THREE.Texture {
  if (typeof document === 'undefined') {
    const w = 8;
    const h = 4;
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
  return texture;
}
