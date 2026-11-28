import * as THREE from 'three';
import { DEFAULT_RAMP, RAMP_GENTLE, RAMP_STEEP } from '../../../content/hazards';
import type { GraphicsUtils } from '../graphicsUtils';
import { createTexturedToonMaterial, type SharedToonMaterials } from '../toonMaterials';
import {
  type AtlasTileRect,
  buildMergedTexturedGeometry,
  buildTaperedPostGeometry,
  createProceduralCanvasTexture,
  makeAtlasTile,
  type TexturedGeometryPart,
  type TileMappingSpec,
} from './proceduralModelUtils';

export const SKI_RAMP_ATLAS_SIZE = 1024;
export const SKI_RAMP_DEFAULT_WIDTH = DEFAULT_RAMP.width;
export const SKI_RAMP_DEFAULT_HEIGHT = DEFAULT_RAMP.height;
export const SKI_RAMP_DEFAULT_LENGTH = DEFAULT_RAMP.length;
export const SKI_RAMP_POST_BASE_Y = -0.55;
export const SKI_RAMP_LIP_LENGTH_M = 0.97;

export type SkiRampVariant = 'gentle' | 'standard' | 'steep';

export interface SkiRampDimensions {
  readonly width: number;
  readonly height: number;
  readonly length: number;
}

export const SKI_RAMP_VARIANT_DIMS: Readonly<Record<SkiRampVariant, SkiRampDimensions>> = {
  gentle: { width: RAMP_GENTLE.width, height: RAMP_GENTLE.height, length: RAMP_GENTLE.length },
  standard: { width: DEFAULT_RAMP.width, height: DEFAULT_RAMP.height, length: DEFAULT_RAMP.length },
  steep: { width: RAMP_STEEP.width, height: RAMP_STEEP.height, length: RAMP_STEEP.length },
};

/**
 * Resolves a ramp definition ID (`ski_ramp_gentle`, `ski_ramp_standard`, `ski_ramp_steep`)
 * to its canonical 3D mesh variant (`'standard'` fallback for custom/unknown IDs).
 */
export function resolveSkiRampVariant(defId: string): SkiRampVariant {
  if (defId === RAMP_GENTLE.id) return 'gentle';
  if (defId === RAMP_STEEP.id) return 'steep';
  return 'standard';
}

/**
 * Evaluates the linear riding deck elevation (meters) at local `z` (`+length/2` entry at `y = 0`
 * rising linearly to `-length/2` takeoff lip at `y = height`), matching the Jolt ConvexHull collider.
 */
export function evaluateSkiRampDeckY(
  z: number,
  height = SKI_RAMP_DEFAULT_HEIGHT,
  length = SKI_RAMP_DEFAULT_LENGTH,
): number {
  const halfLen = length * 0.5;
  return height * ((halfLen - z) / Math.max(1e-4, length));
}

export type SkiRampTileName =
  | 'snowDeck'
  | 'woodRail'
  | 'orangeGrate'
  | 'shrubFoliage'
  | 'woodPost'
  | 'woodEnd'
  | 'woodUnderside'
  | 'shrubSnow'
  | 'cyanGlow';

export type SkiRampAtlasTile = AtlasTileRect;

export const SKI_RAMP_ATLAS_TILES: Readonly<Record<SkiRampTileName, SkiRampAtlasTile>> = {
  // Row 0 (y: 0..256)
  snowDeck: makeAtlasTile(0, 0, 512, 256, SKI_RAMP_ATLAS_SIZE, 4),
  woodRail: makeAtlasTile(512, 0, 512, 256, SKI_RAMP_ATLAS_SIZE, 4),
  // Row 1 (y: 256..512)
  orangeGrate: makeAtlasTile(0, 256, 512, 256, SKI_RAMP_ATLAS_SIZE, 4),
  shrubFoliage: makeAtlasTile(512, 256, 512, 256, SKI_RAMP_ATLAS_SIZE, 4),
  // Row 2 (y: 512..768)
  woodPost: makeAtlasTile(0, 512, 256, 256, SKI_RAMP_ATLAS_SIZE, 4),
  woodEnd: makeAtlasTile(256, 512, 256, 256, SKI_RAMP_ATLAS_SIZE, 4),
  woodUnderside: makeAtlasTile(512, 512, 256, 256, SKI_RAMP_ATLAS_SIZE, 4),
  shrubSnow: makeAtlasTile(768, 512, 256, 256, SKI_RAMP_ATLAS_SIZE, 4),
  // Row 3 (y: 768..1024)
  cyanGlow: makeAtlasTile(0, 768, 512, 256, SKI_RAMP_ATLAS_SIZE, 4),
};

/**
 * Paints the complete 1024x1024 procedural ski ramp CanvasTexture atlas:
 * packed snow deck, weathered timber rails/trestle, ribbed orange takeoff pad,
 * snow-dusted evergreen shrubs, and luminous ice-cyan glow strips.
 */
export function drawSkiRampAtlas(ctx: CanvasRenderingContext2D): void {
  const ink = '#2d251e';
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. snowDeck (0, 0, 512, 256) - bright alpine snow with subtle side rail AO & warm/cool seam bounce
  // Note: CanvasTexture uses flipY = true, so canvas top (t.py) maps to UV v = 1 (orange lip seam)
  // and canvas bottom (t.py + t.ph) maps to UV v = 0 (cyan entry threshold).
  {
    const t = SKI_RAMP_ATLAS_TILES.snowDeck;
    const baseGrad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    baseGrad.addColorStop(0, '#f7f6f4');
    baseGrad.addColorStop(0.14, '#f4f8fc');
    baseGrad.addColorStop(0.5, '#f0f5fa');
    baseGrad.addColorStop(0.88, '#e8f3fa');
    baseGrad.addColorStop(1, '#dcf4fc');
    ctx.fillStyle = baseGrad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Subtle orange bounce warmth at upper lip edge (v -> 1, canvas top)
    const lipGlow = ctx.createLinearGradient(t.px, t.py, t.px, t.py + 34);
    lipGlow.addColorStop(0, 'rgba(255, 130, 48, 0.24)');
    lipGlow.addColorStop(1, 'rgba(255, 130, 48, 0)');
    ctx.fillStyle = lipGlow;
    ctx.fillRect(t.px, t.py, t.pw, 34);

    // Subtle cool cyan bounce tint at entry threshold (v -> 0, canvas bottom)
    const entryGlow = ctx.createLinearGradient(t.px, t.py + t.ph - 36, t.px, t.py + t.ph);
    entryGlow.addColorStop(0, 'rgba(64, 232, 255, 0)');
    entryGlow.addColorStop(1, 'rgba(64, 232, 255, 0.28)');
    ctx.fillStyle = entryGlow;
    ctx.fillRect(t.px, t.py + t.ph - 36, t.pw, 36);

    // Left & right cool shadow vignette tucked beside timber side rails
    const leftAo = ctx.createLinearGradient(t.px, t.py, t.px + 54, t.py);
    leftAo.addColorStop(0, 'rgba(130, 156, 184, 0.34)');
    leftAo.addColorStop(1, 'rgba(130, 156, 184, 0)');
    ctx.fillStyle = leftAo;
    ctx.fillRect(t.px, t.py, 54, t.ph);

    const rightAo = ctx.createLinearGradient(t.px + t.pw - 54, t.py, t.px + t.pw, t.py);
    rightAo.addColorStop(0, 'rgba(130, 156, 184, 0)');
    rightAo.addColorStop(1, 'rgba(130, 156, 184, 0.34)');
    ctx.fillStyle = rightAo;
    ctx.fillRect(t.px + t.pw - 54, t.py, 54, t.ph);

    // Faint lengthwise groomed snow ski tracks
    ctx.strokeStyle = 'rgba(194, 214, 232, 0.45)';
    ctx.lineWidth = 3;
    for (const xOff of [146, 168, 256, 344, 366]) {
      ctx.beginPath();
      ctx.moveTo(t.px + xOff, t.py + 12);
      ctx.quadraticCurveTo(t.px + xOff + 4, t.py + t.ph * 0.5, t.px + xOff - 2, t.py + t.ph - 12);
      ctx.stroke();
    }
  }

  // 2. woodRail (512, 0, 512, 256) - weathered grey-brown rustic driftwood timber along U
  {
    const t = SKI_RAMP_ATLAS_TILES.woodRail;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#5b4e42');
    grad.addColorStop(0.24, '#7f6f5d');
    grad.addColorStop(0.54, '#94826e');
    grad.addColorStop(0.84, '#6d5e4f');
    grad.addColorStop(1, '#483d33');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Weathered silver-tan highlight grain streaks
    ctx.strokeStyle = '#a89986';
    ctx.lineWidth = 2.4;
    for (const [yOff, bow] of [
      [48, -5],
      [118, 6],
      [194, -4],
    ] as const) {
      const y = t.py + yOff;
      ctx.beginPath();
      ctx.moveTo(t.px, y);
      ctx.bezierCurveTo(t.px + 150, y + bow, t.px + 340, y - bow, t.px + t.pw, y);
      ctx.stroke();
    }

    // Dark hand-drawn bark fissures & weathered grain lines
    ctx.strokeStyle = '#3d332a';
    ctx.lineWidth = 2.8;
    for (const [yOff, bow] of [
      [26, 7],
      [74, -6],
      [104, 5],
      [148, -7],
      [178, 6],
      [226, -5],
    ] as const) {
      const y = t.py + yOff;
      ctx.beginPath();
      ctx.moveTo(t.px, y);
      ctx.bezierCurveTo(t.px + 160, y + bow, t.px + 340, y - bow, t.px + t.pw, y);
      ctx.stroke();
    }

    // Check splits & twin oval timber knots
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.6;
    for (const [kx, ky, rx, ry] of [
      [144, 92, 22, 8],
      [368, 166, 26, 9],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(t.px + kx, t.py + ky, rx, ry, 0.05, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(t.px + 24, t.py + 132);
    ctx.lineTo(t.px + 116, t.py + 136);
    ctx.moveTo(t.px + 392, t.py + 58);
    ctx.lineTo(t.px + 488, t.py + 54);
    ctx.stroke();
  }

  // 3. orangeGrate (0, 256, 512, 256) - glowing fiery orange takeoff pad with diagonal traction ribs
  {
    const t = SKI_RAMP_ATLAS_TILES.orangeGrate;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#ff8826');
    grad.addColorStop(0.5, '#ff5c08');
    grad.addColorStop(1, '#f24700');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Clip diagonal ribs inside the border rim
    ctx.save();
    ctx.beginPath();
    ctx.rect(t.px + 10, t.py + 10, t.pw - 20, t.ph - 20);
    ctx.clip();

    const ribCount = 26;
    const pitch = (t.pw + t.ph) / ribCount;
    for (let i = -2; i <= ribCount + 2; i++) {
      const sx = t.px + i * pitch;
      // Deep orange-red groove trough
      ctx.strokeStyle = '#bf2d00';
      ctx.lineWidth = 7.5;
      ctx.beginPath();
      ctx.moveTo(sx, t.py);
      ctx.lineTo(sx - t.ph * 0.78, t.py + t.ph);
      ctx.stroke();

      // Bright glowing hot-orange traction crest beside each trough
      ctx.strokeStyle = '#ffac42';
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      ctx.moveTo(sx + 5, t.py);
      ctx.lineTo(sx + 5 - t.ph * 0.78, t.py + t.ph);
      ctx.stroke();
    }
    ctx.restore();

    // Glowing golden-orange outer bevel rim
    ctx.strokeStyle = '#ffd978';
    ctx.lineWidth = 10;
    ctx.strokeRect(t.px + 5, t.py + 5, t.pw - 10, t.ph - 10);
    ctx.strokeStyle = '#ff982e';
    ctx.lineWidth = 4;
    ctx.strokeRect(t.px + 11, t.py + 11, t.pw - 22, t.ph - 22);
  }

  // 4. shrubFoliage (512, 256, 512, 256) - dense alpine spruce/olive foliage dusted with snow flecks
  {
    const t = SKI_RAMP_ATLAS_TILES.shrubFoliage;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#384c32');
    grad.addColorStop(0.5, '#253924');
    grad.addColorStop(1, '#1a2a1a');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Warm autumn/olive foliage undertone blotches
    for (let i = 0; i < 18; i++) {
      const bx = t.px + ((i * 89 + 37) % (t.pw - 40)) + 20;
      const by = t.py + ((i * 53 + 29) % (t.ph - 40)) + 20;
      ctx.fillStyle = i % 2 === 0 ? '#4d4d2c' : '#56432a';
      ctx.beginPath();
      ctx.arc(bx, by, 22 + (i % 3) * 8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Crisp evergreen needle sprays & woody twigs
    for (let i = 0; i < 42; i++) {
      const cx = t.px + ((i * 73 + 23) % (t.pw - 32)) + 16;
      const cy = t.py + ((i * 61 + 19) % (t.ph - 32)) + 16;
      ctx.strokeStyle = i % 3 === 0 ? '#182b18' : i % 3 === 1 ? '#2f4b2b' : '#4a5a34';
      ctx.lineWidth = 3.2;
      for (let k = -2; k <= 2; k++) {
        const ang = -Math.PI * 0.5 + k * 0.44 + (i % 5) * 0.12;
        ctx.beginPath();
        ctx.moveTo(cx, cy + 8);
        ctx.lineTo(cx + Math.cos(ang) * 20, cy + Math.sin(ang) * 20);
        ctx.stroke();
      }
    }

    // Frosted snow dusting flecks across upper needles
    for (let i = 0; i < 36; i++) {
      const fx = t.px + ((i * 97 + 41) % (t.pw - 24)) + 12;
      const fy = t.py + ((i * 47 + 17) % (t.ph - 36)) + 12;
      ctx.fillStyle = i % 2 === 0 ? '#eef6fc' : '#c6daea';
      ctx.beginPath();
      ctx.ellipse(fx, fy, 7 + (i % 4) * 2, 4 + (i % 3), (i % 5) * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 5. woodPost (0, 512, 256, 256) - matching weathered vertical timber grain along V
  {
    const t = SKI_RAMP_ATLAS_TILES.woodPost;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px + t.pw, t.py);
    grad.addColorStop(0, '#56493e');
    grad.addColorStop(0.25, '#7c6c5b');
    grad.addColorStop(0.55, '#917f6c');
    grad.addColorStop(0.84, '#6a5b4c');
    grad.addColorStop(1, '#473c32');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#3c3229';
    ctx.lineWidth = 2.8;
    for (const [xOff, bow] of [
      [34, 6],
      [82, -5],
      [130, 7],
      [178, -6],
      [220, 5],
    ] as const) {
      const x = t.px + xOff;
      ctx.beginPath();
      ctx.moveTo(x, t.py);
      ctx.bezierCurveTo(x + bow, t.py + 86, x - bow, t.py + 170, x, t.py + t.ph);
      ctx.stroke();
    }

    ctx.strokeStyle = '#a49481';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(t.px + 106, t.py + 12);
    ctx.lineTo(t.px + 102, t.py + t.ph - 12);
    ctx.stroke();

    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(t.px + 154, t.py + 132, 8, 18, 0.04, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 6. woodEnd (256, 512, 256, 256) - saw-cut weathered timber end-grain
  {
    const t = SKI_RAMP_ATLAS_TILES.woodEnd;
    ctx.fillStyle = '#4c4034';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.5;

    ctx.fillStyle = '#8b7965';
    ctx.beginPath();
    ctx.arc(cx, cy, 118, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#b4a38d';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, 102, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#736250';
    ctx.lineWidth = 4.2;
    for (const r of [24, 48, 72, 90]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = ink;
    ctx.lineWidth = 4.5;
    for (const [ang, r0, r1] of [
      [-0.45, 16, 98],
      [2.15, 22, 96],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }
  }

  // 7. woodUnderside (512, 512, 256, 256) - shaded weathered under-deck plank soffit
  {
    const t = SKI_RAMP_ATLAS_TILES.woodUnderside;
    ctx.fillStyle = '#4f4338';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    for (let i = 0; i < 4; i++) {
      const px = t.px + i * 64;
      ctx.fillStyle = i % 2 === 0 ? '#584b3e' : '#493e33';
      ctx.fillRect(px, t.py, 64, t.ph);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(px, t.py);
      ctx.lineTo(px, t.py + t.ph);
      ctx.stroke();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 5;
    ctx.strokeRect(t.px + 2.5, t.py + 2.5, t.pw - 5, t.ph - 5);
  }

  // 8. shrubSnow (768, 512, 256, 256) - crisp alpine snow for shrub snow caps & entry apron
  {
    const t = SKI_RAMP_ATLAS_TILES.shrubSnow;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#f7fbff');
    grad.addColorStop(0.6, '#e5f0fa');
    grad.addColorStop(1, '#c5d9ea');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#b4cbe0';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(t.px + 28, t.py + 124);
    ctx.quadraticCurveTo(t.px + 128, t.py + 102, t.px + 228, t.py + 128);
    ctx.stroke();
  }

  // 9. cyanGlow (0, 768, 512, 256) - luminous ice-cyan threshold & shrub accent glow
  {
    const t = SKI_RAMP_ATLAS_TILES.cyanGlow;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#10bcd4');
    grad.addColorStop(0.25, '#6cf7ff');
    grad.addColorStop(0.5, '#e8ffff');
    grad.addColorStop(0.75, '#6cf7ff');
    grad.addColorStop(1, '#10bcd4');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Subtle crisp inner light core streak
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(t.px + 16, t.py + t.ph * 0.5);
    ctx.lineTo(t.px + t.pw - 16, t.py + t.ph * 0.5);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Builds a closed non-indexed linear ramp prism spanning `x in [xMin, xMax]` and
 * `z in [zFar, zNear]` (`zNear > zFar`), with strictly outward CCW faces and groups:
 * `0` top, `1` bottom, `2` `+Z` near cap, `3` `-Z` far cap, `4` `-X` left side, `5` `+X` right side.
 */
function buildLinearRampPrismGeometry(
  xMin: number,
  xMax: number,
  zNear: number,
  yBotNear: number,
  yTopNear: number,
  zFar: number,
  yBotFar: number,
  yTopFar: number,
): THREE.BufferGeometry {
  const nBL: readonly [number, number, number] = [xMin, yBotNear, zNear];
  const nBR: readonly [number, number, number] = [xMax, yBotNear, zNear];
  const nTR: readonly [number, number, number] = [xMax, yTopNear, zNear];
  const nTL: readonly [number, number, number] = [xMin, yTopNear, zNear];

  const fBL: readonly [number, number, number] = [xMin, yBotFar, zFar];
  const fBR: readonly [number, number, number] = [xMax, yBotFar, zFar];
  const fTR: readonly [number, number, number] = [xMax, yTopFar, zFar];
  const fTL: readonly [number, number, number] = [xMin, yTopFar, zFar];

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushTri = (
    a: readonly [number, number, number],
    ua: readonly [number, number],
    b: readonly [number, number, number],
    ub: readonly [number, number],
    c: readonly [number, number, number],
    uc: readonly [number, number],
  ): void => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };

  const pushQuad = (
    a: readonly [number, number, number],
    ua: readonly [number, number],
    b: readonly [number, number, number],
    ub: readonly [number, number],
    c: readonly [number, number, number],
    uc: readonly [number, number],
    d: readonly [number, number, number],
    ud: readonly [number, number],
  ): void => {
    pushTri(a, ua, b, ub, c, uc);
    pushTri(a, ua, c, uc, d, ud);
  };

  // Group 0: Top sloped surface (v=0 near +Z, v=1 far -Z)
  pushQuad(nTL, [0, 0], nTR, [1, 0], fTR, [1, 1], fTL, [0, 1]);
  // Group 1: Bottom underside
  pushQuad(fBL, [0, 1], fBR, [1, 1], nBR, [1, 0], nBL, [0, 0]);
  // Group 2: +Z near cap
  pushQuad(nBL, [0, 0], nBR, [1, 0], nTR, [1, 1], nTL, [0, 1]);
  // Group 3: -Z far cap
  pushQuad(fBR, [0, 0], fBL, [1, 0], fTL, [1, 1], fTR, [0, 1]);
  // Group 4: -X left side
  pushQuad(fBL, [1, 0], nBL, [0, 0], nTL, [0, 1], fTL, [1, 1]);
  // Group 5: +X right side
  pushQuad(nBR, [0, 0], fBR, [1, 0], fTR, [1, 1], nTR, [0, 1]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  for (let g = 0; g < 6; g++) {
    geo.addGroup(g * 6, 6, g);
  }
  return geo;
}

/**
 * Builds a closed chamfered 8-sided sloped timber rail spanning `z in [zFar, zNear]`
 * with outward CCW winding, horizontal grain along `U` (`group 0`), and `woodEnd` end caps (`group 1`).
 */
function buildChamferedSlopedRailGeometry(
  centerX: number,
  halfW: number,
  zNear: number,
  yBotNear: number,
  yTopNear: number,
  zFar: number,
  yBotFar: number,
  yTopFar: number,
  chamfer: number,
): THREE.BufferGeometry {
  const xL = centerX - halfW;
  const xR = centerX + halfW;
  const c = Math.min(chamfer, halfW * 0.45, (yTopNear - yBotNear) * 0.35, (yTopFar - yBotFar) * 0.35);

  const makeRing = (z: number, yBot: number, yTop: number): Array<readonly [number, number, number]> => [
    [xL + c, yBot, z],
    [xR - c, yBot, z],
    [xR, yBot + c, z],
    [xR, yTop - c, z],
    [xR - c, yTop, z],
    [xL + c, yTop, z],
    [xL, yTop - c, z],
    [xL, yBot + c, z],
  ];

  const nearRing = makeRing(zNear, yBotNear, yTopNear);
  const farRing = makeRing(zFar, yBotFar, yTopFar);
  const ringCount = nearRing.length;

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushTri = (
    a: readonly [number, number, number],
    ua: readonly [number, number],
    b: readonly [number, number, number],
    ub: readonly [number, number],
    cPt: readonly [number, number, number],
    uc: readonly [number, number],
  ): void => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], cPt[0], cPt[1], cPt[2]);
    uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };

  // Group 0: 8 longitudinal faces (48 vertices), grain along U
  for (let k = 0; k < ringCount; k++) {
    const nextK = (k + 1) % ringCount;
    const v0 = k / ringCount;
    const v1 = (k + 1) / ringCount;
    const f0 = farRing[k]!;
    const f1 = farRing[nextK]!;
    const n1 = nearRing[nextK]!;
    const n0 = nearRing[k]!;
    pushTri(f0, [1, v0], f1, [1, v1], n1, [0, v1]);
    pushTri(f0, [1, v0], n1, [0, v1], n0, [0, v0]);
  }

  // Group 1: +Z near cap & -Z far cap (48 vertices)
  const capStartVert = positions.length / 3;
  const nearCenter: readonly [number, number, number] = [centerX, (yBotNear + yTopNear) * 0.5, zNear];
  const farCenter: readonly [number, number, number] = [centerX, (yBotFar + yTopFar) * 0.5, zFar];
  const ringUv = (pt: readonly [number, number, number], yBot: number, yTop: number): readonly [number, number] => [
    (pt[0] - xL) / (halfW * 2),
    (pt[1] - yBot) / Math.max(1e-4, yTop - yBot),
  ];

  for (let k = 0; k < ringCount; k++) {
    const nextK = (k + 1) % ringCount;
    const p0 = nearRing[k]!;
    const p1 = nearRing[nextK]!;
    pushTri(nearCenter, [0.5, 0.5], p0, ringUv(p0, yBotNear, yTopNear), p1, ringUv(p1, yBotNear, yTopNear));
  }
  for (let k = 0; k < ringCount; k++) {
    const nextK = (k + 1) % ringCount;
    const p0 = farRing[k]!;
    const p1 = farRing[nextK]!;
    pushTri(farCenter, [0.5, 0.5], p1, ringUv(p1, yBotFar, yTopFar), p0, ringUv(p0, yBotFar, yTopFar));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.addGroup(0, capStartVert, 0);
  geo.addGroup(capStartVert, positions.length / 3 - capStartVert, 1);
  return geo;
}

/**
 * Builds a closed 6-face rectangular timber beam spanning from `A` to `B` with exact
 * outward CCW winding, longitudinal grain running along `U` (`group 0`), and end caps (`group 1`).
 */
function buildOrientedBeamGeometry(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  width: number,
  depth: number,
): THREE.BufferGeometry {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.max(1e-4, Math.hypot(dx, dy, dz));
  const axX = dx / len;
  const axY = dy / len;
  const axZ = dz / len;

  // Pick a stable reference vector not collinear with axis
  const refX = 0;
  const refY = Math.abs(axY) < 0.95 ? 1 : 0;
  const refZ = Math.abs(axY) < 0.95 ? 0 : 1;

  // u = normalize(cross(ref, axis))
  let ux = refY * axZ - refZ * axY;
  let uy = refZ * axX - refX * axZ;
  let uz = refX * axY - refY * axX;
  const uLen = Math.max(1e-4, Math.hypot(ux, uy, uz));
  ux /= uLen;
  uy /= uLen;
  uz /= uLen;

  // v = cross(axis, u) -> {u, v, axis} forms a right-handed orthonormal frame (u x v = +axis)
  const vx = axY * uz - axZ * uy;
  const vy = axZ * ux - axX * uz;
  const vz = axX * uy - axY * ux;

  const hu = width * 0.5;
  const hv = depth * 0.5;

  const corner = (ox: number, oy: number, oz: number, su: number, sv: number): readonly [number, number, number] => [
    ox + su * hu * ux + sv * hv * vx,
    oy + su * hu * uy + sv * hv * vy,
    oz + su * hu * uz + sv * hv * vz,
  ];

  const a0 = corner(ax, ay, az, -1, -1);
  const a1 = corner(ax, ay, az, 1, -1);
  const a2 = corner(ax, ay, az, 1, 1);
  const a3 = corner(ax, ay, az, -1, 1);

  const b0 = corner(bx, by, bz, -1, -1);
  const b1 = corner(bx, by, bz, 1, -1);
  const b2 = corner(bx, by, bz, 1, 1);
  const b3 = corner(bx, by, bz, -1, 1);

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushTri = (
    p0: readonly [number, number, number],
    uv0: readonly [number, number],
    p1: readonly [number, number, number],
    uv1: readonly [number, number],
    p2: readonly [number, number, number],
    uv2: readonly [number, number],
  ): void => {
    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
  };

  const pushQuad = (
    p0: readonly [number, number, number],
    uv0: readonly [number, number],
    p1: readonly [number, number, number],
    uv1: readonly [number, number],
    p2: readonly [number, number, number],
    uv2: readonly [number, number],
    p3: readonly [number, number, number],
    uv3: readonly [number, number],
  ): void => {
    pushTri(p0, uv0, p1, uv1, p2, uv2);
    pushTri(p0, uv0, p2, uv2, p3, uv3);
  };

  // Group 0: 4 side faces (24 verts), grain running along U from A -> B
  pushQuad(a3, [0, 0], b3, [1, 0], b2, [1, 1], a2, [0, 1]); // +v
  pushQuad(a0, [0, 0], a1, [0, 1], b1, [1, 1], b0, [1, 0]); // -v
  pushQuad(a1, [0, 0], a2, [0, 1], b2, [1, 1], b1, [1, 0]); // +u
  pushQuad(a0, [0, 0], b0, [1, 0], b3, [1, 1], a3, [0, 1]); // -u

  // Group 1: 2 end caps (12 verts)
  pushQuad(b0, [0, 0], b1, [1, 0], b2, [1, 1], b3, [0, 1]); // +axis at B
  pushQuad(a0, [0, 0], a3, [0, 1], a2, [1, 1], a1, [1, 0]); // -axis at A

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.addGroup(0, 24, 0);
  geo.addGroup(24, 12, 1);
  return geo;
}

const DECK_GROUP_TILES: Readonly<Record<number, SkiRampTileName | TileMappingSpec<SkiRampTileName>>> = {
  0: 'snowDeck',
  1: 'woodUnderside',
  2: 'woodUnderside',
  3: 'woodUnderside',
  4: 'woodUnderside',
  5: 'woodUnderside',
};

const LIP_BACKING_GROUP_TILES: Readonly<Record<number, SkiRampTileName | TileMappingSpec<SkiRampTileName>>> = {
  0: 'woodUnderside',
  1: 'woodUnderside',
  2: 'woodUnderside',
  3: 'woodRail',
  4: 'woodUnderside',
  5: 'woodUnderside',
};

const RAIL_GROUP_TILES: Readonly<Record<number, SkiRampTileName | TileMappingSpec<SkiRampTileName>>> = {
  0: 'woodRail',
  1: 'woodEnd',
};

const POST_GROUP_TILES: Readonly<Record<number, SkiRampTileName | TileMappingSpec<SkiRampTileName>>> = {
  0: 'woodPost',
  1: 'woodEnd',
};

const BEAM_GROUP_TILES: Readonly<Record<number, SkiRampTileName | TileMappingSpec<SkiRampTileName>>> = {
  0: 'woodRail',
  1: 'woodEnd',
};

export interface SkiRampShrubMoundSpec {
  readonly xOff: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly ry: number;
}

interface ShrubFrondSpec {
  readonly xOff: number;
  readonly y: number;
  readonly z: number;
  readonly rBot: number;
  readonly len: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
}

interface ShrubSnowSpec {
  readonly xOff: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}

interface CyanLightSpec {
  readonly xOff: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
}

export const SKI_RAMP_LEFT_SHRUB_MOUNDS: readonly SkiRampShrubMoundSpec[] = [
  { xOff: 0.36, y: 0.08, z: 2.38, r: 0.28, sx: 1.15, sy: 0.72, sz: 1.35, ry: 0.2 },
  { xOff: 0.44, y: 0.1, z: 1.52, r: 0.34, sx: 1.25, sy: 0.78, sz: 1.3, ry: -0.3 },
  { xOff: 0.38, y: 0.09, z: 0.56, r: 0.3, sx: 1.12, sy: 0.68, sz: 1.28, ry: 0.45 },
  { xOff: 0.48, y: 0.11, z: -0.46, r: 0.35, sx: 1.22, sy: 0.76, sz: 1.32, ry: -0.15 },
  { xOff: 0.4, y: 0.09, z: -1.58, r: 0.32, sx: 1.18, sy: 0.72, sz: 1.25, ry: 0.35 },
  { xOff: 0.36, y: 0.07, z: -2.56, r: 0.27, sx: 1.08, sy: 0.65, sz: 1.18, ry: -0.4 },
];

export const SKI_RAMP_RIGHT_SHRUB_MOUNDS: readonly SkiRampShrubMoundSpec[] = [
  { xOff: 0.42, y: 0.09, z: 2.52, r: 0.3, sx: 1.2, sy: 0.74, sz: 1.32, ry: -0.25 },
  { xOff: 0.38, y: 0.1, z: 1.68, r: 0.33, sx: 1.16, sy: 0.75, sz: 1.28, ry: 0.3 },
  { xOff: 0.48, y: 0.12, z: 0.72, r: 0.36, sx: 1.28, sy: 0.8, sz: 1.35, ry: -0.18 },
  { xOff: 0.42, y: 0.1, z: -0.34, r: 0.32, sx: 1.18, sy: 0.7, sz: 1.24, ry: 0.4 },
  { xOff: 0.46, y: 0.11, z: -1.36, r: 0.34, sx: 1.22, sy: 0.74, sz: 1.3, ry: -0.35 },
  { xOff: 0.38, y: 0.08, z: -2.42, r: 0.28, sx: 1.1, sy: 0.66, sz: 1.2, ry: 0.22 },
];

const SHRUB_FRONDS: readonly ShrubFrondSpec[] = [
  { xOff: 0.32, y: 0.22, z: 2.68, rBot: 0.16, len: 0.46, rx: 0.38, ry: 0.2, rz: 0.48 },
  { xOff: 0.48, y: 0.24, z: 2.18, rBot: 0.18, len: 0.52, rx: -0.22, ry: -0.3, rz: 0.66 },
  { xOff: 0.36, y: 0.26, z: 1.78, rBot: 0.19, len: 0.56, rx: 0.26, ry: 0.4, rz: 0.44 },
  { xOff: 0.54, y: 0.22, z: 1.24, rBot: 0.17, len: 0.5, rx: -0.32, ry: 0.15, rz: 0.72 },
  { xOff: 0.38, y: 0.25, z: 0.84, rBot: 0.18, len: 0.54, rx: 0.18, ry: -0.35, rz: 0.52 },
  { xOff: 0.52, y: 0.24, z: 0.28, rBot: 0.2, len: 0.58, rx: -0.24, ry: 0.28, rz: 0.64 },
  { xOff: 0.4, y: 0.26, z: -0.18, rBot: 0.18, len: 0.52, rx: 0.3, ry: -0.2, rz: 0.46 },
  { xOff: 0.56, y: 0.23, z: -0.74, rBot: 0.19, len: 0.56, rx: -0.2, ry: 0.36, rz: 0.68 },
  { xOff: 0.42, y: 0.25, z: -1.24, rBot: 0.17, len: 0.5, rx: 0.28, ry: -0.25, rz: 0.5 },
  { xOff: 0.5, y: 0.22, z: -1.82, rBot: 0.18, len: 0.52, rx: -0.28, ry: 0.22, rz: 0.64 },
  { xOff: 0.36, y: 0.24, z: -2.26, rBot: 0.16, len: 0.46, rx: 0.24, ry: -0.32, rz: 0.48 },
  { xOff: 0.44, y: 0.2, z: -2.76, rBot: 0.15, len: 0.44, rx: -0.34, ry: 0.18, rz: 0.6 },
];

const SHRUB_SNOW_PUFFS: readonly ShrubSnowSpec[] = [
  { xOff: 0.38, y: 0.26, z: 2.36, r: 0.15, sx: 1.25, sy: 0.42, sz: 1.35 },
  { xOff: 0.46, y: 0.3, z: 1.44, r: 0.17, sx: 1.3, sy: 0.44, sz: 1.3 },
  { xOff: 0.42, y: 0.28, z: 0.48, r: 0.16, sx: 1.2, sy: 0.42, sz: 1.25 },
  { xOff: 0.48, y: 0.3, z: -0.56, r: 0.17, sx: 1.28, sy: 0.44, sz: 1.32 },
  { xOff: 0.4, y: 0.26, z: -1.68, r: 0.15, sx: 1.22, sy: 0.42, sz: 1.22 },
];

const SHRUB_CYAN_LIGHTS: readonly CyanLightSpec[] = [
  { xOff: 0.52, y: 0.2, z: 1.96, r: 0.095 },
  { xOff: 0.48, y: 0.18, z: 1.18, r: 0.09 },
  { xOff: 0.42, y: 0.17, z: 0.06, r: 0.085 },
  { xOff: 0.5, y: 0.19, z: -1.04, r: 0.09 },
  { xOff: 0.38, y: 0.16, z: -2.14, r: 0.08 },
];

export interface SkiRampGeometries {
  readonly bodyGeo: THREE.BufferGeometry;
  readonly glowGeo: THREE.BufferGeometry;
}

function resolveDims(dims?: Partial<SkiRampDimensions>): SkiRampDimensions {
  const w = dims?.width;
  const h = dims?.height;
  const l = dims?.length;
  return {
    width: w !== undefined && Number.isFinite(w) && w > 0.5 ? w : SKI_RAMP_DEFAULT_WIDTH,
    height: h !== undefined && Number.isFinite(h) && h > 0.35 ? h : SKI_RAMP_DEFAULT_HEIGHT,
    length: l !== undefined && Number.isFinite(l) && l > 1.5 ? l : SKI_RAMP_DEFAULT_LENGTH,
  };
}

/**
 * Builds procedural 3D ski ramp geometries in exact physics dimensions (`width x height x length`):
 * `bodyGeo` (snow deck, rustic timber side rails, open wooden trestle, snow-dusted base shrubs
 * with `aSmoothNormal`) and `glowGeo` (unlit ribbed orange takeoff lip pad, cyan entry threshold bar,
 * and shrub-base cyan accent lights).
 */
export function buildSkiRampGeometries(
  dims?: Partial<SkiRampDimensions>,
  labelPrefix = 'SkiRamp',
): SkiRampGeometries {
  const bodyParts: TexturedGeometryPart<SkiRampTileName>[] = [];
  const glowParts: TexturedGeometryPart<SkiRampTileName>[] = [];

  const { width, height, length } = resolveDims(dims);
  const hw = width * 0.5;
  const hl = length * 0.5;
  const lipLen = Math.min(SKI_RAMP_LIP_LENGTH_M, length * 0.2);
  const lipJoinZ = -hl + lipLen;
  const deckHalfW = hw - 0.08; // tucks cleanly inside rails at |x| = hw - 0.115
  const deckSlabThickness = 0.22;
  const deckY = (z: number): number => evaluateSkiRampDeckY(z, height, length);

  // 1. Linear snow riding deck slab (z in [lipJoinZ, +hl], top matches evaluateSkiRampDeckY)
  bodyParts.push({
    geometry: buildLinearRampPrismGeometry(
      -deckHalfW,
      deckHalfW,
      hl,
      -deckSlabThickness,
      0,
      lipJoinZ,
      deckY(lipJoinZ) - deckSlabThickness,
      deckY(lipJoinZ),
    ),
    tile: 'snowDeck',
    groupTiles: DECK_GROUP_TILES,
  });

  // 2. Recessed lip sub-deck backing beneath the glowing orange takeoff pad (6mm clearance below pad)
  bodyParts.push({
    geometry: buildLinearRampPrismGeometry(
      -deckHalfW,
      deckHalfW,
      lipJoinZ,
      deckY(lipJoinZ) - deckSlabThickness,
      deckY(lipJoinZ) - 0.028,
      -hl,
      height - deckSlabThickness,
      height - 0.028,
    ),
    tile: 'woodUnderside',
    groupTiles: LIP_BACKING_GROUP_TILES,
  });

  // 3. Grounded snow lead-in apron ahead of cyan bar (6mm clear of cyan bar at z = hl + 0.105)
  bodyParts.push({
    geometry: buildLinearRampPrismGeometry(
      -deckHalfW,
      deckHalfW,
      hl + 0.43,
      -0.32,
      -0.18,
      hl + 0.111,
      -0.22,
      -0.02,
    ),
    tile: 'shrubSnow',
  });

  // 4. Left & right rustic weathered timber side rails + open wooden trestle support frame
  const railCenterX = hw + 0.03;
  const railHalfW = 0.145;
  const railNearZ = hl + 0.11;
  const railFarZ = -hl - 0.07;
  const postX = hw - 0.04;
  const rearPostZ = -hl + 0.23;
  const midPostZ = -hl + length * 0.312;
  const frontPostZ = -hl + length * 0.589;

  const rearPostTopY = deckY(rearPostZ) - 0.1;
  const midPostTopY = deckY(midPostZ) - 0.11;
  const frontPostTopY = deckY(frontPostZ) - 0.105;
  const sideMidRailY = Math.max(0.32, midPostTopY * 0.74);
  const rearHeaderY = rearPostTopY - 0.12;
  const rearLowerTieY = Math.max(0.18, rearHeaderY * 0.32);
  const midHeaderY = midPostTopY - 0.12;
  const rampSlopeAngle = Math.atan2(height, length);

  for (const side of [-1, 1] as const) {
    // Chamfered rustic timber rail
    bodyParts.push({
      geometry: buildChamferedSlopedRailGeometry(
        side * railCenterX,
        railHalfW,
        railNearZ,
        -0.2,
        0.075,
        railFarZ,
        height - 0.19,
        height + 0.11,
        0.045,
      ),
      tile: 'woodRail',
      groupTiles: RAIL_GROUP_TILES,
    });

    const px = side * postX;

    // Three tapered vertical trestle posts grounded to y = -0.55m
    bodyParts.push(
      {
        geometry: buildTaperedPostGeometry(0.24, 0.24, 0.21, 0.21, SKI_RAMP_POST_BASE_Y, rearPostTopY),
        tile: 'woodPost',
        groupTiles: POST_GROUP_TILES,
        tx: px,
        tz: rearPostZ,
      },
      {
        geometry: buildTaperedPostGeometry(0.22, 0.22, 0.19, 0.19, SKI_RAMP_POST_BASE_Y, midPostTopY),
        tile: 'woodPost',
        groupTiles: POST_GROUP_TILES,
        tx: px,
        tz: midPostZ,
      },
      {
        geometry: buildTaperedPostGeometry(0.2, 0.2, 0.18, 0.18, SKI_RAMP_POST_BASE_Y, frontPostTopY),
        tile: 'woodPost',
        groupTiles: POST_GROUP_TILES,
        tx: px,
        tz: frontPostZ,
      },
    );

    // Side longitudinal tie beams & staggered diagonal X-braces (0.032m lateral offset prevents Z-fighting)
    const sideXTopY = Math.min(midPostTopY - 0.12, sideMidRailY + 0.08);
    const frontBraceTopY = Math.max(0.28, midPostTopY - 0.22);
    bodyParts.push(
      {
        geometry: buildOrientedBeamGeometry(px, sideMidRailY, rearPostZ, px, sideMidRailY, midPostZ, 0.14, 0.14),
        tile: 'woodRail',
        groupTiles: BEAM_GROUP_TILES,
      },
      {
        geometry: buildOrientedBeamGeometry(px, 0.08, rearPostZ, px, 0.08, frontPostZ, 0.15, 0.14),
        tile: 'woodRail',
        groupTiles: BEAM_GROUP_TILES,
      },
      {
        geometry: buildOrientedBeamGeometry(
          px + side * 0.016,
          0.1,
          rearPostZ,
          px + side * 0.016,
          sideXTopY,
          midPostZ,
          0.11,
          0.11,
        ),
        tile: 'woodRail',
        groupTiles: BEAM_GROUP_TILES,
      },
      {
        geometry: buildOrientedBeamGeometry(
          px - side * 0.016,
          sideMidRailY,
          rearPostZ,
          px - side * 0.016,
          0.1,
          midPostZ,
          0.11,
          0.11,
        ),
        tile: 'woodRail',
        groupTiles: BEAM_GROUP_TILES,
      },
      {
        geometry: buildOrientedBeamGeometry(
          px,
          frontBraceTopY,
          midPostZ,
          px,
          0.1,
          frontPostZ - 0.04,
          0.1,
          0.1,
        ),
        tile: 'woodRail',
        groupTiles: BEAM_GROUP_TILES,
      },
      // Timber corbel block strengthening the rear post-to-rail carpentry joint
      {
        geometry: new THREE.BoxGeometry(0.24, 0.22, 0.28),
        tile: 'woodRail',
        tx: side * (hw - 0.01),
        ty: rearPostTopY - 0.1,
        tz: rearPostZ - 0.06,
        rx: rampSlopeAngle,
      },
    );

    if (height >= 1.85) {
      // Upper diagonal knee strut filling the tall open bay on steep big-air kickers
      bodyParts.push({
        geometry: buildOrientedBeamGeometry(
          px,
          sideMidRailY,
          midPostZ,
          px,
          rearPostTopY - 0.22,
          rearPostZ,
          0.12,
          0.12,
        ),
        tile: 'woodRail',
        groupTiles: BEAM_GROUP_TILES,
      });
    }
  }

  // 5. Transverse structural crossbeams, rear X-bracing (staggered in Z), and under-deck stringers
  const xBraceEdgeX = postX - 0.04;
  const stringerX = hw * 0.42;
  const stringerStartZ = hl - length * 0.29;
  const stringerStartY = deckY(stringerStartZ) - 0.175;
  bodyParts.push(
    {
      geometry: buildOrientedBeamGeometry(-postX, rearHeaderY, rearPostZ, postX, rearHeaderY, rearPostZ, 0.16, 0.18),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    },
    {
      geometry: buildOrientedBeamGeometry(-postX, rearLowerTieY, rearPostZ, postX, rearLowerTieY, rearPostZ, 0.14, 0.14),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    },
    {
      geometry: buildOrientedBeamGeometry(
        -xBraceEdgeX,
        rearLowerTieY + 0.02,
        rearPostZ - 0.018,
        xBraceEdgeX,
        rearHeaderY - 0.04,
        rearPostZ - 0.018,
        0.11,
        0.11,
      ),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    },
    {
      geometry: buildOrientedBeamGeometry(
        -xBraceEdgeX,
        rearHeaderY - 0.04,
        rearPostZ + 0.018,
        xBraceEdgeX,
        rearLowerTieY + 0.02,
        rearPostZ + 0.018,
        0.11,
        0.11,
      ),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    },
    {
      geometry: buildOrientedBeamGeometry(-postX, midHeaderY, midPostZ, postX, midHeaderY, midPostZ, 0.15, 0.16),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    },
    {
      geometry: buildOrientedBeamGeometry(
        -stringerX,
        stringerStartY,
        stringerStartZ,
        -stringerX,
        rearHeaderY - 0.04,
        rearPostZ,
        0.14,
        0.16,
      ),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    },
    {
      geometry: buildOrientedBeamGeometry(
        stringerX,
        stringerStartY,
        stringerStartZ,
        stringerX,
        rearHeaderY - 0.04,
        rearPostZ,
        0.14,
        0.16,
      ),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    },
  );
  if (rearLowerTieY > 0.45) {
    bodyParts.push({
      geometry: buildOrientedBeamGeometry(-postX, 0.14, rearPostZ, postX, 0.14, rearPostZ, 0.13, 0.13),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    });
  }
  if (midHeaderY - 0.12 > 0.22) {
    bodyParts.push({
      geometry: buildOrientedBeamGeometry(-postX, 0.12, midPostZ, postX, 0.12, midPostZ, 0.13, 0.13),
      tile: 'woodRail',
      groupTiles: BEAM_GROUP_TILES,
    });
  }

  // 6. Snow-dusted evergreen base shrubs flanking both outer rail edges
  // (grounded skirt descends to -0.45m so shrubs never hover on banked turns or mogul dips)
  const shrubAnchorX = hw + 0.16;
  const zScale = length / SKI_RAMP_DEFAULT_LENGTH;
  for (const side of [-1, 1] as const) {
    const skirtMinX = side < 0 ? -(shrubAnchorX + 0.52) : shrubAnchorX + 0.1;
    const skirtMaxX = side < 0 ? -(shrubAnchorX + 0.1) : shrubAnchorX + 0.52;
    bodyParts.push({
      geometry: buildLinearRampPrismGeometry(
        skirtMinX,
        skirtMaxX,
        2.72 * zScale,
        -0.45,
        0.02,
        -2.72 * zScale,
        -0.45,
        0.02,
      ),
      tile: 'shrubFoliage',
    });

    const mounds = side < 0 ? SKI_RAMP_LEFT_SHRUB_MOUNDS : SKI_RAMP_RIGHT_SHRUB_MOUNDS;
    for (const m of mounds) {
      bodyParts.push({
        geometry: new THREE.DodecahedronGeometry(m.r, 0),
        tile: 'shrubFoliage',
        tx: side * (shrubAnchorX + m.xOff),
        ty: m.y,
        tz: m.z * zScale,
        ry: side * m.ry,
        sx: m.sx,
        sy: m.sy,
        sz: m.sz,
      });
    }

    for (let i = 0; i < SHRUB_FRONDS.length; i++) {
      const f = SHRUB_FRONDS[i]!;
      const zShift = side > 0 ? 0.14 : 0;
      bodyParts.push({
        geometry: new THREE.CylinderGeometry(0.038, f.rBot, f.len, 5),
        tile: 'shrubFoliage',
        tx: side * (shrubAnchorX + f.xOff),
        ty: f.y,
        tz: f.z * zScale + zShift,
        rx: f.rx,
        ry: side * f.ry,
        rz: -side * f.rz,
        sz: 0.56,
      });
    }

    for (let i = 0; i < SHRUB_SNOW_PUFFS.length; i++) {
      const p = SHRUB_SNOW_PUFFS[i]!;
      const zShift = side > 0 ? 0.12 : 0;
      bodyParts.push({
        geometry: new THREE.IcosahedronGeometry(p.r, 0),
        tile: 'shrubSnow',
        tx: side * (shrubAnchorX + p.xOff),
        ty: p.y,
        tz: p.z * zScale + zShift,
        sx: p.sx,
        sy: p.sy,
        sz: p.sz,
      });
    }
  }

  // 7. Unlit self-illuminated glow accents: ribbed orange takeoff pad, cyan entry strip, shrub lights
  const glowHalfW = hw - 0.12; // 5mm clear of rail inner wall at |x| = hw - 0.115
  const lipNearZ = lipJoinZ - 0.004; // 4mm clear of snow deck
  const lipFarZ = -hl - 0.008;
  glowParts.push({
    geometry: buildLinearRampPrismGeometry(
      -glowHalfW,
      glowHalfW,
      lipNearZ,
      deckY(lipNearZ) - 0.022,
      deckY(lipNearZ) + 0.014,
      lipFarZ,
      deckY(lipFarZ) - 0.022,
      deckY(lipFarZ) + 0.014,
    ),
    tile: 'orangeGrate',
  });

  // Cyan entry threshold light bar tucked flush inside rail tips (hl + 0.11) and 6mm clear of deck & apron
  glowParts.push({
    geometry: buildLinearRampPrismGeometry(
      -glowHalfW,
      glowHalfW,
      hl + 0.105,
      -0.065,
      0.008,
      hl + 0.006,
      -0.055,
      0.018,
    ),
    tile: 'cyanGlow',
  });

  // Luminous cyan accent crystals nestled among the evergreen base shrubs
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < SHRUB_CYAN_LIGHTS.length; i++) {
      const l = SHRUB_CYAN_LIGHTS[i]!;
      const zShift = side > 0 ? 0.1 : 0;
      glowParts.push({
        geometry: new THREE.OctahedronGeometry(l.r, 0),
        tile: 'cyanGlow',
        tx: side * (shrubAnchorX + l.xOff),
        ty: l.y,
        tz: l.z * zScale + zShift,
        sx: 1.0,
        sy: 0.72,
        sz: 1.35,
      });
    }
  }

  const bodyGeo = buildMergedTexturedGeometry(
    bodyParts,
    SKI_RAMP_ATLAS_TILES,
    `${labelPrefix}BodyGeo`,
    true,
  );
  const glowGeo = buildMergedTexturedGeometry(
    glowParts,
    SKI_RAMP_ATLAS_TILES,
    `${labelPrefix}GlowGeo`,
    false,
  );

  return { bodyGeo, glowGeo };
}

export interface SkiRampAssets {
  readonly atlasTexture: THREE.Texture;
  readonly toonMaterial: THREE.MeshToonMaterial;
  readonly glowMaterial: THREE.MeshBasicMaterial;
  readonly bodyGeo: THREE.BufferGeometry;
  readonly glowGeo: THREE.BufferGeometry;
  readonly variants: Readonly<Record<SkiRampVariant, SkiRampGeometries>>;
}

/**
 * Builds, paints, and caches the shared CanvasTexture atlas, toon/glow materials, and
 * procedural geometries for all 3 incline presets (`gentle`, `standard`, `steep`) under `GraphicsUtils`.
 */
export function createSkiRampAssets(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
): SkiRampAssets {
  const gentle = buildSkiRampGeometries(SKI_RAMP_VARIANT_DIMS.gentle, 'SkiRampGentle');
  const standard = buildSkiRampGeometries(SKI_RAMP_VARIANT_DIMS.standard, 'SkiRamp');
  const steep = buildSkiRampGeometries(SKI_RAMP_VARIANT_DIMS.steep, 'SkiRampSteep');

  for (const geos of [gentle, standard, steep]) {
    gfx.markAsCache(geos.bodyGeo, geos.bodyGeo.name);
    gfx.markAsCache(geos.glowGeo, geos.glowGeo.name);
  }

  const atlasTexture = createProceduralCanvasTexture(
    gfx,
    SKI_RAMP_ATLAS_SIZE,
    SKI_RAMP_ATLAS_SIZE,
    drawSkiRampAtlas,
    'SkiRampAtlasTex',
    [195, 182, 165, 255],
  );
  const toonMaterial = createTexturedToonMaterial(
    gfx,
    atlasTexture,
    materials.gradientMap,
    materials.sharedUniforms,
    'SkiRampToonMaterial',
  );
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: atlasTexture,
    fog: true,
  });
  glowMaterial.name = 'SkiRampGlowMaterial';
  gfx.markAsCache(glowMaterial, 'SkiRampGlowMaterial');

  return {
    atlasTexture,
    toonMaterial,
    glowMaterial,
    bodyGeo: standard.bodyGeo,
    glowGeo: standard.glowGeo,
    variants: {
      gentle,
      standard,
      steep,
    },
  };
}
