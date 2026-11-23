import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  clamp,
  clampAngleAround,
  damp,
  degToRad,
  inverseLerp,
  lerp,
  lerpAngle,
  radToDeg,
  smootherstep,
  smoothstep,
  wrapAngle,
  wrapAnglePositive,
} from './math';

describe('math helpers', () => {
  it('clamps and interpolates linearly', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(4, 0, 10)).toBe(4);

    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(inverseLerp(10, 20, 12.5)).toBe(0.25);
    expect(inverseLerp(5, 5, 10)).toBe(0);
  });

  it('computes smoothstep and smootherstep with edge safety', () => {
    expect(smoothstep(0, 10, -2)).toBe(0);
    expect(smoothstep(0, 10, 12)).toBe(1);
    expect(smoothstep(0, 10, 5)).toBe(0.5);
    expect(smoothstep(5, 5, 5)).toBe(1);
    expect(smoothstep(5, 5, 4)).toBe(0);

    expect(smootherstep(0, 10, 0)).toBe(0);
    expect(smootherstep(0, 10, 10)).toBe(1);
    expect(smootherstep(0, 10, 5)).toBe(0.5);
  });

  it('damps exponentially toward target', () => {
    const start = 0;
    const step1 = damp(start, 10, 5, 1 / 60);
    const step2 = damp(step1, 10, 5, 1 / 60);
    expect(step1).toBeGreaterThan(0);
    expect(step2).toBeGreaterThan(step1);
    expect(step2).toBeLessThan(10);
    expect(damp(3, 10, 5, 0)).toBe(3);
  });

  it('wraps, diffs, interpolates, and clamps angles across the +/-PI seam', () => {
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI * 0.5, 6);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI * 0.5, 6);
    expect(wrapAnglePositive(-Math.PI * 0.5)).toBeCloseTo(Math.PI * 1.5, 6);

    const a = degToRad(170);
    const b = degToRad(-170);
    expect(radToDeg(angleDelta(a, b))).toBeCloseTo(20, 5);
    expect(radToDeg(lerpAngle(a, b, 0.5))).toBeCloseTo(-180, 5);

    // Clamp heading within +/-80 deg around downhill heading at 170 deg
    const clampedRight = clampAngleAround(degToRad(-60), a, degToRad(80));
    expect(radToDeg(angleDelta(a, clampedRight))).toBeCloseTo(80, 5);

    const clampedLeft = clampAngleAround(degToRad(40), a, degToRad(80));
    expect(radToDeg(angleDelta(a, clampedLeft))).toBeCloseTo(-80, 5);
  });
});
