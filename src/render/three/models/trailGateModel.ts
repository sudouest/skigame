import * as THREE from 'three';
import { getStageDef } from '../../../content/stages';
import { clamp } from '../../../core/math';
import type { GraphicsUtils } from '../graphicsUtils';
import type { LandmarkModelDef } from '../landmarkRegistry';
import { createTexturedToonMaterial, type SharedToonMaterials } from '../toonMaterials';
import {
  type AtlasTileRect,
  buildMergedTexturedGeometry,
  createProceduralCanvasTexture,
  makeAtlasTile,
  type TexturedGeometryPart,
  type TileMappingSpec,
} from './proceduralModelUtils';

export const TRAIL_GATE_ATLAS_SIZE = 1024;
export const TRAIL_GATE_DEFAULT_HALF_SPAN = 10.0;
export const TRAIL_GATE_MIN_HALF_SPAN = 6.2;
export const TRAIL_GATE_MAX_HALF_SPAN = 13.2;
export const TRAIL_GATE_BEAM_Y = 10.8;
export const TRAIL_GATE_LOG_RADIUS = 0.96;

export type TrailGateTileName =
  | 'logBark'
  | 'postTimber'
  | 'logEnd'
  | 'snowCap'
  | 'snowDrift'
  | 'braceWood'
  | 'signCircle'
  | 'signSquare'
  | 'signDiamond'
  | 'pineSprig'
  | 'signEdge';

export type TrailGateAtlasTile = AtlasTileRect;

export const TRAIL_GATE_ATLAS_TILES: Readonly<Record<TrailGateTileName, TrailGateAtlasTile>> = {
  // Row 0 (y: 0..256)
  logBark: makeAtlasTile(0, 0, 512, 256, TRAIL_GATE_ATLAS_SIZE),
  postTimber: makeAtlasTile(512, 0, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  logEnd: makeAtlasTile(768, 0, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  // Row 1 (y: 256..512)
  snowCap: makeAtlasTile(0, 256, 512, 256, TRAIL_GATE_ATLAS_SIZE),
  snowDrift: makeAtlasTile(512, 256, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  braceWood: makeAtlasTile(768, 256, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  // Row 2 (y: 512..768)
  signCircle: makeAtlasTile(0, 512, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  signSquare: makeAtlasTile(256, 512, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  signDiamond: makeAtlasTile(512, 512, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  pineSprig: makeAtlasTile(768, 512, 256, 256, TRAIL_GATE_ATLAS_SIZE),
  // Row 3 (y: 768..1024)
  signEdge: makeAtlasTile(0, 768, 256, 256, TRAIL_GATE_ATLAS_SIZE),
};

function drawSignPlaque(
  ctx: CanvasRenderingContext2D,
  t: AtlasTileRect,
  ink: string,
  shape: 'circle' | 'square' | 'diamond',
): void {
  const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
  grad.addColorStop(0, '#fcfaf3');
  grad.addColorStop(0.75, '#f6f1e4');
  grad.addColorStop(1, '#eae2cf');
  ctx.fillStyle = grad;
  ctx.fillRect(t.px, t.py, t.pw, t.ph);

  // Subtle hand-drawn dark plank border framing the signboard face
  ctx.strokeStyle = ink;
  ctx.lineWidth = 12;
  ctx.strokeRect(t.px + 7, t.py + 7, t.pw - 14, t.ph - 14);

  const cx = t.px + t.pw * 0.5;
  const cy = t.py + t.ph * 0.5;

  if (shape === 'circle') {
    ctx.fillStyle = '#1ca04a';
    ctx.strokeStyle = '#125e2c';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, t.pw * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'square') {
    const half = t.pw * 0.24;
    ctx.fillStyle = '#2466d6';
    ctx.strokeStyle = '#153d85';
    ctx.lineWidth = 6;
    ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
  } else {
    // Bold alpine black diamond matching concept art proportions
    const rx = t.pw * 0.22;
    const ry = t.ph * 0.32;
    ctx.fillStyle = '#15161b';
    ctx.beginPath();
    ctx.moveTo(cx, cy - ry);
    ctx.lineTo(cx + rx, cy);
    ctx.lineTo(cx, cy + ry);
    ctx.lineTo(cx - rx, cy);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Paints the complete 1024x1024 hand-illustrated folk trail gate texture atlas.
 */
export function drawTrailGateAtlas(ctx: CanvasRenderingContext2D): void {
  const ink = '#2f180b';
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. logBark (0, 0, 512, 256) - bright golden honey-amber round log grain along U
  {
    const t = TRAIL_GATE_ATLAS_TILES.logBark;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#9f5a14');
    grad.addColorStop(0.24, '#dd9630');
    grad.addColorStop(0.55, '#eda93e');
    grad.addColorStop(0.84, '#c37a20');
    grad.addColorStop(1, '#86470f');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#623510';
    ctx.lineWidth = 3;
    for (const [yOff, bow] of [
      [34, 8],
      [76, -6],
      [118, 7],
      [162, -7],
      [204, 6],
      [234, -5],
    ] as const) {
      const y = t.py + yOff;
      ctx.beginPath();
      ctx.moveTo(t.px, y);
      ctx.bezierCurveTo(t.px + 150, y + bow, t.px + 340, y - bow, t.px + t.pw, y);
      ctx.stroke();
    }

    // Timber check cracks & oval grain knots
    ctx.strokeStyle = '#4c260a';
    ctx.lineWidth = 2.6;
    for (const [kx, ky] of [
      [132, 92],
      [376, 172],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(t.px + kx, t.py + ky, 24, 9, 0.06, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(t.px + 28, t.py + 136);
    ctx.lineTo(t.px + 124, t.py + 141);
    ctx.moveTo(t.px + 412, t.py + 64);
    ctx.lineTo(t.px + 492, t.py + 60);
    ctx.stroke();
  }

  // 2. postTimber (512, 0, 256, 256) - bright golden-amber hand-hewn vertical post wood
  {
    const t = TRAIL_GATE_ATLAS_TILES.postTimber;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px + t.pw, t.py);
    grad.addColorStop(0, '#9a5614');
    grad.addColorStop(0.22, '#dd9530');
    grad.addColorStop(0.54, '#eba63c');
    grad.addColorStop(0.84, '#c57c22');
    grad.addColorStop(1, '#844610');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#5e320d';
    ctx.lineWidth = 2.8;
    for (const [xOff, bow] of [
      [36, 7],
      [82, -5],
      [128, 6],
      [176, -6],
      [218, 5],
    ] as const) {
      const x = t.px + xOff;
      ctx.beginPath();
      ctx.moveTo(x, t.py);
      ctx.bezierCurveTo(x + bow, t.py + 86, x - bow, t.py + 170, x, t.py + t.ph);
      ctx.stroke();
    }

    ctx.strokeStyle = '#472308';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(t.px + 98, t.py + 144, 9, 20, -0.05, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 3. logEnd (768, 0, 256, 256) - spiral concentric log end-grain with radial check cracks
  {
    const t = TRAIL_GATE_ATLAS_TILES.logEnd;
    ctx.fillStyle = '#5f3414';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.5;

    ctx.fillStyle = '#ab6822';
    ctx.beginPath();
    ctx.arc(cx, cy, 122, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#eccf94';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, 108, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#ce9f5e';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, 84, 0, Math.PI * 2);
    ctx.stroke();

    // Hand-drawn spiral growth rings
    ctx.strokeStyle = '#5e3415';
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

    // Radial season splits
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4.5;
    for (const [ang, r0, r1] of [
      [-0.45, 58, 107],
      [2.1, 66, 107],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }
  }

  // 4. snowCap (0, 256, 512, 256) - crisp cream roof snow with wavy blue-grey lower drip edge
  {
    const t = TRAIL_GATE_ATLAS_TILES.snowCap;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#fdfaf3');
    grad.addColorStop(0.74, '#f8f4ea');
    grad.addColorStop(0.9, '#d8e5ee');
    grad.addColorStop(1, '#bed0dd');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Wavy lower shadow scallop tucked cleanly along bottom drip eave
    ctx.fillStyle = '#cfdde7';
    ctx.beginPath();
    ctx.moveTo(t.px, t.py + t.ph);
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      const x = t.px + f * t.pw;
      const y = t.py + t.ph - 26 + Math.sin(f * Math.PI * 8) * 9;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(t.px + t.pw, t.py + t.ph);
    ctx.closePath();
    ctx.fill();

    // Subtle soft upper crest highlight lines
    ctx.strokeStyle = '#d8e5ee';
    ctx.lineWidth = 4.5;
    for (const [sx, sy, sw] of [
      [64, 68, 86],
      [268, 54, 112],
      [158, 134, 94],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(t.px + sx, t.py + sy);
      ctx.quadraticCurveTo(t.px + sx + sw * 0.5, t.py + sy - 10, t.px + sx + sw, t.py + sy + 2);
      ctx.stroke();
    }
  }

  // 5. snowDrift (512, 256, 256, 256) - creamy base snowbank fading into cool alpine edge shadow
  {
    const t = TRAIL_GATE_ATLAS_TILES.snowDrift;
    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.45;
    const rad = ctx.createRadialGradient(cx, cy, 18, cx, cy, 140);
    rad.addColorStop(0, '#fcf9f2');
    rad.addColorStop(0.68, '#f1ece0');
    rad.addColorStop(1, '#c3d3de');
    ctx.fillStyle = rad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#b9cbd8';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(t.px + 38, t.py + 96);
    ctx.quadraticCurveTo(t.px + 124, t.py + 80, t.px + 214, t.py + 98);
    ctx.moveTo(t.px + 54, t.py + 188);
    ctx.quadraticCurveTo(t.px + 132, t.py + 172, t.px + 206, t.py + 190);
    ctx.stroke();
  }

  // 6. braceWood (768, 256, 256, 256) - dark chestnut brace wood with hand-carved scroll linework
  {
    const t = TRAIL_GATE_ATLAS_TILES.braceWood;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#542a11');
    grad.addColorStop(0.5, '#7e4621');
    grad.addColorStop(1, '#4c250e');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#995c30';
    ctx.lineWidth = 5;
    for (let y = 32; y < t.ph; y += 48) {
      ctx.beginPath();
      ctx.moveTo(t.px, t.py + y);
      ctx.bezierCurveTo(t.px + 82, t.py + y - 8, t.px + 172, t.py + y + 8, t.px + t.pw, t.py + y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#331708';
    ctx.lineWidth = 3.5;
    ctx.strokeRect(t.px + 5, t.py + 5, t.pw - 10, t.ph - 10);
  }

  // 7-9. Trail Difficulty Signboards (512..768)
  drawSignPlaque(ctx, TRAIL_GATE_ATLAS_TILES.signCircle, ink, 'circle');
  drawSignPlaque(ctx, TRAIL_GATE_ATLAS_TILES.signSquare, ink, 'square');
  drawSignPlaque(ctx, TRAIL_GATE_ATLAS_TILES.signDiamond, ink, 'diamond');

  // 10. pineSprig (768, 512, 256, 256) - evergreen spruce needles poking from base snowdrift
  {
    const t = TRAIL_GATE_ATLAS_TILES.pineSprig;
    ctx.fillStyle = '#254f2d';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#172e1b';
    ctx.lineWidth = 4;
    for (let i = 1; i <= 6; i++) {
      const y = t.py + i * 36;
      ctx.beginPath();
      ctx.moveTo(t.px + t.pw * 0.5, t.py + t.ph);
      ctx.lineTo(t.px + 20, y);
      ctx.moveTo(t.px + t.pw * 0.5, t.py + t.ph);
      ctx.lineTo(t.px + t.pw - 20, y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#47824d';
    ctx.lineWidth = 3.2;
    for (let i = 1; i <= 5; i++) {
      const y = t.py + i * 42;
      ctx.beginPath();
      ctx.moveTo(t.px + t.pw * 0.5, y + 18);
      ctx.lineTo(t.px + 44, y - 8);
      ctx.moveTo(t.px + t.pw * 0.5, y + 18);
      ctx.lineTo(t.px + t.pw - 44, y - 8);
      ctx.stroke();
    }
  }

  // 11. signEdge (0, 768, 256, 256) - dark wooden signboard thickness trim
  {
    const t = TRAIL_GATE_ATLAS_TILES.signEdge;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px + t.pw, t.py);
    grad.addColorStop(0, '#3a1f0e');
    grad.addColorStop(0.5, '#66381b');
    grad.addColorStop(1, '#361c0c');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);
  }

  ctx.restore();
}

/**
 * Builds a closed non-indexed tapered vertical rectangular timber post with guaranteed
 * outward CCW winding and clean [0, 1] UVs per face (`groups[0]` side faces, `groups[1]` caps).
 */
function buildTaperedPostGeometry(
  wBot: number,
  dBot: number,
  wTop: number,
  dTop: number,
  yBot: number,
  yTop: number,
): THREE.BufferGeometry {
  const hwB = wBot * 0.5;
  const hdB = dBot * 0.5;
  const hwT = wTop * 0.5;
  const hdT = dTop * 0.5;

  const b0: readonly [number, number, number] = [-hwB, yBot, hdB];
  const b1: readonly [number, number, number] = [hwB, yBot, hdB];
  const b2: readonly [number, number, number] = [hwB, yBot, -hdB];
  const b3: readonly [number, number, number] = [-hwB, yBot, -hdB];

  const t0: readonly [number, number, number] = [-hwT, yTop, hdT];
  const t1: readonly [number, number, number] = [hwT, yTop, hdT];
  const t2: readonly [number, number, number] = [hwT, yTop, -hdT];
  const t3: readonly [number, number, number] = [-hwT, yTop, -hdT];

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
    p1: readonly [number, number, number],
    p2: readonly [number, number, number],
    p3: readonly [number, number, number],
  ): void => {
    pushTri(p0, [0, 0], p1, [1, 0], p2, [1, 1]);
    pushTri(p0, [0, 0], p2, [1, 1], p3, [0, 1]);
  };

  // Side faces (vertices 0..23 -> materialIndex 0)
  pushQuad(b0, b1, t1, t0); // +Z front
  pushQuad(b1, b2, t2, t1); // +X right
  pushQuad(b2, b3, t3, t2); // -Z back
  pushQuad(b3, b0, t0, t3); // -X left

  // Caps (vertices 24..35 -> materialIndex 1)
  pushQuad(t0, t1, t2, t3); // +Y top
  pushQuad(b3, b2, b1, b0); // -Y bottom

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.addGroup(0, 24, 0);
  geo.addGroup(24, 12, 1);
  return geo;
}

/**
 * Builds a continuous 3D concave S-scrollwork corner knee-brace curving from an inward
 * lower volute curl on the post face up into a scrolled upper volute beneath the beam.
 */
function buildCornerBraceParts(sideSign: -1 | 1): TexturedGeometryPart<TrailGateTileName>[] {
  const y0 = TRAIL_GATE_BEAM_Y;
  const u = -sideSign;
  const scrollPoints = [
    new THREE.Vector3(u * 0.94, y0 - 3.16, 0),
    new THREE.Vector3(u * 1.16, y0 - 3.44, 0),
    new THREE.Vector3(u * 0.9, y0 - 3.76, 0),
    new THREE.Vector3(u * 0.58, y0 - 3.38, 0),
    new THREE.Vector3(u * 0.9, y0 - 2.45, 0),
    new THREE.Vector3(u * 1.68, y0 - 1.54, 0),
    new THREE.Vector3(u * 2.58, y0 - 0.92, 0),
    new THREE.Vector3(u * 3.18, y0 - 1.04, 0),
    new THREE.Vector3(u * 3.22, y0 - 1.44, 0),
    new THREE.Vector3(u * 2.86, y0 - 1.4, 0),
  ];
  const scrollCurve = new THREE.CatmullRomCurve3(scrollPoints, false, 'centripetal');
  const ribCurve = new THREE.CatmullRomCurve3(
    [scrollPoints[3]!, scrollPoints[4]!, scrollPoints[5]!, scrollPoints[6]!],
    false,
    'centripetal',
  );
  const scrollRadius = 0.145;
  const ribRadius = 0.175;
  const braceDepthScale = 1.45;
  const capPoints: ReadonlyArray<readonly [THREE.Vector3, number, number]> = [
    [scrollPoints[0]!, scrollRadius, braceDepthScale],
    [scrollPoints[scrollPoints.length - 1]!, scrollRadius, braceDepthScale],
    [scrollPoints[3]!, ribRadius, braceDepthScale * 0.96],
    [scrollPoints[6]!, ribRadius, braceDepthScale * 0.96],
  ];

  const parts: TexturedGeometryPart<TrailGateTileName>[] = [
    {
      geometry: new THREE.TubeGeometry(scrollCurve, 40, scrollRadius, 8, false),
      tile: 'braceWood',
      sz: braceDepthScale,
    },
    {
      geometry: new THREE.TubeGeometry(ribCurve, 18, ribRadius, 8, false),
      tile: 'braceWood',
      sz: braceDepthScale * 0.96,
    },
  ];
  for (const [pt, radius, sz] of capPoints) {
    parts.push({
      geometry: new THREE.SphereGeometry(radius, 8, 6),
      tile: 'braceWood',
      tx: pt.x,
      ty: pt.y,
      tz: pt.z,
      sz,
    });
  }
  return parts;
}

/**
 * Builds a closed swept wavy snow blanket over the horizontal beam log with strict outward CCW winding
 * and cream top highlighting / blue-grey scalloped lower drip edges.
 */
function buildWavySnowBlanketGeometry(halfLen: number): THREE.BufferGeometry {
  const xSlices = 48;
  const profileTemplate: ReadonlyArray<readonly [z: number, yOff: number, v: number]> = [
    [1.01, 0.28, 0.04], // 0: front lower scallop drip lip
    [1.03, 0.58, 0.34], // 1: front round cheek (strictly <= 1.05 < signboard front face 1.39)
    [0.82, 0.98, 0.62], // 2: front upper shoulder
    [0.42, 1.24, 0.84], // 3: front top slope
    [0.0, 1.34, 0.96], // 4: crest spine peak
    [-0.42, 1.24, 0.84], // 5: back top slope
    [-0.82, 0.98, 0.62], // 6: back upper shoulder
    [-1.03, 0.58, 0.34], // 7: back round cheek
    [-1.01, 0.28, 0.04], // 8: back lower scallop drip lip
    [-0.56, 0.22, 0.02], // 9: inner bottom-back core (buried inside beam log)
    [0.56, 0.22, 0.02], // 10: inner bottom-front core (buried inside beam log)
  ];
  const ringCount = profileTemplate.length;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= xSlices; i++) {
    const t = i / xSlices;
    const uSpan = t * 2 - 1;
    const x = uSpan * halfLen;
    const centerSwell = 0.22 * Math.exp(-Math.pow(uSpan * 3.6, 2));
    const ridgeWave =
      0.08 * Math.sin(uSpan * Math.PI * 3.0 + 0.3) +
      0.04 * Math.cos(uSpan * Math.PI * 5.0 - 0.4) +
      centerSwell;
    const frontDrip =
      0.13 * Math.sin(uSpan * Math.PI * 4.5 + 0.5) + 0.06 * Math.cos(uSpan * Math.PI * 7.5);
    const backDrip =
      0.11 * Math.cos(uSpan * Math.PI * 4.0 - 0.4) + 0.05 * Math.sin(uSpan * Math.PI * 6.5);

    for (let j = 0; j < ringCount; j++) {
      const [baseZ, baseYOff, baseV] = profileTemplate[j]!;
      let y = TRAIL_GATE_BEAM_Y + baseYOff;
      let z = baseZ;
      if (j === 0) {
        y -= frontDrip;
      } else if (j === 1) {
        y -= frontDrip * 0.45;
        z += frontDrip * 0.1;
      } else if (j >= 2 && j <= 6) {
        const crestWeight = j === 4 ? 1.0 : j === 3 || j === 5 ? 0.82 : 0.52;
        y += ridgeWave * crestWeight;
      } else if (j === 7) {
        y -= backDrip * 0.45;
        z -= backDrip * 0.1;
      } else if (j === 8) {
        y -= backDrip;
      }
      positions.push(x, y, z);
      uvs.push(t, baseV);
    }
  }

  for (let i = 0; i < xSlices; i++) {
    const row0 = i * ringCount;
    const row1 = (i + 1) * ringCount;
    for (let j = 0; j < ringCount; j++) {
      const nextJ = (j + 1) % ringCount;
      const v00 = row0 + j;
      const v10 = row1 + j;
      const v01 = row0 + nextJ;
      const v11 = row1 + nextJ;
      indices.push(v00, v10, v01);
      indices.push(v10, v11, v01);
    }
  }

  // Dedicated flat end caps at -halfLen (-X) and +halfLen (+X) to keep cap normals clean
  const capY = TRAIL_GATE_BEAM_Y + 0.66;
  const pushCap = (rowStart: number, capX: number, uCoord: number, flipWinding: boolean): void => {
    const centerIdx = positions.length / 3;
    positions.push(capX, capY, 0);
    uvs.push(uCoord, 0.45);
    const ringStart = positions.length / 3;
    for (let j = 0; j < ringCount; j++) {
      const pIdx = (rowStart + j) * 3;
      positions.push(positions[pIdx]!, positions[pIdx + 1]!, positions[pIdx + 2]!);
      uvs.push(uvs[(rowStart + j) * 2]!, uvs[(rowStart + j) * 2 + 1]!);
    }
    for (let j = 0; j < ringCount; j++) {
      const nextJ = (j + 1) % ringCount;
      if (flipWinding) {
        indices.push(centerIdx, ringStart + nextJ, ringStart + j);
      } else {
        indices.push(centerIdx, ringStart + j, ringStart + nextJ);
      }
    }
  };
  pushCap(0, -halfLen, 0, false);
  pushCap(xSlices * ringCount, halfLen, 1, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildPostAssemblyGeometry(
  sideSign: -1 | 1,
  label: string,
): THREE.BufferGeometry {
  const parts: TexturedGeometryPart<TrailGateTileName>[] = [];
  const logCapGroupTiles: Readonly<Record<number, TrailGateTileName | TileMappingSpec<TrailGateTileName>>> = {
    0: { tile: 'logBark', swapUV: true },
    1: 'logEnd',
    2: 'logEnd',
  };

  // 1. Tall tapered vertical timber post grounded to y = -1.8m so steep slopes never gap
  parts.push({
    geometry: buildTaperedPostGeometry(1.62, 1.44, 1.28, 1.14, -1.8, TRAIL_GATE_BEAM_Y - 0.16),
    tile: 'postTimber',
    groupTiles: {
      0: 'postTimber',
      1: 'braceWood',
    },
  });

  // 2. Bold outer horizontal log overhang cap with flared spiral end-grain
  parts.push({
    geometry: new THREE.CylinderGeometry(1.03, TRAIL_GATE_LOG_RADIUS, 2.35, 16, 1, false),
    tile: 'logBark',
    groupTiles: logCapGroupTiles,
    tx: sideSign * 0.52,
    ty: TRAIL_GATE_BEAM_Y,
    tz: 0,
    rz: sideSign < 0 ? Math.PI * 0.5 : -Math.PI * 0.5,
  });

  // 3. Plump outer snow bolster capping the overhanging log end cleanly to beam crest height
  parts.push(
    {
      geometry: new THREE.SphereGeometry(0.92, 12, 8),
      tile: 'snowCap',
      tx: sideSign * 0.62,
      ty: TRAIL_GATE_BEAM_Y + 0.86,
      tz: 0,
      sx: 1.38,
      sy: 0.54,
      sz: 1.08,
    },
    {
      geometry: new THREE.SphereGeometry(0.46, 10, 7),
      tile: 'snowCap',
      tx: sideSign * 1.48,
      ty: TRAIL_GATE_BEAM_Y + 0.58,
      tz: 0.28,
      sx: 0.92,
      sy: 0.72,
      sz: 0.94,
    },
  );

  // 4. Continuous 3D concave S-scrollwork corner knee-brace with lower & upper volutes
  parts.push(...buildCornerBraceParts(sideSign));

  // 5. Compact sculpted base snowdrift mounds hugging the post foot without touching twin fork neighbors
  parts.push(
    {
      geometry: new THREE.BoxGeometry(2.35, 1.7, 2.1),
      tile: 'snowDrift',
      tx: sideSign * 0.12,
      ty: -0.92,
      tz: 0,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowDrift',
      tx: sideSign * 0.76,
      ty: 0.24,
      tz: 0.16,
      sx: 1.24,
      sy: 0.88,
      sz: 1.16,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowDrift',
      tx: sideSign * -0.44,
      ty: 0.14,
      tz: 0.28,
      sx: 0.92,
      sy: 0.64,
      sz: 0.98,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowDrift',
      tx: sideSign * 0.14,
      ty: 0.1,
      tz: -0.64,
      sx: 1.22,
      sy: 0.62,
      sz: 1.02,
    },
    {
      geometry: new THREE.SphereGeometry(1, 9, 6),
      tile: 'snowDrift',
      tx: sideSign * 1.28,
      ty: 0.0,
      tz: -0.1,
      sx: 0.84,
      sy: 0.44,
      sz: 0.88,
    },
    {
      geometry: new THREE.SphereGeometry(1, 9, 6),
      tile: 'snowDrift',
      tx: sideSign * 0.18,
      ty: 0.08,
      tz: 0.76,
      sx: 1.06,
      sy: 0.48,
      sz: 0.82,
    },
  );

  // 6. Evergreen pine sprigs on the left post's outer snow shoulder (matching concept art)
  if (sideSign < 0) {
    const sprigSpecs: ReadonlyArray<{
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly h: number;
      readonly rBottom: number;
      readonly rz: number;
      readonly rx: number;
    }> = [
      { x: -0.98, y: 1.32, z: 0.22, h: 1.18, rBottom: 0.2, rz: 0.24, rx: 0.08 },
      { x: -1.16, y: 1.1, z: -0.04, h: 0.92, rBottom: 0.18, rz: 0.58, rx: -0.06 },
      { x: -0.9, y: 1.02, z: -0.22, h: 0.78, rBottom: 0.16, rz: 0.14, rx: -0.14 },
    ];
    for (const sp of sprigSpecs) {
      parts.push({
        geometry: new THREE.CylinderGeometry(0.025, sp.rBottom, sp.h, 5),
        tile: 'pineSprig',
        tx: sp.x,
        ty: sp.y,
        tz: sp.z,
        rx: sp.rx,
        rz: sp.rz,
        sz: 0.55,
      });
    }
  }

  return buildMergedTexturedGeometry(parts, TRAIL_GATE_ATLAS_TILES, label, true);
}

function buildSignPlaqueGeometry(tile: TrailGateTileName, label: string): THREE.BufferGeometry {
  return buildMergedTexturedGeometry<TrailGateTileName>(
    [
      {
        geometry: new THREE.BoxGeometry(4.05, 3.65, 0.42),
        tile,
        groupTiles: {
          0: 'signEdge',
          1: 'signEdge',
          2: 'signEdge',
          3: 'signEdge',
          4: tile,
          5: tile,
        },
      },
    ],
    TRAIL_GATE_ATLAS_TILES,
    label,
    true,
  );
}

export interface TrailGateGeometries {
  readonly beamCenterGeo: THREE.BufferGeometry;
  readonly leftPostGeo: THREE.BufferGeometry;
  readonly rightPostGeo: THREE.BufferGeometry;
  readonly badgeCircleGeo: THREE.BufferGeometry;
  readonly badgeSquareGeo: THREE.BufferGeometry;
  readonly badgeDiamondGeo: THREE.BufferGeometry;
  readonly badgeSnowCapGeo: THREE.BufferGeometry;
}

/**
 * Builds the modular textured & smooth-normal geometries for the folk trail gate.
 */
export function buildTrailGateGeometries(): TrailGateGeometries {
  const beamSpan = TRAIL_GATE_DEFAULT_HALF_SPAN * 2 + 0.5;
  const snowHalfLen = TRAIL_GATE_DEFAULT_HALF_SPAN + 0.2;
  const beamParts: TexturedGeometryPart<TrailGateTileName>[] = [
    {
      geometry: new THREE.CylinderGeometry(
        TRAIL_GATE_LOG_RADIUS,
        TRAIL_GATE_LOG_RADIUS,
        beamSpan,
        16,
        1,
        true,
      ),
      tile: 'logBark',
      swapUV: true,
      ty: TRAIL_GATE_BEAM_Y,
      rz: Math.PI * 0.5,
    },
    {
      geometry: buildWavySnowBlanketGeometry(snowHalfLen),
      tile: 'snowCap',
    },
  ];

  const beamCenterGeo = buildMergedTexturedGeometry(
    beamParts,
    TRAIL_GATE_ATLAS_TILES,
    'TrailGateBeamGeo',
    true,
  );
  const leftPostGeo = buildPostAssemblyGeometry(-1, 'TrailGateLeftPostGeo');
  const rightPostGeo = buildPostAssemblyGeometry(1, 'TrailGateRightPostGeo');

  const badgeCircleGeo = buildSignPlaqueGeometry('signCircle', 'TrailGateBadgeCircleGeo');
  const badgeSquareGeo = buildSignPlaqueGeometry('signSquare', 'TrailGateBadgeSquareGeo');
  const badgeDiamondGeo = buildSignPlaqueGeometry('signDiamond', 'TrailGateBadgeDiamondGeo');

  // Plump continuous snow crest crowning above the signboard top rim without clipping front emblem
  const badgeSnowCapGeo = buildMergedTexturedGeometry<TrailGateTileName>(
    [
      {
        geometry: new THREE.SphereGeometry(0.62, 12, 8),
        tile: 'snowCap',
        tx: 0,
        ty: 2.05,
        tz: -0.22,
        sx: 2.25,
        sy: 0.56,
        sz: 0.66,
      },
      {
        geometry: new THREE.SphereGeometry(0.46, 10, 7),
        tile: 'snowCap',
        tx: -1.28,
        ty: 1.92,
        tz: -0.24,
        sx: 1.65,
        sy: 0.48,
        sz: 0.65,
      },
      {
        geometry: new THREE.SphereGeometry(0.46, 10, 7),
        tile: 'snowCap',
        tx: 1.28,
        ty: 1.92,
        tz: -0.24,
        sx: 1.65,
        sy: 0.48,
        sz: 0.65,
      },
    ],
    TRAIL_GATE_ATLAS_TILES,
    'TrailGateBadgeSnowCapGeo',
    true,
  );

  return {
    beamCenterGeo,
    leftPostGeo,
    rightPostGeo,
    badgeCircleGeo,
    badgeSquareGeo,
    badgeDiamondGeo,
    badgeSnowCapGeo,
  };
}

export interface TrailGateAssets {
  readonly beamCenterGeo: THREE.BufferGeometry;
  readonly leftPostGeo: THREE.BufferGeometry;
  readonly rightPostGeo: THREE.BufferGeometry;
  readonly badgeCircleGeo: THREE.BufferGeometry;
  readonly badgeSquareGeo: THREE.BufferGeometry;
  readonly badgeDiamondGeo: THREE.BufferGeometry;
  readonly badgeSnowCapGeo: THREE.BufferGeometry;
  readonly atlasTexture: THREE.Texture;
  readonly frameMaterial: THREE.MeshToonMaterial;
  readonly badgeMaterial: THREE.MeshBasicMaterial;
  readonly outlineMaterial: THREE.Material | undefined;
}

/**
 * Builds, paints, and registers all cached GPU assets for folk trail gates under `GraphicsUtils`.
 */
export function createTrailGateAssets(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  outlineMaterial?: THREE.Material,
): TrailGateAssets {
  const geos = buildTrailGateGeometries();
  const allGeos = [
    geos.beamCenterGeo,
    geos.leftPostGeo,
    geos.rightPostGeo,
    geos.badgeCircleGeo,
    geos.badgeSquareGeo,
    geos.badgeDiamondGeo,
    geos.badgeSnowCapGeo,
  ];
  for (const g of allGeos) {
    gfx.markAsCache(g, g.name);
  }

  const atlasTexture = createProceduralCanvasTexture(
    gfx,
    TRAIL_GATE_ATLAS_SIZE,
    TRAIL_GATE_ATLAS_SIZE,
    drawTrailGateAtlas,
    'TrailGateAtlasTex',
    [205, 142, 62, 255],
  );
  const frameMaterial = createTexturedToonMaterial(
    gfx,
    atlasTexture,
    materials.gradientMap,
    materials.sharedUniforms,
    'TrailGateToonMaterial',
  );
  const badgeMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: atlasTexture,
    fog: true,
  });
  badgeMaterial.name = 'TrailGateBadgeMaterial';
  gfx.markAsCache(badgeMaterial, 'TrailGateBadgeMaterial');

  return {
    ...geos,
    atlasTexture,
    frameMaterial,
    badgeMaterial,
    outlineMaterial,
  };
}

/**
 * Instantiates a pooled folk trail gate whose posts slide distortion-free with `gateHalfWidth`
 * and whose central signboard swaps between green circle, blue square, and black diamond.
 */
export function createTrailGateObject(
  gfx: GraphicsUtils,
  assets: TrailGateAssets,
  stageId?: string | null,
): {
  readonly group: THREE.Group;
  setBadge: (stageId?: string | null, gateHalfWidth?: number) => void;
} {
  const group = new THREE.Group();
  group.name = 'ForkArchLandmark';

  const outlineMat = assets.outlineMaterial;

  // 1. Horizontal center log beam + snow blanket (scaled along X with branch width)
  const beamHolder = new THREE.Group();
  beamHolder.name = 'TrailGateBeamHolder';
  const beamMesh = gfx.createMesh(assets.beamCenterGeo, assets.frameMaterial, 'TrailGateBeam');
  beamMesh.castShadow = true;
  beamHolder.add(beamMesh);
  if (outlineMat) {
    const beamOutline = gfx.createMesh(assets.beamCenterGeo, outlineMat, 'TrailGateBeamOutline');
    beamOutline.castShadow = false;
    beamHolder.add(beamOutline);
  }
  group.add(beamHolder);

  // 2. Left & right tapered posts, braces, log caps, snowdrifts & pine sprigs (never scaled)
  const leftPostHolder = new THREE.Group();
  leftPostHolder.name = 'TrailGateLeftPost';
  leftPostHolder.position.set(-TRAIL_GATE_DEFAULT_HALF_SPAN, 0, 0);
  const leftPostMesh = gfx.createMesh(assets.leftPostGeo, assets.frameMaterial, 'TrailGateLeftPostMesh');
  leftPostMesh.castShadow = true;
  leftPostHolder.add(leftPostMesh);
  if (outlineMat) {
    const leftOutline = gfx.createMesh(assets.leftPostGeo, outlineMat, 'TrailGateLeftPostOutline');
    leftOutline.castShadow = false;
    leftPostHolder.add(leftOutline);
  }
  group.add(leftPostHolder);

  const rightPostHolder = new THREE.Group();
  rightPostHolder.name = 'TrailGateRightPost';
  rightPostHolder.position.set(TRAIL_GATE_DEFAULT_HALF_SPAN, 0, 0);
  const rightPostMesh = gfx.createMesh(assets.rightPostGeo, assets.frameMaterial, 'TrailGateRightPostMesh');
  rightPostMesh.castShadow = true;
  rightPostHolder.add(rightPostMesh);
  if (outlineMat) {
    const rightOutline = gfx.createMesh(assets.rightPostGeo, outlineMat, 'TrailGateRightPostOutline');
    rightOutline.castShadow = false;
    rightPostHolder.add(rightOutline);
  }
  group.add(rightPostHolder);

  // 3. Central signboard plaque & snow crest mound (never scaled with gate width)
  const badgeHolder = new THREE.Group();
  badgeHolder.name = 'ForkArchBadgeHolder';
  badgeHolder.position.set(0, TRAIL_GATE_BEAM_Y - 0.14, 1.18);

  const circle = gfx.createMesh(assets.badgeCircleGeo, assets.badgeMaterial, 'ForkBadgeCircle');
  const square = gfx.createMesh(assets.badgeSquareGeo, assets.badgeMaterial, 'ForkBadgeSquare');
  const diamond = gfx.createMesh(assets.badgeDiamondGeo, assets.badgeMaterial, 'ForkBadgeDiamond');
  circle.castShadow = true;
  square.castShadow = true;
  diamond.castShadow = true;
  badgeHolder.add(circle, square, diamond);

  if (outlineMat) {
    const badgeOutline = gfx.createMesh(assets.badgeSquareGeo, outlineMat, 'ForkBadgeOutline');
    badgeOutline.castShadow = false;
    badgeHolder.add(badgeOutline);
  }

  const snowCap = gfx.createMesh(assets.badgeSnowCapGeo, assets.frameMaterial, 'ForkBadgeSnowCap');
  snowCap.castShadow = true;
  badgeHolder.add(snowCap);
  if (outlineMat) {
    const snowCapOutline = gfx.createMesh(
      assets.badgeSnowCapGeo,
      outlineMat,
      'ForkBadgeSnowCapOutline',
    );
    snowCapOutline.castShadow = false;
    badgeHolder.add(snowCapOutline);
  }
  group.add(badgeHolder);

  const setBadge = (nextStageId?: string | null, gateHalfWidth?: number): void => {
    const shape = nextStageId ? (getStageDef(nextStageId)?.badge.shape ?? 'square') : 'square';
    circle.visible = shape === 'circle';
    square.visible = shape === 'square';
    diamond.visible = shape === 'diamond';

    const halfSpan =
      gateHalfWidth !== undefined
        ? clamp(gateHalfWidth - 2.8, TRAIL_GATE_MIN_HALF_SPAN, TRAIL_GATE_MAX_HALF_SPAN)
        : TRAIL_GATE_DEFAULT_HALF_SPAN;
    beamHolder.scale.set(halfSpan / TRAIL_GATE_DEFAULT_HALF_SPAN, 1, 1);
    leftPostHolder.position.x = -halfSpan;
    rightPostHolder.position.x = halfSpan;
  };

  setBadge(stageId);
  return { group, setBadge };
}

/**
 * Registers the folk Trail Gate landmark archetype (`forkArch`) with pooled geometry,
 * shared folk atlas materials, smooth outlines, and per-branch badge/width configuration.
 */
export function createTrailGateLandmarkDef(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  outlineMaterial?: THREE.Material,
): LandmarkModelDef {
  const assets = createTrailGateAssets(gfx, materials, outlineMaterial);
  return {
    id: 'forkArch',
    poolCapacity: 12,
    yawPolicy: 'none',
    createInstance: (index) => {
      const gate = createTrailGateObject(gfx, assets);
      gfx.markAsCache(gate.group, `PooledForkArch_${index}`);
      return {
        group: gate.group,
        configure: (lm) => gate.setBadge(lm.badgeStageId, lm.gateHalfWidth),
      };
    },
  };
}
