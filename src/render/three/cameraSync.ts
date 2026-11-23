import * as THREE from 'three';
import { clamp, degToRad, lerp, lerpAngle, radToDeg } from '../../core/math';
import type { CameraPose } from '../../sim/contracts';

const BASE_MIN_VERTICAL_FOV_DEG = 52;
const MIN_VFOV_CLAMP_DEG = 30;
const MAX_VFOV_CLAMP_DEG = 118;

const _scratchPos = new THREE.Vector3();
const _scratchLookAt = new THREE.Vector3();

/**
 * Computes vertical FOV in degrees from a target minimum horizontal FOV + speed boost
 * and the viewport aspect ratio, preventing trail-edge cropping on 9:16 portrait mobile screens.
 */
export function computeVerticalFovDeg(
  minHorizontalFovDeg: number,
  speedFovBoostDeg: number,
  aspect: number,
): number {
  const safeAspect = Math.max(0.25, aspect);
  const targetHorizontalDeg = clamp(minHorizontalFovDeg + speedFovBoostDeg, 35, 130);
  const halfH = degToRad(targetHorizontalDeg) * 0.5;
  const computedVerticalDeg = radToDeg(2 * Math.atan(Math.tan(halfH) / safeAspect));
  const boostedBaseVertical = BASE_MIN_VERTICAL_FOV_DEG + speedFovBoostDeg * 0.6;
  return clamp(Math.max(boostedBaseVertical, computedVerticalDeg), MIN_VFOV_CLAMP_DEG, MAX_VFOV_CLAMP_DEG);
}

/**
 * Interpolates prevCamera -> currCamera with alpha and updates camera transform, roll, and FOV
 * with zero heap allocations.
 */
export function syncPerspectiveCamera(
  camera: THREE.PerspectiveCamera,
  prev: CameraPose,
  curr: CameraPose,
  alpha: number,
  aspect: number,
): void {
  const t = clamp(alpha, 0, 1);

  _scratchPos.set(
    lerp(prev.posX, curr.posX, t),
    lerp(prev.posY, curr.posY, t),
    lerp(prev.posZ, curr.posZ, t),
  );
  _scratchLookAt.set(
    lerp(prev.lookAtX, curr.lookAtX, t),
    lerp(prev.lookAtY, curr.lookAtY, t),
    lerp(prev.lookAtZ, curr.lookAtZ, t),
  );

  camera.position.copy(_scratchPos);
  camera.up.set(0, 1, 0);
  camera.lookAt(_scratchLookAt);

  const rollRad = lerpAngle(prev.rollRad, curr.rollRad, t);
  if (Math.abs(rollRad) > 1e-5) {
    camera.rotateZ(rollRad);
  }

  const minHFov = lerp(prev.minHorizontalFovDeg, curr.minHorizontalFovDeg, t);
  const speedBoost = lerp(prev.speedFovBoostDeg, curr.speedFovBoostDeg, t);
  const nextVfov = computeVerticalFovDeg(minHFov, speedBoost, aspect);

  let projDirty = false;
  if (Math.abs(camera.aspect - aspect) > 1e-5) {
    camera.aspect = aspect;
    projDirty = true;
  }
  if (Math.abs(camera.fov - nextVfov) > 1e-3) {
    camera.fov = nextVfov;
    projDirty = true;
  }
  if (projDirty) {
    camera.updateProjectionMatrix();
  }
}
