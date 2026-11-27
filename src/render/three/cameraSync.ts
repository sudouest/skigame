import * as THREE from 'three';
import { PORTRAIT_FOV_TUNING, type PortraitFovTuning } from '../../content/visibilityTuning';
import { clamp, degToRad, lerp, lerpAngle, radToDeg } from '../../core/math';
import type { CameraPose } from '../../sim/contracts';

const _scratchPos = new THREE.Vector3();
const _scratchLookAt = new THREE.Vector3();

/**
 * Computes vertical FOV in degrees from a target minimum horizontal FOV + speed boost
 * and the viewport aspect ratio. When `portraitTuning.enabled` is true, caps extreme
 * wide-angle vertical FOV expansion on narrow portrait screens so characters stay readable
 * while preserving Hor+ framing on landscape displays.
 */
export function computeVerticalFovDeg(
  minHorizontalFovDeg: number,
  speedFovBoostDeg: number,
  aspect: number,
  portraitTuning: PortraitFovTuning = PORTRAIT_FOV_TUNING,
): number {
  const safeAspect = Number.isFinite(aspect) ? Math.max(0.25, aspect) : 16 / 9;
  const safeMinH = Number.isFinite(minHorizontalFovDeg) ? minHorizontalFovDeg : 72;
  const clampedBoost = Number.isFinite(speedFovBoostDeg) ? Math.max(0, speedFovBoostDeg) : 0;
  const targetHorizontalDeg = clamp(safeMinH + clampedBoost, 35, 130);
  const halfH = degToRad(targetHorizontalDeg) * 0.5;
  const fullHorPlusVfov = radToDeg(2 * Math.atan(Math.tan(halfH) / safeAspect));

  const minClamp = clamp(
    Number.isFinite(portraitTuning.minVerticalFovDeg) ? portraitTuning.minVerticalFovDeg : 30,
    1,
    170,
  );
  const baseMinV = Number.isFinite(portraitTuning.baseMinVerticalFovDeg)
    ? portraitTuning.baseMinVerticalFovDeg
    : 52;
  const boostedBaseVertical = baseMinV + clampedBoost * 0.6;

  if (!portraitTuning.enabled) {
    const legacyMax = clamp(
      Number.isFinite(portraitTuning.legacyMaxVerticalFovDeg)
        ? portraitTuning.legacyMaxVerticalFovDeg
        : 118,
      minClamp,
      175,
    );
    return clamp(Math.max(boostedBaseVertical, fullHorPlusVfov), minClamp, legacyMax);
  }

  const hardMax = clamp(
    Number.isFinite(portraitTuning.hardMaxVerticalFovDeg)
      ? portraitTuning.hardMaxVerticalFovDeg
      : 88,
    minClamp,
    175,
  );
  const baseCap = Number.isFinite(portraitTuning.maxBaseVerticalFovDeg)
    ? portraitTuning.maxBaseVerticalFovDeg
    : 82;
  const boostScale = Number.isFinite(portraitTuning.speedBoostScale)
    ? Math.max(0, portraitTuning.speedBoostScale)
    : 0.55;
  const portraitCap = Math.min(hardMax, baseCap + clampedBoost * boostScale);
  const effectiveHorPlus = Math.min(fullHorPlusVfov, portraitCap);
  return clamp(Math.max(boostedBaseVertical, effectiveHorPlus), minClamp, hardMax);
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
  portraitTuning: PortraitFovTuning = PORTRAIT_FOV_TUNING,
): void {
  const t = clamp(alpha, 0, 1);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;

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
  const nextVfov = computeVerticalFovDeg(minHFov, speedBoost, safeAspect, portraitTuning);

  let projDirty = false;
  if (Math.abs(camera.aspect - safeAspect) > 1e-5) {
    camera.aspect = safeAspect;
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
