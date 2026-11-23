import * as THREE from 'three';

const POS_QUANT = 10000;

function quantizeKey(x: number, y: number, z: number): string {
  const qx = Math.round(x * POS_QUANT) || 0;
  const qy = Math.round(y * POS_QUANT) || 0;
  const qz = Math.round(z * POS_QUANT) || 0;
  return `${qx},${qy},${qz}`;
}

function accumulateCornerNormal(
  accum: Map<string, [number, number, number]>,
  key: string,
  nx: number,
  ny: number,
  nz: number,
  weight: number,
): void {
  let bucket = accum.get(key);
  if (!bucket) {
    bucket = [0, 0, 0];
    accum.set(key, bucket);
  }
  bucket[0] += nx * weight;
  bucket[1] += ny * weight;
  bucket[2] += nz * weight;
}

function computeCornerAngle(
  ux: number,
  uy: number,
  uz: number,
  vx: number,
  vy: number,
  vz: number,
): number {
  const lenU = Math.hypot(ux, uy, uz);
  const lenV = Math.hypot(vx, vy, vz);
  if (lenU <= 1e-8 || lenV <= 1e-8) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (lenU * lenV)));
  return Math.acos(cos);
}

/**
 * Computes averaged vertex normals across coincident positions into `aSmoothNormal` (`vec3`)
 * while leaving the face-split `normal` attribute intact for crisp cel shading.
 * Uses triangle interior-angle weighting so split/unindexed faces produce unbiased smooth normals.
 */
export function computeSmoothNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) {
    throw new Error('computeSmoothNormals requires a position attribute');
  }

  let normalAttr = geometry.getAttribute('normal');
  if (!normalAttr) {
    geometry.computeVertexNormals();
    normalAttr = geometry.getAttribute('normal');
  }

  const vertexCount = posAttr.count;
  const keys = new Array<string>(vertexCount);
  const usedInTriangle = new Uint8Array(vertexCount);
  const accum = new Map<string, [number, number, number]>();

  for (let i = 0; i < vertexCount; i++) {
    keys[i] = quantizeKey(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
  }

  const indexAttr = geometry.getIndex();
  const triVertexCount = indexAttr ? indexAttr.count : vertexCount;
  const triCount = Math.floor(triVertexCount / 3);

  for (let t = 0; t < triCount; t++) {
    const ia = indexAttr ? indexAttr.getX(t * 3) : t * 3;
    const ib = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const ic = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    const ax = posAttr.getX(ia);
    const ay = posAttr.getY(ia);
    const az = posAttr.getZ(ia);

    const bx = posAttr.getX(ib);
    const by = posAttr.getY(ib);
    const bz = posAttr.getZ(ib);

    const cx = posAttr.getX(ic);
    const cy = posAttr.getY(ic);
    const cz = posAttr.getZ(ic);

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;

    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const bcx = cx - bx;
    const bcy = cy - by;
    const bcz = cz - bz;

    // Skip degenerate zero-area triangles.
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ <= 1e-16) {
      continue;
    }

    const angleA = computeCornerAngle(abx, aby, abz, acx, acy, acz);
    const angleB = computeCornerAngle(-abx, -aby, -abz, bcx, bcy, bcz);
    const angleC = Math.max(0, Math.PI - angleA - angleB);

    usedInTriangle[ia] = 1;
    usedInTriangle[ib] = 1;
    usedInTriangle[ic] = 1;

    accumulateCornerNormal(
      accum,
      keys[ia]!,
      normalAttr.getX(ia),
      normalAttr.getY(ia),
      normalAttr.getZ(ia),
      angleA,
    );
    accumulateCornerNormal(
      accum,
      keys[ib]!,
      normalAttr.getX(ib),
      normalAttr.getY(ib),
      normalAttr.getZ(ib),
      angleB,
    );
    accumulateCornerNormal(
      accum,
      keys[ic]!,
      normalAttr.getX(ic),
      normalAttr.getY(ic),
      normalAttr.getZ(ic),
      angleC,
    );
  }

  for (let i = 0; i < vertexCount; i++) {
    if (usedInTriangle[i] === 0) {
      accumulateCornerNormal(
        accum,
        keys[i]!,
        normalAttr.getX(i),
        normalAttr.getY(i),
        normalAttr.getZ(i),
        1,
      );
    }
  }

  const smoothNormals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const bucket = accum.get(keys[i]!);
    let sx = bucket ? bucket[0] : normalAttr.getX(i);
    let sy = bucket ? bucket[1] : normalAttr.getY(i);
    let sz = bucket ? bucket[2] : normalAttr.getZ(i);
    const len = Math.hypot(sx, sy, sz);
    if (len > 1e-8) {
      sx /= len;
      sy /= len;
      sz /= len;
    } else {
      sx = normalAttr.getX(i);
      sy = normalAttr.getY(i);
      sz = normalAttr.getZ(i);
    }
    smoothNormals[i * 3] = sx;
    smoothNormals[i * 3 + 1] = sy;
    smoothNormals[i * 3 + 2] = sz;
  }

  geometry.setAttribute('aSmoothNormal', new THREE.Float32BufferAttribute(smoothNormals, 3));
  return geometry;
}
