/// <reference types="vite/client" />
import * as THREE from 'three';
import bearSpritesUrl from './assets/bearSprites.png';
import bearWalkSpritesUrl from './assets/bearWalkSprites.png';
import childBlueSpritesUrl from './assets/childBlueSprites.png';
import childOchreSpritesUrl from './assets/childOchreSprites.png';
import childSpritesUrl from './assets/childSprites.png';
import childTealSpritesUrl from './assets/childTealSprites.png';
import type { GraphicsUtils } from './graphicsUtils';
import { dilateAtlasEdges, type AtlasFrameRect } from './spriteAtlas';

export const CHARACTER_ATLAS_WIDTH = 2048;
export const CHARACTER_ATLAS_HEIGHT = 1024;
export const CHARACTER_ATLAS_COLS = 8;
export const CHARACTER_ATLAS_ROWS = 4;
export const CHARACTER_CELL_SIZE = 256;
export const CHARACTER_CELL_PAD_PX = 4;

export const CHILD_SPRITE_BASE_WIDTH_M = 1.8;
export const CHILD_SPRITE_BASE_HEIGHT_M = 1.8;
export const CHILD_SHADOW_RADIUS_M = 0.62;

export type ChildVariantId = 'red' | 'teal' | 'blue' | 'ochre';

export const CHILD_VARIANT_IDS: readonly ChildVariantId[] = ['red', 'teal', 'blue', 'ochre'];

export type CharacterFrameName =
  | 'child_idle_0'
  | 'child_idle_1'
  | 'child_crouch'
  | 'child_jump'
  | 'child_teal_idle_0'
  | 'child_teal_idle_1'
  | 'child_teal_crouch'
  | 'child_teal_jump'
  | 'child_blue_idle_0'
  | 'child_blue_idle_1'
  | 'child_blue_crouch'
  | 'child_blue_jump'
  | 'child_ochre_idle_0'
  | 'child_ochre_idle_1'
  | 'child_ochre_crouch'
  | 'child_ochre_jump'
  | 'bear_idle'
  | 'bear_telegraph'
  | 'bear_walk'
  | 'bear_walk_1'
  | 'bear_walk_2'
  | 'bear_walk_3'
  | 'bear_walk_4'
  | 'bear_walk_5'
  | 'bear_walk_6'
  | 'bear_walk_7';

export interface CharacterSpriteStripSpec {
  readonly id: string;
  readonly col: number;
  readonly row: number;
  readonly frameCount: number;
  readonly url: string;
  readonly drawFallback?: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void;
}

const CHILD_FALLBACK_POSES: readonly ChildFallbackPose[] = ['idle_0', 'idle_1', 'crouch', 'jump'];

function makeChildStripSpec(
  id: ChildVariantId,
  col: number,
  row: number,
  url: string,
): CharacterSpriteStripSpec {
  return {
    id,
    col,
    row,
    frameCount: 4,
    url,
    drawFallback(ctx, ox, oy) {
      const palette = CHILD_FALLBACK_PALETTES[id];
      for (let f = 0; f < CHILD_FALLBACK_POSES.length; f++) {
        drawCharacterChildFallback(
          ctx,
          ox + f * CHARACTER_CELL_SIZE,
          oy,
          CHILD_FALLBACK_POSES[f]!,
          palette,
        );
      }
    },
  };
}

export const CHARACTER_SPRITE_STRIPS: readonly CharacterSpriteStripSpec[] = [
  makeChildStripSpec('red', 0, 0, childSpritesUrl),
  makeChildStripSpec('teal', 4, 0, childTealSpritesUrl),
  makeChildStripSpec('blue', 0, 1, childBlueSpritesUrl),
  makeChildStripSpec('ochre', 4, 1, childOchreSpritesUrl),
  {
    id: 'bear',
    col: 0,
    row: 2,
    frameCount: 2,
    url: bearSpritesUrl,
    drawFallback(ctx, ox, oy) {
      drawCharacterBearFallback(ctx, ox + 0 * CHARACTER_CELL_SIZE, oy, false);
      drawCharacterBearFallback(ctx, ox + 1 * CHARACTER_CELL_SIZE, oy, true);
    },
  },
  {
    id: 'bear_walk',
    col: 0,
    row: 3,
    frameCount: 8,
    url: bearWalkSpritesUrl,
    drawFallback(ctx, ox, oy) {
      for (let f = 0; f < 8; f++) {
        drawCharacterBearFallback(ctx, ox + f * CHARACTER_CELL_SIZE, oy, false);
      }
    },
  },
];

function makeCharacterFrameRect(col: number, row: number): AtlasFrameRect {
  const padU = CHARACTER_CELL_PAD_PX / CHARACTER_ATLAS_WIDTH;
  const padV = CHARACTER_CELL_PAD_PX / CHARACTER_ATLAS_HEIGHT;
  const cellW = 1 / CHARACTER_ATLAS_COLS;
  const cellH = 1 / CHARACTER_ATLAS_ROWS;
  const uOffset = col * cellW + padU;
  const uScale = cellW - padU * 2;
  // Atlas rows map top-down row 0 -> WebGL v near 1.0 (bottom-to-top DataTexture row order).
  const vOffset = 1 - (row + 1) * cellH + padV;
  const vScale = cellH - padV * 2;
  return { col, row, uOffset, vOffset, uScale, vScale };
}

export const CHARACTER_ATLAS_FRAMES: Readonly<Record<CharacterFrameName, AtlasFrameRect>> = {
  child_idle_0: makeCharacterFrameRect(0, 0),
  child_idle_1: makeCharacterFrameRect(1, 0),
  child_crouch: makeCharacterFrameRect(2, 0),
  child_jump: makeCharacterFrameRect(3, 0),
  child_teal_idle_0: makeCharacterFrameRect(4, 0),
  child_teal_idle_1: makeCharacterFrameRect(5, 0),
  child_teal_crouch: makeCharacterFrameRect(6, 0),
  child_teal_jump: makeCharacterFrameRect(7, 0),
  child_blue_idle_0: makeCharacterFrameRect(0, 1),
  child_blue_idle_1: makeCharacterFrameRect(1, 1),
  child_blue_crouch: makeCharacterFrameRect(2, 1),
  child_blue_jump: makeCharacterFrameRect(3, 1),
  child_ochre_idle_0: makeCharacterFrameRect(4, 1),
  child_ochre_idle_1: makeCharacterFrameRect(5, 1),
  child_ochre_crouch: makeCharacterFrameRect(6, 1),
  child_ochre_jump: makeCharacterFrameRect(7, 1),
  bear_idle: makeCharacterFrameRect(0, 2),
  bear_telegraph: makeCharacterFrameRect(1, 2),
  bear_walk: makeCharacterFrameRect(0, 3),
  bear_walk_1: makeCharacterFrameRect(1, 3),
  bear_walk_2: makeCharacterFrameRect(2, 3),
  bear_walk_3: makeCharacterFrameRect(3, 3),
  bear_walk_4: makeCharacterFrameRect(4, 3),
  bear_walk_5: makeCharacterFrameRect(5, 3),
  bear_walk_6: makeCharacterFrameRect(6, 3),
  bear_walk_7: makeCharacterFrameRect(7, 3),
};

export function isCharacterFrameName(frame: string): frame is CharacterFrameName {
  return Object.prototype.hasOwnProperty.call(CHARACTER_ATLAS_FRAMES, frame);
}

type ChildFallbackPose = 'idle_0' | 'idle_1' | 'crouch' | 'jump';

interface ChildFallbackPalette {
  readonly coat: string;
  readonly scarf: string;
  readonly beanie: string;
  readonly pom: string;
  readonly mitten: string;
}

const CHILD_FALLBACK_PALETTES: Readonly<Record<ChildVariantId, ChildFallbackPalette>> = {
  red: {
    coat: '#a62c2b',
    scarf: '#c43c35',
    beanie: '#243b55',
    pom: '#d99b38',
    mitten: '#2c5e4f',
  },
  teal: {
    coat: '#2e6f5e',
    scarf: '#8e3b68',
    beanie: '#f0e2c8',
    pom: '#9e3545',
    mitten: '#2c5e4f',
  },
  blue: {
    coat: '#2f5388',
    scarf: '#c7642a',
    beanie: '#a84226',
    pom: '#a84226',
    mitten: '#2c5e4f',
  },
  ochre: {
    coat: '#c98e27',
    scarf: '#2c7576',
    beanie: '#3d5860',
    pom: '#e5d4b3',
    mitten: '#263a47',
  },
};

function drawCharacterChildFallback(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  pose: ChildFallbackPose,
  palette: ChildFallbackPalette,
): void {
  const cx = ox + CHARACTER_CELL_SIZE * 0.5;
  const bottom = oy + CHARACTER_CELL_SIZE - 8;
  const isCrouch = pose === 'crouch';
  const isJump = pose === 'jump';
  const crouchDrop = isCrouch ? 16 : 0;
  const legLift = isJump ? 12 : 0;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#181825';
  ctx.lineWidth = 6;

  // Boots
  ctx.fillStyle = '#2b2d42';
  ctx.beginPath();
  ctx.roundRect(cx - 26, bottom - 26 - legLift, 20, 24, 6);
  ctx.roundRect(cx + 6, bottom - 26 - (isJump ? 18 : 0), 20, 24, 6);
  ctx.fill();
  ctx.stroke();

  // Legs
  ctx.fillStyle = '#1d3557';
  ctx.beginPath();
  ctx.roundRect(cx - 24, bottom - 66 + crouchDrop * 0.4 - legLift, 18, 44 - crouchDrop * 0.4, 6);
  ctx.roundRect(
    cx + 6,
    bottom - 66 + crouchDrop * 0.4 - (isJump ? 12 : 0),
    18,
    44 - crouchDrop * 0.4,
    6,
  );
  ctx.fill();
  ctx.stroke();

  // Trailing scarf tail
  ctx.fillStyle = palette.scarf;
  ctx.beginPath();
  if (pose === 'idle_0') {
    ctx.moveTo(cx - 26, bottom - 126);
    ctx.lineTo(cx - 70, bottom - 64);
    ctx.lineTo(cx - 50, bottom - 56);
    ctx.lineTo(cx - 14, bottom - 116);
  } else {
    ctx.moveTo(cx - 26, bottom - 126 + crouchDrop);
    ctx.lineTo(cx - 82, bottom - 96 + crouchDrop * 0.5);
    ctx.lineTo(cx - 72, bottom - 76 + crouchDrop * 0.5);
    ctx.lineTo(cx - 16, bottom - 114 + crouchDrop);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Raised arms (drawn behind torso) when not crouching
  if (!isCrouch) {
    const raiseY = isJump ? 196 : 164;
    ctx.fillStyle = palette.coat;
    ctx.beginPath();
    ctx.moveTo(cx - 30, bottom - 116);
    ctx.lineTo(cx - 66, bottom - raiseY);
    ctx.lineTo(cx - 50, bottom - raiseY - 12);
    ctx.lineTo(cx - 16, bottom - 126);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + 30, bottom - 116);
    ctx.lineTo(cx + 66, bottom - raiseY);
    ctx.lineTo(cx + 50, bottom - raiseY - 12);
    ctx.lineTo(cx + 16, bottom - 126);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = palette.mitten;
    ctx.beginPath();
    ctx.arc(cx - 60, bottom - raiseY - 6, 11, 0, Math.PI * 2);
    ctx.arc(cx + 60, bottom - raiseY - 6, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Parka torso
  ctx.fillStyle = palette.coat;
  ctx.beginPath();
  ctx.roundRect(cx - 34, bottom - 130 + crouchDrop, 68, 70, 18);
  ctx.fill();
  ctx.stroke();

  // Front-held crouched arms & mittens drawn OVER torso
  if (isCrouch) {
    ctx.fillStyle = palette.coat;
    ctx.beginPath();
    ctx.roundRect(cx - 42, bottom - 116 + crouchDrop, 18, 36, 8);
    ctx.roundRect(cx + 24, bottom - 116 + crouchDrop, 18, 36, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = palette.mitten;
    ctx.beginPath();
    ctx.arc(cx - 20, bottom - 94 + crouchDrop, 11, 0, Math.PI * 2);
    ctx.arc(cx + 20, bottom - 94 + crouchDrop, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Scarf collar
  ctx.fillStyle = palette.scarf;
  ctx.beginPath();
  ctx.roundRect(cx - 28, bottom - 140 + crouchDrop, 56, 18, 8);
  ctx.fill();
  ctx.stroke();

  // Head
  const headY = bottom - 164 + crouchDrop;
  ctx.fillStyle = '#f6c3a4';
  ctx.beginPath();
  ctx.arc(cx, headY, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Eyes & smile
  ctx.fillStyle = '#181825';
  ctx.beginPath();
  ctx.arc(cx - 9, headY - 2, 3.5, 0, Math.PI * 2);
  ctx.arc(cx + 9, headY - 2, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.beginPath();
  if (isJump) {
    ctx.arc(cx, headY + 6, 8, 0, Math.PI);
  } else {
    ctx.arc(cx, headY + 6, 7, 0.15 * Math.PI, 0.85 * Math.PI);
  }
  ctx.stroke();

  // Beanie + pom-pom
  ctx.lineWidth = 6;
  ctx.fillStyle = palette.beanie;
  ctx.beginPath();
  ctx.arc(cx, headY - 12, 29, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = palette.pom;
  ctx.beginPath();
  ctx.arc(cx - 12, headY - 46, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawCharacterBearFallback(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  telegraph: boolean,
): void {
  const cx = ox + CHARACTER_CELL_SIZE * 0.5;
  const bottom = oy + CHARACTER_CELL_SIZE - 14;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1b130e';
  ctx.lineWidth = 6;

  ctx.fillStyle = '#6f4528';
  ctx.beginPath();
  ctx.arc(cx - 38, bottom - 182, 16, 0, Math.PI * 2);
  ctx.arc(cx + 38, bottom - 182, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#5c3a21';
  ctx.beginPath();
  ctx.roundRect(cx - 46, bottom - 56, 30, 52, 10);
  ctx.roundRect(cx + 16, bottom - 56, 30, 52, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#754829';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 100, 62, 68, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#c89f78';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 96, 36, 44, 0, 0, Math.PI * 2);
  ctx.fill();

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

  ctx.fillStyle = '#7c4d2b';
  ctx.beginPath();
  ctx.arc(cx, bottom - 162, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#e6ccb2';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 148, 22, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#1b130e';
  ctx.beginPath();
  ctx.ellipse(cx, bottom - 154, 9, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = telegraph ? '#ffaa33' : '#1b130e';
  ctx.beginPath();
  ctx.arc(cx - 15, bottom - 170, telegraph ? 6 : 4.5, 0, Math.PI * 2);
  ctx.arc(cx + 15, bottom - 170, telegraph ? 6 : 4.5, 0, Math.PI * 2);
  ctx.fill();

  if (telegraph) {
    ctx.fillStyle = '#7f1d1d';
    ctx.beginPath();
    ctx.ellipse(cx, bottom - 140, 12, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Copies a top-down Canvas2D RGBA buffer region into a bottom-up `DataTexture` RGBA buffer
 * (`flipY = false`) so dilated `alpha === 0` RGB texels reach WebGL intact without Canvas2D
 * premultiplied `putImageData` zeroing.
 */
export function copyCanvasRegionToFlippedRgba(
  srcRgba: Uint8ClampedArray | Uint8Array,
  srcW: number,
  srcH: number,
  dstRgba: Uint8Array,
  dstW: number,
  dstH: number,
  dstTopX: number,
  dstTopY: number,
): void {
  const rowBytes = srcW * 4;
  for (let sy = 0; sy < srcH; sy++) {
    const glY = dstH - 1 - (dstTopY + sy);
    if (glY < 0 || glY >= dstH) continue;
    const srcStart = sy * rowBytes;
    const dstStart = (glY * dstW + dstTopX) * 4;
    dstRgba.set(srcRgba.subarray(srcStart, srcStart + rowBytes), dstStart);
  }
}

/**
 * Generates the dedicated 2.5D animated character sprite atlas (`2048x1024`, 8x4 cells of 256x256)
 * backed by `THREE.DataTexture` (preserving dilated `alpha === 0` RGB edges without Canvas2D
 * premultiplication loss), drawing immediate procedural fallbacks and upgrading each strip in
 * `CHARACTER_SPRITE_STRIPS` asynchronously once decoded.
 */
export function createCharacterSpriteAtlasTexture(gfx: GraphicsUtils): THREE.Texture {
  if (typeof document === 'undefined') {
    const w = 8;
    const h = 8;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 240;
      data[i * 4 + 1] = 220;
      data[i * 4 + 2] = 220;
      data[i * 4 + 3] = 255;
    }
    const fallback = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    fallback.name = 'CharacterBillboardAtlasFallback';
    fallback.colorSpace = THREE.SRGBColorSpace;
    fallback.minFilter = THREE.LinearFilter;
    fallback.magFilter = THREE.LinearFilter;
    fallback.generateMipmaps = false;
    fallback.needsUpdate = true;
    gfx.markAsCache(fallback, 'CharacterBillboardAtlasFallback');
    return fallback;
  }

  const canvas = document.createElement('canvas');
  canvas.width = CHARACTER_ATLAS_WIDTH;
  canvas.height = CHARACTER_ATLAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D context for CharacterBillboardAtlas');
  }

  ctx.clearRect(0, 0, CHARACTER_ATLAS_WIDTH, CHARACTER_ATLAS_HEIGHT);

  for (const strip of CHARACTER_SPRITE_STRIPS) {
    strip.drawFallback?.(
      ctx,
      strip.col * CHARACTER_CELL_SIZE,
      strip.row * CHARACTER_CELL_SIZE,
    );
  }

  const imgData = ctx.getImageData(0, 0, CHARACTER_ATLAS_WIDTH, CHARACTER_ATLAS_HEIGHT);
  dilateAtlasEdges(imgData.data, CHARACTER_ATLAS_WIDTH, CHARACTER_ATLAS_HEIGHT, 6);

  const atlasPixels = new Uint8Array(CHARACTER_ATLAS_WIDTH * CHARACTER_ATLAS_HEIGHT * 4);
  copyCanvasRegionToFlippedRgba(
    imgData.data,
    CHARACTER_ATLAS_WIDTH,
    CHARACTER_ATLAS_HEIGHT,
    atlasPixels,
    CHARACTER_ATLAS_WIDTH,
    CHARACTER_ATLAS_HEIGHT,
    0,
    0,
  );

  const texture = new THREE.DataTexture(
    atlasPixels,
    CHARACTER_ATLAS_WIDTH,
    CHARACTER_ATLAS_HEIGHT,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.name = 'CharacterBillboardAtlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.needsUpdate = true;
  gfx.markAsCache(texture, 'CharacterBillboardAtlas');

  let disposed = false;
  texture.addEventListener('dispose', () => {
    disposed = true;
  });

  if (typeof Image !== 'undefined') {
    for (const strip of CHARACTER_SPRITE_STRIPS) {
      const expectedW = strip.frameCount * CHARACTER_CELL_SIZE;
      const expectedH = CHARACTER_CELL_SIZE;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (disposed) return;
        const srcW = img.naturalWidth || img.width;
        const srcH = img.naturalHeight || img.height;
        if (srcW !== expectedW || srcH !== expectedH) {
          return;
        }

        const stripCanvas = document.createElement('canvas');
        stripCanvas.width = expectedW;
        stripCanvas.height = expectedH;
        const stripCtx = stripCanvas.getContext('2d');
        if (!stripCtx) return;

        stripCtx.clearRect(0, 0, expectedW, expectedH);
        stripCtx.drawImage(img, 0, 0, expectedW, expectedH);
        const stripData = stripCtx.getImageData(0, 0, expectedW, expectedH);
        dilateAtlasEdges(stripData.data, expectedW, expectedH, 6);
        copyCanvasRegionToFlippedRgba(
          stripData.data,
          expectedW,
          expectedH,
          atlasPixels,
          CHARACTER_ATLAS_WIDTH,
          CHARACTER_ATLAS_HEIGHT,
          strip.col * CHARACTER_CELL_SIZE,
          strip.row * CHARACTER_CELL_SIZE,
        );
        texture.needsUpdate = true;
      };
      img.onerror = () => {
        // Keep procedural fallback silently if image decode fails.
      };
      img.src = strip.url;
    }
  }

  return texture;
}
