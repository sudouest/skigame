import * as THREE from 'three';
import { buildChimneySmokeQuadGeometry } from './chimneySmoke';
import type { GraphicsUtils } from './graphicsUtils';
import {
  buildMergedColoredGeometry,
  type ColoredGeometryPart,
} from './models/proceduralModelUtils';
import { computeSmoothNormals } from './smoothNormals';

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

export interface ProceduralMeshAssets {
  readonly boulderSmallGeo: THREE.BufferGeometry;
  readonly boulderLargeGeo: THREE.BufferGeometry;
  readonly presentStdGeo: THREE.BufferGeometry;
  readonly presentGoldGeo: THREE.BufferGeometry;
  readonly cabinSmokeGeo: THREE.BufferGeometry;
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

  const cabinSmokeGeo = buildChimneySmokeQuadGeometry('DeliveryCabinSmokeGeo');

  const allGeos = [
    boulderSmallGeo,
    boulderLargeGeo,
    presentStdGeo,
    presentGoldGeo,
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
    cabinSmokeGeo,
  };
}
