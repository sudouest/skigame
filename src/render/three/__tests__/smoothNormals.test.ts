import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { computeSmoothNormals } from '../smoothNormals';

describe('computeSmoothNormals', () => {
  it('preserves hard face normals while computing identical averaged corner normals across split vertices of an indexed BoxGeometry', () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const originalNormals = Float32Array.from(box.getAttribute('normal').array as Float32Array);

    computeSmoothNormals(box);

    const normalAttr = box.getAttribute('normal');
    const smoothAttr = box.getAttribute('aSmoothNormal');
    const posAttr = box.getAttribute('position');

    expect(smoothAttr).toBeDefined();
    expect(smoothAttr.itemSize).toBe(3);
    expect(smoothAttr.count).toBe(posAttr.count);

    // 1. Original face-split normals remain untouched (pure cardinal axes)
    for (let i = 0; i < normalAttr.count; i++) {
      expect(normalAttr.getX(i)).toBeCloseTo(originalNormals[i * 3]!, 6);
      expect(normalAttr.getY(i)).toBeCloseTo(originalNormals[i * 3 + 1]!, 6);
      expect(normalAttr.getZ(i)).toBeCloseTo(originalNormals[i * 3 + 2]!, 6);
    }

    // 2. Group vertices by quantized corner position and verify coincident corners share smooth radial normals
    const byCorner = new Map<string, THREE.Vector3[]>();
    const invSqrt3 = 1 / Math.sqrt(3);

    for (let i = 0; i < posAttr.count; i++) {
      const px = posAttr.getX(i);
      const py = posAttr.getY(i);
      const pz = posAttr.getZ(i);
      const key = `${px.toFixed(2)},${py.toFixed(2)},${pz.toFixed(2)}`;

      const sn = new THREE.Vector3(
        smoothAttr.getX(i),
        smoothAttr.getY(i),
        smoothAttr.getZ(i),
      );
      expect(sn.length()).toBeCloseTo(1, 5);
      expect(sn.x).toBeCloseTo(Math.sign(px) * invSqrt3, 4);
      expect(sn.y).toBeCloseTo(Math.sign(py) * invSqrt3, 4);
      expect(sn.z).toBeCloseTo(Math.sign(pz) * invSqrt3, 4);

      const list = byCorner.get(key) ?? [];
      list.push(sn);
      byCorner.set(key, list);
    }

    expect(byCorner.size).toBe(8);
    for (const [, normalsAtCorner] of byCorner) {
      expect(normalsAtCorner).toHaveLength(3);
      const ref = normalsAtCorner[0]!;
      for (const n of normalsAtCorner) {
        expect(n.distanceTo(ref)).toBeLessThan(1e-5);
      }
    }

    box.dispose();
  });

  it('produces unbiased corner smooth normals even on non-indexed split-triangle boxes', () => {
    const box = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
    computeSmoothNormals(box);

    const posAttr = box.getAttribute('position');
    const smoothAttr = box.getAttribute('aSmoothNormal');
    const invSqrt3 = 1 / Math.sqrt(3);

    for (let i = 0; i < posAttr.count; i++) {
      const px = posAttr.getX(i);
      const py = posAttr.getY(i);
      const pz = posAttr.getZ(i);
      const sx = smoothAttr.getX(i);
      const sy = smoothAttr.getY(i);
      const sz = smoothAttr.getZ(i);

      // Even though different faces contribute 1 vs 2 triangles to a corner, angle-weighting yields (+/-1/sqrt(3))^3
      expect(sx).toBeCloseTo(Math.sign(px) * invSqrt3, 4);
      expect(sy).toBeCloseTo(Math.sign(py) * invSqrt3, 4);
      expect(sz).toBeCloseTo(Math.sign(pz) * invSqrt3, 4);
    }

    box.dispose();
  });
});
