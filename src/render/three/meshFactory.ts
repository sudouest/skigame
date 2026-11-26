import * as THREE from 'three';
import { getStageDef } from '../../content/stages';
import { buildChimneySmokeQuadGeometry } from './chimneySmoke';
import type { GraphicsUtils } from './graphicsUtils';
import {
  buildMergedColoredGeometry,
  type ColoredGeometryPart,
} from './models/proceduralModelUtils';
import { computeSmoothNormals } from './smoothNormals';
import type { SharedToonMaterials } from './toonMaterials';

export { buildMergedColoredGeometry, type ColoredGeometryPart };

/**
 * Builds a low-poly faceted boulder normalized to unit radius (`x,z in [-1,1]`) and
 * unit height (`y in [0,1]`) with deterministic vertex displacement and snow-dusted top faces.
 */
export function buildUnitBoulderGeometry(
  palette: readonly string[],
  variantSeed: number,
  label: string,
): THREE.BufferGeometry {
  const raw = new THREE.IcosahedronGeometry(1, 0);
  const base = raw.index ? raw.toNonIndexed() : raw;
  if (base !== raw) {
    raw.dispose();
  }
  const posAttr = base.getAttribute('position');
  const vertCount = posAttr.count;

  // Quantize vertices to displace coincident corners coherently without cracking the icosahedron.
  let minY = Infinity;
  let maxY = -Infinity;
  let maxHoriz = 0.001;

  for (let i = 0; i < vertCount; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key =
      Math.round(x * 1000) * 73856093 ^
      Math.round(y * 1000) * 19349663 ^
      Math.round(z * 1000) * 83492791 ^
      (variantSeed * 2654435761);
    const hashA = ((Math.sin(key * 0.00017) * 43758.5453) % 1 + 1) % 1;
    const hashB = ((Math.cos(key * 0.00031) * 28411.1234) % 1 + 1) % 1;
    const radialScale = 0.8 + hashA * 0.34;
    const ny = (y < 0 ? y * 0.65 : y * (0.85 + hashB * 0.3)) + 0.55;
    const nx = x * radialScale;
    const nz = z * radialScale;

    posAttr.setXYZ(i, nx, ny, nz);
    if (ny < minY) minY = ny;
    if (ny > maxY) maxY = ny;
    const r = Math.hypot(nx, nz);
    if (r > maxHoriz) maxHoriz = r;
  }

  const heightSpan = Math.max(0.001, maxY - minY);
  for (let i = 0; i < vertCount; i++) {
    const x = posAttr.getX(i) / maxHoriz;
    const y = (posAttr.getY(i) - minY) / heightSpan;
    const z = posAttr.getZ(i) / maxHoriz;
    posAttr.setXYZ(i, x, y, z);
  }

  base.computeVertexNormals();
  const normAttr = base.getAttribute('normal');
  const colors = new Float32Array(vertCount * 3);

  const rockDark = new THREE.Color(palette[0] ?? '#475569');
  const rockLight = new THREE.Color(palette[1] ?? '#64748b');
  const snowColor = new THREE.Color(palette[2] ?? '#e2e8f0');
  const col = new THREE.Color();

  for (let t = 0; t < vertCount; t += 3) {
    const ny = normAttr.getY(t);
    if (ny > 0.52) {
      col.copy(snowColor);
    } else if (ny > 0.12) {
      col.copy(rockLight);
    } else {
      col.copy(rockDark);
    }
    for (let k = 0; k < 3; k++) {
      const idx = (t + k) * 3;
      colors[idx] = col.r;
      colors[idx + 1] = col.g;
      colors[idx + 2] = col.b;
    }
  }

  base.name = label;
  base.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  base.computeBoundingBox();
  base.computeBoundingSphere();
  computeSmoothNormals(base);
  return base;
}

/**
 * Builds a wrapped holiday present mesh seated at y = 0 with box, lid overhang,
 * ribbon bands, and top bow.
 */
export function buildPresentGeometry(
  palette: readonly string[],
  golden: boolean,
  label: string,
): THREE.BufferGeometry {
  const boxColor = palette[0] ?? (golden ? '#ffb703' : '#e63946');
  const ribbonColor = palette[1] ?? (golden ? '#ffffff' : '#ffd166');
  const bowColor = palette[2] ?? (golden ? '#fb8500' : '#ffffff');

  const parts: ColoredGeometryPart[] = [
    // Main cube body seated on y = 0
    { geometry: new THREE.BoxGeometry(0.86, 0.72, 0.86), color: boxColor, ty: 0.36 },
    // Lid overhang
    { geometry: new THREE.BoxGeometry(0.94, 0.16, 0.94), color: boxColor, ty: 0.76 },
    // Cross ribbons
    { geometry: new THREE.BoxGeometry(0.96, 0.85, 0.2), color: ribbonColor, ty: 0.435 },
    { geometry: new THREE.BoxGeometry(0.2, 0.85, 0.96), color: ribbonColor, ty: 0.435 },
    // Bow knot + twin loops
    { geometry: new THREE.OctahedronGeometry(0.14, 0), color: bowColor, ty: 0.92 },
    { geometry: new THREE.BoxGeometry(0.28, 0.16, 0.14), color: bowColor, tx: -0.18, ty: 0.95, rz: 0.35 },
    { geometry: new THREE.BoxGeometry(0.28, 0.16, 0.14), color: bowColor, tx: 0.18, ty: 0.95, rz: -0.35 },
  ];

  if (golden) {
    parts.push({
      geometry: new THREE.OctahedronGeometry(0.18, 0),
      color: '#fff3b0',
      ty: 1.12,
    });
  }

  return buildMergedColoredGeometry(parts, label, true);
}

/**
 * Builds a unit ski kicker ramp normalized to `x in [-0.5, 0.5]`, `y in [0, 1]`, `z in [-0.5, 0.5]`.
 * Entry sits at `+Z` (`+0.5`, height 0) and launch kicker lip rises along `-Z` forward (`-0.5`, height 1).
 */
export function buildUnitRampGeometry(
  palette: readonly string[],
  label: string,
): THREE.BufferGeometry {
  const snowBody = new THREE.Color(palette[0] ?? '#e0f2fe');
  const iceDeck = new THREE.Color(palette[1] ?? '#7dd3fc');
  const chevron = new THREE.Color(palette[2] ?? '#f59e0b');

  // Wedge vertices: entry at z = +0.5 (y = 0), lip at z = -0.5 (y = 1)
  const hw = 0.5;
  const hl = 0.5;

  const p0: [number, number, number] = [-hw, 0, hl];  // back-left ground
  const p1: [number, number, number] = [hw, 0, hl];   // back-right ground
  const p2: [number, number, number] = [-hw, 0, -hl]; // front-left ground
  const p3: [number, number, number] = [hw, 0, -hl];  // front-right ground
  const p4: [number, number, number] = [-hw, 1, -hl]; // front-left lip
  const p5: [number, number, number] = [hw, 1, -hl];  // front-right lip

  const pos: number[] = [];
  const col: number[] = [];

  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    color: THREE.Color,
  ): void => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    col.push(color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b);
  };

  // Sloped top deck (CCW looking from above)
  pushTri(p0, p1, p5, iceDeck);
  pushTri(p0, p5, p4, iceDeck);

  // Vertical front kicker wall at z = -0.5 facing -Z
  pushTri(p2, p4, p5, snowBody);
  pushTri(p2, p5, p3, snowBody);

  // Left side wall (x = -0.5)
  pushTri(p0, p4, p2, snowBody);

  // Right side wall (x = +0.5)
  pushTri(p1, p3, p5, snowBody);

  // Bottom face
  pushTri(p0, p2, p3, snowBody);
  pushTri(p0, p3, p1, snowBody);

  // Bright launch lip stripe bar right along the kicker edge
  const lipStripe: [number, number, number][] = [
    [-hw * 0.92, 0.88, -hl + 0.14],
    [hw * 0.92, 0.88, -hl + 0.14],
    [-hw * 0.92, 1.02, -hl],
    [hw * 0.92, 1.02, -hl],
  ];
  pushTri(lipStripe[0]!, lipStripe[1]!, lipStripe[3]!, chevron);
  pushTri(lipStripe[0]!, lipStripe[3]!, lipStripe[2]!, chevron);

  const geo = new THREE.BufferGeometry();
  geo.name = label;
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  computeSmoothNormals(geo);
  return geo;
}

export interface ProceduralMeshAssets {
  readonly boulderSmallGeo: THREE.BufferGeometry;
  readonly boulderLargeGeo: THREE.BufferGeometry;
  readonly presentStdGeo: THREE.BufferGeometry;
  readonly presentGoldGeo: THREE.BufferGeometry;
  readonly rampGeo: THREE.BufferGeometry;
  readonly badgeCircleGeo: THREE.BufferGeometry;
  readonly badgeSquareGeo: THREE.BufferGeometry;
  readonly badgeDiamondGeo: THREE.BufferGeometry;
  readonly badgeTrimCircleGeo: THREE.BufferGeometry;
  readonly badgeTrimSquareGeo: THREE.BufferGeometry;
  readonly badgeTrimDiamondGeo: THREE.BufferGeometry;
  readonly forkArchFrameGeo: THREE.BufferGeometry;
  readonly lanternPostGeo: THREE.BufferGeometry;
  readonly lanternGlowGeo: THREE.BufferGeometry;
  readonly deliveryArchGeo: THREE.BufferGeometry;
  readonly deliveryArchGlowGeo: THREE.BufferGeometry;
  readonly cabinSmokeGeo: THREE.BufferGeometry;
}

function buildStageBadgeGeo(
  shape: 'circle' | 'square' | 'diamond',
  colorHex: string,
  label: string,
): THREE.BufferGeometry {
  const parts: ColoredGeometryPart[] = [
    // Dark contrast outer backing frame
    { geometry: new THREE.BoxGeometry(3.65, 3.65, 0.22), color: '#0f172a' },
    // White backing plaque
    { geometry: new THREE.BoxGeometry(3.4, 3.4, 0.3), color: '#f8fafc' },
  ];
  if (shape === 'circle') {
    parts.push({
      geometry: new THREE.CylinderGeometry(1.18, 1.18, 0.42, 16),
      color: colorHex,
      rx: Math.PI * 0.5,
    });
  } else if (shape === 'square') {
    parts.push({
      geometry: new THREE.BoxGeometry(2.1, 2.1, 0.42),
      color: colorHex,
    });
  } else {
    parts.push({
      geometry: new THREE.BoxGeometry(1.78, 1.78, 0.42),
      color: colorHex,
      rz: Math.PI * 0.25,
    });
  }
  return buildMergedColoredGeometry(parts, label, false);
}

function buildGateTrimGeo(
  colorHex: string,
  accentHex: string,
  label: string,
): THREE.BufferGeometry {
  const parts: ColoredGeometryPart[] = [
    // Color-coded header fascia bars along front and back of crossbar
    { geometry: new THREE.BoxGeometry(19.6, 0.48, 0.12), color: colorHex, ty: 7.15, tz: 0.52 },
    { geometry: new THREE.BoxGeometry(19.6, 0.48, 0.12), color: colorHex, ty: 7.15, tz: -0.52 },
    // Thin contrast trim borders framing the fascia bar
    { geometry: new THREE.BoxGeometry(19.6, 0.1, 0.12), color: accentHex, ty: 7.45, tz: 0.52 },
    { geometry: new THREE.BoxGeometry(19.6, 0.1, 0.12), color: accentHex, ty: 6.85, tz: 0.52 },
    { geometry: new THREE.BoxGeometry(19.6, 0.1, 0.12), color: accentHex, ty: 7.45, tz: -0.52 },
    { geometry: new THREE.BoxGeometry(19.6, 0.1, 0.12), color: accentHex, ty: 6.85, tz: -0.52 },
    // Upper post accent bands
    { geometry: new THREE.BoxGeometry(0.96, 0.72, 0.96), color: colorHex, tx: -10.0, ty: 5.35 },
    { geometry: new THREE.BoxGeometry(0.96, 0.72, 0.96), color: colorHex, tx: 10.0, ty: 5.35 },
    { geometry: new THREE.BoxGeometry(1.0, 0.16, 1.0), color: accentHex, tx: -10.0, ty: 4.9 },
    { geometry: new THREE.BoxGeometry(1.0, 0.16, 1.0), color: accentHex, tx: 10.0, ty: 4.9 },
  ];
  return buildMergedColoredGeometry(parts, label, false);
}

/**
 * Builds and caches all shared low-poly 3D procedural geometries under GraphicsTracker.
 */
export function createProceduralMeshAssets(gfx: GraphicsUtils): ProceduralMeshAssets {
  const boulderSmallGeo = buildUnitBoulderGeometry(
    ['#64748b', '#94a3b8', '#e2e8f0'],
    11,
    'BoulderSmallUnitGeo',
  );
  const boulderLargeGeo = buildUnitBoulderGeometry(
    ['#475569', '#64748b', '#cbd5e1'],
    37,
    'BoulderLargeUnitGeo',
  );
  const presentStdGeo = buildPresentGeometry(
    ['#e63946', '#ffd166', '#ffffff'],
    false,
    'PresentStandardGeo',
  );
  const presentGoldGeo = buildPresentGeometry(
    ['#ffb703', '#ffffff', '#fb8500'],
    true,
    'PresentGoldenGeo',
  );
  const rampGeo = buildUnitRampGeometry(
    ['#e0f2fe', '#7dd3fc', '#f59e0b'],
    'SkiRampUnitGeo',
  );

  // Single-path gate frame spanning X = [-10.0, +10.0] with 7.15m overhead crossbar
  const forkArchFrameGeo = buildMergedColoredGeometry(
    [
      { geometry: new THREE.BoxGeometry(0.85, 7.4, 0.85), color: '#78350f', tx: -10.0, ty: 3.7 },
      { geometry: new THREE.BoxGeometry(0.85, 7.4, 0.85), color: '#78350f', tx: 10.0, ty: 3.7 },
      {
        geometry: new THREE.BoxGeometry(0.45, 2.2, 0.45),
        color: '#78350f',
        tx: -9.15,
        ty: 6.1,
        rz: -Math.PI * 0.25,
      },
      {
        geometry: new THREE.BoxGeometry(0.45, 2.2, 0.45),
        color: '#78350f',
        tx: 9.15,
        ty: 6.1,
        rz: Math.PI * 0.25,
      },
      { geometry: new THREE.BoxGeometry(21.6, 1.05, 0.95), color: '#92400e', ty: 7.15 },
      { geometry: new THREE.BoxGeometry(22.2, 0.35, 1.15), color: '#f8fafc', ty: 7.85 },
    ],
    'ForkArchFrameGeo',
    false,
  );

  const badgeCircleGeo = buildStageBadgeGeo('circle', '#16a34a', 'BadgeCircleGeo');
  const badgeSquareGeo = buildStageBadgeGeo('square', '#2563eb', 'BadgeSquareGeo');
  const badgeDiamondGeo = buildStageBadgeGeo('diamond', '#111827', 'BadgeDiamondGeo');

  const badgeTrimCircleGeo = buildGateTrimGeo('#16a34a', '#dcfce7', 'BadgeTrimCircleGeo');
  const badgeTrimSquareGeo = buildGateTrimGeo('#2563eb', '#dbeafe', 'BadgeTrimSquareGeo');
  const badgeTrimDiamondGeo = buildGateTrimGeo('#111827', '#38bdf8', 'BadgeTrimDiamondGeo');

  // Delivery Lantern Post
  const lanternPostGeo = buildMergedColoredGeometry(
    [
      { geometry: new THREE.BoxGeometry(0.36, 3.6, 0.36), color: '#78350f', ty: 1.8 },
      { geometry: new THREE.BoxGeometry(1.3, 0.28, 0.28), color: '#78350f', tx: 0.45, ty: 3.45 },
      { geometry: new THREE.ConeGeometry(0.45, 0.35, 4), color: '#334155', tx: 0.95, ty: 3.22, ry: Math.PI * 0.25 },
    ],
    'DeliveryLanternPostGeo',
    false,
  );
  const lanternGlowGeo = buildMergedColoredGeometry(
    [
      { geometry: new THREE.BoxGeometry(0.48, 0.56, 0.48), color: '#fde047', tx: 0.95, ty: 2.82 },
    ],
    'DeliveryLanternGlowGeo',
    false,
  );

  // Delivery Sibling Arch
  const deliveryArchGeo = buildMergedColoredGeometry(
    [
      { geometry: new THREE.BoxGeometry(0.45, 4.2, 0.45), color: '#7c2d12', tx: -2.6, ty: 2.1 },
      { geometry: new THREE.BoxGeometry(0.45, 4.2, 0.45), color: '#7c2d12', tx: 2.6, ty: 2.1 },
      { geometry: new THREE.BoxGeometry(6.2, 0.55, 0.55), color: '#9a3412', ty: 4.15 },
      { geometry: new THREE.BoxGeometry(6.6, 0.25, 0.75), color: '#f8fafc', ty: 4.5 },
    ],
    'DeliveryArchGeo',
    false,
  );
  const deliveryArchGlowGeo = buildMergedColoredGeometry(
    [
      { geometry: new THREE.OctahedronGeometry(0.28, 0), color: '#fde047', tx: -1.6, ty: 3.65 },
      { geometry: new THREE.OctahedronGeometry(0.32, 0), color: '#fef08a', tx: 0, ty: 3.55 },
      { geometry: new THREE.OctahedronGeometry(0.28, 0), color: '#fde047', tx: 1.6, ty: 3.65 },
    ],
    'DeliveryArchGlowGeo',
    false,
  );

  const cabinSmokeGeo = buildChimneySmokeQuadGeometry('DeliveryCabinSmokeGeo');

  const allGeos = [
    boulderSmallGeo,
    boulderLargeGeo,
    presentStdGeo,
    presentGoldGeo,
    rampGeo,
    badgeCircleGeo,
    badgeSquareGeo,
    badgeDiamondGeo,
    badgeTrimCircleGeo,
    badgeTrimSquareGeo,
    badgeTrimDiamondGeo,
    forkArchFrameGeo,
    lanternPostGeo,
    lanternGlowGeo,
    deliveryArchGeo,
    deliveryArchGlowGeo,
    cabinSmokeGeo,
  ];
  for (const g of allGeos) {
    gfx.markAsCache(g, g.name);
  }

  return {
    boulderSmallGeo,
    boulderLargeGeo,
    presentStdGeo,
    presentGoldGeo,
    rampGeo,
    badgeCircleGeo,
    badgeSquareGeo,
    badgeDiamondGeo,
    badgeTrimCircleGeo,
    badgeTrimSquareGeo,
    badgeTrimDiamondGeo,
    forkArchFrameGeo,
    lanternPostGeo,
    lanternGlowGeo,
    deliveryArchGeo,
    deliveryArchGlowGeo,
    cabinSmokeGeo,
  };
}

/**
 * Helper to create a complete pooled single-branch ForkArch gate with swappable stage badge and trim.
 */
export function createForkArchObject(
  gfx: GraphicsUtils,
  assets: ProceduralMeshAssets,
  toonMat: THREE.Material,
  badgeMat: THREE.Material = toonMat,
  stageId?: string | null,
): {
  readonly group: THREE.Group;
  setBadge: (stageId?: string | null, gateHalfWidth?: number) => void;
} {
  const group = new THREE.Group();
  group.name = 'ForkArchLandmark';

  const frameHolder = new THREE.Group();
  frameHolder.name = 'ForkArchFrameHolder';
  const frameMesh = gfx.createMesh(assets.forkArchFrameGeo, toonMat, 'ForkArchFrame');
  const trimCircle = gfx.createMesh(assets.badgeTrimCircleGeo, toonMat, 'ForkGateTrimCircle');
  const trimSquare = gfx.createMesh(assets.badgeTrimSquareGeo, toonMat, 'ForkGateTrimSquare');
  const trimDiamond = gfx.createMesh(assets.badgeTrimDiamondGeo, toonMat, 'ForkGateTrimDiamond');
  frameMesh.castShadow = true;
  trimCircle.castShadow = true;
  trimSquare.castShadow = true;
  trimDiamond.castShadow = true;
  frameHolder.add(frameMesh, trimCircle, trimSquare, trimDiamond);
  group.add(frameHolder);

  const badgeHolder = new THREE.Group();
  badgeHolder.name = 'ForkArchBadgeHolder';
  badgeHolder.position.set(0, 7.55, 0.65);
  const circle = gfx.createMesh(assets.badgeCircleGeo, badgeMat, 'ForkBadgeCircle');
  const square = gfx.createMesh(assets.badgeSquareGeo, badgeMat, 'ForkBadgeSquare');
  const diamond = gfx.createMesh(assets.badgeDiamondGeo, badgeMat, 'ForkBadgeDiamond');
  circle.castShadow = true;
  square.castShadow = true;
  diamond.castShadow = true;
  badgeHolder.add(circle, square, diamond);
  group.add(badgeHolder);

  const setBadge = (nextStageId?: string | null, gateHalfWidth?: number): void => {
    const shape = nextStageId ? (getStageDef(nextStageId)?.badge.shape ?? 'square') : 'square';
    circle.visible = shape === 'circle';
    square.visible = shape === 'square';
    diamond.visible = shape === 'diamond';
    trimCircle.visible = shape === 'circle';
    trimSquare.visible = shape === 'square';
    trimDiamond.visible = shape === 'diamond';

    const scaleX =
      gateHalfWidth !== undefined
        ? Math.min(1.35, Math.max(0.65, (gateHalfWidth - 2.5) / 10.0))
        : 1.0;
    frameHolder.scale.set(scaleX, 1, 1);
  };

  setBadge(stageId);
  return { group, setBadge };
}
