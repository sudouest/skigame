/// <reference types="vite/client" />
import * as THREE from 'three';
import childSpritesUrl from './assets/childSprites.png';
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

export type CharacterFrameName =
  | 'child_idle_0'
  | 'child_idle_1'
  | 'child_crouch'
  | 'child_jump'
  | 'bear_walk'
  | 'bear_telegraph';

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
  bear_walk: makeCharacterFrameRect(0, 1),
  bear_telegraph: makeCharacterFrameRect(1, 1),
};

export function isCharacterFrameName(frame: string): frame is CharacterFrameName {
  return Object.prototype.hasOwnProperty.call(CHARACTER_ATLAS_FRAMES, frame);
}

type ChildFallbackPose = 'idle_0' | 'idle_1' | 'crouch' | 'jump';

function drawCharacterChildFallback(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  pose: ChildFallbackPose,
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
  ctx.fillStyle = '#a62c2b';
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
    ctx.fillStyle = '#a62c2b';
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

    ctx.fillStyle = '#2c5e4f';
    ctx.beginPath();
    ctx.arc(cx - 60, bottom - raiseY - 6, 11, 0, Math.PI * 2);
    ctx.arc(cx + 60, bottom - raiseY - 6, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Parka torso
  ctx.fillStyle = '#a62c2b';
  ctx.beginPath();
  ctx.roundRect(cx - 34, bottom - 130 + crouchDrop, 68, 70, 18);
  ctx.fill();
  ctx.stroke();

  // Front-held crouched arms & mittens drawn OVER torso
  if (isCrouch) {
    ctx.fillStyle = '#a62c2b';
    ctx.beginPath();
    ctx.roundRect(cx - 42, bottom - 116 + crouchDrop, 18, 36, 8);
    ctx.roundRect(cx + 24, bottom - 116 + crouchDrop, 18, 36, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#2c5e4f';
    ctx.beginPath();
    ctx.arc(cx - 20, bottom - 94 + crouchDrop, 11, 0, Math.PI * 2);
    ctx.arc(cx + 20, bottom - 94 + crouchDrop, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Scarf collar
  ctx.fillStyle = '#c43c35';
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

  // Beanie + ochre pom-pom
  ctx.lineWidth = 6;
  ctx.fillStyle = '#243b55';
  ctx.beginPath();
  ctx.arc(cx, headY - 12, 29, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#d99b38';
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
 * premultiplication loss), drawing immediate procedural fallbacks and upgrading the child strip
 * asynchronously once `childSprites.png` decodes.
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

  drawCharacterChildFallback(ctx, 0 * CHARACTER_CELL_SIZE, 0 * CHARACTER_CELL_SIZE, 'idle_0');
  drawCharacterChildFallback(ctx, 1 * CHARACTER_CELL_SIZE, 0 * CHARACTER_CELL_SIZE, 'idle_1');
  drawCharacterChildFallback(ctx, 2 * CHARACTER_CELL_SIZE, 0 * CHARACTER_CELL_SIZE, 'crouch');
  drawCharacterChildFallback(ctx, 3 * CHARACTER_CELL_SIZE, 0 * CHARACTER_CELL_SIZE, 'jump');
  drawCharacterBearFallback(ctx, 0 * CHARACTER_CELL_SIZE, 1 * CHARACTER_CELL_SIZE, false);
  drawCharacterBearFallback(ctx, 1 * CHARACTER_CELL_SIZE, 1 * CHARACTER_CELL_SIZE, true);

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
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (disposed) return;
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      if (srcW !== 1024 || srcH !== 256) {
        return;
      }

      const stripCanvas = document.createElement('canvas');
      stripCanvas.width = 1024;
      stripCanvas.height = 256;
      const stripCtx = stripCanvas.getContext('2d');
      if (!stripCtx) return;

      stripCtx.clearRect(0, 0, 1024, 256);
      stripCtx.drawImage(img, 0, 0, 1024, 256);
      const topStrip = stripCtx.getImageData(0, 0, 1024, 256);
      dilateAtlasEdges(topStrip.data, 1024, 256, 6);
      copyCanvasRegionToFlippedRgba(
        topStrip.data,
        1024,
        256,
        atlasPixels,
        CHARACTER_ATLAS_WIDTH,
        CHARACTER_ATLAS_HEIGHT,
        0,
        0,
      );
      texture.needsUpdate = true;
    };
    img.onerror = () => {
      // Keep procedural child fallbacks silently if image decode fails.
    };
    img.src = childSpritesUrl;
  }

  return texture;
}
