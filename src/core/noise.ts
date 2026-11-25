import { clamp, lerp } from './math';
import { hashCoords2DU32 } from './rng';

const GRAD2_X = new Float64Array(16);
const GRAD2_Z = new Float64Array(16);

for (let k = 0; k < 16; k++) {
  const angle = (k * Math.PI) / 8;
  GRAD2_X[k] = Math.cos(angle);
  GRAD2_Z[k] = Math.sin(angle);
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradDot2D(ix: number, iz: number, dx: number, dz: number, seed: number): number {
  const idx = hashCoords2DU32(ix, iz, seed) & 15;
  return (GRAD2_X[idx] ?? 0) * dx + (GRAD2_Z[idx] ?? 0) * dz;
}

/**
 * Stateless deterministic 2D gradient (Perlin) noise in [-1, 1] with C^2 quintic fade
 * and Math.SQRT2 amplitude correction for 2D unit gradients.
 */
export function gradientNoise2D(x: number, z: number, seed = 0): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;

  const fx0 = Math.floor(x);
  const fz0 = Math.floor(z);
  const fx = x - fx0;
  const fz = z - fz0;
  const ix = fx0 | 0;
  const iz = fz0 | 0;
  const s = seed | 0;

  const n00 = gradDot2D(ix, iz, fx, fz, s);
  const n10 = gradDot2D((ix + 1) | 0, iz, fx - 1, fz, s);
  const n01 = gradDot2D(ix, (iz + 1) | 0, fx, fz - 1, s);
  const n11 = gradDot2D((ix + 1) | 0, (iz + 1) | 0, fx - 1, fz - 1, s);

  const u = fade(fx);
  const v = fade(fz);
  const nx0 = lerp(n00, n10, u);
  const nx1 = lerp(n01, n11, u);
  const raw = lerp(nx0, nx1, v);

  return clamp(raw * Math.SQRT2, -1, 1);
}

/**
 * Multi-octave fractional Brownian motion (fBm) 2D noise normalized to [-1, 1].
 */
export function fbm2D(
  x: number,
  z: number,
  seed = 0,
  octaves = 3,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;

  const oct = Math.max(1, Math.floor(Number.isFinite(octaves) ? octaves : 1));
  const lac = Number.isFinite(lacunarity) && lacunarity > 0 ? lacunarity : 2.0;
  const g = Number.isFinite(gain) && gain > 0 ? gain : 0.5;
  const baseSeed = seed | 0;

  let freq = 1;
  let amp = 1;
  let sum = 0;
  let ampSum = 0;

  for (let i = 0; i < oct; i++) {
    const octSeed = (baseSeed + Math.imul(i, 1013904223)) | 0;
    sum += amp * gradientNoise2D(x * freq, z * freq, octSeed);
    ampSum += amp;
    freq *= lac;
    amp *= g;
  }

  if (ampSum <= 0 || !Number.isFinite(ampSum)) return 0;
  return clamp(sum / ampSum, -1, 1);
}

const SMOOTH_RIDGE_EPS = 0.08;
const SMOOTH_RIDGE_EPS_SQ = SMOOTH_RIDGE_EPS * SMOOTH_RIDGE_EPS;
const SMOOTH_RIDGE_MIN_RAW =
  (1 - Math.sqrt(1 + SMOOTH_RIDGE_EPS_SQ) + SMOOTH_RIDGE_EPS) *
  (1 - Math.sqrt(1 + SMOOTH_RIDGE_EPS_SQ) + SMOOTH_RIDGE_EPS);
const SMOOTH_RIDGE_INV_SPAN = 1 / (1 - SMOOTH_RIDGE_MIN_RAW);

/**
 * Multi-octave C^2 smooth ridged 2D noise normalized cleanly to [0, 1].
 * Replaces the C^0 |n| cusp with `r_smooth(n) = (1 - sqrt(n^2 + eps^2) + eps)^2` (eps = 0.08),
 * rescaled affinely from [r_smooth(1), 1] to [0, 1].
 */
export function smoothRidgedNoise2D(
  x: number,
  z: number,
  seed = 0,
  octaves = 3,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;

  const oct = Math.max(1, Math.floor(Number.isFinite(octaves) ? octaves : 1));
  const lac = Number.isFinite(lacunarity) && lacunarity > 0 ? lacunarity : 2.0;
  const g = Number.isFinite(gain) && gain > 0 ? gain : 0.5;
  const baseSeed = seed | 0;

  let freq = 1;
  let amp = 1;
  let sum = 0;
  let ampSum = 0;

  for (let i = 0; i < oct; i++) {
    const octSeed = (baseSeed + Math.imul(i, 1013904223)) | 0;
    const n = gradientNoise2D(x * freq, z * freq, octSeed);
    const t = 1 - Math.sqrt(n * n + SMOOTH_RIDGE_EPS_SQ) + SMOOTH_RIDGE_EPS;
    const r = (t * t - SMOOTH_RIDGE_MIN_RAW) * SMOOTH_RIDGE_INV_SPAN;
    sum += amp * r;
    ampSum += amp;
    freq *= lac;
    amp *= g;
  }

  if (ampSum <= 0 || !Number.isFinite(ampSum)) return 0;
  return clamp(sum / ampSum, 0, 1);
}

/**
 * Multi-octave ridged 2D noise normalized to [0, 1].
 * Uses squared ridge shaping: `r = (1 - Math.abs(n)) * (1 - Math.abs(n))` in [0, 1].
 */
export function ridgedNoise2D(
  x: number,
  z: number,
  seed = 0,
  octaves = 3,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;

  const oct = Math.max(1, Math.floor(Number.isFinite(octaves) ? octaves : 1));
  const lac = Number.isFinite(lacunarity) && lacunarity > 0 ? lacunarity : 2.0;
  const g = Number.isFinite(gain) && gain > 0 ? gain : 0.5;
  const baseSeed = seed | 0;

  let freq = 1;
  let amp = 1;
  let sum = 0;
  let ampSum = 0;

  for (let i = 0; i < oct; i++) {
    const octSeed = (baseSeed + Math.imul(i, 1013904223)) | 0;
    const n = gradientNoise2D(x * freq, z * freq, octSeed);
    const t = 1 - Math.abs(n);
    const r = t * t;
    sum += amp * r;
    ampSum += amp;
    freq *= lac;
    amp *= g;
  }

  if (ampSum <= 0 || !Number.isFinite(ampSum)) return 0;
  return clamp(sum / ampSum, 0, 1);
}
