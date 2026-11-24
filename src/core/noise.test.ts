import { describe, expect, it } from 'vitest';
import { fbm2D, gradientNoise2D, ridgedNoise2D } from './noise';

describe('2D deterministic noise', () => {
  it('is deterministic for identical coordinates and seeds, and sensitive to seed changes', () => {
    const coords: readonly [number, number][] = [
      [0.37, 0.81],
      [-4.12, 9.64],
      [123.45, -67.89],
      [-0.5, -0.5],
    ];

    for (const [x, z] of coords) {
      expect(gradientNoise2D(x, z, 42)).toBe(gradientNoise2D(x, z, 42));
      expect(fbm2D(x, z, 42, 4, 2.1, 0.5)).toBe(fbm2D(x, z, 42, 4, 2.1, 0.5));
      expect(ridgedNoise2D(x, z, 42, 4, 2.1, 0.5)).toBe(ridgedNoise2D(x, z, 42, 4, 2.1, 0.5));
    }

    const gradA = coords.map(([x, z]) => gradientNoise2D(x, z, 11));
    const gradB = coords.map(([x, z]) => gradientNoise2D(x, z, 99));
    expect(gradA).not.toEqual(gradB);

    const fbmA = coords.map(([x, z]) => fbm2D(x, z, 11));
    const fbmB = coords.map(([x, z]) => fbm2D(x, z, 99));
    expect(fbmA).not.toEqual(fbmB);

    const ridgeA = coords.map(([x, z]) => ridgedNoise2D(x, z, 11));
    const ridgeB = coords.map(([x, z]) => ridgedNoise2D(x, z, 99));
    expect(ridgeA).not.toEqual(ridgeB);
  });

  it('strictly stays within output bounds with no NaN or Infinity across dense samples', () => {
    for (let ix = -25; ix <= 25; ix++) {
      for (let iz = -25; iz <= 25; iz++) {
        const x = ix * 0.37 + 0.13;
        const z = iz * 0.41 - 0.19;

        const g = gradientNoise2D(x, z, 7);
        const f = fbm2D(x, z, 7, 4, 2.0, 0.5);
        const r = ridgedNoise2D(x, z, 7, 4, 2.0, 0.5);

        expect(Number.isFinite(g)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(-1);
        expect(g).toBeLessThanOrEqual(1);

        expect(Number.isFinite(f)).toBe(true);
        expect(f).toBeGreaterThanOrEqual(-1);
        expect(f).toBeLessThanOrEqual(1);

        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is spatially continuous across positive and negative integer cell boundaries', () => {
    const boundaryPairs: readonly [number, number, number, number][] = [
      [-0.001, 0.37, 0.001, 0.37],
      [0.999, -2.43, 1.001, -2.43],
      [-3.001, 4.18, -2.999, 4.18],
      [2.61, -0.001, 2.61, 0.001],
      [-5.19, 0.999, -5.19, 1.001],
      [7.44, -4.001, 7.44, -3.999],
    ];

    for (const [x0, z0, x1, z1] of boundaryPairs) {
      expect(Math.abs(gradientNoise2D(x0, z0, 123) - gradientNoise2D(x1, z1, 123))).toBeLessThan(0.02);
      expect(Math.abs(fbm2D(x0, z0, 123, 3) - fbm2D(x1, z1, 123, 3))).toBeLessThan(0.03);
      expect(Math.abs(ridgedNoise2D(x0, z0, 123, 3) - ridgedNoise2D(x1, z1, 123, 3))).toBeLessThan(0.04);
    }
  });

  it('reaches scaled gradient magnitudes > 0.72 and ridged extrema near 0 and 1', () => {
    let maxAbsGrad = 0;
    let minRidge1 = 1;
    let maxRidge1 = 0;
    let minRidge3 = 1;
    let maxRidge3 = 0;

    for (let ix = 0; ix < 80; ix++) {
      for (let iz = 0; iz < 80; iz++) {
        const x = ix * 0.23 - 9.1;
        const z = iz * 0.23 - 9.1;

        const g = gradientNoise2D(x, z, 31415);
        maxAbsGrad = Math.max(maxAbsGrad, Math.abs(g));

        const r1 = ridgedNoise2D(x, z, 31415, 1);
        minRidge1 = Math.min(minRidge1, r1);
        maxRidge1 = Math.max(maxRidge1, r1);

        const r3 = ridgedNoise2D(x, z, 31415, 3);
        minRidge3 = Math.min(minRidge3, r3);
        maxRidge3 = Math.max(maxRidge3, r3);
      }
    }

    expect(maxAbsGrad).toBeGreaterThan(0.72);
    expect(minRidge1).toBeLessThan(0.05);
    expect(maxRidge1).toBeGreaterThan(0.95);
    expect(minRidge3).toBeLessThan(0.2);
    expect(maxRidge3).toBeGreaterThan(0.8);
  });

  it('remains stable, continuous, and non-constant at large negative coordinates', () => {
    const baseX = -50000.25;
    const baseZ = -120000.75;
    const vals: number[] = [];

    for (let dx = 0; dx < 12; dx++) {
      for (let dz = 0; dz < 12; dz++) {
        const x = baseX + dx * 0.37;
        const z = baseZ + dz * 0.37;
        const g = gradientNoise2D(x, z, 55);
        const f = fbm2D(x, z, 55);
        const r = ridgedNoise2D(x, z, 55);
        expect(Number.isFinite(g)).toBe(true);
        expect(Number.isFinite(f)).toBe(true);
        expect(Number.isFinite(r)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(-1);
        expect(g).toBeLessThanOrEqual(1);
        expect(f).toBeGreaterThanOrEqual(-1);
        expect(f).toBeLessThanOrEqual(1);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
        vals.push(g);
      }
    }

    const min = Math.min(...vals);
    const max = Math.max(...vals);
    expect(max - min).toBeGreaterThan(0.5);

    // Continuity across integer boundary near large negative coordinates
    expect(
      Math.abs(gradientNoise2D(-50000.001, baseZ, 55) - gradientNoise2D(-49999.999, baseZ, 55)),
    ).toBeLessThan(0.02);
  });

  it('exhibits non-trivial variance across samples for all noise functions', () => {
    const computeVariance = (fn: (x: number, z: number) => number): number => {
      const samples: number[] = [];
      for (let ix = 0; ix < 20; ix++) {
        for (let iz = 0; iz < 20; iz++) {
          samples.push(fn(ix * 0.43 - 4.0, iz * 0.47 - 4.0));
        }
      }
      const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
      return samples.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / samples.length;
    };

    expect(computeVariance((x, z) => gradientNoise2D(x, z, 17))).toBeGreaterThan(0.05);
    expect(computeVariance((x, z) => fbm2D(x, z, 17, 3))).toBeGreaterThan(0.03);
    expect(computeVariance((x, z) => ridgedNoise2D(x, z, 17, 3))).toBeGreaterThan(0.015);
  });

  it('sanitizes invalid coordinates and invalid octave/lacunarity/gain parameters', () => {
    const nonFiniteCoords: readonly [number, number][] = [
      [Number.NaN, 1.5],
      [1.5, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
      [0, Number.NEGATIVE_INFINITY],
    ];

    for (const [x, z] of nonFiniteCoords) {
      expect(gradientNoise2D(x, z, 1)).toBe(0);
      expect(fbm2D(x, z, 1)).toBe(0);
      expect(ridgedNoise2D(x, z, 1)).toBe(0);
    }

    const x = 1.35;
    const z = -2.72;
    expect(fbm2D(x, z, 9, 0)).toBe(fbm2D(x, z, 9, 1));
    expect(fbm2D(x, z, 9, -4)).toBe(fbm2D(x, z, 9, 1));
    expect(fbm2D(x, z, 9, Number.NaN)).toBe(fbm2D(x, z, 9, 1));
    expect(fbm2D(x, z, 9, Number.POSITIVE_INFINITY)).toBe(fbm2D(x, z, 9, 1));
    expect(fbm2D(x, z, 9, 3, 0, 0)).toBe(fbm2D(x, z, 9, 3, 2.0, 0.5));
    expect(fbm2D(x, z, 9, 3, -2, -0.5)).toBe(fbm2D(x, z, 9, 3, 2.0, 0.5));
    expect(fbm2D(x, z, 9, 3, Number.NaN, Number.POSITIVE_INFINITY)).toBe(
      fbm2D(x, z, 9, 3, 2.0, 0.5),
    );

    expect(ridgedNoise2D(x, z, 9, 0)).toBe(ridgedNoise2D(x, z, 9, 1));
    expect(ridgedNoise2D(x, z, 9, -4)).toBe(ridgedNoise2D(x, z, 9, 1));
    expect(ridgedNoise2D(x, z, 9, Number.NaN)).toBe(ridgedNoise2D(x, z, 9, 1));
    expect(ridgedNoise2D(x, z, 9, Number.POSITIVE_INFINITY)).toBe(ridgedNoise2D(x, z, 9, 1));
    expect(ridgedNoise2D(x, z, 9, 3, 0, 0)).toBe(ridgedNoise2D(x, z, 9, 3, 2.0, 0.5));
    expect(ridgedNoise2D(x, z, 9, 3, -2, -0.5)).toBe(ridgedNoise2D(x, z, 9, 3, 2.0, 0.5));
    expect(ridgedNoise2D(x, z, 9, 3, Number.NaN, Number.POSITIVE_INFINITY)).toBe(
      ridgedNoise2D(x, z, 9, 3, 2.0, 0.5),
    );
  });
});
