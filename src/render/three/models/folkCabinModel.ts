import * as THREE from 'three';
import { buildChimneySmokeQuadGeometry, createChimneySmokeAssets } from '../chimneySmoke';
import type { GraphicsUtils } from '../graphicsUtils';
import type { ChimneyEmitterAnchor, LandmarkModelDef } from '../landmarkRegistry';
import { createTexturedToonMaterial, type SharedLightingUniforms, type SharedToonMaterials } from '../toonMaterials';
import {
  type AtlasTileRect,
  buildMergedColoredGeometry,
  buildMergedTexturedGeometry,
  type ColoredGeometryPart,
  createProceduralCanvasTexture,
  drawFolkStar,
  drawRoundedRectPath,
  makeAtlasTile,
  type TexturedGeometryPart,
  type TileMappingSpec,
} from './proceduralModelUtils';

export const FOLK_CABIN_ATLAS_SIZE = 1024;

const CHIMNEY_BASE_POS = { x: -1.36, y: 3.92, z: -0.75 } as const;
const CHIMNEY_TILT = { rx: -0.05, ry: 0, rz: 0.16 } as const;
const CHIMNEY_MOUTH_LOCAL_Y = 1.66;

const _smokeOriginVec = new THREE.Vector3(0, CHIMNEY_MOUTH_LOCAL_Y, 0)
  .applyEuler(new THREE.Euler(CHIMNEY_TILT.rx, CHIMNEY_TILT.ry, CHIMNEY_TILT.rz, 'YXZ'))
  .add(new THREE.Vector3(CHIMNEY_BASE_POS.x, CHIMNEY_BASE_POS.y, CHIMNEY_BASE_POS.z));

/**
 * Exact local origin of the chimney mouth on `cabinGeo`.
 */
export const FOLK_CABIN_SMOKE_ORIGIN = {
  x: _smokeOriginVec.x,
  y: _smokeOriginVec.y,
  z: _smokeOriginVec.z,
} as const;

export const FOLK_CABIN_SMOKE_ANCHOR: ChimneyEmitterAnchor = {
  x: FOLK_CABIN_SMOKE_ORIGIN.x,
  y: FOLK_CABIN_SMOKE_ORIGIN.y,
  z: FOLK_CABIN_SMOKE_ORIGIN.z,
  tiltX: -0.16,
  tiltZ: -0.05,
  puffScale: 1.0,
};

export type FolkCabinTileName =
  | 'logBark'
  | 'logEnd'
  | 'darkTrim'
  | 'roofSnowFolk'
  | 'snowPlain'
  | 'folkTrim'
  | 'gablePediment'
  | 'doorPlanks'
  | 'greenShutter'
  | 'shedPlanks'
  | 'chimneyStone'
  | 'roundFrameBeads'
  | 'snowShadow';

export type FolkCabinAtlasTile = AtlasTileRect;

export const FOLK_CABIN_ATLAS_TILES: Readonly<Record<FolkCabinTileName, FolkCabinAtlasTile>> = {
  // Row 0 (y: 0..256)
  logBark: makeAtlasTile(0, 0, 512, 256, FOLK_CABIN_ATLAS_SIZE),
  logEnd: makeAtlasTile(512, 0, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  darkTrim: makeAtlasTile(768, 0, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  // Row 1 (y: 256..512)
  roofSnowFolk: makeAtlasTile(0, 256, 512, 256, FOLK_CABIN_ATLAS_SIZE),
  snowPlain: makeAtlasTile(512, 256, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  folkTrim: makeAtlasTile(768, 256, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  // Row 2 (y: 512..768)
  gablePediment: makeAtlasTile(0, 512, 512, 256, FOLK_CABIN_ATLAS_SIZE),
  doorPlanks: makeAtlasTile(512, 512, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  greenShutter: makeAtlasTile(768, 512, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  // Row 3 (y: 768..1024)
  shedPlanks: makeAtlasTile(0, 768, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  chimneyStone: makeAtlasTile(256, 768, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  roundFrameBeads: makeAtlasTile(512, 768, 256, 256, FOLK_CABIN_ATLAS_SIZE),
  snowShadow: makeAtlasTile(768, 768, 256, 256, FOLK_CABIN_ATLAS_SIZE),
};

function drawHeart(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  fill: string,
  stroke: string,
): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy + size * 0.48);
  ctx.bezierCurveTo(cx - size * 0.65, cy + size * 0.05, cx - size * 0.55, cy - size * 0.55, cx, cy - size * 0.16);
  ctx.bezierCurveTo(cx + size * 0.55, cy - size * 0.55, cx + size * 0.65, cy + size * 0.05, cx, cy + size * 0.48);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawFolkVinePattern(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  w: number,
  h: number,
): void {
  const cy = oy + h * 0.5;
  ctx.strokeStyle = '#ebb434';
  ctx.lineWidth = Math.max(4, h * 0.1);
  ctx.lineCap = 'round';
  ctx.beginPath();
  const waves = 6;
  const amp = h * 0.22;
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const px = ox + t * w;
    const py = cy + Math.sin(t * Math.PI * 2 * waves) * amp;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  for (let k = 0; k < waves * 2; k++) {
    const t = (k + 0.5) / (waves * 2);
    const px = ox + t * w;
    const crest = k % 2 === 0 ? -1 : 1;
    ctx.fillStyle = '#c93428';
    ctx.beginPath();
    ctx.arc(px, cy + crest * h * 0.26, Math.max(3, h * 0.065), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#3f7d58';
    ctx.beginPath();
    ctx.ellipse(px, cy - crest * h * 0.12, Math.max(3.5, h * 0.08), Math.max(2, h * 0.045), crest * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Paints the complete 1024x1024 procedural folk-art log cabin CanvasTexture atlas.
 */
export function drawFolkCabinAtlas(ctx: CanvasRenderingContext2D): void {
  const ink = '#2f180b';
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. logBark (0, 0, 512, 256) - warm honey-ochre log grain running horizontally along U
  {
    const t = FOLK_CABIN_ATLAS_TILES.logBark;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#a76824');
    grad.addColorStop(0.22, '#cf8f37');
    grad.addColorStop(0.55, '#dfa447');
    grad.addColorStop(0.85, '#ba7929');
    grad.addColorStop(1, '#8f551a');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#6c3e14';
    ctx.lineWidth = 2.6;
    const lines = [28, 64, 98, 134, 174, 210, 236];
    for (let i = 0; i < lines.length; i++) {
      const y = t.py + lines[i]!;
      ctx.beginPath();
      ctx.moveTo(t.px, y);
      ctx.bezierCurveTo(t.px + 140, y + (i % 2 === 0 ? 7 : -6), t.px + 340, y + (i % 2 === 0 ? -6 : 7), t.px + t.pw, y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#5c3310';
    ctx.lineWidth = 2.5;
    for (const [kx, ky] of [
      [148, 96],
      [365, 168],
    ]) {
      ctx.beginPath();
      ctx.ellipse(t.px + kx!, t.py + ky!, 22, 8, 0.05, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 2. logEnd (512, 0, 256, 256) - pale tan circular end-grain with hand-drawn spiral
  {
    const t = FOLK_CABIN_ATLAS_TILES.logEnd;
    ctx.fillStyle = '#5a3215';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.5;
    ctx.fillStyle = '#995e22';
    ctx.beginPath();
    ctx.arc(cx, cy, 122, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#dec08e';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, 108, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#c49b60';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, 86, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#573317';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    const turns = 3.2;
    const steps = 96;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const ang = f * Math.PI * 2 * turns;
      const rad = 8 + f * 84;
      const px = cx + Math.cos(ang) * rad;
      const py = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // 3. darkTrim (768, 0, 256, 256) - deep warm chocolate-brown timber frame
  {
    const t = FOLK_CABIN_ATLAS_TILES.darkTrim;
    ctx.fillStyle = '#4e2712';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#331708';
    ctx.lineWidth = 3;
    for (let i = 1; i <= 7; i++) {
      const y = t.py + i * 32;
      ctx.beginPath();
      ctx.moveTo(t.px, y);
      ctx.lineTo(t.px + t.pw, y + (i % 2 === 0 ? 4 : -4));
      ctx.stroke();
    }
    ctx.strokeStyle = '#6c3b1d';
    ctx.lineWidth = 4;
    ctx.strokeRect(t.px + 6, t.py + 6, t.pw - 12, t.ph - 12);
  }

  // 4. roofSnowFolk (0, 256, 512, 256) - creamy roof snow with bottom eave folk motif band
  {
    const t = FOLK_CABIN_ATLAS_TILES.roofSnowFolk;
    ctx.fillStyle = '#faf6ee';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#cfe0ee';
    ctx.lineWidth = 4.5;
    for (const [wx, wy, ww] of [
      [85, 62, 74],
      [286, 48, 86],
      [182, 114, 92],
      [392, 102, 68],
    ]) {
      ctx.beginPath();
      ctx.moveTo(t.px + wx!, t.py + wy!);
      ctx.quadraticCurveTo(t.px + wx! + ww! * 0.5, t.py + wy! - 10, t.px + wx! + ww!, t.py + wy! + 2);
      ctx.stroke();
    }

    ctx.fillStyle = '#d3e3f0';
    ctx.fillRect(t.px, t.py + t.ph - 16, t.pw, 16);

    ctx.fillStyle = '#346b4d';
    ctx.fillRect(t.px, t.py + t.ph - 25, t.pw, 7);

    const vineY = t.py + t.ph - 42;
    ctx.strokeStyle = '#e0a426';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    const waveCount = 7;
    for (let i = 0; i <= 70; i++) {
      const f = i / 70;
      const x = t.px + f * t.pw;
      const y = vineY + Math.sin(f * Math.PI * 2 * waveCount) * 6.5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (let k = 0; k < waveCount * 2; k++) {
      const f = (k + 0.5) / (waveCount * 2);
      const x = t.px + f * t.pw;
      const crest = k % 2 === 0 ? -1 : 1;
      ctx.fillStyle = '#b93326';
      ctx.beginPath();
      ctx.arc(x, vineY + crest * 8.5, 3.8, 0, Math.PI * 2);
      ctx.fill();
    }

    const starY = t.py + t.ph - 78;
    for (let i = 0; i < 5; i++) {
      const sx = t.px + ((i + 0.5) / 5) * t.pw;
      drawFolkStar(ctx, sx, starY, 14, 10, '#a82d22');
    }
  }

  // 5. snowPlain (512, 256, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.snowPlain;
    ctx.fillStyle = '#fbf8f1';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);
    ctx.strokeStyle = '#d5e4f0';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(t.px + 32, t.py + 88);
    ctx.quadraticCurveTo(t.px + 98, t.py + 72, t.px + 158, t.py + 92);
    ctx.moveTo(t.px + 94, t.py + 184);
    ctx.quadraticCurveTo(t.px + 158, t.py + 168, t.px + 224, t.py + 188);
    ctx.stroke();
  }

  // 6. folkTrim (768, 256, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.folkTrim;
    ctx.fillStyle = '#4c2511';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.fillStyle = '#733d1b';
    ctx.fillRect(t.px, t.py + 10, t.pw, 16);
    ctx.fillRect(t.px, t.py + t.ph - 26, t.pw, 16);

    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(t.px, t.py + 28);
    ctx.lineTo(t.px + t.pw, t.py + 28);
    ctx.moveTo(t.px, t.py + t.ph - 28);
    ctx.lineTo(t.px + t.pw, t.py + t.ph - 28);
    ctx.stroke();

    drawFolkVinePattern(ctx, t.px, t.py + 30, t.pw, t.ph - 60);
  }

  // 7. gablePediment (0, 512, 512, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.gablePediment;
    ctx.fillStyle = '#c5862e';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#995f1a';
    ctx.lineWidth = 2.8;
    for (let y = 32; y < t.ph; y += 36) {
      ctx.beginPath();
      ctx.moveTo(t.px, t.py + y);
      ctx.lineTo(t.px + t.pw, t.py + y);
      ctx.stroke();
    }

    const wcx = t.px + t.pw * 0.5;
    const wcy = t.py + t.ph * 0.6;

    for (let i = -3; i <= 3; i++) {
      const ang = -Math.PI * 0.5 + i * 0.25;
      const dist = 76;
      const px = wcx + Math.cos(ang) * dist;
      const py = wcy + Math.sin(ang) * dist;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang + Math.PI * 0.5);
      ctx.fillStyle = i % 2 === 0 ? '#f3bf38' : '#e09f24';
      ctx.beginPath();
      ctx.ellipse(0, 0, 7, 16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (const side of [-1, 1] as const) {
      ctx.strokeStyle = '#f2bc36';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(wcx + side * 70, wcy + 26);
      ctx.bezierCurveTo(
        wcx + side * 120,
        wcy + 24,
        wcx + side * 142,
        wcy - 18,
        wcx + side * 108,
        wcy - 34,
      );
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(wcx + side * 95, wcy + 26);
      ctx.bezierCurveTo(
        wcx + side * 145,
        wcy + 42,
        wcx + side * 170,
        wcy + 12,
        wcx + side * 150,
        wcy - 4,
      );
      ctx.stroke();

      ctx.fillStyle = '#c43427';
      ctx.beginPath();
      ctx.arc(wcx + side * 116, wcy - 6, 8, 0, Math.PI * 2);
      ctx.arc(wcx + side * 148, wcy + 26, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#3a7553';
      ctx.beginPath();
      ctx.ellipse(wcx + side * 134, wcy + 10, 10, 5, side * -0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 8. doorPlanks (512, 512, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.doorPlanks;
    ctx.fillStyle = '#995c2d';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    for (let i = 0; i < 4; i++) {
      const px = t.px + i * 64;
      ctx.fillStyle = i % 2 === 0 ? '#9c5f30' : '#8e5429';
      ctx.fillRect(px, t.py, 64, t.ph);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(px, t.py);
      ctx.lineTo(px, t.py + t.ph);
      ctx.stroke();

      ctx.strokeStyle = '#6d3e1c';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(px + 22, t.py + 20);
      ctx.lineTo(px + 20, t.py + t.ph - 20);
      ctx.moveTo(px + 44, t.py + 35);
      ctx.lineTo(px + 46, t.py + t.ph - 18);
      ctx.stroke();
    }

    ctx.strokeStyle = ink;
    ctx.lineWidth = 8;
    ctx.strokeRect(t.px + 4, t.py + 4, t.pw - 8, t.ph - 8);

    ctx.fillStyle = '#f6df98';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(t.px + t.pw * 0.82, t.py + t.ph * 0.54, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // 9. greenShutter (768, 512, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.greenShutter;
    ctx.fillStyle = '#366b4c';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#244b35';
    ctx.lineWidth = 4;
    for (const frac of [0.34, 0.66]) {
      const gx = t.px + t.pw * frac;
      ctx.beginPath();
      ctx.moveTo(gx, t.py + 12);
      ctx.lineTo(gx, t.py + t.ph - 12);
      ctx.stroke();
    }

    ctx.strokeStyle = '#183324';
    ctx.lineWidth = 10;
    ctx.strokeRect(t.px + 5, t.py + 5, t.pw - 10, t.ph - 10);

    drawHeart(ctx, t.px + t.pw * 0.5, t.py + t.ph * 0.42, 42, '#f2c144', '#1d3c2b');
  }

  // 10. shedPlanks (0, 768, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.shedPlanks;
    ctx.fillStyle = '#8b5127';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    for (let i = 0; i < 5; i++) {
      const px = t.px + i * (t.pw / 5);
      ctx.fillStyle = i % 2 === 0 ? '#8c5328' : '#7d4821';
      ctx.fillRect(px, t.py, t.pw / 5, t.ph);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(px, t.py);
      ctx.lineTo(px, t.py + t.ph);
      ctx.stroke();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6;
    ctx.strokeRect(t.px + 3, t.py + 3, t.pw - 6, t.ph - 6);
  }

  // 11. chimneyStone (256, 768, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.chimneyStone;
    ctx.fillStyle = '#5c4e4a';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const rows = 4;
    const rowH = t.ph / rows;
    ctx.strokeStyle = '#2d2320';
    ctx.lineWidth = 5;
    for (let r = 0; r < rows; r++) {
      const ry = t.py + r * rowH;
      const offset = r % 2 === 0 ? 0 : 64;
      const blocks = ['#685854', '#584945', '#73625d', '#50423f'];
      for (let c = -1; c < 3; c++) {
        const bx = t.px + c * 128 + offset;
        ctx.fillStyle = blocks[(r + c + 4) % blocks.length]!;
        drawRoundedRectPath(ctx, bx + 4, ry + 4, 120, rowH - 8, 6);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // 12. roundFrameBeads (512, 768, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.roundFrameBeads;
    ctx.fillStyle = '#4c2612';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.5;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, 118, 0, Math.PI * 2);
    ctx.stroke();

    const beadCount = 16;
    const beadR = 98;
    for (let i = 0; i < beadCount; i++) {
      const ang = (i / beadCount) * Math.PI * 2;
      ctx.fillStyle = i % 2 === 0 ? '#ebb434' : '#c93428';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * beadR, cy + Math.sin(ang) * beadR, 7.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 13. snowShadow (768, 768, 256, 256)
  {
    const t = FOLK_CABIN_ATLAS_TILES.snowShadow;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#eef5fb');
    grad.addColorStop(0.55, '#d5e4f0');
    grad.addColorStop(1, '#bdd2e4');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#aac1d6';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(t.px + 24, t.py + 120);
    ctx.quadraticCurveTo(t.px + 128, t.py + 96, t.px + 232, t.py + 126);
    ctx.stroke();
  }

  ctx.restore();
}

export interface FolkCabinMaterials {
  readonly cabinAtlasTexture: THREE.Texture;
  readonly cabinToonMaterial: THREE.MeshToonMaterial;
  readonly cabinSmokeTexture: THREE.Texture;
  readonly cabinSmokeMaterial: THREE.MeshBasicMaterial;
}

/**
 * Creates and caches the folk-art log cabin atlas texture, shared smoke texture,
 * and toon/smoke materials wired to `SharedLightingUniforms`.
 */
export function createFolkCabinMaterials(
  gfx: GraphicsUtils,
  gradientMap: THREE.DataTexture,
  sharedUniforms: SharedLightingUniforms,
): FolkCabinMaterials {
  const cabinAtlasTexture = createProceduralCanvasTexture(
    gfx,
    FOLK_CABIN_ATLAS_SIZE,
    FOLK_CABIN_ATLAS_SIZE,
    drawFolkCabinAtlas,
    'FolkCabinAtlasTex',
    [200, 145, 72, 255],
  );
  const cabinToonMaterial = createTexturedToonMaterial(
    gfx,
    cabinAtlasTexture,
    gradientMap,
    sharedUniforms,
    'SharedFolkCabinToonMaterial',
  );
  const smoke = createChimneySmokeAssets(gfx, sharedUniforms);

  return {
    cabinAtlasTexture,
    cabinToonMaterial,
    cabinSmokeTexture: smoke.smokeTexture,
    cabinSmokeMaterial: smoke.smokeMaterial,
  };
}

/**
 * Builds a closed triangular prism spanning `z in [-halfDepth, +halfDepth]`,
 * `x in [-halfWidth, +halfWidth]` at `baseY`, rising to `(0, apexY)` with outward CCW normals.
 */
function buildGablePedimentPrismGeometry(
  halfWidth: number,
  baseY: number,
  apexY: number,
  halfDepth: number,
): THREE.BufferGeometry {
  const fL: [number, number, number] = [-halfWidth, baseY, halfDepth];
  const fR: [number, number, number] = [halfWidth, baseY, halfDepth];
  const fT: [number, number, number] = [0, apexY, halfDepth];
  const bL: [number, number, number] = [-halfWidth, baseY, -halfDepth];
  const bR: [number, number, number] = [halfWidth, baseY, -halfDepth];
  const bT: [number, number, number] = [0, apexY, -halfDepth];

  const pos: number[] = [];
  const uv: number[] = [];
  const geo = new THREE.BufferGeometry();

  const pushTri = (
    a: [number, number, number],
    ua: [number, number],
    b: [number, number, number],
    ub: [number, number],
    c: [number, number, number],
    uc: [number, number],
  ): void => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };

  pushTri(fL, [0, 0], fR, [1, 0], fT, [0.5, 1]);
  pushTri(bR, [0, 0], bL, [1, 0], bT, [0.5, 1]);
  geo.addGroup(0, 6, 0);

  pushTri(fL, [0, 0], fT, [1, 1], bT, [1, 0]);
  pushTri(fL, [0, 0], bT, [1, 0], bL, [0, 1]);

  pushTri(fR, [0, 0], bT, [1, 0], fT, [1, 1]);
  pushTri(fR, [0, 0], bR, [0, 1], bT, [1, 0]);

  pushTri(fL, [0, 0], bL, [0, 1], bR, [1, 1]);
  pushTri(fL, [0, 0], bR, [1, 1], fR, [1, 0]);
  geo.addGroup(6, 18, 1);

  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

export interface FolkCabinGeometries {
  readonly cabinGeo: THREE.BufferGeometry;
  readonly cabinGlowGeo: THREE.BufferGeometry;
  readonly cabinSmokeGeo: THREE.BufferGeometry;
}

/**
 * Builds the sculpted 3D Folk Log Cabin geometry (`cabinGeo`), glowing 4-pane window &
 * dark muntin geometry (`cabinGlowGeo`), and unit smoke quad (`cabinSmokeGeo`).
 */
export function buildFolkCabinGeometries(): FolkCabinGeometries {
  const parts: TexturedGeometryPart<FolkCabinTileName>[] = [];
  const glowParts: ColoredGeometryPart[] = [];

  // 1. Snow foundation skirt (dips to y = -1.16m so cabin stays grounded on steep ski slopes) + base snowdrifts
  parts.push(
    {
      geometry: new THREE.BoxGeometry(4.86, 1.24, 5.56),
      tile: 'snowShadow',
      groupTiles: { 2: 'snowPlain' },
      ty: -0.54,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowShadow',
      tx: -2.42,
      ty: 0.02,
      tz: -0.25,
      sx: 0.85,
      sy: 0.42,
      sz: 3.1,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowShadow',
      tx: 2.42,
      ty: 0.02,
      tz: -0.25,
      sx: 0.85,
      sy: 0.42,
      sz: 3.1,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowShadow',
      tx: 0,
      ty: -0.02,
      tz: -3.28,
      sx: 2.85,
      sy: 0.44,
      sz: 1.0,
    },
    {
      geometry: new THREE.SphereGeometry(1, 9, 6),
      tile: 'snowPlain',
      tx: -1.82,
      ty: 0.06,
      tz: 2.84,
      sx: 0.82,
      sy: 0.34,
      sz: 0.65,
    },
    {
      geometry: new THREE.SphereGeometry(1, 9, 6),
      tile: 'snowPlain',
      tx: 1.82,
      ty: 0.06,
      tz: 2.84,
      sx: 0.82,
      sy: 0.34,
      sz: 0.65,
    },
  );

  // 2. Opaque inner timber core
  parts.push({
    geometry: new THREE.BoxGeometry(4.36, 2.52, 5.16),
    tile: 'darkTrim',
    ty: 1.26,
  });

  // 3. Interlocking 6-course log walls with pale spiral-grain protruding corner log ends
  const logRadius = 0.225;
  const logStepY = 0.4;
  const logGroupTiles: Readonly<Record<number, FolkCabinTileName | TileMappingSpec<FolkCabinTileName>>> = {
    0: { tile: 'logBark', swapUV: true },
    1: 'logEnd',
    2: 'logEnd',
  };

  for (let k = 0; k < 6; k++) {
    const sideY = 0.2 + k * logStepY;
    for (const sx of [-2.22, 2.22]) {
      parts.push({
        geometry: new THREE.CylinderGeometry(logRadius, logRadius, 6.16, 10, 1, false),
        tile: 'logBark',
        groupTiles: logGroupTiles,
        tx: sx,
        ty: sideY,
        tz: 0,
        rx: Math.PI * 0.5,
      });
    }

    const endY = 0.4 + k * logStepY;
    for (const sz of [-2.62, 2.62]) {
      parts.push({
        geometry: new THREE.CylinderGeometry(logRadius, logRadius, 5.36, 10, 1, false),
        tile: 'logBark',
        groupTiles: logGroupTiles,
        tx: 0,
        ty: endY,
        tz: sz,
        rz: Math.PI * 0.5,
      });
    }
  }

  // 4. Front door (+Z) with 3D recessed jambs, snow lintel cap, plank door, doorknob & 4-pane window
  parts.push(
    {
      geometry: new THREE.BoxGeometry(0.18, 2.08, 0.32),
      tile: 'darkTrim',
      tx: -0.64,
      ty: 1.04,
      tz: 2.78,
    },
    {
      geometry: new THREE.BoxGeometry(0.18, 2.08, 0.32),
      tile: 'darkTrim',
      tx: 0.64,
      ty: 1.04,
      tz: 2.78,
    },
    {
      geometry: new THREE.BoxGeometry(1.5, 0.2, 0.34),
      tile: 'darkTrim',
      tx: 0,
      ty: 2.04,
      tz: 2.79,
    },
    {
      geometry: new THREE.BoxGeometry(1.54, 0.09, 0.36),
      tile: 'snowPlain',
      tx: 0,
      ty: 2.18,
      tz: 2.8,
    },
    {
      geometry: new THREE.BoxGeometry(1.12, 1.94, 0.16),
      tile: 'doorPlanks',
      tx: 0,
      ty: 0.97,
      tz: 2.81,
    },
  );

  glowParts.push(
    {
      geometry: new THREE.BoxGeometry(0.56, 0.56, 0.04),
      color: '#3b1d0c',
      tx: 0,
      ty: 1.46,
      tz: 2.89,
    },
    {
      geometry: new THREE.BoxGeometry(0.46, 0.46, 0.04),
      color: '#ffe066',
      tx: 0,
      ty: 1.46,
      tz: 2.91,
    },
    {
      geometry: new THREE.BoxGeometry(0.48, 0.055, 0.05),
      color: '#3b1d0c',
      tx: 0,
      ty: 1.46,
      tz: 2.925,
    },
    {
      geometry: new THREE.BoxGeometry(0.055, 0.48, 0.05),
      color: '#3b1d0c',
      tx: 0,
      ty: 1.46,
      tz: 2.925,
    },
  );

  // 5. Side 4-pane windows with forest-green heart shutters on BOTH -X and +X walls
  for (const sideSign of [-1, 1] as const) {
    const wx = sideSign * 2.34;
    const wz = 0.25;
    parts.push(
      {
        geometry: new THREE.BoxGeometry(0.28, 1.08, 1.14),
        tile: 'darkTrim',
        tx: wx,
        ty: 1.24,
        tz: wz,
      },
      {
        geometry: new THREE.BoxGeometry(0.38, 0.11, 1.32),
        tile: 'darkTrim',
        tx: sideSign * 2.38,
        ty: 0.68,
        tz: wz,
      },
      {
        geometry: new THREE.BoxGeometry(0.1, 0.96, 0.44),
        tile: 'greenShutter',
        tx: sideSign * 2.47,
        ty: 1.24,
        tz: wz - 0.81,
        ry: sideSign * -0.14,
      },
      {
        geometry: new THREE.BoxGeometry(0.1, 0.96, 0.44),
        tile: 'greenShutter',
        tx: sideSign * 2.47,
        ty: 1.24,
        tz: wz + 0.81,
        ry: sideSign * 0.14,
      },
    );

    glowParts.push(
      {
        geometry: new THREE.BoxGeometry(0.04, 0.96, 1.0),
        color: '#3b1d0c',
        tx: sideSign * 2.475,
        ty: 1.25,
        tz: wz,
      },
      {
        geometry: new THREE.BoxGeometry(0.04, 0.84, 0.88),
        color: '#ffe066',
        tx: sideSign * 2.495,
        ty: 1.25,
        tz: wz,
      },
      {
        geometry: new THREE.BoxGeometry(0.055, 0.065, 0.9),
        color: '#3b1d0c',
        tx: sideSign * 2.51,
        ty: 1.25,
        tz: wz,
      },
      {
        geometry: new THREE.BoxGeometry(0.055, 0.86, 0.065),
        color: '#3b1d0c',
        tx: sideSign * 2.51,
        ty: 1.25,
        tz: wz,
      },
    );
  }

  // 6. Horizontal decorated frieze beams, snow frieze ledges, gable pediments & beaded round attic windows
  parts.push({
    geometry: buildGablePedimentPrismGeometry(2.42, 2.82, 4.98, 2.78),
    tile: 'gablePediment',
    groupTiles: {
      0: 'gablePediment',
      1: 'darkTrim',
    },
  });

  const roundFrameGroupTiles: Readonly<Record<number, FolkCabinTileName | TileMappingSpec<FolkCabinTileName>>> = {
    0: 'darkTrim',
    1: 'roundFrameBeads',
    2: 'roundFrameBeads',
  };

  for (const endSign of [-1, 1] as const) {
    parts.push(
      {
        geometry: new THREE.BoxGeometry(4.92, 0.34, 0.32),
        tile: 'folkTrim',
        tx: 0,
        ty: 2.68,
        tz: endSign * 2.74,
      },
      {
        geometry: new THREE.BoxGeometry(4.96, 0.1, 0.38),
        tile: 'snowPlain',
        tx: 0,
        ty: 2.89,
        tz: endSign * 2.75,
      },
      {
        geometry: new THREE.CylinderGeometry(0.58, 0.58, 0.14, 20),
        tile: 'roundFrameBeads',
        groupTiles: roundFrameGroupTiles,
        tx: 0,
        ty: 3.68,
        tz: endSign * 2.78,
        rx: Math.PI * 0.5,
      },
    );

    glowParts.push(
      {
        geometry: new THREE.CylinderGeometry(0.41, 0.41, 0.05, 16),
        color: '#ffe066',
        tx: 0,
        ty: 3.68,
        tz: endSign * 2.845,
        rx: Math.PI * 0.5,
      },
      {
        geometry: new THREE.BoxGeometry(0.84, 0.06, 0.07),
        color: '#3b1d0c',
        tx: 0,
        ty: 3.68,
        tz: endSign * 2.86,
      },
      {
        geometry: new THREE.BoxGeometry(0.06, 0.84, 0.07),
        color: '#3b1d0c',
        tx: 0,
        ty: 3.68,
        tz: endSign * 2.86,
      },
    );
  }

  // 7. Steep snowy folk-art gable roof, ornate mitered bargeboards, ridge & eave snow rolls
  const roofEaveX = 3.02;
  const roofEaveY = 2.48;
  const roofRidgeY = 5.2;
  const roofDx = roofEaveX;
  const roofDy = roofRidgeY - roofEaveY;
  const roofAngle = Math.atan2(roofDy, roofDx);
  const roofSlopeLen = Math.hypot(roofDx, roofDy);
  const sinA = Math.sin(roofAngle);
  const cosA = Math.cos(roofAngle);

  const leftSlopeGroupTiles: Readonly<Record<number, FolkCabinTileName | TileMappingSpec<FolkCabinTileName>>> = {
    0: 'snowPlain',
    1: 'snowPlain',
    2: { tile: 'roofSnowFolk', swapUV: true },
    3: 'snowShadow',
    4: 'snowPlain',
    5: 'snowPlain',
  };
  const rightSlopeGroupTiles: Readonly<Record<number, FolkCabinTileName | TileMappingSpec<FolkCabinTileName>>> = {
    0: 'snowPlain',
    1: 'snowPlain',
    2: { tile: 'roofSnowFolk', swapUV: true, flipV: true },
    3: 'snowShadow',
    4: 'snowPlain',
    5: 'snowPlain',
  };

  for (const slopeSign of [-1, 1] as const) {
    const midX = slopeSign * (roofEaveX * 0.5);
    const midY = (roofRidgeY + roofEaveY) * 0.5;
    const normX = slopeSign * sinA;
    const normY = cosA;
    const rz = slopeSign < 0 ? roofAngle : -roofAngle;

    parts.push({
      geometry: new THREE.BoxGeometry(roofSlopeLen + 0.14, 0.18, 6.46),
      tile: 'darkTrim',
      tx: midX,
      ty: midY,
      tz: 0,
      rz,
    });

    for (const endSign of [-1, 1] as const) {
      parts.push({
        geometry: new THREE.BoxGeometry(roofSlopeLen + 0.18, 0.28, 0.22),
        tile: 'folkTrim',
        tx: midX + normX * 0.02,
        ty: midY + normY * 0.02,
        tz: endSign * 3.12,
        rz,
      });
    }

    parts.push({
      geometry: new THREE.BoxGeometry(roofSlopeLen + 0.18, 0.24, 6.54),
      tile: 'snowPlain',
      groupTiles: slopeSign < 0 ? leftSlopeGroupTiles : rightSlopeGroupTiles,
      tx: midX + normX * 0.2,
      ty: midY + normY * 0.2,
      tz: 0,
      rz,
    });

    parts.push({
      geometry: new THREE.CylinderGeometry(0.17, 0.17, 6.58, 10, 1, false),
      tile: 'snowPlain',
      tx: slopeSign * (roofEaveX + 0.06),
      ty: roofEaveY + 0.1,
      tz: 0,
      rx: Math.PI * 0.5,
    });

    for (const endSign of [-1, 1] as const) {
      parts.push({
        geometry: new THREE.CylinderGeometry(0.14, 0.14, roofSlopeLen + 0.26, 8, 1, false),
        tile: 'snowPlain',
        tx: midX + normX * 0.26,
        ty: midY + normY * 0.26,
        tz: endSign * 3.19,
        rz: rz + Math.PI * 0.5,
      });
    }
  }

  parts.push({
    geometry: new THREE.CylinderGeometry(0.25, 0.25, 6.62, 10, 1, false),
    tile: 'snowPlain',
    tx: 0,
    ty: roofRidgeY + 0.18,
    tz: 0,
    rx: Math.PI * 0.5,
  });

  // 8. Symmetric rear lean-to woodshed (-Z face)
  parts.push(
    {
      geometry: new THREE.BoxGeometry(5.16, 1.38, 1.18),
      tile: 'shedPlanks',
      tx: 0,
      ty: 0.69,
      tz: -3.18,
    },
    {
      geometry: new THREE.BoxGeometry(5.32, 0.14, 1.36),
      tile: 'darkTrim',
      tx: 0,
      ty: 1.44,
      tz: -3.22,
      rx: -0.36,
    },
    {
      geometry: new THREE.BoxGeometry(5.38, 0.16, 1.4),
      tile: 'snowPlain',
      tx: 0,
      ty: 1.54,
      tz: -3.23,
      rx: -0.36,
    },
  );

  // 9. Crooked masonry chimney on -X roof slope with flared crown, dark flue & snow collar
  const chimneyEuler = new THREE.Euler(CHIMNEY_TILT.rx, CHIMNEY_TILT.ry, CHIMNEY_TILT.rz, 'YXZ');
  const addChimneyPart = (
    geometry: THREE.BufferGeometry,
    tile: FolkCabinTileName,
    localY: number,
    localX = 0,
    localZ = 0,
  ): void => {
    const offset = new THREE.Vector3(localX, localY, localZ).applyEuler(chimneyEuler);
    parts.push({
      geometry,
      tile,
      tx: CHIMNEY_BASE_POS.x + offset.x,
      ty: CHIMNEY_BASE_POS.y + offset.y,
      tz: CHIMNEY_BASE_POS.z + offset.z,
      rx: CHIMNEY_TILT.rx,
      ry: CHIMNEY_TILT.ry,
      rz: CHIMNEY_TILT.rz,
    });
  };

  parts.push({
    geometry: new THREE.SphereGeometry(0.54, 9, 6),
    tile: 'snowShadow',
    tx: -1.36,
    ty: 4.18,
    tz: -0.75,
    sx: 1.1,
    sy: 0.45,
    sz: 1.1,
  });

  addChimneyPart(new THREE.BoxGeometry(0.62, 0.92, 0.62), 'chimneyStone', 0.46, 0, 0);
  addChimneyPart(new THREE.BoxGeometry(0.56, 0.64, 0.56), 'chimneyStone', 1.12, -0.02, 0.01);
  addChimneyPart(new THREE.BoxGeometry(0.74, 0.24, 0.74), 'chimneyStone', 1.54, -0.01, 0);
  addChimneyPart(new THREE.BoxGeometry(0.46, 0.08, 0.46), 'darkTrim', 1.65, -0.01, 0);

  const cabinGeo = buildMergedTexturedGeometry(parts, FOLK_CABIN_ATLAS_TILES, 'DeliveryCabinGeo', true);
  const cabinGlowGeo = buildMergedColoredGeometry(glowParts, 'DeliveryCabinGlowGeo', false);
  const cabinSmokeGeo = buildChimneySmokeQuadGeometry('DeliveryCabinSmokeGeo');

  return {
    cabinGeo,
    cabinGlowGeo,
    cabinSmokeGeo,
  };
}

/**
 * Registers the Folk Log Cabin landmark archetype (`proc:cabin:folk_log`) with its own
 * cached geometry, atlas material, optional outline hull, and chimney smoke anchor.
 */
export function createFolkCabinLandmarkDef(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  outlineMaterial?: THREE.Material,
): LandmarkModelDef {
  const { cabinGeo, cabinGlowGeo } = buildFolkCabinGeometries();
  gfx.markAsCache(cabinGeo, cabinGeo.name);
  gfx.markAsCache(cabinGlowGeo, cabinGlowGeo.name);

  const atlasTex = createProceduralCanvasTexture(
    gfx,
    FOLK_CABIN_ATLAS_SIZE,
    FOLK_CABIN_ATLAS_SIZE,
    drawFolkCabinAtlas,
    'FolkCabinAtlasTex',
    [200, 145, 72, 255],
  );
  const cabinMat = createTexturedToonMaterial(
    gfx,
    atlasTex,
    materials.gradientMap,
    materials.sharedUniforms,
    'FolkCabinToonMaterial',
  );

  return {
    id: 'proc:cabin:folk_log',
    poolCapacity: 8,
    yawPolicy: 'faceTrail',
    smokeAnchors: [FOLK_CABIN_SMOKE_ANCHOR],
    createInstance: (index) => {
      const group = new THREE.Group();
      group.name = `PooledDeliveryCabin_${index}`;
      const cabinMesh = gfx.createMesh(cabinGeo, cabinMat, `DeliveryCabin_${index}`);
      cabinMesh.castShadow = true;
      if (outlineMaterial) {
        const outlineMesh = gfx.createMesh(
          cabinGeo,
          outlineMaterial,
          `DeliveryCabinOutline_${index}`,
        );
        outlineMesh.castShadow = false;
        group.add(outlineMesh);
      }
      const glowMesh = gfx.createMesh(
        cabinGlowGeo,
        materials.beaconGlowMaterial,
        `DeliveryCabinGlow_${index}`,
      );
      glowMesh.castShadow = false;
      group.add(cabinMesh, glowMesh);
      gfx.markAsCache(group, group.name);
      return { group };
    },
  };
}
