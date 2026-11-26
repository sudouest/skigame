import type { DeliveryZoneDef, VisualSpec } from '../../content/types';
import { clamp, lerp } from '../../core/math';
import {
  CREATURE_PHASE_ATTACK,
  CREATURE_PHASE_TELEGRAPH,
  type MountainFieldView,
} from '../../sim/contracts';
import { isCharacterFrameName, type CharacterFrameName } from './characterSpriteAtlas';

export const CHILD_SLOT_SPREAD_M = 1.45;
/** Must match `zones.celebratingTimer` duration set in `src/sim/skiSimulation.ts` (`2.5`). */
export const CHILD_CELEBRATION_DURATION_SEC = 2.5;
export const CHILD_CELEBRATION_HOP_COUNT = 3;
export const CHILD_CELEBRATION_STAGGER_SEC = 0.13;

export type SpriteAnimLoopMode = 'loop' | 'once' | 'pingpong';

export interface SpriteAnimClip<TFrame extends string = CharacterFrameName> {
  readonly frames: readonly TFrame[];
  readonly fps: number;
  readonly mode: SpriteAnimLoopMode;
}

export interface BillboardAnimPose<TFrame extends string = CharacterFrameName> {
  frame: TFrame;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  /**
   * Screen-space counter-clockwise rotation in radians around the ground pivot `(0, 0)`.
   * Positive values lean the top of the sprite toward screen-left (pitching a right-facing nose upward).
   */
  tiltRad: number;
}

export interface ThreePhaseHopConfig<TFrame extends string = CharacterFrameName> {
  readonly cycleDurationSec: number;
  readonly crouchEndRatio: number;
  readonly landStartRatio: number;
  readonly maxHopHeightM: number;
  readonly crouchSquashY: number;
  readonly takeoffStretchY: number;
  readonly landSquashY: number;
  readonly maxTiltRad: number;
  readonly crouchFrame: TFrame;
  readonly airUpFrame: TFrame;
  readonly airDownFrame?: TFrame;
  readonly landFrame?: TFrame;
}

export interface BallisticHopConfig<TFrame extends string = CharacterFrameName> {
  readonly idleClip: SpriteAnimClip<TFrame>;
  readonly crouchFrame: TFrame;
  readonly airUpFrame: TFrame;
  readonly airDownFrame: TFrame;
  readonly takeoffStretchY: number;
  readonly landSquashY: number;
  readonly maxTiltRad: number;
  readonly airborneThresholdM: number;
}

export interface CreatureAnimMetrics {
  baseWidthM: number;
  baseHeightM: number;
  flipX: boolean;
}

interface CreatureBillboardSpec {
  readonly baseWidthM: number;
  readonly baseHeightM: number;
  readonly spriteFacesRight: boolean;
  evaluate(
    elapsedSec: number,
    phaseCode: number,
    telegraphProgress: number,
    clearanceM: number,
    velY: number,
    movingDirSign: number,
    flipX: boolean,
    creatureIndex: number,
    out: BillboardAnimPose<CharacterFrameName>,
  ): void;
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function clampFinite(v: number, min: number, max: number, fallback: number): number {
  return clamp(finiteOr(v, fallback), min, max);
}

export function createBillboardAnimPose<TFrame extends string = CharacterFrameName>(
  defaultFrame: TFrame = 'child_idle_0' as TFrame,
): BillboardAnimPose<TFrame> {
  return {
    frame: defaultFrame,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    tiltRad: 0,
  };
}

export const CHILD_IDLE_CLIP: SpriteAnimClip<CharacterFrameName> = {
  frames: ['child_idle_0', 'child_idle_1'],
  fps: 2.5,
  mode: 'loop',
};

export const CHILD_HOP_CONFIG: ThreePhaseHopConfig<CharacterFrameName> = {
  cycleDurationSec: 0.68,
  crouchEndRatio: 0.2,
  landStartRatio: 0.84,
  maxHopHeightM: 0.64,
  crouchSquashY: 0.9,
  takeoffStretchY: 1.12,
  landSquashY: 0.86,
  maxTiltRad: 0.09,
  crouchFrame: 'child_crouch',
  airUpFrame: 'child_jump',
};

/**
 * Samples a flipbook frame deterministically from `timeSec` with zero heap allocations.
 */
export function sampleSpriteAnimFrame<TFrame extends string>(
  clip: SpriteAnimClip<TFrame>,
  timeSec: number,
): TFrame {
  const len = clip.frames.length;
  if (len <= 0) {
    throw new Error('SpriteAnimClip requires at least one frame');
  }
  if (len === 1) {
    return clip.frames[0]!;
  }
  const safeTime = Number.isFinite(timeSec) && timeSec > 0 ? timeSec : 0;
  const fps = Number.isFinite(clip.fps) && clip.fps > 0 ? clip.fps : 0;
  const step = Math.floor(safeTime * fps);
  if (!Number.isFinite(step)) {
    return clip.frames[clip.mode === 'once' ? len - 1 : 0]!;
  }

  switch (clip.mode) {
    case 'once':
      return clip.frames[Math.min(step, len - 1)]!;
    case 'loop':
      return clip.frames[step % len]!;
    case 'pingpong': {
      if (len === 2) {
        return clip.frames[step & 1]!;
      }
      const period = 2 * (len - 1);
      const m = step % period;
      const idx = m < len ? m : period - m;
      return clip.frames[idx]!;
    }
    default: {
      const _exhaustive: never = clip.mode;
      return _exhaustive;
    }
  }
}

/**
 * Applies area/volume-preserving squash-and-stretch (`scaleX = 1 / sqrt(scaleY)`).
 */
export function applyVolumePreservingSquash(
  scaleY: number,
  out: { scaleX: number; scaleY: number },
): void {
  const sy = clampFinite(scaleY, 0.5, 1.8, 1);
  out.scaleY = sy;
  out.scaleX = 1 / Math.sqrt(sy);
}

/**
 * Evaluates a C0-continuous 3-phase procedural hop cycle (anticipation crouch -> parabolic air arc
 * -> landing squash) into `out` with zero heap allocations.
 */
export function evaluateThreePhaseHop<TFrame extends string>(
  cycleTimeSec: number,
  config: ThreePhaseHopConfig<TFrame>,
  out: BillboardAnimPose<TFrame>,
): BillboardAnimPose<TFrame> {
  const safeT = Number.isFinite(cycleTimeSec) && cycleTimeSec > 0 ? cycleTimeSec : 0;
  const cycleDur = Math.max(0.05, finiteOr(config.cycleDurationSec, 0.68));
  const cyclePos = safeT / cycleDur;
  const cycleIndex = Math.floor(cyclePos);
  const u = cyclePos - cycleIndex;

  const crouchEnd = clampFinite(config.crouchEndRatio, 0.05, 0.45, 0.2);
  const landStart = clampFinite(config.landStartRatio, crouchEnd + 0.1, 0.95, 0.84);
  const crouchSquash = finiteOr(config.crouchSquashY, 0.9);
  const takeoffStretch = finiteOr(config.takeoffStretchY, 1.12);
  const landSquash = finiteOr(config.landSquashY, 0.86);
  const maxHop = finiteOr(config.maxHopHeightM, 0.64);
  const maxTilt = finiteOr(config.maxTiltRad, 0.09);

  let sy = 1;
  if (u < crouchEnd) {
    const p = u / crouchEnd;
    sy = 1 - (1 - crouchSquash) * Math.sin(p * Math.PI);
    out.offsetY = 0;
    out.tiltRad = 0;
    out.frame = config.crouchFrame;
  } else if (u < landStart) {
    const airT = (u - crouchEnd) / (landStart - crouchEnd);
    out.offsetY = maxHop * 4 * airT * (1 - airT);
    const stretchDelta = takeoffStretch - 1;
    if (airT < 0.5) {
      sy = 1 + stretchDelta * Math.sin(airT * 2 * Math.PI);
    } else {
      sy = 1 + stretchDelta * 0.6 * Math.sin((airT - 0.5) * 2 * Math.PI);
    }
    const tiltSign = (cycleIndex & 1) === 0 ? 1 : -1;
    out.tiltRad = tiltSign * maxTilt * Math.sin(airT * Math.PI);
    out.frame = airT < 0.55 || !config.airDownFrame ? config.airUpFrame : config.airDownFrame;
  } else {
    const landT = (u - landStart) / (1 - landStart);
    sy = 1 - (1 - landSquash) * Math.sin(landT * Math.PI);
    out.offsetY = 0;
    out.tiltRad = 0;
    out.frame = config.landFrame ?? config.crouchFrame;
  }

  applyVolumePreservingSquash(sy, out);
  return out;
}

/**
 * Evaluates a simulation-driven ballistic hop pose (for hopping creatures such as rabbits),
 * producing screen-space CCW `tiltRad` (`movingDirSign = +1` moving screen-right, `-1` screen-left).
 */
export function evaluateBallisticHopPose<TFrame extends string>(
  elapsedSec: number,
  clearanceM: number,
  velY: number,
  movingDirSign: number,
  config: BallisticHopConfig<TFrame>,
  out: BillboardAnimPose<TFrame>,
  crouching = false,
  landingImpact01 = 0,
): BillboardAnimPose<TFrame> {
  const safeElapsed = finiteOr(elapsedSec, 0);
  const safeClearance = finiteOr(clearanceM, 0);
  const safeVelY = finiteOr(velY, 0);
  const safeDir = finiteOr(movingDirSign, 1);
  const safeImpact = clampFinite(landingImpact01, 0, 1, 0);
  const threshold = finiteOr(config.airborneThresholdM, 0.03);
  const maxTilt = finiteOr(config.maxTiltRad, 0.2);

  out.offsetY = 0;
  if (safeClearance > threshold) {
    out.frame = safeVelY >= 0 ? config.airUpFrame : config.airDownFrame;
    const velMag = clampFinite(Math.abs(safeVelY) / 6.0, 0, 1, 0);
    const sy = lerp(1.0, finiteOr(config.takeoffStretchY, 1.15), velMag);
    const dir = safeDir === 0 ? 1 : Math.sign(safeDir);
    const pitchFactor = clampFinite(safeVelY / 6.0, -1, 1, 0);
    out.tiltRad = dir * maxTilt * pitchFactor;
    applyVolumePreservingSquash(sy, out);
  } else if (crouching) {
    out.frame = config.crouchFrame;
    out.tiltRad = 0;
    applyVolumePreservingSquash(finiteOr(config.landSquashY, 0.85), out);
  } else if (safeImpact > 0) {
    out.frame = config.crouchFrame;
    out.tiltRad = 0;
    applyVolumePreservingSquash(lerp(1.0, finiteOr(config.landSquashY, 0.85), safeImpact), out);
  } else {
    out.frame = sampleSpriteAnimFrame(config.idleClip, safeElapsed);
    const sy = 1 + Math.sin(safeElapsed * 4.5) * 0.025;
    out.tiltRad = 0;
    applyVolumePreservingSquash(sy, out);
  }
  return out;
}

/**
 * Evaluates the standing/fluttering idle or staggered 3-hop celebration pose for a child in a DeliveryZone,
 * returning screen-space CCW `tiltRad` (compensated for horizontal mirroring `flipX`).
 */
export function evaluateChildAnimPose(
  elapsedSec: number,
  celebratingTimerSec: number,
  childIndex: number,
  out: BillboardAnimPose<CharacterFrameName>,
  flipX = false,
): BillboardAnimPose<CharacterFrameName> {
  const safeElapsed = finiteOr(elapsedSec, 0);
  const safeTimer = finiteOr(celebratingTimerSec, 0);
  const idx = finiteOr(childIndex, 0);

  if (safeTimer > 0) {
    const celebElapsed = Math.max(0, CHILD_CELEBRATION_DURATION_SEC - safeTimer);
    const staggeredT = celebElapsed - (idx % 4) * CHILD_CELEBRATION_STAGGER_SEC;
    const totalHopWindow = CHILD_CELEBRATION_HOP_COUNT * CHILD_HOP_CONFIG.cycleDurationSec;

    if (staggeredT < 0) {
      out.frame = 'child_crouch';
      out.offsetY = 0;
      out.scaleX = 1;
      out.scaleY = 1;
      out.tiltRad = 0;
      return out;
    }

    if (staggeredT < totalHopWindow) {
      evaluateThreePhaseHop(staggeredT, CHILD_HOP_CONFIG, out);
      if (flipX) {
        out.tiltRad = -out.tiltRad;
      }
      return out;
    }
  }

  out.frame = sampleSpriteAnimFrame(CHILD_IDLE_CLIP, safeElapsed + idx * 0.43);
  out.offsetY = 0;
  const breathY = 1 + Math.sin(safeElapsed * 2.8 + idx * 1.9) * 0.022;
  applyVolumePreservingSquash(breathY, out);
  const rawTilt = Math.sin(safeElapsed * 1.9 + idx * 2.1) * 0.025;
  out.tiltRad = flipX ? -rawTilt : rawTilt;
  return out;
}

/**
 * Evaluates procedural waddle & telegraph pulse for patrolling mountain bears,
 * returning screen-space CCW `tiltRad` (compensated for horizontal mirroring `flipX`).
 */
export function evaluateBearAnimPose(
  elapsedSec: number,
  phaseCode: number,
  telegraphProgress: number,
  creatureIndex: number,
  out: BillboardAnimPose<CharacterFrameName>,
  flipX = false,
): BillboardAnimPose<CharacterFrameName> {
  const safeElapsed = finiteOr(elapsedSec, 0);
  const safeProgress = clampFinite(telegraphProgress, 0, 1, 0);
  const idx = finiteOr(creatureIndex, 0);
  const isTelegraph =
    phaseCode === CREATURE_PHASE_TELEGRAPH || phaseCode === CREATURE_PHASE_ATTACK;
  const pulse = isTelegraph ? 1 + 0.14 * safeProgress : 1;
  out.frame = isTelegraph ? 'bear_telegraph' : 'bear_walk';
  out.offsetY = Math.abs(Math.sin(safeElapsed * 8.5 + idx * 2.1)) * 0.12;
  out.scaleX = pulse;
  out.scaleY = pulse;
  const waddleTilt = Math.sin(safeElapsed * 8.5 + idx * 2.1) * 0.07;
  out.tiltRad = flipX ? -waddleTilt : waddleTilt;
  return out;
}

const CREATURE_BILLBOARD_SPECS: Readonly<Record<string, CreatureBillboardSpec>> = {
  bear_patrol: {
    baseWidthM: 2.55,
    baseHeightM: 2.75,
    spriteFacesRight: false,
    evaluate(
      elapsedSec,
      phaseCode,
      telegraphProgress,
      _clearanceM,
      _velY,
      _movingDirSign,
      flipX,
      creatureIndex,
      out,
    ): void {
      evaluateBearAnimPose(elapsedSec, phaseCode, telegraphProgress, creatureIndex, out, flipX);
    },
  },
};

/**
 * Evaluates a creature billboard pose and visual dimensions into pre-allocated `outPose` and
 * `outMetrics` with zero heap allocations. Returns `false` for non-2.5D creature visuals (e.g., 3D `.glb`).
 */
export function evaluateCreatureAnimEntry(
  defId: string,
  visual: VisualSpec | undefined,
  elapsedSec: number,
  phaseCode: number,
  telegraphProgress: number,
  clearanceM: number,
  velY: number,
  headingRad: number,
  camRightX: number,
  camRightZ: number,
  creatureIndex: number,
  outPose: BillboardAnimPose<CharacterFrameName>,
  outMetrics: CreatureAnimMetrics,
): boolean {
  const safeHeading = finiteOr(headingRad, 0);
  const safeCamRightX = finiteOr(camRightX, 1);
  const safeCamRightZ = finiteOr(camRightZ, 0);
  const fwdX = -Math.sin(safeHeading);
  const fwdZ = -Math.cos(safeHeading);
  const dotRight = fwdX * safeCamRightX + fwdZ * safeCamRightZ;
  const movingDirSign = dotRight === 0 ? 1 : Math.sign(dotRight);

  const spec = CREATURE_BILLBOARD_SPECS[defId];
  if (spec) {
    const scaleMult = visual?.kind === 'procedural' ? finiteOr(visual.scale ?? 1, 1) : 1;
    const flipX = computeCameraRelativeFlipX(
      safeHeading,
      safeCamRightX,
      safeCamRightZ,
      spec.spriteFacesRight,
    );
    spec.evaluate(
      elapsedSec,
      phaseCode,
      telegraphProgress,
      clearanceM,
      velY,
      movingDirSign,
      flipX,
      creatureIndex,
      outPose,
    );
    outMetrics.baseWidthM = spec.baseWidthM * scaleMult;
    outMetrics.baseHeightM = spec.baseHeightM * scaleMult;
    outMetrics.flipX = flipX;
    return true;
  }

  if (visual?.kind === 'billboard' && isCharacterFrameName(visual.frame)) {
    outPose.frame = visual.frame;
    outPose.offsetY = 0;
    outPose.scaleX = 1;
    outPose.scaleY = 1;
    outPose.tiltRad = 0;
    outMetrics.baseWidthM = finiteOr(visual.width, 2);
    outMetrics.baseHeightM = finiteOr(visual.height, 2);
    outMetrics.flipX = computeCameraRelativeFlipX(safeHeading, safeCamRightX, safeCamRightZ, false);
    return true;
  }

  return false;
}

/**
 * Resolves per-slot visual scale for any `DeliveryZoneDef` child entry (`procedural`, `mesh`, or `billboard`).
 */
export function resolveChildVisualScale(
  zoneDef: DeliveryZoneDef | undefined,
  childIndex: number,
): number {
  const childVisual = zoneDef?.childVisuals[childIndex];
  if (!childVisual) return 1.0;
  if (childVisual.kind === 'procedural' || childVisual.kind === 'mesh') {
    return finiteOr(childVisual.scale ?? 1.0, 1.0);
  }
  return 1.0;
}

/**
 * Determines camera-relative horizontal flip so 2.5D moving characters face their screen travel direction
 * even along curved trails.
 */
export function computeCameraRelativeFlipX(
  headingRad: number,
  camRightX: number,
  camRightZ: number,
  spriteFacesRight = false,
): boolean {
  const safeHeading = finiteOr(headingRad, 0);
  const safeRightX = finiteOr(camRightX, 1);
  const safeRightZ = finiteOr(camRightZ, 0);
  const fwdX = -Math.sin(safeHeading);
  const fwdZ = -Math.cos(safeHeading);
  const dotRight = fwdX * safeRightX + fwdZ * safeRightZ;
  return spriteFacesRight ? dotRight < 0 : dotRight > 0;
}

/**
 * Computes terrain-hugging world ground position for each child slot in a DeliveryZone,
 * shared identically by `InstancePools` and `ContactShadows` with zero heap allocations.
 */
export function computeDeliveryChildPosition(
  zonePosX: number,
  zonePosY: number,
  zonePosZ: number,
  zoneYawRad: number,
  childIndex: number,
  childCount: number,
  mountainField: MountainFieldView | undefined,
  outPos: { x: number; y: number; z: number },
): void {
  const safeYaw = finiteOr(zoneYawRad, 0);
  const spread = (childIndex - (childCount - 1) * 0.5) * CHILD_SLOT_SPREAD_M;
  const x = finiteOr(zonePosX, 0) + Math.cos(safeYaw) * spread;
  const z = finiteOr(zonePosZ, 0) - Math.sin(safeYaw) * spread;
  let y = finiteOr(zonePosY, 0);
  if (spread !== 0 && mountainField) {
    y += mountainField.evaluateHeight(x, z) - mountainField.evaluateHeight(zonePosX, zonePosZ);
  }
  outPos.x = x;
  outPos.y = y;
  outPos.z = z;
}
