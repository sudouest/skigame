const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return (value - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Framerate-independent exponential damping toward target.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  if (dt <= 0) return current;
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Wraps an angle in radians to the half-open interval [-PI, PI).
 */
export function wrapAngle(rad: number): number {
  const shifted = (((rad + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  return shifted - Math.PI;
}

/**
 * Wraps an angle in radians to the half-open interval [0, 2*PI).
 */
export function wrapAnglePositive(rad: number): number {
  return ((rad % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Returns shortest signed angular difference (toRad - fromRad) in [-PI, PI).
 */
export function angleDelta(fromRad: number, toRad: number): number {
  return wrapAngle(toRad - fromRad);
}

/**
 * Shortest-arc linear interpolation between two angles in radians.
 */
export function lerpAngle(fromRad: number, toRad: number, t: number): number {
  return wrapAngle(fromRad + angleDelta(fromRad, toRad) * t);
}

/**
 * Clamps angleRad within +/- maxOffsetRad around centerRad, returning wrapped radians in [-PI, PI).
 */
export function clampAngleAround(
  angleRad: number,
  centerRad: number,
  maxOffsetRad: number,
): number {
  const limit = Math.max(0, maxOffsetRad);
  const delta = clamp(angleDelta(centerRad, angleRad), -limit, limit);
  return wrapAngle(centerRad + delta);
}

export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD_TO_DEG;
}
