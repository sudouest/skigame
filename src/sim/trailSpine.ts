import { clamp, degToRad, lerp, smoothstep, smootherstep, wrapAngle } from '../core/math';
import { SeededRng } from '../core/rng';
import type {
  LandscapeProfile,
  PisteSurfaceType,
  SideLandscapeSpec,
  StageDef,
} from '../content/types';
import {
  createSpineFrameOut,
  createSpineProjectionOut,
  type PisteHeightOut,
  type RibbonPointOut,
  type SpineCorridorSideView,
  type SpineForkMeta,
  type SpineFrameOut,
  type SpineMacroNodesView,
  type SpineProjectionOut,
  type SpineView,
} from './contracts';

export const POLYLINE_SPACING_M = 3.0;
export const SPINE_LUT_STEP_M = 1.0;
export const MACRO_NODE_STEP_M = 16;
export const MACRO_LEAF_EXTENSION_M = 224;
export const CORRIDOR_NODE_STEP_M = 12;
export const CORRIDOR_MAX_AMP_TO_RADIUS = 0.70;
export const INNER_WALL_RAMP_LENGTH_M = 25;
export const SEAM_NOSE_RADIUS_M = 1.5;
export const MAX_CURVATURE_RIBBON_RATIO = 0.4;
const SAFE_CURVATURE_RATIO = 0.395;
const COARSE_STRIDE = 8;
const AVOID_EVAL_STEP_M = 6;
const SIBLING_TARGET_CLEARANCE_M = 58;
const COUSIN_TARGET_CLEARANCE_M = 58;
const AVOID_LOOKAHEAD_M = 48;
const RIEMANN_KERNEL_NORM = 35 / 32;

// Broad downhill fall-line cone constraints (|yaw| <= 60 deg mid-segment, fork seams <= 45 deg < 48 deg limit)
const SOFT_OUTWARD_YAW_RAD = degToRad(48);
const HARD_OUTWARD_YAW_RAD = degToRad(57);
const RESTORE_START_YAW_RAD = degToRad(50);
const RESTORE_FULL_YAW_RAD = degToRad(58.5);
const FORK_PULL_WINDOW_M = 85;
const FORK_OUTWARD_START_RAD = degToRad(38);
const FORK_OUTWARD_ZERO_RAD = degToRad(46);
const FORK_RESTORE_START_RAD = degToRad(40);
const FORK_RESTORE_FULL_RAD = degToRad(47.5);

export interface IslandDividerConfig {
  readonly startS: number;
  readonly endS: number;
  readonly maxHalfWidth: number;
  readonly maxHeight: number;
  readonly leftLaneSurface: PisteSurfaceType;
  readonly rightLaneSurface: PisteSurfaceType;
}

export interface TrailSpineConfig {
  readonly id: number;
  readonly stage: StageDef;
  readonly seed: number;
  readonly length: number;
  readonly startPosX: number;
  readonly startPosY: number;
  readonly startPosZ: number;
  readonly startYawRad: number;
  readonly startPitchRad: number;
  readonly startHalfWidth: number;
  readonly endHalfWidth?: number;
  readonly hasFork: boolean;
  readonly leftStageId: string | null;
  readonly rightStageId: string | null;
  readonly isForkChild: boolean;
  readonly forkSide: 'none' | 'left' | 'right';
  readonly seamWorldX: number;
  readonly seamWorldY: number;
  readonly seamWorldZ: number;
  readonly seamYawRad: number;
  readonly allowIslandDivider?: boolean;
  /** True when this spine attaches seamlessly to an upstream parent spine (disables upstream leaf extension). */
  readonly hasUpstreamParent?: boolean;
  /** Optional parent spine ID for tracking downstream child lifecycle on ghost pruning. */
  readonly parentId?: number | null;
  /** Optional nested-shell max yaw envelope (rad) so inner tree shells never outrun outer shells (G2). */
  readonly maxBranchYawRad?: number;
  /** Optional umbrella-fan mid-segment target yaw (rad) for non-crossing planar tree layout (G2). */
  readonly targetBranchYawRad?: number;
  /** Optional bisector yaw (rad) between this fork child and its twin for the signed divergence floor (G2). */
  readonly bisectorYawRad?: number;
  /** Deterministic list of already-integrated sibling/cousin spines to repel laterally during LUT integration (G2). */
  readonly avoidSpines?: readonly TrailSpine[];
}

interface MutableMacroNodes extends SpineMacroNodesView {
  useUpstreamExt: boolean;
  useDownstreamExt: boolean;
  upBoundsMinX: number;
  upBoundsMaxX: number;
  upBoundsMinZ: number;
  upBoundsMaxZ: number;
  downBoundsMinX: number;
  downBoundsMaxX: number;
  downBoundsMinZ: number;
  downBoundsMaxZ: number;
}

interface MutableCorridorSide extends SpineCorridorSideView {
  boundsMinX: number;
  boundsMaxX: number;
  boundsMinZ: number;
  boundsMaxZ: number;
}

interface CurvatureLobe {
  readonly centerS: number;
  readonly sigma: number;
  readonly amplitude: number;
}

/**
 * Computes lateral position x(u) in [-totalSideWidth, +totalSideWidth] using non-linear
 * cubic spacing concentrating triangles across the playable corridor and bank edges.
 */
export function mapRibbonUtoX(u: number, sideTotalWidth: number): number {
  const clampedU = clamp(u, -1, 1);
  return 0.5 * sideTotalWidth * clampedU * (1 + clampedU * clampedU);
}

/**
 * Pure geometric spine & piste height/surface evaluator implementing `SpineView`.
 * Up-locked Yaw-Pitch-Bank frame (never Frenet-Serret), enforcing both the ribbon
 * curvature clamp |k(s)| * (halfWidth + skirtWidth) <= 0.4 and broad downhill
 * fall-line cone |yawRad| <= 60 deg.
 */
export class TrailSpine implements SpineView {
  readonly id: number;
  readonly parentId: number | null;
  readonly stageId: string;
  readonly stage: StageDef;
  readonly landscape: LandscapeProfile;
  readonly seed: number;
  readonly length: number;
  readonly skirtWidth: number;
  readonly divider: IslandDividerConfig | null;

  private readonly _fork: {
    hasFork: boolean;
    leftStageId: string | null;
    rightStageId: string | null;
    isForkChild: boolean;
    forkSide: 'none' | 'left' | 'right';
    innerWallRampLength: number;
    seamNoseRadius: number;
    seamWorldX: number;
    seamWorldY: number;
    seamWorldZ: number;
    seamYawRad: number;
  };

  private _boundsMinX: number;
  private _boundsMaxX: number;
  private _boundsMinZ: number;
  private _boundsMaxZ: number;

  // Pre-integrated spine lookup table at SPINE_LUT_STEP_M spacing
  private readonly lutCount: number;
  private readonly lutStep: number;
  private readonly lutPosX: Float64Array;
  private readonly lutPosY: Float64Array;
  private readonly lutPosZ: Float64Array;
  private readonly lutYaw: Float32Array;
  private readonly lutPitch: Float32Array;
  private readonly lutBank: Float32Array;
  private readonly lutCurvature: Float32Array;
  private readonly lutHalfWidth: Float32Array;
  private readonly lutDividerHalfWidth: Float32Array;

  // Lightweight ~3m spacing centerline polyline for O(1) XZ projections
  readonly polyCount: number;
  readonly polyStep: number;
  readonly polyS: Float32Array;
  readonly polyX: Float64Array;
  readonly polyY: Float64Array;
  readonly polyZ: Float64Array;

  // Precomputed Model 3 coarse 16m macro nodes & open-leaf tangent extensions
  private readonly _macroNodes: MutableMacroNodes;
  // Precomputed Model 3 curvature-clamped 2D side corridor kernel chains
  private readonly _corridorLeft: MutableCorridorSide;
  private readonly _corridorRight: MutableCorridorSide;

  private readonly mogulPhaseA: number;
  private readonly mogulPhaseB: number;
  private readonly mogulAmplitude: number;
  private readonly endYawRad: number;
  private readonly endPitchRad: number;
  private readonly endHalfWidthValue: number;

  // Instance-private scratch buffers (zero hot-loop heap allocations)
  private readonly scratchFrameA: SpineFrameOut = createSpineFrameOut();
  private readonly scratchFrameB: SpineFrameOut = createSpineFrameOut();
  private readonly scratchFrameC: SpineFrameOut = createSpineFrameOut();
  private readonly localHeightScratch = {
    h: 0,
    inCorridor: true,
    inDivider: false,
    dividerMask: 0,
    isInnerFork: false,
  };

  constructor(config: TrailSpineConfig) {
    this.id = config.id;
    this.parentId = config.parentId ?? null;
    this.stage = config.stage;
    this.stageId = config.stage.id;
    this.landscape = config.stage.landscape;
    this.seed = config.seed;
    this.length = Math.max(60, config.length);
    this.skirtWidth = config.stage.terrain.skirtWidth;
    const defaultHalfWidth =
      0.5 * (config.stage.terrain.halfWidth[0] + config.stage.terrain.halfWidth[1]);
    this.endHalfWidthValue = config.endHalfWidth ?? defaultHalfWidth;

    this._fork = {
      hasFork: config.hasFork,
      leftStageId: config.leftStageId,
      rightStageId: config.rightStageId,
      isForkChild: config.isForkChild,
      forkSide: config.forkSide,
      innerWallRampLength: INNER_WALL_RAMP_LENGTH_M,
      seamNoseRadius: SEAM_NOSE_RADIUS_M,
      seamWorldX: config.seamWorldX,
      seamWorldY: config.seamWorldY,
      seamWorldZ: config.seamWorldZ,
      seamYawRad: config.seamYawRad,
    };

    // Derive spine RNG strictly from '.fork("spine")' so gameplay promotion RNG is independent
    const rng = new SeededRng(config.seed).fork('spine');
    this.mogulPhaseA = rng.nextRange(0, Math.PI * 2);
    this.mogulPhaseB = rng.nextRange(0, Math.PI * 2);
    this.mogulAmplitude = config.stage.terrain.mogulDensity * 0.52;

    const baseHalfWidth = rng.nextRange(
      config.stage.terrain.halfWidth[0],
      config.stage.terrain.halfWidth[1],
    );

    // Optional Model B inline IslandDivider (placed safely away from start & fork runway)
    let divider: IslandDividerConfig | null = null;
    if (
      (config.allowIslandDivider ?? true) &&
      this.length >= 220 &&
      rng.nextBool(config.stage.layout.islandDividerChance)
    ) {
      const divStart = rng.nextRange(55, 85);
      const divLen = rng.nextRange(75, Math.min(115, this.length - divStart - 75));
      if (divLen >= 65) {
        const iceLeft = rng.nextBool(0.5);
        const hasIceLane = config.stage.terrain.icePatchChance >= 0.2;
        const primarySurface: PisteSurfaceType = hasIceLane ? 'ice' : 'packed';
        const secondarySurface: PisteSurfaceType = hasIceLane ? 'packed' : 'powder';
        divider = {
          startS: divStart,
          endS: divStart + divLen,
          // G3: Flattened IslandDivider (maxHeight 1.35m, maxHalfWidth [3.0, 3.8]m -> <= 42 deg slope)
          maxHalfWidth: rng.nextRange(3.0, 3.8),
          maxHeight: 1.35,
          leftLaneSurface: iceLeft ? primarySurface : secondarySurface,
          rightLaneSurface: iceLeft ? secondarySurface : primarySurface,
        };
      }
    }
    this.divider = divider;

    // Generate smooth S-curve curvature lobes
    const lobes: CurvatureLobe[] = [];
    const lobeCount = 3;
    const minK = config.stage.terrain.curveStrength[0];
    const maxK = config.stage.terrain.curveStrength[1];
    const startSign =
      config.forkSide === 'left' ? 1 : config.forkSide === 'right' ? -1 : rng.nextBool(0.5) ? 1 : -1;
    for (let i = 0; i < lobeCount; i++) {
      const tCenter = (i + 0.5) / lobeCount;
      const centerS = lerp(45, this.length - 70, tCenter) + rng.nextRange(-12, 12);
      const sigma = rng.nextRange(24, 38);
      const sign = i % 2 === 0 ? startSign : -startSign;
      const amp = sign * rng.nextRange(minK, maxK);
      lobes.push({ centerS, sigma, amplitude: amp });
    }

    // Generate pitch roller/crest harmonics
    const [pitchMinDeg, pitchMaxDeg] = config.stage.terrain.pitchDeg;
    const basePitchDeg = lerp(pitchMinDeg, pitchMaxDeg, 0.5);
    const pitchSwingDeg = Math.max(1.5, (pitchMaxDeg - pitchMinDeg) * 0.45);
    const endPitchDeg = lerp(pitchMinDeg, pitchMaxDeg, 0.45);
    const endPitchTargetRad = -degToRad(endPitchDeg);
    const rollerFreq = config.stage.terrain.rollerFrequency;
    const pitchPhaseA = rng.nextRange(0, Math.PI * 2);
    const pitchPhaseB = rng.nextRange(0, Math.PI * 2);

    // Pre-integrate spine LUT
    this.lutStep = SPINE_LUT_STEP_M;
    this.lutCount = Math.ceil(this.length / this.lutStep) + 1;
    this.lutPosX = new Float64Array(this.lutCount);
    this.lutPosY = new Float64Array(this.lutCount);
    this.lutPosZ = new Float64Array(this.lutCount);
    this.lutYaw = new Float32Array(this.lutCount);
    this.lutPitch = new Float32Array(this.lutCount);
    this.lutBank = new Float32Array(this.lutCount);
    this.lutCurvature = new Float32Array(this.lutCount);
    this.lutHalfWidth = new Float32Array(this.lutCount);
    this.lutDividerHalfWidth = new Float32Array(this.lutCount);

    const evalDividerHalfWidth = (s: number): number => {
      if (!divider || s <= divider.startS || s >= divider.endS) return 0;
      const rampLen = 22;
      const rampIn = smoothstep(divider.startS, divider.startS + rampLen, s);
      const rampOut = 1 - smoothstep(divider.endS - rampLen, divider.endS, s);
      return divider.maxHalfWidth * rampIn * rampOut;
    };

    const evalHalfWidth = (s: number): number => {
      let hw = baseHalfWidth;
      if (config.isForkChild) {
        const blend = smoothstep(0, 38, s);
        hw = lerp(config.startHalfWidth, baseHalfWidth, blend);
      } else if (s < 28) {
        const blend = smoothstep(0, 28, s);
        hw = lerp(config.startHalfWidth, baseHalfWidth, blend);
      }
      hw += evalDividerHalfWidth(s);
      if (config.hasFork && s > this.length - 75) {
        const widen = smoothstep(this.length - 75, this.length - 8, s);
        hw = lerp(hw, this.endHalfWidthValue, widen);
      }
      return hw;
    };

    // Pre-filter avoidSpines once against this spine's generous reachable AABB so the LUT loop
    // only tests ~3-6 nearby spines instead of all ~44 ghosts (cuts soak50km spine build time by ~5x).
    const rawAvoidSpines = config.avoidSpines;
    let avoidSpines: TrailSpine[] | null = null;
    if (rawAvoidSpines && rawAvoidSpines.length > 0) {
      const reachMinX = config.startPosX - this.length - 180;
      const reachMaxX = config.startPosX + this.length + 180;
      const reachMinZ = config.startPosZ - this.length - 220;
      const reachMaxZ = config.startPosZ + 120;
      for (let a = 0; a < rawAvoidSpines.length; a++) {
        const other = rawAvoidSpines[a]!;
        if (
          other.boundsMaxX < reachMinX ||
          other.boundsMinX > reachMaxX ||
          other.boundsMaxZ < reachMinZ ||
          other.boundsMinZ > reachMaxZ
        ) {
          continue;
        }
        if (avoidSpines === null) avoidSpines = [];
        avoidSpines.push(other);
      }
    }
    const avoidProjScratch = avoidSpines !== null ? createSpineProjectionOut() : null;
    const avoidLookProjScratch = avoidSpines !== null ? createSpineProjectionOut() : null;
    // Cache deterministic initial left/right side sign vs each avoidSpine at our entry seam
    // so two converging cousins can never flip repelSign if they briefly pass close to each other.
    const avoidInitSideSign: Int8Array | null =
      avoidSpines !== null && avoidProjScratch ? new Int8Array(avoidSpines.length) : null;
    if (avoidSpines !== null && avoidInitSideSign && avoidProjScratch) {
      const sR0X = Math.cos(config.startYawRad);
      const sR0Z = -Math.sin(config.startYawRad);
      for (let a = 0; a < avoidSpines.length; a++) {
        const other = avoidSpines[a]!;
        other.projectXZ(config.startPosX, config.startPosZ, avoidProjScratch);
        const dot =
          (config.startPosX - avoidProjScratch.spineX) * sR0X +
          (config.startPosZ - avoidProjScratch.spineZ) * sR0Z;
        // dot > 0 => other sits to our left => steer right (repelSign = -1)
        avoidInitSideSign[a] = Math.abs(dot) > 1.0 ? (dot >= 0 ? -1 : 1) : 0;
      }
    }
    const sepSign = config.forkSide === 'left' ? 1 : config.forkSide === 'right' ? -1 : 0;
    // Monotonic 8-rib umbrella-fan target heading (G2):
    // - Mid-segment sweeps cleanly to its assigned umbrella rib (strictly ordered LLL > LLR > LRL > LRR >
    //   RLL > RLR > RRL > RRR) so twins and cousins diverge monotonically with zero wall jams.
    // - Final 95m gently returns fork seams within +/-36 deg (<< +/-48 deg seam invariant).
    const shellPushCapRad = clamp(config.maxBranchYawRad ?? degToRad(52), degToRad(24), degToRad(56));
    const isOuterWing = shellPushCapRad >= degToRad(52);
    const isMidRib = !isOuterWing && shellPushCapRad >= degToRad(40) && shellPushCapRad < degToRad(45);
    const isOuterInnerRib = !isOuterWing && shellPushCapRad >= degToRad(45);
    const midBranchYawRad =
      config.targetBranchYawRad !== undefined
        ? clamp(config.targetBranchYawRad, -degToRad(49), degToRad(49))
        : config.isForkChild && sepSign !== 0
          ? clamp(config.seamYawRad * 0.75 + sepSign * degToRad(18), -degToRad(48), degToRad(48))
          : clamp(config.startYawRad * 0.65, -degToRad(24), degToRad(24));
    const exitBranchYawRad = clamp(midBranchYawRad, -degToRad(35), degToRad(35));
    const bisectorYawRad = config.bisectorYawRad ?? config.seamYawRad * 0.75;
    // Per-shell directional push caps (strictly nested angular firewalls so inner ribs NEVER intrude into outer ribs):
    // - Center ribs (LRR/RLL, +/-5 deg): +/-23 deg dodge (up to +/-28 deg) so RLL always clears LRR even from -36 deg parents.
    // - Mid ribs (LRL/RLR, +/-17 deg): cousin push capped at +/-25 deg, twin push capped at +/-36 deg (8 deg clear of RLL's 28 deg!).
    // - Outer-inner ribs (LLR/RRL, +/-34 deg): capped at +/-42 deg -> >= 13 deg clear for outer wings (LLL/RRR, +/-55 deg).
    const cousinDodgeRad = isMidRib ? degToRad(8) : isOuterInnerRib ? degToRad(9) : degToRad(23);
    const maxPushAbsRad = isOuterWing
      ? degToRad(55)
      : isOuterInnerRib
        ? degToRad(42)
        : isMidRib
          ? degToRad(25)
          : degToRad(28);
    const maxCousinPushLeftRad = isOuterWing
      ? degToRad(55)
      : Math.min(maxPushAbsRad, midBranchYawRad + cousinDodgeRad);
    const maxCousinPushRightRad = isOuterWing
      ? -degToRad(55)
      : Math.max(-maxPushAbsRad, midBranchYawRad - cousinDodgeRad);
    const maxTwinPushAbsRad = isMidRib ? degToRad(36) : degToRad(55);
    const divOutwardTargetM = 36;
    let hasTwinInAvoid = false;
    if (avoidSpines !== null && config.isForkChild) {
      for (let a = 0; a < avoidSpines.length; a++) {
        const other = avoidSpines[a]!;
        if (
          other.fork.isForkChild &&
          config.parentId != null &&
          other.parentId != null &&
          config.parentId === other.parentId
        ) {
          hasTwinInAvoid = true;
          break;
        }
      }
    }

    // Evaluate deterministic lateral repulsion curvature against already-built sibling/cousin spines (G2)
    const evalAvoidRepulsion = (
      s: number,
      hw: number,
      px: number,
      py: number,
      pz: number,
      curYaw: number,
      out: {
        pushK: number;
        dampPos: number;
        dampNeg: number;
        urgentSign: number;
        urgentStrength: number;
        twinUrgent: boolean;
        pitchBiasRad: number;
      },
    ): void => {
      out.pushK = 0;
      out.dampPos = 0;
      out.dampNeg = 0;
      out.urgentSign = 0;
      out.urgentStrength = 0;
      out.twinUrgent = false;
      out.pitchBiasRad = 0;
      if (!avoidSpines || !avoidProjScratch || !avoidLookProjScratch) {
        return;
      }
      const cosY = Math.cos(curYaw);
      const sinY = Math.sin(curYaw);
      const r0X = cosY;
      const r0Z = -sinY;
      const fwdX = -sinY;
      const fwdZ = -cosY;
      const lookX = px + fwdX * AVOID_LOOKAHEAD_M;
      const lookZ = pz + fwdZ * AVOID_LOOKAHEAD_M;

      let posPushMax = 0;
      let negPushMax = 0;
      let twinPushSign = 0;
      let twinPushAmp = 0;
      let twinImminent = false;
      let neighborYWeightSum = 0;
      let neighborYWeightedDiff = 0;

      for (let a = 0; a < avoidSpines.length; a++) {
        const other = avoidSpines[a]!;
        if (
          (px < other.boundsMinX - 240 && lookX < other.boundsMinX - 240) ||
          (px > other.boundsMaxX + 240 && lookX > other.boundsMaxX + 240) ||
          (pz < other.boundsMinZ - 240 && lookZ < other.boundsMinZ - 240) ||
          (pz > other.boundsMaxZ + 240 && lookZ > other.boundsMaxZ + 240)
        ) {
          continue;
        }
        other.projectXZ(px, pz, avoidProjScratch);
        other.projectXZ(lookX, lookZ, avoidLookProjScratch);

        const isTwin =
          config.isForkChild &&
          other.fork.isForkChild &&
          (config.parentId != null && other.parentId != null
            ? config.parentId === other.parentId
            : Math.hypot(
                config.startPosX - other.lutPosX[0]!,
                config.startPosZ - other.lutPosZ[0]!,
              ) <
              Math.max(config.startHalfWidth, other.lutHalfWidth[0]!) * 4 + 4);

        const maxLongExt = isTwin ? 55 : 75;
        const curValid = Math.abs(avoidProjScratch.longExt) <= maxLongExt;
        const lookValid = Math.abs(avoidLookProjScratch.longExt) <= maxLongExt;
        if (!curValid && !lookValid) continue;

        let activeProj = avoidProjScratch;
        let qx = px;
        let qz = pz;
        let bestDSq = curValid ? avoidProjScratch.distSq : Infinity;
        if (lookValid && avoidLookProjScratch.distSq < bestDSq) {
          activeProj = avoidLookProjScratch;
          qx = lookX;
          qz = lookZ;
          bestDSq = avoidLookProjScratch.distSq;
        }

        const dist = Math.sqrt(bestDSq);
        const dx = qx - activeProj.spineX;
        const dz = qz - activeProj.spineZ;
        const dotRight = dx * r0X + dz * r0Z;
        const initSign = avoidInitSideSign ? avoidInitSideSign[a]! : 0;
        // Prefer deterministic entry-seam side sign for non-twins so converging cousins never cross & flip sign
        const repelSign = isTwin
          ? sepSign !== 0
            ? sepSign
            : -1
          : initSign !== 0
            ? initSign
            : Math.abs(dotRight) > 1e-3
              ? dotRight >= 0
                ? -1
                : 1
              : sepSign !== 0
                ? sepSign
                : -1;

        // Mountain-coherent PD vertical sheet coupling for nearby spines within 220m:
        // Combines proportional elevation-difference correction (excessY) with derivative pitch-matching
        // (activeProj.pitchRad - nativePitchRad) when spines pass close so twins/cousins stay on a coherent
        // alpine mountainside (|dY| <= ~22m at close gaps) while isolated runs keep 100% native stage pitch.
        // Note: evalPitch multiplies pitchBiasRad by startBlend = smootherstep(18, 72, s), so G1 (s <= 18) is exact!
        const edgeDist = Math.max(8, dist - hw - activeProj.halfWidth);
        // Project neighbor elevation along its pitch tangent when longExt != 0 so upstream/downstream
        // endpoints contribute their true extrapolated mountainside height rather than a clamped ledge.
        if (dist < 240) {
          const prox = 1 - smootherstep(40, 240, dist);
          const safeDy = Math.min(14, edgeDist * 0.24);
          const otherY =
            activeProj.spineY +
            activeProj.longExt * Math.tan(clamp(activeProj.pitchRad, -1.0, 1.0));
          const yDiff = otherY - py;
          const excessY =
            Math.abs(yDiff) > safeDy ? Math.sign(yDiff) * (Math.abs(yDiff) - safeDy) : 0;
          const tightT = 1 - smootherstep(18, 130, edgeDist);
          const pitchDiff = activeProj.pitchRad - (-degToRad(basePitchDeg));
          const desiredBias =
            clamp(excessY * 0.017, -degToRad(19), degToRad(19)) +
            tightT * clamp(yDiff * 0.006 + pitchDiff * 0.75, -degToRad(16), degToRad(16));
          const yw = prox / (edgeDist * edgeDist + 225);
          neighborYWeightSum += yw;
          neighborYWeightedDiff += yw * desiredBias;
        }

        // Scale lateral clearance with vertical elevation difference and anticipate fork-end widening
        // smoothly over s in [70, 140] before endEnv reduces steering authority near the fork seam.
        const dyAbs = Math.abs(py - activeProj.spineY);
        const verticalClear = isTwin ? Math.min(72, dyAbs * 0.72) : Math.min(96, dyAbs * 0.65);
        const targetBase = isTwin
          ? Math.max(SIBLING_TARGET_CLEARANCE_M, verticalClear)
          : Math.max(COUSIN_TARGET_CLEARANCE_M, verticalClear);
        const widenLook = smootherstep(70, 145, s);
        const effHw = lerp(hw, Math.max(hw, Math.min(24, this.endHalfWidthValue * 0.86)), widenLook);
        const otherEffHw = lerp(
          activeProj.halfWidth,
          Math.max(activeProj.halfWidth, 22),
          widenLook,
        );
        const fullClear = effHw + otherEffHw + targetBase;
        const targetClear = isTwin
          ? lerp(hw + activeProj.halfWidth + 8, fullClear, smootherstep(6, 56, s))
          : fullClear;

        const softBuf = isTwin ? 34 : 52;
        if (dist >= targetClear + softBuf) continue;

        const dampPen = smootherstep(targetClear + softBuf, targetClear + 12, dist);
        const pen = smootherstep(targetClear + softBuf * 0.72, Math.max(0, targetClear - 18), dist);
        const isInwardCousin = !isTwin && config.isForkChild && sepSign !== 0 && repelSign === -sepSign;
        const imminentCousin = !isTwin && dist < hw + activeProj.halfWidth + 20;

        const dampEnv = isInwardCousin
          ? imminentCousin
            ? smootherstep(10, 24, s)
            : smootherstep(18, 40, s)
          : 1.0;
        const effDamp = dampPen * dampEnv;
        if (effDamp > 1e-4) {
          if (repelSign > 0) {
            if (effDamp > out.dampNeg) out.dampNeg = effDamp;
          } else {
            if (effDamp > out.dampPos) out.dampPos = effDamp;
          }
        }

        let pushAmp: number;
        if (isTwin) {
          pushAmp = 0.036 * pen;
        } else if (isInwardCousin) {
          const pushEnv = imminentCousin ? smootherstep(10, 24, s) : smootherstep(20, 44, s);
          const maxCousinPush = imminentCousin ? 0.025 : 0.019;
          pushAmp = maxCousinPush * pen * pushEnv;
        } else {
          pushAmp = 0.025 * pen;
        }

        // Per-shell directional push caps: inner ribs only dodge within their allowed margin around
        // midBranchYawRad AND mid-ribs cap twin push at +/-32 deg so RLR never crowds RRL!
        if (pushAmp > 1e-5) {
          const headroom = isTwin
            ? repelSign < 0
              ? smootherstep(-maxTwinPushAbsRad, -(maxTwinPushAbsRad - degToRad(8)), curYaw)
              : smootherstep(maxTwinPushAbsRad, maxTwinPushAbsRad - degToRad(8), curYaw)
            : repelSign < 0
              ? smootherstep(maxCousinPushRightRad, maxCousinPushRightRad + degToRad(8), curYaw)
              : smootherstep(maxCousinPushLeftRad, maxCousinPushLeftRad - degToRad(8), curYaw);
          pushAmp *= headroom;
        }

        // PD angular-rate damping: stop pushing once already diverging away from `other` at target angle
        // so spines never overshoot by 60 deg and T-bone adjacent cousins!
        if (pushAmp > 1e-5) {
          const otherYaw = Math.atan2(-activeProj.forwardX, -activeProj.forwardZ);
          const divAngle = wrapAngle(curYaw - otherYaw) * repelSign;
          const targetDivAngle = lerp(degToRad(8), isTwin ? degToRad(28) : degToRad(20), pen);
          const rateScale = smootherstep(
            targetDivAngle + degToRad(6),
            targetDivAngle - degToRad(14),
            divAngle,
          );
          pushAmp *= rateScale;
          if (isTwin && pushAmp > twinPushAmp) {
            twinPushAmp = pushAmp;
            twinPushSign = repelSign;
            if (dist < hw + activeProj.halfWidth + 28) {
              twinImminent = true;
            }
          }
        }

        if (pushAmp > 1e-5) {
          if (repelSign > 0) {
            if (pushAmp > posPushMax) posPushMax = pushAmp;
          } else {
            if (pushAmp > negPushMax) negPushMax = pushAmp;
          }
          if (pen > out.urgentStrength) {
            out.urgentStrength = pen;
            out.urgentSign = repelSign;
          }
        }
      }

      // Twin separation overrides opposite-side push AND damping when twin clearance is tight (< hw1+hw2+28m),
      // so distant ghosts on the outside never cancel a fork child's opening away from its own twin!
      if (twinImminent && twinPushAmp > 0) {
        out.twinUrgent = true;
        if (twinPushSign > 0) {
          if (negPushMax > twinPushAmp * 0.25) negPushMax = twinPushAmp * 0.25;
          out.dampPos *= 0.2;
        } else if (twinPushSign < 0) {
          if (posPushMax > twinPushAmp * 0.25) posPushMax = twinPushAmp * 0.25;
          out.dampNeg *= 0.2;
        }
      }
      out.pushK = posPushMax - negPushMax;
      if (neighborYWeightSum > 1e-6) {
        out.pitchBiasRad = clamp(
          neighborYWeightedDiff / neighborYWeightSum,
          -degToRad(18),
          degToRad(18),
        );
      }
    };

    const avoidRepelScratch = {
      pushK: 0,
      dampPos: 0,
      dampNeg: 0,
      urgentSign: 0,
      urgentStrength: 0,
      twinUrgent: false,
      pitchBiasRad: 0,
    };

    const evalCurvature = (
      s: number,
      hw: number,
      curYaw: number,
      px: number,
      pz: number,
      repelPushK: number,
      repelDampPos: number,
      repelDampNeg: number,
      repelUrgentSign: number,
      repelUrgentStrength: number,
      repelTwinUrgent: boolean,
    ): number => {
      const startEnv = smoothstep(0, 10, s);
      const endEnv = 1 - smoothstep(this.length - 58, this.length - 16, s);
      let k = 0;

      // Guaranteed V-wedge branch separation curvature immediately after fork seam
      if (config.isForkChild && s < 72) {
        const sepEnv = smoothstep(0, 5, s) * (1 - smoothstep(40, 72, s));
        const sepAmp = lerp(0.019, 0.022, smootherstep(14, 30, s));
        k += sepSign * sepAmp * sepEnv;
      }

      let lobeK = 0;
      for (let i = 0; i < lobes.length; i++) {
        const lobe = lobes[i]!;
        const d = (s - lobe.centerS) / lobe.sigma;
        if (d > -4.5 && d < 4.5) {
          lobeK += lobe.amplitude * Math.exp(-0.5 * d * d);
        }
      }
      // Keep S-curve oscillations fun while respecting the non-crossing umbrella fan
      lobeK *= config.isForkChild ? 0.48 : 0.72;
      // Prevent random inward S-curve lobes from closing the V-wedge during fork opening
      if (config.isForkChild && sepSign !== 0 && s < 95 && lobeK * sepSign < 0) {
        lobeK *= smootherstep(45, 95, s);
      }
      k += lobeK;

      // G2: Smooth two-stage proportional heading guidance (umbrella rib -> +/-35 deg exit).
      // Delay INWARD guidance (s=52..88) so fork seams open wide before curving inward across a twin's turn.
      const exitBlend = config.hasFork ? smootherstep(this.length - 115, this.length - 25, s) : 0;
      const curTargetYaw = lerp(midBranchYawRad, exitBranchYawRad, exitBlend);
      const yawErr = wrapAngle(curTargetYaw - curYaw);
      const isInwardGuide = config.isForkChild && sepSign !== 0 && yawErr * sepSign < 0;
      const guideEnv = isInwardGuide
        ? smootherstep(52, 88, s)
        : smootherstep(14, 38, s);
      if (guideEnv > 0) {
        k += clamp(yawErr * 0.03, -0.018, 0.018) * guideEnv;
      }

      // G2: Signed fork divergence floor over s in [25, 160].
      // Clamp bisector shift relative to seamYawRad so steep-turning ribs (e.g. LRL when parent arrived at -25 deg)
      // don't falsely treat the umbrella turn as a -50m outward deficit and overshoot into adjacent cousins.
      // When the exact twin is already in avoidSpines, taper off after s=95 so direct twin avoidance takes over.
      const divEndS = hasTwinInAvoid ? Math.min(115, this.length - 45) : Math.min(165, this.length - 45);
      if (config.isForkChild && sepSign !== 0 && s >= 25 && s <= divEndS) {
        const divWin = smootherstep(25, 36, s) * (1 - smootherstep(divEndS - 30, divEndS, s));
        const clampedBisector = clamp(
          bisectorYawRad,
          config.seamYawRad - degToRad(14),
          config.seamYawRad + degToRad(14),
        );
        const refYaw = lerp(config.seamYawRad, clampedBisector, smootherstep(25, 120, s));
        const refRightX = Math.cos(refYaw);
        const refRightZ = -Math.sin(refYaw);
        const latFromSeam = (px - config.seamWorldX) * refRightX + (pz - config.seamWorldZ) * refRightZ;
        // Left child wants latFromSeam < 0 (signedOutward = -latFromSeam); right wants latFromSeam > 0
        const signedOutward = sepSign > 0 ? -latFromSeam : latFromSeam;
        const minOutward = hw + divOutwardTargetM * smootherstep(25, 115, s);
        if (signedOutward < minOutward + 14) {
          const deficit = smootherstep(minOutward + 14, minOutward - 10, signedOutward);
          if (k * sepSign < 0) {
            k *= 1 - deficit * divWin;
          }
          k += sepSign * 0.013 * deficit * divWin;
        }
      }

      // Apply cached deterministic avoidSpines repulsion (damp curvature toward any avoided spine & add push)
      if (k > 0 && repelDampPos > 0) {
        k *= 1 - repelDampPos;
      } else if (k < 0 && repelDampNeg > 0) {
        k *= 1 - repelDampNeg;
      }
      k += repelPushK;

      // Broad downhill fall-line invariant (|yawRad| <= 60 deg) applied prior to seam taper & clamp.
      const absYaw = Math.abs(curYaw);
      const yawSign = curYaw >= 0 ? 1 : -1;
      const forkConeRelax =
        config.isForkChild && s < 65 && yawSign === sepSign ? 1 - smootherstep(35, 65, s) : 0;
      const avoidConeRelax =
        repelUrgentStrength > 0.05 && yawSign === repelUrgentSign
          ? clamp(repelUrgentStrength, 0, 1) * (1 - smoothstep(this.length - 85, this.length - 45, s))
          : 0;
      const coneRelax = Math.max(forkConeRelax, avoidConeRelax);
      const softOutYaw = lerp(SOFT_OUTWARD_YAW_RAD, degToRad(48), coneRelax);
      const hardOutYaw = lerp(HARD_OUTWARD_YAW_RAD, degToRad(57), coneRelax);
      const restoreStartYaw = lerp(RESTORE_START_YAW_RAD, degToRad(50), coneRelax);
      if (absYaw > softOutYaw) {
        if (k * yawSign > 0) {
          k *= 1 - smoothstep(softOutYaw, hardOutYaw, absYaw);
        }
      }
      if (absYaw > restoreStartYaw) {
        const restoreT = smoothstep(restoreStartYaw, RESTORE_FULL_YAW_RAD, absYaw);
        k -= yawSign * 0.022 * restoreT;
      }

      // Stronger pull in the final 75m before a fork seam so seam yaw stays safely within +/-48 deg
      if (config.hasFork && s > this.length - FORK_PULL_WINDOW_M) {
        const forkBlend = smoothstep(
          this.length - FORK_PULL_WINDOW_M,
          this.length - FORK_PULL_WINDOW_M + 15,
          s,
        );
        if (absYaw > FORK_OUTWARD_START_RAD && k * yawSign > 0) {
          k *= 1 - forkBlend * smoothstep(FORK_OUTWARD_START_RAD, FORK_OUTWARD_ZERO_RAD, absYaw);
        }
        if (absYaw > FORK_RESTORE_START_RAD) {
          const forkRestoreT = smoothstep(FORK_RESTORE_START_RAD, FORK_RESTORE_FULL_RAD, absYaw);
          k -= yawSign * 0.020 * forkBlend * forkRestoreT;
        }
      }

      k *= startEnv * endEnv;

      // Enforce non-self-intersection ribbon curvature clamp: |k(s)| * (halfWidth(s) + skirt) <= 0.4
      const maxAllowedK = SAFE_CURVATURE_RATIO / Math.max(1, hw + this.skirtWidth);
      return clamp(k, -maxAllowedK, maxAllowedK);
    };

    let smoothPitchBiasRad = 0;
    const evalPitch = (s: number, pitchBiasRad: number): number => {
      const wave =
        Math.sin(s * rollerFreq * Math.PI * 2 + pitchPhaseA) * 0.65 +
        Math.sin(s * rollerFreq * 1.85 * Math.PI * 2 + pitchPhaseB) * 0.35;
      const rawPitchRad = -degToRad(clamp(basePitchDeg + pitchSwingDeg * wave, 6, 38));
      // G1: Delayed fork pitch divergence over smootherstep(18, 72, s) for smooth V-wedge slope
      const startBlend = config.isForkChild ? smootherstep(18, 72, s) : smoothstep(0, 22, s);
      const endBlend = smoothstep(this.length - 26, this.length - 2, s);
      let p = lerp(config.startPitchRad, rawPitchRad, startBlend);
      p = lerp(p, endPitchTargetRad, endBlend);
      // Apply smooth mountain-coherent neighbor elevation bias strictly after G1 lock (s > 18m)
      p += pitchBiasRad * startBlend;
      return clamp(p, -degToRad(36), -degToRad(7));
    };

    let curX = config.startPosX;
    let curY = config.startPosY;
    let curZ = config.startPosZ;
    let curYaw = wrapAngle(config.startYawRad);

    let minX = curX;
    let maxX = curX;
    let minZ = curZ;
    let maxZ = curZ;
    let maxHalfWidth = 0;

    let smoothPushK = 0;
    let smoothDampPos = 0;
    let smoothDampNeg = 0;
    let smoothUrgentStrength = 0;
    let smoothBank = 0;

    for (let i = 0; i < this.lutCount; i++) {
      const s = Math.min(this.length, i * this.lutStep);
      const hw = evalHalfWidth(s);
      const divHw = evalDividerHalfWidth(s);
      if (avoidSpines && avoidSpines.length > 0 && i % AVOID_EVAL_STEP_M === 0) {
        evalAvoidRepulsion(s, hw, curX, curY, curZ, curYaw, avoidRepelScratch);
      }
      // Smooth staircase avoidSpines samples & banking over ~5-8m so k(s) and bank(s) stay strictly C^1
      // with zero 6m-step sawtooth vertical jumps on banked piste edges!
      smoothPushK += (avoidRepelScratch.pushK - smoothPushK) * 0.25;
      smoothDampPos += (avoidRepelScratch.dampPos - smoothDampPos) * 0.25;
      smoothDampNeg += (avoidRepelScratch.dampNeg - smoothDampNeg) * 0.25;
      smoothUrgentStrength += (avoidRepelScratch.urgentStrength - smoothUrgentStrength) * 0.25;
      smoothPitchBiasRad += (avoidRepelScratch.pitchBiasRad - smoothPitchBiasRad) * 0.14;
      const k = evalCurvature(
        s,
        hw,
        curYaw,
        curX,
        curZ,
        smoothPushK,
        smoothDampPos,
        smoothDampNeg,
        avoidRepelScratch.urgentSign,
        smoothUrgentStrength,
        avoidRepelScratch.twinUrgent,
      );
      const pitch = evalPitch(s, smoothPitchBiasRad);
      const targetBank = clamp(config.stage.terrain.bankingFactor * k * 18.0, -0.28, 0.28);
      smoothBank = i === 0 ? targetBank : smoothBank + (targetBank - smoothBank) * 0.12;
      const bankSeamEnv =
        smoothstep(0, 10, s) * (1 - smoothstep(this.length - 18, this.length - 2, s));
      const bank = smoothBank * bankSeamEnv;

      this.lutPosX[i] = curX;
      this.lutPosY[i] = curY;
      this.lutPosZ[i] = curZ;
      this.lutYaw[i] = curYaw;
      this.lutPitch[i] = pitch;
      this.lutBank[i] = bank;
      this.lutCurvature[i] = k;
      this.lutHalfWidth[i] = hw;
      this.lutDividerHalfWidth[i] = divHw;

      if (curX < minX) minX = curX;
      if (curX > maxX) maxX = curX;
      if (curZ < minZ) minZ = curZ;
      if (curZ > maxZ) maxZ = curZ;
      if (hw > maxHalfWidth) maxHalfWidth = hw;

      if (i < this.lutCount - 1) {
        const nextS = Math.min(this.length, (i + 1) * this.lutStep);
        const stepDs = nextS - s;
        const midS = s + 0.5 * stepDs;
        const midHw = evalHalfWidth(midS);
        const midYawEst = wrapAngle(curYaw + 0.5 * k * stepDs);
        const cosP0 = Math.cos(pitch);
        const midXEst = curX - cosP0 * Math.sin(midYawEst) * (0.5 * stepDs);
        const midZEst = curZ - cosP0 * Math.cos(midYawEst) * (0.5 * stepDs);
        const midK = evalCurvature(
          midS,
          midHw,
          midYawEst,
          midXEst,
          midZEst,
          avoidRepelScratch.pushK,
          avoidRepelScratch.dampPos,
          avoidRepelScratch.dampNeg,
          avoidRepelScratch.urgentSign,
          avoidRepelScratch.urgentStrength,
          avoidRepelScratch.twinUrgent,
        );
        const midYaw = wrapAngle(curYaw + 0.5 * midK * stepDs);
        const midPitch = evalPitch(midS, smoothPitchBiasRad);

        const cosP = Math.cos(midPitch);
        const tx = -cosP * Math.sin(midYaw);
        const ty = Math.sin(midPitch);
        const tz = -cosP * Math.cos(midYaw);

        curX += tx * stepDs;
        curY += ty * stepDs;
        curZ += tz * stepDs;
        curYaw = wrapAngle(curYaw + midK * stepDs);
      }
    }

    const boundsPad = maxHalfWidth + this.skirtWidth + 2;
    this._boundsMinX = minX - boundsPad;
    this._boundsMaxX = maxX + boundsPad;
    this._boundsMinZ = minZ - boundsPad;
    this._boundsMaxZ = maxZ + boundsPad;

    const lastIdx = this.lutCount - 1;
    this.endYawRad = this.lutYaw[lastIdx]!;
    this.endPitchRad = this.lutPitch[lastIdx]!;

    // Ensure fork seam world anchor matches the actual exit seam at s = length
    if (this._fork.hasFork) {
      this._fork.seamWorldX = this.lutPosX[lastIdx]!;
      this._fork.seamWorldY = this.lutPosY[lastIdx]!;
      this._fork.seamWorldZ = this.lutPosZ[lastIdx]!;
      this._fork.seamYawRad = this.endYawRad;
    }

    // Build ~3m centerline polyline directly from pre-integrated 1m LUT (zero trig)
    this.polyStep = POLYLINE_SPACING_M;
    this.polyCount = Math.ceil(this.length / this.polyStep) + 1;
    this.polyS = new Float32Array(this.polyCount);
    this.polyX = new Float64Array(this.polyCount);
    this.polyY = new Float64Array(this.polyCount);
    this.polyZ = new Float64Array(this.polyCount);
    const polyStride = Math.round(this.polyStep / this.lutStep);
    for (let i = 0; i < this.polyCount; i++) {
      const isLast = i === this.polyCount - 1;
      const idx = isLast ? lastIdx : Math.min(lastIdx, i * polyStride);
      this.polyS[i] = isLast ? this.length : i * this.polyStep;
      this.polyX[i] = this.lutPosX[idx]!;
      this.polyY[i] = this.lutPosY[idx]!;
      this.polyZ[i] = this.lutPosZ[idx]!;
    }

    // Build Model 3 coarse ~16m midpoint-spaced macro nodes + open-leaf tangent extensions
    const useUpstreamExt = !(config.hasUpstreamParent ?? false);
    this._macroNodes = this.buildMacroNodes(useUpstreamExt);

    // Build Model 3 curvature-clamped 2D side corridor kernel chains (zero caustics, |A|/R <= 0.82)
    this._corridorLeft = this.buildCorridorSide(-1, this.landscape.left, useUpstreamExt);
    this._corridorRight = this.buildCorridorSide(1, this.landscape.right, useUpstreamExt);
  }

  get fork(): SpineForkMeta {
    return this._fork;
  }

  get macroNodes(): SpineMacroNodesView {
    return this._macroNodes;
  }

  get corridorLeft(): SpineCorridorSideView {
    return this._corridorLeft;
  }

  get corridorRight(): SpineCorridorSideView {
    return this._corridorRight;
  }

  /**
   * Marks whether this spine currently has downstream child spines attached in TrailWindow.
   * Open-leaf spines keep straight-tangent downstream macro nodes so far horizons never flatten.
   */
  setHasDownstreamChildren(hasChildren: boolean): void {
    this._macroNodes.useDownstreamExt = !hasChildren;
  }

  private buildMacroNodes(useUpstreamExt: boolean): MutableMacroNodes {
    const count = Math.max(4, Math.round(this.length / MACRO_NODE_STEP_M));
    const step = this.length / count;
    const posX = new Float64Array(count);
    const posY = new Float64Array(count);
    const posZ = new Float64Array(count);
    const fwdX = new Float32Array(count);
    const fwdY = new Float32Array(count);
    const fwdZ = new Float32Array(count);
    const halfWidth = new Float32Array(count);

    const lastIdx = this.lutCount - 1;
    const invLutStep = 1 / this.lutStep;
    for (let i = 0; i < count; i++) {
      const s = (i + 0.5) * step;
      const fIdx = s * invLutStep;
      const i0 = Math.min(lastIdx - 1, Math.floor(fIdx));
      const i1 = i0 + 1;
      const s0 = i0 * this.lutStep;
      const s1 = i1 === lastIdx ? this.length : i1 * this.lutStep;
      const t = clamp((s - s0) / Math.max(1e-6, s1 - s0), 0, 1);

      const yaw0 = this.lutYaw[i0]!;
      const yawRad = wrapAngle(yaw0 + wrapAngle(this.lutYaw[i1]! - yaw0) * t);
      const pitchRad = lerp(this.lutPitch[i0]!, this.lutPitch[i1]!, t);
      const cosP = Math.cos(pitchRad);

      posX[i] = lerp(this.lutPosX[i0]!, this.lutPosX[i1]!, t);
      posY[i] = lerp(this.lutPosY[i0]!, this.lutPosY[i1]!, t);
      posZ[i] = lerp(this.lutPosZ[i0]!, this.lutPosZ[i1]!, t);
      fwdX[i] = -cosP * Math.sin(yawRad);
      fwdY[i] = Math.sin(pitchRad);
      fwdZ[i] = -cosP * Math.cos(yawRad);
      halfWidth[i] = lerp(this.lutHalfWidth[i0]!, this.lutHalfWidth[i1]!, t);
    }

    const extCount = Math.floor(MACRO_LEAF_EXTENSION_M / MACRO_NODE_STEP_M);
    const upExtX = new Float64Array(extCount);
    const upExtY = new Float64Array(extCount);
    const upExtZ = new Float64Array(extCount);
    const upYaw = this.lutYaw[0]!;
    const upPitch = this.lutPitch[0]!;
    const upCosP = Math.cos(upPitch);
    const upFwdX = -upCosP * Math.sin(upYaw);
    const upFwdY = Math.sin(upPitch);
    const upFwdZ = -upCosP * Math.cos(upYaw);
    const upHw = this.lutHalfWidth[0]!;
    const upBaseX = this.lutPosX[0]!;
    const upBaseY = this.lutPosY[0]!;
    const upBaseZ = this.lutPosZ[0]!;
    let upMinX = Infinity;
    let upMaxX = -Infinity;
    let upMinZ = Infinity;
    let upMaxZ = -Infinity;
    for (let i = 0; i < extCount; i++) {
      const ds = -((i + 0.5) * MACRO_NODE_STEP_M);
      const px = upBaseX + upFwdX * ds;
      const py = upBaseY + upFwdY * ds;
      const pz = upBaseZ + upFwdZ * ds;
      upExtX[i] = px;
      upExtY[i] = py;
      upExtZ[i] = pz;
      if (px < upMinX) upMinX = px;
      if (px > upMaxX) upMaxX = px;
      if (pz < upMinZ) upMinZ = pz;
      if (pz > upMaxZ) upMaxZ = pz;
    }

    const downExtX = new Float64Array(extCount);
    const downExtY = new Float64Array(extCount);
    const downExtZ = new Float64Array(extCount);
    const dnYaw = this.lutYaw[lastIdx]!;
    const dnPitch = this.lutPitch[lastIdx]!;
    const dnCosP = Math.cos(dnPitch);
    const dnFwdX = -dnCosP * Math.sin(dnYaw);
    const dnFwdY = Math.sin(dnPitch);
    const dnFwdZ = -dnCosP * Math.cos(dnYaw);
    const dnHw = this.lutHalfWidth[lastIdx]!;
    const dnBaseX = this.lutPosX[lastIdx]!;
    const dnBaseY = this.lutPosY[lastIdx]!;
    const dnBaseZ = this.lutPosZ[lastIdx]!;
    let dnMinX = Infinity;
    let dnMaxX = -Infinity;
    let dnMinZ = Infinity;
    let dnMaxZ = -Infinity;
    for (let i = 0; i < extCount; i++) {
      const ds = (i + 0.5) * MACRO_NODE_STEP_M;
      const px = dnBaseX + dnFwdX * ds;
      const py = dnBaseY + dnFwdY * ds;
      const pz = dnBaseZ + dnFwdZ * ds;
      downExtX[i] = px;
      downExtY[i] = py;
      downExtZ[i] = pz;
      if (px < dnMinX) dnMinX = px;
      if (px > dnMaxX) dnMaxX = px;
      if (pz < dnMinZ) dnMinZ = pz;
      if (pz > dnMaxZ) dnMaxZ = pz;
    }

    return {
      count,
      posX,
      posY,
      posZ,
      fwdX,
      fwdY,
      fwdZ,
      halfWidth,
      useUpstreamExt,
      useDownstreamExt: true,
      upExtCount: extCount,
      upExtX,
      upExtY,
      upExtZ,
      upExtFwdX: upFwdX,
      upExtFwdY: upFwdY,
      upExtFwdZ: upFwdZ,
      upExtHalfWidth: upHw,
      upBoundsMinX: upMinX,
      upBoundsMaxX: upMaxX,
      upBoundsMinZ: upMinZ,
      upBoundsMaxZ: upMaxZ,
      downExtCount: extCount,
      downExtX,
      downExtY,
      downExtZ,
      downExtFwdX: dnFwdX,
      downExtFwdY: dnFwdY,
      downExtFwdZ: dnFwdZ,
      downExtHalfWidth: dnHw,
      downBoundsMinX: dnMinX,
      downBoundsMaxX: dnMaxX,
      downBoundsMinZ: dnMinZ,
      downBoundsMaxZ: dnMaxZ,
    };
  }

  private buildCorridorSide(
    sideSign: -1 | 1,
    spec: SideLandscapeSpec,
    includeUpstreamExt: boolean,
  ): MutableCorridorSide {
    const baseR = this.computeBaseCorridorRadius(spec);
    const spineNodeCount = Math.max(4, Math.round(this.length / CORRIDOR_NODE_STEP_M));
    const stepS = this.length / spineNodeCount;
    const upExtCount = includeUpstreamExt ? 8 : 0;
    const hasFarRim = spec.archetype === 'chasm' && spec.farWallOffsetM !== undefined;
    const farRimCount = hasFarRim ? spineNodeCount : 0;
    const baseCount = upExtCount + spineNodeCount;
    const totalCount = baseCount + farRimCount;

    const posX = new Float64Array(totalCount);
    const posZ = new Float64Array(totalCount);
    const radius = new Float32Array(totalCount);
    const invRadiusSq = new Float32Array(totalCount);
    const kernelWeight = new Float32Array(totalCount);
    const ampMag = new Float32Array(totalCount);
    const forkEnvArr = new Float32Array(totalCount);

    const isInnerForkSide =
      this._fork.isForkChild &&
      ((this._fork.forkSide === 'left' && sideSign === 1) ||
        (this._fork.forkSide === 'right' && sideSign === -1));

    const lastIdx = this.lutCount - 1;
    const invLutStep = 1 / this.lutStep;

    let writeIdx = 0;
    if (upExtCount > 0) {
      const upYaw = this.lutYaw[0]!;
      const upPitch = this.lutPitch[0]!;
      const cosY0 = Math.cos(upYaw);
      const sinY0 = Math.sin(upYaw);
      const cosP0 = Math.cos(upPitch);
      const fwdX0 = -cosP0 * sinY0;
      const fwdZ0 = -cosP0 * cosY0;
      const baseX0 = this.lutPosX[0]!;
      const baseZ0 = this.lutPosZ[0]!;
      const dEff = this.lutHalfWidth[0]! + baseR;
      const amp = Math.min(spec.reliefScale, CORRIDOR_MAX_AMP_TO_RADIUS * baseR);
      const invBaseRSq = 1 / (baseR * baseR);
      for (let i = upExtCount - 1; i >= 0; i--) {
        const ds = -((i + 0.5) * CORRIDOR_NODE_STEP_M);
        posX[writeIdx] = baseX0 + fwdX0 * ds + sideSign * dEff * cosY0;
        posZ[writeIdx] = baseZ0 + fwdZ0 * ds - sideSign * dEff * sinY0;
        radius[writeIdx] = baseR;
        invRadiusSq[writeIdx] = invBaseRSq;
        ampMag[writeIdx] = amp;
        forkEnvArr[writeIdx] = 1.0;
        writeIdx++;
      }
    }

    const farR = 36;
    const invFarRSq = 1 / (farR * farR);
    const farAmp = 18; // |A|/R = 0.50 (gentle <= 42 deg rim)
    const farOffsetBeyondHw =
      (spec.archetype === 'chasm' ? (spec.farWallOffsetM ?? 75) : 75) + 28;

    for (let i = 0; i < spineNodeCount; i++) {
      const s = (i + 0.5) * stepS;
      const fIdx = s * invLutStep;
      const i0 = Math.min(lastIdx - 1, Math.floor(fIdx));
      const i1 = i0 + 1;
      const s0 = i0 * this.lutStep;
      const s1 = i1 === lastIdx ? this.length : i1 * this.lutStep;
      const t = clamp((s - s0) / Math.max(1e-6, s1 - s0), 0, 1);

      const spX = lerp(this.lutPosX[i0]!, this.lutPosX[i1]!, t);
      const spZ = lerp(this.lutPosZ[i0]!, this.lutPosZ[i1]!, t);
      const yaw0 = this.lutYaw[i0]!;
      const yaw = wrapAngle(yaw0 + wrapAngle(this.lutYaw[i1]! - yaw0) * t);
      const pitch = lerp(this.lutPitch[i0]!, this.lutPitch[i1]!, t);
      const k = lerp(this.lutCurvature[i0]!, this.lutCurvature[i1]!, t);
      const hw = lerp(this.lutHalfWidth[i0]!, this.lutHalfWidth[i1]!, t);
      const dNom = hw + baseR;

      // Medial-safe inner-turn clamp: strictly inside 0.70 * cos(pitch) / |k(s)|
      let dEff = dNom;
      let innerCurvFrac = 0;
      let rXz = Infinity;
      const absK = Math.abs(k);
      if (k * sideSign < 0 && absK > 1e-5) {
        rXz = Math.cos(pitch) / absK;
        const maxInnerOffset = 0.7 * rXz;
        if (maxInnerOffset < dEff) {
          dEff = maxInnerOffset;
        }
        innerCurvFrac = clamp(dEff / Math.max(1, rXz), 0, 0.7);
      }

      // Keep ball inner edge tangential to own piste edge (dEff - rEff >= hw)
      const availR = Math.max(6, dEff - hw);
      const rEff = Math.min(baseR, availR);
      // Enforce strict slope budget |A| / R <= 0.82 (<= 0.85), smoothly attenuated on tight concave inner turns so normalY >= 0.42
      const tightInnerT = smootherstep(0.3, 0.7, innerCurvFrac);
      const slopeBudget = CORRIDOR_MAX_AMP_TO_RADIUS * lerp(1.0, 0.72, tightInnerT);
      const amp = Math.min(spec.reliefScale, slopeBudget * rEff);
      const r0X = Math.cos(yaw);
      const r0Z = -Math.sin(yaw);

      posX[writeIdx] = spX + sideSign * dEff * r0X;
      posZ[writeIdx] = spZ + sideSign * dEff * r0Z;
      radius[writeIdx] = rEff;
      invRadiusSq[writeIdx] = 1 / (rEff * rEff);
      ampMag[writeIdx] = amp;
      forkEnvArr[writeIdx] = isInnerForkSide ? smootherstep(24, 84, s) : 1.0;
      writeIdx++;

      // Bounded chasm far rim over [farWallOffsetM, farWallOffsetM + 35]m (negative ampMag encodes positive far-rim lift!)
      // Strictly omitted/faded inside tight inner turns so it never crosses the center of curvature.
      if (hasFarRim) {
        const farIdx = baseCount + i;
        const dFar = hw + farOffsetBeyondHw;
        const innerFade =
          rXz < Infinity ? 1 - smootherstep(0.45, 0.7, dFar / Math.max(1, rXz)) : 1.0;
        posX[farIdx] = spX + sideSign * dFar * r0X;
        posZ[farIdx] = spZ + sideSign * dFar * r0Z;
        radius[farIdx] = farR;
        invRadiusSq[farIdx] = invFarRSq;
        ampMag[farIdx] = -farAmp;
        forkEnvArr[farIdx] = (isInnerForkSide ? smootherstep(40, 100, s) : 1.0) * innerFade;
      }
    }

    // Compute Riemann arc-length weights separately for primary chain [0..baseCount) and optional far rim [baseCount..totalCount)
    let bMinX = Infinity;
    let bMaxX = -Infinity;
    let bMinZ = Infinity;
    let bMaxZ = -Infinity;
    const finalizeRange = (start: number, end: number): void => {
      const len = end - start;
      for (let i = start; i < end; i++) {
        const px = posX[i]!;
        const pz = posZ[i]!;
        const rEff = radius[i]!;
        let segLen = stepS;
        if (len > 1) {
          if (i === start) {
            segLen = Math.hypot(posX[i + 1]! - px, posZ[i + 1]! - pz);
          } else if (i === end - 1) {
            segLen = Math.hypot(px - posX[i - 1]!, pz - posZ[i - 1]!);
          } else {
            const dPrev = Math.hypot(px - posX[i - 1]!, pz - posZ[i - 1]!);
            const dNext = Math.hypot(posX[i + 1]! - px, posZ[i + 1]! - pz);
            segLen = 0.5 * (dPrev + dNext);
          }
          segLen = clamp(segLen, 0.25 * stepS, 1.85 * stepS);
        }
        const kw = RIEMANN_KERNEL_NORM * (segLen / rEff) * forkEnvArr[i]!;
        kernelWeight[i] = kw;
        if (kw > 1e-5) {
          if (px - rEff < bMinX) bMinX = px - rEff;
          if (px + rEff > bMaxX) bMaxX = px + rEff;
          if (pz - rEff < bMinZ) bMinZ = pz - rEff;
          if (pz + rEff > bMaxZ) bMaxZ = pz + rEff;
        }
      }
    };
    finalizeRange(0, baseCount);
    if (farRimCount > 0) {
      finalizeRange(baseCount, totalCount);
    }

    return {
      sideSign,
      count: totalCount,
      posX,
      posZ,
      radius,
      invRadiusSq,
      kernelWeight,
      ampMag,
      boundsMinX: bMinX,
      boundsMaxX: bMaxX,
      boundsMinZ: bMinZ,
      boundsMaxZ: bMaxZ,
    };
  }

  private computeBaseCorridorRadius(spec: SideLandscapeSpec): number {
    switch (spec.archetype) {
      case 'chasm': {
        const minSlopeR = spec.reliefScale / 0.84;
        let baseR = Math.max(minSlopeR, spec.transitionWidth * 2.1, 38);
        if (spec.farWallOffsetM !== undefined) {
          const maxFarR = Math.max(minSlopeR, spec.farWallOffsetM * 0.58);
          baseR = clamp(baseR, minSlopeR, maxFarR);
        }
        return baseR;
      }
      case 'canyonWalls':
        return Math.max(spec.reliefScale / 0.8, spec.transitionWidth * 1.5, 28);
      case 'alpineBowl':
        return Math.max(spec.reliefScale / 0.6, spec.transitionWidth * 1.45, 34);
      case 'rollingHills':
      default:
        return Math.max(spec.reliefScale / 0.45, spec.transitionWidth * 1.35, 32);
    }
  }

  get boundsMinX(): number {
    return this._boundsMinX;
  }

  get boundsMaxX(): number {
    return this._boundsMaxX;
  }

  get boundsMinZ(): number {
    return this._boundsMinZ;
  }

  get boundsMaxZ(): number {
    return this._boundsMaxZ;
  }

  getEndPose(): {
    posX: number;
    posY: number;
    posZ: number;
    yawRad: number;
    pitchRad: number;
    halfWidth: number;
  } {
    const lastIdx = this.lutCount - 1;
    return {
      posX: this.lutPosX[lastIdx]!,
      posY: this.lutPosY[lastIdx]!,
      posZ: this.lutPosZ[lastIdx]!,
      yawRad: this.endYawRad,
      pitchRad: this.endPitchRad,
      halfWidth: this.endHalfWidthValue,
    };
  }

  /**
   * Detects convex crest brow drop-offs along the pre-integrated LUT for post-brow obstacle clearance.
   */
  collectCrestBrows(outBrows: number[]): void {
    outBrows.length = 0;
    for (let i = 10; i < this.lutCount - 14; i += 4) {
      const pBefore = this.lutPitch[i - 6]!;
      const pAfter = this.lutPitch[i + 6]!;
      const dropSlope = (pAfter - pBefore) / (12 * this.lutStep);
      if (dropSlope < -0.0045) {
        const browS = i * this.lutStep;
        if (outBrows.length === 0 || browS - outBrows[outBrows.length - 1]! > 22) {
          outBrows.push(browS);
        }
      }
    }
  }

  /**
   * Shifts all stored world-space polyline points, LUT anchors, fork seam coordinates,
   * and AABB bounds by subtracting (deltaX, deltaY, deltaZ) during floating-origin rebasing.
   */
  rebaseOrigin(deltaX: number, deltaY: number, deltaZ: number): void {
    for (let i = 0; i < this.lutCount; i++) {
      this.lutPosX[i] = this.lutPosX[i]! - deltaX;
      this.lutPosY[i] = this.lutPosY[i]! - deltaY;
      this.lutPosZ[i] = this.lutPosZ[i]! - deltaZ;
    }
    for (let i = 0; i < this.polyCount; i++) {
      this.polyX[i] = this.polyX[i]! - deltaX;
      this.polyY[i] = this.polyY[i]! - deltaY;
      this.polyZ[i] = this.polyZ[i]! - deltaZ;
    }
    const mn = this._macroNodes;
    for (let i = 0; i < mn.count; i++) {
      mn.posX[i] = mn.posX[i]! - deltaX;
      mn.posY[i] = mn.posY[i]! - deltaY;
      mn.posZ[i] = mn.posZ[i]! - deltaZ;
    }
    for (let i = 0; i < mn.upExtCount; i++) {
      mn.upExtX[i] = mn.upExtX[i]! - deltaX;
      mn.upExtY[i] = mn.upExtY[i]! - deltaY;
      mn.upExtZ[i] = mn.upExtZ[i]! - deltaZ;
    }
    for (let i = 0; i < mn.downExtCount; i++) {
      mn.downExtX[i] = mn.downExtX[i]! - deltaX;
      mn.downExtY[i] = mn.downExtY[i]! - deltaY;
      mn.downExtZ[i] = mn.downExtZ[i]! - deltaZ;
    }
    mn.upBoundsMinX -= deltaX;
    mn.upBoundsMaxX -= deltaX;
    mn.upBoundsMinZ -= deltaZ;
    mn.upBoundsMaxZ -= deltaZ;
    mn.downBoundsMinX -= deltaX;
    mn.downBoundsMaxX -= deltaX;
    mn.downBoundsMinZ -= deltaZ;
    mn.downBoundsMaxZ -= deltaZ;

    this.rebaseCorridorSide(this._corridorLeft, deltaX, deltaZ);
    this.rebaseCorridorSide(this._corridorRight, deltaX, deltaZ);

    this._fork.seamWorldX -= deltaX;
    this._fork.seamWorldY -= deltaY;
    this._fork.seamWorldZ -= deltaZ;

    this._boundsMinX -= deltaX;
    this._boundsMaxX -= deltaX;
    this._boundsMinZ -= deltaZ;
    this._boundsMaxZ -= deltaZ;
  }

  private rebaseCorridorSide(side: MutableCorridorSide, deltaX: number, deltaZ: number): void {
    for (let i = 0; i < side.count; i++) {
      side.posX[i] = side.posX[i]! - deltaX;
      side.posZ[i] = side.posZ[i]! - deltaZ;
    }
    side.boundsMinX -= deltaX;
    side.boundsMaxX -= deltaX;
    side.boundsMinZ -= deltaZ;
    side.boundsMaxZ -= deltaZ;
  }

  sampleSpineFrame(s: number, out: SpineFrameOut): void {
    const clampedS = clamp(s, 0, this.length);
    const fIdx = clampedS / this.lutStep;
    const i0 = Math.min(this.lutCount - 2, Math.floor(fIdx));
    const i1 = i0 + 1;
    const s0 = i0 * this.lutStep;
    const s1 = i1 === this.lutCount - 1 ? this.length : i1 * this.lutStep;
    const span = Math.max(1e-6, s1 - s0);
    const t = clamp((clampedS - s0) / span, 0, 1);

    const posX = lerp(this.lutPosX[i0]!, this.lutPosX[i1]!, t);
    const posY = lerp(this.lutPosY[i0]!, this.lutPosY[i1]!, t);
    const posZ = lerp(this.lutPosZ[i0]!, this.lutPosZ[i1]!, t);

    const yaw0 = this.lutYaw[i0]!;
    const yaw1 = this.lutYaw[i1]!;
    const yawDelta = wrapAngle(yaw1 - yaw0);
    const yawRad = wrapAngle(yaw0 + yawDelta * t);
    const pitchRad = lerp(this.lutPitch[i0]!, this.lutPitch[i1]!, t);
    const bankRad = lerp(this.lutBank[i0]!, this.lutBank[i1]!, t);
    const curvature = lerp(this.lutCurvature[i0]!, this.lutCurvature[i1]!, t);
    const halfWidth = lerp(this.lutHalfWidth[i0]!, this.lutHalfWidth[i1]!, t);
    const dividerHalfWidth = lerp(
      this.lutDividerHalfWidth[i0]!,
      this.lutDividerHalfWidth[i1]!,
      t,
    );

    const sinY = Math.sin(yawRad);
    const cosY = Math.cos(yawRad);
    const sinP = Math.sin(pitchRad);
    const cosP = Math.cos(pitchRad);

    // Right-handed +Y up, 0 yaw faces -Z: forward = (-cosP*sinY, sinP, -cosP*cosY)
    const fwdX = -cosP * sinY;
    const fwdY = sinP;
    const fwdZ = -cosP * cosY;

    // Horizontal unbanked right R0 = normalize(T x (0,1,0)) = (cosY, 0, -sinY)
    const r0X = cosY;
    const r0Z = -sinY;

    // Up-locked orthogonal U0 = R0 x T = (sinP*sinY, cosP, sinP*cosY)
    const u0X = sinP * sinY;
    const u0Y = cosP;
    const u0Z = sinP * cosY;

    // Banked right R = cos(bank)*R0 + sin(bank)*U0 (tilts right edge up on left turns)
    const cosB = Math.cos(bankRad);
    const sinB = Math.sin(bankRad);

    out.posX = posX;
    out.posY = posY;
    out.posZ = posZ;
    out.forwardX = fwdX;
    out.forwardY = fwdY;
    out.forwardZ = fwdZ;
    out.rightX = cosB * r0X + sinB * u0X;
    out.rightY = sinB * u0Y;
    out.rightZ = cosB * r0Z + sinB * u0Z;
    out.yawRad = yawRad;
    out.pitchRad = pitchRad;
    out.bankRad = bankRad;
    out.curvature = curvature;
    out.halfWidth = halfWidth;
    out.skirtWidth = this.skirtWidth;
    out.dividerHalfWidth = dividerHalfWidth;
  }

  /**
   * Projects world XZ coordinates onto the clamped [0, length] spine centerline,
   * refining s against the continuous spine frame and computing exact Euclidean distSq,
   * horizontal signedX, and signed longitudinal extension longExt past seam endpoints.
   */
  projectXZ(wx: number, wz: number, out: SpineProjectionOut): void {
    let bestPolyDistSq = Infinity;
    let bestS = 0;

    // Coarse pass: chords spanning COARSE_STRIDE polyline edges locate the neighbourhood,
    // then only the fine edges inside that window are tested (~8x fewer edge tests).
    const polyX = this.polyX;
    const polyZ = this.polyZ;
    const polyS = this.polyS;
    const lastEdge = this.polyCount - 1;
    let fineStart = 0;
    let fineEnd = lastEdge;
    if (lastEdge > COARSE_STRIDE * 2) {
      let bestChordDistSq = Infinity;
      let bestChordStart = 0;
      for (let k = 0; k < lastEdge; k += COARSE_STRIDE) {
        const k2 = k + COARSE_STRIDE < lastEdge ? k + COARSE_STRIDE : lastEdge;
        const cax = polyX[k]!;
        const caz = polyZ[k]!;
        const cdx = polyX[k2]! - cax;
        const cdz = polyZ[k2]! - caz;
        const cLenSq = cdx * cdx + cdz * cdz;
        let ct = cLenSq > 1e-8 ? ((wx - cax) * cdx + (wz - caz) * cdz) / cLenSq : 0;
        if (ct < 0) ct = 0;
        else if (ct > 1) ct = 1;
        const cex = wx - (cax + ct * cdx);
        const cez = wz - (caz + ct * cdz);
        const cd = cex * cex + cez * cez;
        if (cd < bestChordDistSq) {
          bestChordDistSq = cd;
          bestChordStart = k;
        }
      }
      fineStart = bestChordStart > COARSE_STRIDE ? bestChordStart - COARSE_STRIDE : 0;
      const fe = bestChordStart + COARSE_STRIDE * 2;
      fineEnd = fe < lastEdge ? fe : lastEdge;
    }

    for (let i = fineStart; i < fineEnd; i++) {
      const ax = polyX[i]!;
      const az = polyZ[i]!;
      const dx = polyX[i + 1]! - ax;
      const dz = polyZ[i + 1]! - az;
      const lenSq = dx * dx + dz * dz;
      let t = lenSq > 1e-8 ? ((wx - ax) * dx + (wz - az) * dz) / lenSq : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = wx - (ax + t * dx);
      const ez = wz - (az + t * dz);
      const dSq = ex * ex + ez * ez;
      if (dSq < bestPolyDistSq) {
        bestPolyDistSq = dSq;
        const sA = polyS[i]!;
        bestS = sA + t * (polyS[i + 1]! - sA);
      }
    }

    // Refine s against continuous spine tangent (1 damped step) via direct LUT reads
    // (skips unused banking trig & full SpineFrameOut writes).
    const lutStep = this.lutStep;
    const maxI0 = this.lutCount - 2;
    const lastLutIdx = this.lutCount - 1;
    const lutPosX = this.lutPosX;
    const lutPosZ = this.lutPosZ;
    const lutYaw = this.lutYaw;
    const lutPitch = this.lutPitch;

    let finalS = bestS;
    let i0 = Math.floor(finalS / lutStep);
    if (i0 > maxI0) i0 = maxI0;
    else if (i0 < 0) i0 = 0;
    let i1 = i0 + 1;
    let s0 = i0 * lutStep;
    let s1 = i1 === lastLutIdx ? this.length : i1 * lutStep;
    let span = s1 - s0;
    let t = span > 1e-6 ? clamp((finalS - s0) / span, 0, 1) : 0;

    let accPosX = lutPosX[i0]! + (lutPosX[i1]! - lutPosX[i0]!) * t;
    let accPosZ = lutPosZ[i0]! + (lutPosZ[i1]! - lutPosZ[i0]!) * t;
    let curDx = wx - accPosX;
    let curDz = wz - accPosZ;
    let curDistSq = curDx * curDx + curDz * curDz;

    let yaw0 = lutYaw[i0]!;
    let accYaw = wrapAngle(yaw0 + wrapAngle(lutYaw[i1]! - yaw0) * t);
    let accPitch = lutPitch[i0]! + (lutPitch[i1]! - lutPitch[i0]!) * t;
    let sinY = Math.sin(accYaw);
    let cosY = Math.cos(accYaw);
    let cosP = Math.cos(accPitch);

    const remFwd0 = curDx * -sinY + curDz * -cosY;
    const deltaS = clamp(remFwd0 / (cosP > 0.3 ? cosP : 0.3), -this.polyStep, this.polyStep);
    const candS = clamp(finalS + deltaS, 0, this.length);
    if (candS !== finalS) {
      let ci0 = Math.floor(candS / lutStep);
      if (ci0 > maxI0) ci0 = maxI0;
      else if (ci0 < 0) ci0 = 0;
      const ci1 = ci0 + 1;
      const cs0 = ci0 * lutStep;
      const cs1 = ci1 === lastLutIdx ? this.length : ci1 * lutStep;
      const cSpan = cs1 - cs0;
      const ct = cSpan > 1e-6 ? clamp((candS - cs0) / cSpan, 0, 1) : 0;
      const cPosX = lutPosX[ci0]! + (lutPosX[ci1]! - lutPosX[ci0]!) * ct;
      const cPosZ = lutPosZ[ci0]! + (lutPosZ[ci1]! - lutPosZ[ci0]!) * ct;
      const dx1 = wx - cPosX;
      const dz1 = wz - cPosZ;
      const distSq1 = dx1 * dx1 + dz1 * dz1;
      if (distSq1 <= curDistSq) {
        finalS = candS;
        i0 = ci0;
        i1 = ci1;
        t = ct;
        accPosX = cPosX;
        accPosZ = cPosZ;
        curDx = dx1;
        curDz = dz1;
        curDistSq = distSq1;
        yaw0 = lutYaw[i0]!;
        accYaw = wrapAngle(yaw0 + wrapAngle(lutYaw[i1]! - yaw0) * t);
        accPitch = lutPitch[i0]! + (lutPitch[i1]! - lutPitch[i0]!) * t;
        sinY = Math.sin(accYaw);
        cosY = Math.cos(accYaw);
        cosP = Math.cos(accPitch);
      }
    }

    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;
    const sinP = Math.sin(accPitch);

    const alongFwd = curDx * fwdX + curDz * fwdZ;
    const signedX = curDx * rightX + curDz * rightZ;

    let longExt = 0;
    if (finalS === 0 && alongFwd < 0) {
      longExt = alongFwd;
    } else if (finalS === this.length && alongFwd > 0) {
      longExt = alongFwd;
    }

    out.s = finalS;
    out.signedX = signedX;
    out.longExt = longExt;
    out.distSq = curDistSq;
    out.spineX = accPosX;
    out.spineY = this.lutPosY[i0]! + (this.lutPosY[i1]! - this.lutPosY[i0]!) * t;
    out.spineZ = accPosZ;
    out.forwardX = -cosP * sinY;
    out.forwardY = sinP;
    out.forwardZ = -cosP * cosY;
    out.rightX = rightX;
    out.rightZ = rightZ;
    out.pitchRad = accPitch;
    out.halfWidth = this.lutHalfWidth[i0]! + (this.lutHalfWidth[i1]! - this.lutHalfWidth[i0]!) * t;
    out.dividerHalfWidth =
      this.lutDividerHalfWidth[i0]! +
      (this.lutDividerHalfWidth[i1]! - this.lutDividerHalfWidth[i0]!) * t;
  }

  /**
   * Evaluates groomed piste elevation (spineY + x * rightY + moguls + divider) for MountainField,
   * intentionally omitting the legacy 3.6m outer ribbon snowbank wall.
   */
  evaluatePisteHeight(s: number, x: number, out: PisteHeightOut): void {
    const clampedS = clamp(s, 0, this.length);
    let i0 = Math.floor(clampedS / this.lutStep);
    const maxI0 = this.lutCount - 2;
    if (i0 > maxI0) i0 = maxI0;
    else if (i0 < 0) i0 = 0;
    const i1 = i0 + 1;
    const s0 = i0 * this.lutStep;
    const s1 = i1 === this.lutCount - 1 ? this.length : i1 * this.lutStep;
    const span = s1 - s0;
    const t = span > 1e-6 ? clamp((clampedS - s0) / span, 0, 1) : 0;

    const posY = this.lutPosY[i0]! + (this.lutPosY[i1]! - this.lutPosY[i0]!) * t;
    const pitchRad = this.lutPitch[i0]! + (this.lutPitch[i1]! - this.lutPitch[i0]!) * t;
    const bankRad = this.lutBank[i0]! + (this.lutBank[i1]! - this.lutBank[i0]!) * t;
    const hw = this.lutHalfWidth[i0]! + (this.lutHalfWidth[i1]! - this.lutHalfWidth[i0]!) * t;
    const divHw =
      this.lutDividerHalfWidth[i0]! +
      (this.lutDividerHalfWidth[i1]! - this.lutDividerHalfWidth[i0]!) * t;
    const rightY = Math.sin(bankRad) * Math.cos(pitchRad);
    const coreH = this.computePisteCoreHeight(clampedS, x, hw, divHw);

    out.heightY = posY + x * rightY + coreH;
    out.dividerHalfWidth = divHw;
    out.inDivider = this.localHeightScratch.inDivider;
    out.dividerMask = this.localHeightScratch.dividerMask;
  }

  evaluatePisteSurface(s: number, x: number): PisteSurfaceType {
    const clampedS = clamp(s, 0, this.length);
    this.sampleSpineFrame(clampedS, this.scratchFrameA);
    return this.evaluatePisteSurfaceWithFrame(
      clampedS,
      x,
      this.scratchFrameA.halfWidth,
      this.scratchFrameA.dividerHalfWidth,
    );
  }

  evaluatePisteSurfaceWithFrame(
    s: number,
    x: number,
    hw: number,
    divHw: number,
  ): PisteSurfaceType {
    if (Math.abs(x) > hw || (divHw > 0.05 && Math.abs(x) < divHw)) {
      return 'powder';
    }
    if (divHw > 0.1 && this.divider && s >= this.divider.startS && s <= this.divider.endS) {
      return x < 0 ? this.divider.leftLaneSurface : this.divider.rightLaneSurface;
    }
    return 'packed';
  }

  evaluateRibbonPoint(s: number, u: number, out: RibbonPointOut): void {
    const clampedS = clamp(s, 0, this.length);
    const clampedU = clamp(u, -1, 1);
    this.sampleSpineFrame(clampedS, this.scratchFrameA);
    const hw = this.scratchFrameA.halfWidth;
    const isInnerFork =
      (this._fork.forkSide === 'left' && clampedU > 0) ||
      (this._fork.forkSide === 'right' && clampedU < 0);
    const effSkirt = isInnerFork ? this.computeInnerForkSkirtWidth(clampedS) : this.skirtWidth;
    const x = mapRibbonUtoX(clampedU, hw + effSkirt);
    this.evaluateSurfaceAtXInternal(clampedS, x, effSkirt, out);
  }

  evaluateSurfaceAtX(s: number, x: number, out: RibbonPointOut): void {
    const clampedS = clamp(s, 0, this.length);
    const isInnerFork =
      (this._fork.forkSide === 'left' && x > 0) || (this._fork.forkSide === 'right' && x < 0);
    const effSkirt = isInnerFork ? this.computeInnerForkSkirtWidth(clampedS) : this.skirtWidth;
    this.evaluateSurfaceAtXInternal(clampedS, x, effSkirt, out);
  }

  private computeInnerForkSkirtWidth(s: number): number {
    // Expands smoothly inside the V-wedge divergence gap between nextLeft and nextRight
    const d = Math.max(0, s - 2);
    return Math.min(this.skirtWidth, 0.005 * d * d);
  }

  private computePisteCoreHeight(s: number, x: number, hw: number, divHw: number): number {
    const absX = Math.abs(x);
    // Taper mogul bumps to 0 near seams for C0/C1-flush attachment across epsS derivative window
    const seamEnv = smoothstep(2, 12, s) * (1 - smoothstep(this.length - 12, this.length - 2, s));
    const corridorFade = 1 - smoothstep(hw * 0.72, hw, absX);

    let h = 0;
    if (this.mogulAmplitude > 0.001 && corridorFade > 0) {
      const m =
        Math.sin(s * 0.31 + this.mogulPhaseA) * Math.cos(x * 0.42 + this.mogulPhaseB);
      h += this.mogulAmplitude * m * corridorFade * seamEnv;
    }

    let inDivider = false;
    let dividerMask = 0;
    if (divHw > 0.001 && absX < divHw && this.divider) {
      inDivider = true;
      const tDiv = 1 - absX / divHw;
      const heightScale = divHw / Math.max(0.01, this.divider.maxHalfWidth);
      const hermite = tDiv * tDiv * (3 - 2 * tDiv);
      dividerMask = clamp(heightScale * hermite, 0, 1);
      h += this.divider.maxHeight * dividerMask;
    }

    this.localHeightScratch.h = h;
    this.localHeightScratch.inCorridor = absX <= hw && !inDivider;
    this.localHeightScratch.inDivider = inDivider;
    this.localHeightScratch.dividerMask = dividerMask;
    return h;
  }

  private computeLocalHeight(
    s: number,
    x: number,
    hw: number,
    divHw: number,
    effectiveSkirt: number,
  ): number {
    const absX = Math.abs(x);
    const isInnerFork =
      ((this._fork.forkSide === 'left' && x > hw) ||
        (this._fork.forkSide === 'right' && x < -hw)) &&
      this._fork.isForkChild;

    let h = this.computePisteCoreHeight(s, x, hw, divHw);
    if (absX > hw) {
      const excess = absX - hw;
      const denom = isInnerFork ? Math.max(1.5, effectiveSkirt) : Math.max(0.5, this.skirtWidth);
      const tBank = clamp(excess / denom, 0, 1);
      let bankH = 3.6 * tBank * tBank * (3 - 2 * tBank);
      if (isInnerFork) {
        bankH *= smootherstep(0, this._fork.innerWallRampLength, s);
      }
      h += bankH;
    }

    this.localHeightScratch.h = h;
    this.localHeightScratch.isInnerFork = isInnerFork;
    return h;
  }

  private evaluateSurfaceAtXInternal(
    s: number,
    x: number,
    effectiveSkirt: number,
    out: RibbonPointOut,
  ): void {
    this.sampleSpineFrame(s, this.scratchFrameA);
    const hw = this.scratchFrameA.halfWidth;
    const divHw = this.scratchFrameA.dividerHalfWidth;
    const centerH = this.computeLocalHeight(s, x, hw, divHw, effectiveSkirt);
    const centerInCorridor = this.localHeightScratch.inCorridor;
    const centerInDivider = this.localHeightScratch.inDivider;
    const centerIsInnerFork = this.localHeightScratch.isInnerFork;

    const posX = this.scratchFrameA.posX + x * this.scratchFrameA.rightX;
    const posY = this.scratchFrameA.posY + x * this.scratchFrameA.rightY + centerH;
    const posZ = this.scratchFrameA.posZ + x * this.scratchFrameA.rightZ;

    // Central difference normal calculation using pre-allocated scratch frames
    const epsS = 0.25;
    const epsX = 0.25;
    const sMinus = Math.max(0, s - epsS);
    const sPlus = Math.min(this.length, s + epsS);
    const spanS = Math.max(1e-4, sPlus - sMinus);

    this.sampleSpineFrame(sMinus, this.scratchFrameB);
    this.sampleSpineFrame(sPlus, this.scratchFrameC);
    const hSm = this.computeLocalHeight(
      sMinus,
      x,
      this.scratchFrameB.halfWidth,
      this.scratchFrameB.dividerHalfWidth,
      effectiveSkirt,
    );
    const hSp = this.computeLocalHeight(
      sPlus,
      x,
      this.scratchFrameC.halfWidth,
      this.scratchFrameC.dividerHalfWidth,
      effectiveSkirt,
    );

    const dSx =
      (this.scratchFrameC.posX +
        x * this.scratchFrameC.rightX -
        (this.scratchFrameB.posX + x * this.scratchFrameB.rightX)) /
      spanS;
    const dSy =
      (this.scratchFrameC.posY +
        x * this.scratchFrameC.rightY +
        hSp -
        (this.scratchFrameB.posY + x * this.scratchFrameB.rightY + hSm)) /
      spanS;
    const dSz =
      (this.scratchFrameC.posZ +
        x * this.scratchFrameC.rightZ -
        (this.scratchFrameB.posZ + x * this.scratchFrameB.rightZ)) /
      spanS;

    const hXm = this.computeLocalHeight(s, x - epsX, hw, divHw, effectiveSkirt);
    const hXp = this.computeLocalHeight(s, x + epsX, hw, divHw, effectiveSkirt);
    const dXx = this.scratchFrameA.rightX;
    const dXy = this.scratchFrameA.rightY + (hXp - hXm) / (2 * epsX);
    const dXz = this.scratchFrameA.rightZ;

    // Cross product dX x dS points upward (+Y)
    let nx = dXy * dSz - dXz * dSy;
    let ny = dXz * dSx - dXx * dSz;
    let nz = dXx * dSy - dXy * dSx;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen > 1e-6) {
      const inv = 1 / nLen;
      nx *= inv;
      ny *= inv;
      nz *= inv;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }

    out.posX = posX;
    out.posY = posY;
    out.posZ = posZ;
    out.normalX = nx;
    out.normalY = ny;
    out.normalZ = nz;
    out.lateralX = x;
    out.halfWidth = hw;
    out.skirtWidth = this.skirtWidth;
    out.slopeDeg = Math.acos(clamp(ny, -1, 1)) * (180 / Math.PI);
    out.localHeight = centerH;
    out.surfaceType = this.evaluatePisteSurfaceWithFrame(s, x, hw, divHw);
    out.inPlayableCorridor = centerInCorridor;
    out.inDivider = centerInDivider;
    out.isInnerForkSlope = centerIsInnerFork;
  }
}
