import { clamp } from '../core/math';
import type { VisualSpec } from './types';

/**
 * Aspect-aware portrait vertical FOV capping so narrow mobile screens keep characters readable
 * instead of expanding vertical FOV to extreme wide-angle values (115-118 deg).
 */
export interface PortraitFovTuning {
  readonly enabled: boolean;
  readonly baseMinVerticalFovDeg: number;
  readonly minVerticalFovDeg: number;
  readonly maxBaseVerticalFovDeg: number;
  readonly speedBoostScale: number;
  readonly hardMaxVerticalFovDeg: number;
  readonly legacyMaxVerticalFovDeg: number;
}

export const PORTRAIT_FOV_TUNING: PortraitFovTuning = {
  enabled: true,
  baseMinVerticalFovDeg: 52,
  minVerticalFovDeg: 30,
  maxBaseVerticalFovDeg: 82,
  speedBoostScale: 0.55,
  hardMaxVerticalFovDeg: 88,
  legacyMaxVerticalFovDeg: 118,
};

/**
 * Base lateral spacing (meters) between neighboring waiting children at 1.0x scale.
 */
export const BASE_CHILD_SLOT_SPREAD_M = 1.45;

/**
 * Stylized hero proportions applied visually in the renderer without altering simulation
 * collision radii or physics dimensions.
 */
export interface CharacterScaleTuning {
  readonly enabled: boolean;
  readonly skierScale: number;
  readonly childScale: number;
  readonly childSlotSpreadScale: number;
  readonly creatureScale: number;
}

export const CHARACTER_SCALE_TUNING: CharacterScaleTuning = {
  enabled: true,
  skierScale: 1.25,
  childScale: 1.3,
  childSlotSpreadScale: 1.18,
  creatureScale: 1.15,
};

/**
 * Spring-damped chase camera distances, heights, look-ahead, and FOV baseline.
 * Set `enabled: false` to revert cleanly to `LEGACY_CAMERA_FRAMING_TUNING`.
 */
export interface CameraFramingTuning {
  readonly enabled: boolean;
  readonly trailDistMinM: number;
  readonly trailDistMaxM: number;
  readonly resetTrailDistM: number;
  readonly baseHeightMinM: number;
  readonly baseHeightMaxM: number;
  readonly resetBaseHeightM: number;
  readonly lookAheadM: number;
  readonly minHorizontalFovDeg: number;
  readonly maxSpeedFovBoostDeg: number;
}

export const LEGACY_CAMERA_FRAMING_TUNING: CameraFramingTuning = {
  enabled: false,
  trailDistMinM: 9.4,
  trailDistMaxM: 11.4,
  resetTrailDistM: 10.2,
  baseHeightMinM: 3.4,
  baseHeightMaxM: 4.0,
  resetBaseHeightM: 3.6,
  lookAheadM: 18.0,
  minHorizontalFovDeg: 72,
  maxSpeedFovBoostDeg: 14,
};

export const CAMERA_FRAMING_TUNING: CameraFramingTuning = {
  enabled: true,
  trailDistMinM: 8.2,
  trailDistMaxM: 10.0,
  resetTrailDistM: 8.8,
  baseHeightMinM: 3.15,
  baseHeightMaxM: 3.75,
  resetBaseHeightM: 3.35,
  lookAheadM: 17.0,
  minHorizontalFovDeg: 72,
  maxSpeedFovBoostDeg: 10,
};

/**
 * Portrait-aware smooth-normal inverted-hull outline thickness scaling so 3D silhouettes
 * remain crisp on narrow mobile viewports.
 */
export interface OutlineVisibilityTuning {
  readonly enabled: boolean;
  readonly baseWidthScale: number;
  readonly portraitBoostScale: number;
  readonly maxClipOffsetCeiling: number;
}

export const OUTLINE_VISIBILITY_TUNING: OutlineVisibilityTuning = {
  enabled: true,
  baseWidthScale: 1.0,
  portraitBoostScale: 0.45,
  maxClipOffsetCeiling: 0.024,
};

export interface VisibilityTuning {
  readonly portraitFov: PortraitFovTuning;
  readonly characterScale: CharacterScaleTuning;
  /**
   * Note: `SkiSimulationOptions.cameraFraming` is authoritative for `CameraRig` in simulation.
   * `ThreeRenderer` only reads `cameraFraming.minHorizontalFovDeg` for initial pre-`sync()` setup.
   */
  readonly cameraFraming: CameraFramingTuning;
  readonly outline: OutlineVisibilityTuning;
}

export const DEFAULT_VISIBILITY_TUNING: VisibilityTuning = {
  portraitFov: PORTRAIT_FOV_TUNING,
  characterScale: CHARACTER_SCALE_TUNING,
  cameraFraming: CAMERA_FRAMING_TUNING,
  outline: OUTLINE_VISIBILITY_TUNING,
};

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Extracts a positive finite visual scale factor from a `VisualSpec` (defaulting to `1.0`
 * for billboards or omitted/invalid values).
 */
export function extractVisualScale(visual: VisualSpec | undefined): number {
  if (!visual || visual.kind === 'billboard') return 1.0;
  return positiveFiniteOr(visual.scale, 1.0);
}

/**
 * Computes final visual scale for `SkierRig` from the character definition's base visual scale
 * and `CharacterScaleTuning`.
 */
export function resolveSkierVisualScale(
  defVisualScale?: number,
  tuning: CharacterScaleTuning = CHARACTER_SCALE_TUNING,
): number {
  const baseScale = positiveFiniteOr(defVisualScale, 1.0);
  if (!tuning.enabled) return baseScale;
  return baseScale * positiveFiniteOr(tuning.skierScale, 1.0);
}

/**
 * Returns the visual scale multiplier for waiting/cheering delivery children.
 */
export function resolveChildScaleMultiplier(
  tuning: CharacterScaleTuning = CHARACTER_SCALE_TUNING,
): number {
  if (!tuning.enabled) return 1.0;
  return positiveFiniteOr(tuning.childScale, 1.0);
}

/**
 * Returns the lateral spacing multiplier for multi-child delivery zones.
 */
export function resolveChildSlotSpreadMultiplier(
  tuning: CharacterScaleTuning = CHARACTER_SCALE_TUNING,
): number {
  if (!tuning.enabled) return 1.0;
  return positiveFiniteOr(tuning.childSlotSpreadScale, 1.0);
}

/**
 * Returns the visual scale multiplier for patrolling creatures.
 */
export function resolveCreatureScaleMultiplier(
  tuning: CharacterScaleTuning = CHARACTER_SCALE_TUNING,
): number {
  if (!tuning.enabled) return 1.0;
  return positiveFiniteOr(tuning.creatureScale, 1.0);
}

/**
 * Sanitizes and resolves the active `CameraFramingTuning`, falling back to
 * `LEGACY_CAMERA_FRAMING_TUNING` whenever `tuning.enabled` is false.
 */
export function resolveActiveCameraFraming(
  tuning: CameraFramingTuning = CAMERA_FRAMING_TUNING,
): CameraFramingTuning {
  if (!tuning.enabled) {
    return LEGACY_CAMERA_FRAMING_TUNING;
  }

  const trailDistMinM = positiveFiniteOr(tuning.trailDistMinM, CAMERA_FRAMING_TUNING.trailDistMinM);
  const trailDistMaxM = Math.max(
    trailDistMinM,
    positiveFiniteOr(tuning.trailDistMaxM, CAMERA_FRAMING_TUNING.trailDistMaxM),
  );
  const resetTrailDistM = clamp(
    positiveFiniteOr(tuning.resetTrailDistM, CAMERA_FRAMING_TUNING.resetTrailDistM),
    trailDistMinM,
    trailDistMaxM,
  );

  const baseHeightMinM = positiveFiniteOr(
    tuning.baseHeightMinM,
    CAMERA_FRAMING_TUNING.baseHeightMinM,
  );
  const baseHeightMaxM = Math.max(
    baseHeightMinM,
    positiveFiniteOr(tuning.baseHeightMaxM, CAMERA_FRAMING_TUNING.baseHeightMaxM),
  );
  const resetBaseHeightM = clamp(
    positiveFiniteOr(tuning.resetBaseHeightM, CAMERA_FRAMING_TUNING.resetBaseHeightM),
    baseHeightMinM,
    baseHeightMaxM,
  );

  return {
    enabled: true,
    trailDistMinM,
    trailDistMaxM,
    resetTrailDistM,
    baseHeightMinM,
    baseHeightMaxM,
    resetBaseHeightM,
    lookAheadM: positiveFiniteOr(tuning.lookAheadM, CAMERA_FRAMING_TUNING.lookAheadM),
    minHorizontalFovDeg: positiveFiniteOr(
      tuning.minHorizontalFovDeg,
      CAMERA_FRAMING_TUNING.minHorizontalFovDeg,
    ),
    maxSpeedFovBoostDeg: nonNegativeFiniteOr(
      tuning.maxSpeedFovBoostDeg,
      CAMERA_FRAMING_TUNING.maxSpeedFovBoostDeg,
    ),
  };
}

/**
 * Normalized `[0, 1]` portrait strength: `0` at square/landscape (`aspect >= 1.0`),
 * smoothly ramping to `1` by phone portrait (`aspect <= 0.45`, e.g., 9:20).
 */
export function computePortraitAspectFactor(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 0;
  return clamp((1.0 - aspect) / 0.55, 0, 1);
}
