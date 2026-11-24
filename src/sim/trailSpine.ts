import { clamp, degToRad, lerp, smoothstep, smootherstep, wrapAngle } from '../core/math';
import { SeededRng } from '../core/rng';
import type { LandscapeProfile, PisteSurfaceType, StageDef } from '../content/types';
import {
  createSpineFrameOut,
  type PisteHeightOut,
  type RibbonPointOut,
  type SpineForkMeta,
  type SpineFrameOut,
  type SpineProjectionOut,
  type SpineView,
} from './contracts';

export const POLYLINE_SPACING_M = 3.0;
export const SPINE_LUT_STEP_M = 1.0;
export const MACRO_ANCHOR_STEP_M = 16;
export const MACRO_ANCHOR_EXTENSION_M = 320;
export const INNER_WALL_RAMP_LENGTH_M = 25;
export const SEAM_NOSE_RADIUS_M = 1.5;
export const MAX_CURVATURE_RIBBON_RATIO = 0.4;
const SAFE_CURVATURE_RATIO = 0.395;
const COARSE_STRIDE = 8;

// Broad downhill fall-line cone constraints (|yaw| <= 60 deg, fork seams <= 48 deg)
const SOFT_OUTWARD_YAW_RAD = degToRad(38);
const HARD_OUTWARD_YAW_RAD = degToRad(56);
const RESTORE_START_YAW_RAD = degToRad(40);
const RESTORE_FULL_YAW_RAD = degToRad(58);
const FORK_PULL_WINDOW_M = 75;
const FORK_OUTWARD_START_RAD = degToRad(30);
const FORK_OUTWARD_ZERO_RAD = degToRad(44);
const FORK_RESTORE_START_RAD = degToRad(28);
const FORK_RESTORE_FULL_RAD = degToRad(45);

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

  // Precomputed 16m macro-spine anchors along [-320, length + 320] for MountainField Gaussian blending
  readonly macroAnchorCount: number;
  readonly macroAnchorX: Float64Array;
  readonly macroAnchorY: Float64Array;
  readonly macroAnchorZ: Float64Array;

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
    isInnerFork: false,
  };

  constructor(config: TrailSpineConfig) {
    this.id = config.id;
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
          maxHalfWidth: rng.nextRange(2.4, 3.4),
          maxHeight: 2.4,
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

    const evalCurvature = (s: number, hw: number, curYaw: number): number => {
      const startEnv = smoothstep(0, 10, s);
      const endEnv = 1 - smoothstep(this.length - 58, this.length - 16, s);
      let k = 0;

      // Guaranteed V-wedge branch separation curvature immediately after fork seam
      if (config.isForkChild && s < 65) {
        const sepEnv = smoothstep(0, 5, s) * (1 - smoothstep(32, 62, s));
        const sepSign = config.forkSide === 'left' ? 1 : -1;
        k += sepSign * 0.0125 * sepEnv;
      }

      for (let i = 0; i < lobes.length; i++) {
        const lobe = lobes[i]!;
        const d = (s - lobe.centerS) / lobe.sigma;
        k += lobe.amplitude * Math.exp(-0.5 * d * d);
      }

      // Broad downhill fall-line invariant (|yawRad| <= 60 deg) applied prior to seam taper & clamp
      const absYaw = Math.abs(curYaw);
      const yawSign = curYaw >= 0 ? 1 : -1;
      if (absYaw > SOFT_OUTWARD_YAW_RAD) {
        if (k * yawSign > 0) {
          k *= 1 - smoothstep(SOFT_OUTWARD_YAW_RAD, HARD_OUTWARD_YAW_RAD, absYaw);
        }
        const restoreT = smoothstep(RESTORE_START_YAW_RAD, RESTORE_FULL_YAW_RAD, absYaw);
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
          k -= yawSign * 0.018 * forkBlend * forkRestoreT;
        }
      }

      k *= startEnv * endEnv;

      // Enforce non-self-intersection ribbon curvature clamp: |k(s)| * (halfWidth(s) + skirt) <= 0.4
      const maxAllowedK = SAFE_CURVATURE_RATIO / Math.max(1, hw + this.skirtWidth);
      return clamp(k, -maxAllowedK, maxAllowedK);
    };

    const evalPitch = (s: number): number => {
      const wave =
        Math.sin(s * rollerFreq * Math.PI * 2 + pitchPhaseA) * 0.65 +
        Math.sin(s * rollerFreq * 1.85 * Math.PI * 2 + pitchPhaseB) * 0.35;
      const rawPitchRad = -degToRad(clamp(basePitchDeg + pitchSwingDeg * wave, 6, 38));
      const startBlend = smoothstep(0, 22, s);
      const endBlend = smoothstep(this.length - 26, this.length - 2, s);
      let p = lerp(config.startPitchRad, rawPitchRad, startBlend);
      p = lerp(p, endPitchTargetRad, endBlend);
      return clamp(p, -degToRad(40), -degToRad(5));
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

    for (let i = 0; i < this.lutCount; i++) {
      const s = Math.min(this.length, i * this.lutStep);
      const hw = evalHalfWidth(s);
      const divHw = evalDividerHalfWidth(s);
      const k = evalCurvature(s, hw, curYaw);
      const pitch = evalPitch(s);
      const bank = clamp(config.stage.terrain.bankingFactor * k * 18.0, -0.28, 0.28);

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
        const midK = evalCurvature(midS, midHw, midYawEst);
        const midYaw = wrapAngle(curYaw + 0.5 * midK * stepDs);
        const midPitch = evalPitch(midS);

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

    // Build ~3m centerline polyline for O(1) XZ queries
    this.polyStep = POLYLINE_SPACING_M;
    this.polyCount = Math.ceil(this.length / this.polyStep) + 1;
    this.polyS = new Float32Array(this.polyCount);
    this.polyX = new Float64Array(this.polyCount);
    this.polyY = new Float64Array(this.polyCount);
    this.polyZ = new Float64Array(this.polyCount);
    for (let i = 0; i < this.polyCount; i++) {
      const s = i === this.polyCount - 1 ? this.length : i * this.polyStep;
      this.sampleSpineFrame(s, this.scratchFrameA);
      this.polyS[i] = s;
      this.polyX[i] = this.scratchFrameA.posX;
      this.polyY[i] = this.scratchFrameA.posY;
      this.polyZ[i] = this.scratchFrameA.posZ;
    }

    // Precompute uniform 16m macro-spine anchors matching [-320, length + 320] sample positions
    const upstreamSteps = Math.floor(MACRO_ANCHOR_EXTENSION_M / MACRO_ANCHOR_STEP_M);
    const spineSteps = Math.ceil(this.length / MACRO_ANCHOR_STEP_M);
    const downstreamSteps = Math.floor(MACRO_ANCHOR_EXTENSION_M / MACRO_ANCHOR_STEP_M) + 1;
    this.macroAnchorCount = upstreamSteps + spineSteps + downstreamSteps;
    this.macroAnchorX = new Float64Array(this.macroAnchorCount);
    this.macroAnchorY = new Float64Array(this.macroAnchorCount);
    this.macroAnchorZ = new Float64Array(this.macroAnchorCount);

    let anchorIdx = 0;
    this.sampleSpineFrame(0, this.scratchFrameA);
    for (let ds = -MACRO_ANCHOR_EXTENSION_M; ds <= -MACRO_ANCHOR_STEP_M; ds += MACRO_ANCHOR_STEP_M) {
      this.macroAnchorX[anchorIdx] = this.scratchFrameA.posX + this.scratchFrameA.forwardX * ds;
      this.macroAnchorY[anchorIdx] = this.scratchFrameA.posY + this.scratchFrameA.forwardY * ds;
      this.macroAnchorZ[anchorIdx] = this.scratchFrameA.posZ + this.scratchFrameA.forwardZ * ds;
      anchorIdx++;
    }
    for (let i = 0; i < spineSteps; i++) {
      this.sampleSpineFrame(i * MACRO_ANCHOR_STEP_M, this.scratchFrameA);
      this.macroAnchorX[anchorIdx] = this.scratchFrameA.posX;
      this.macroAnchorY[anchorIdx] = this.scratchFrameA.posY;
      this.macroAnchorZ[anchorIdx] = this.scratchFrameA.posZ;
      anchorIdx++;
    }
    this.sampleSpineFrame(this.length, this.scratchFrameA);
    for (let ds = 0; ds <= MACRO_ANCHOR_EXTENSION_M; ds += MACRO_ANCHOR_STEP_M) {
      this.macroAnchorX[anchorIdx] = this.scratchFrameA.posX + this.scratchFrameA.forwardX * ds;
      this.macroAnchorY[anchorIdx] = this.scratchFrameA.posY + this.scratchFrameA.forwardY * ds;
      this.macroAnchorZ[anchorIdx] = this.scratchFrameA.posZ + this.scratchFrameA.forwardZ * ds;
      anchorIdx++;
    }
  }

  get fork(): SpineForkMeta {
    return this._fork;
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
    for (let i = 0; i < this.macroAnchorCount; i++) {
      this.macroAnchorX[i] = this.macroAnchorX[i]! - deltaX;
      this.macroAnchorY[i] = this.macroAnchorY[i]! - deltaY;
      this.macroAnchorZ[i] = this.macroAnchorZ[i]! - deltaZ;
    }
    this._fork.seamWorldX -= deltaX;
    this._fork.seamWorldY -= deltaY;
    this._fork.seamWorldZ -= deltaZ;

    this._boundsMinX -= deltaX;
    this._boundsMaxX -= deltaX;
    this._boundsMinZ -= deltaZ;
    this._boundsMaxZ -= deltaZ;
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
    const lastEdge = this.polyCount - 1;
    let fineStart = 0;
    let fineEnd = lastEdge;
    if (lastEdge > COARSE_STRIDE * 2) {
      let bestChordDistSq = Infinity;
      let bestChordStart = 0;
      for (let k = 0; k < lastEdge; k += COARSE_STRIDE) {
        const k2 = Math.min(lastEdge, k + COARSE_STRIDE);
        const cax = this.polyX[k]!;
        const caz = this.polyZ[k]!;
        const cdx = this.polyX[k2]! - cax;
        const cdz = this.polyZ[k2]! - caz;
        const cLenSq = cdx * cdx + cdz * cdz;
        const ct = cLenSq > 1e-8 ? clamp(((wx - cax) * cdx + (wz - caz) * cdz) / cLenSq, 0, 1) : 0;
        const cex = wx - (cax + ct * cdx);
        const cez = wz - (caz + ct * cdz);
        const cd = cex * cex + cez * cez;
        if (cd < bestChordDistSq) {
          bestChordDistSq = cd;
          bestChordStart = k;
        }
      }
      fineStart = Math.max(0, bestChordStart - COARSE_STRIDE);
      fineEnd = Math.min(lastEdge, bestChordStart + COARSE_STRIDE * 2);
    }

    for (let i = fineStart; i < fineEnd; i++) {
      const ax = this.polyX[i]!;
      const az = this.polyZ[i]!;
      const bx = this.polyX[i + 1]!;
      const bz = this.polyZ[i + 1]!;
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq > 1e-8 ? clamp(((wx - ax) * dx + (wz - az) * dz) / lenSq, 0, 1) : 0;
      const px = ax + t * dx;
      const pz = az + t * dz;
      const ex = wx - px;
      const ez = wz - pz;
      const dSq = ex * ex + ez * ez;
      if (dSq < bestPolyDistSq) {
        bestPolyDistSq = dSq;
        const sA = this.polyS[i]!;
        const sB = this.polyS[i + 1]!;
        bestS = sA + t * (sB - sA);
      }
    }

    // Refine s against continuous spine tangent (2 damped steps) while ensuring distSq never worsens
    let finalS = bestS;
    this.sampleSpineFrame(finalS, this.scratchFrameA);
    let curDx = wx - this.scratchFrameA.posX;
    let curDz = wz - this.scratchFrameA.posZ;
    let curDistSq = curDx * curDx + curDz * curDz;

    for (let iter = 0; iter < 2; iter++) {
      const fwdX0 = -Math.sin(this.scratchFrameA.yawRad);
      const fwdZ0 = -Math.cos(this.scratchFrameA.yawRad);
      const cosP0 = Math.max(0.3, Math.cos(this.scratchFrameA.pitchRad));
      const remFwd0 = curDx * fwdX0 + curDz * fwdZ0;
      const deltaS = clamp(remFwd0 / cosP0, -this.polyStep, this.polyStep);
      const candS = clamp(finalS + deltaS, 0, this.length);
      if (candS === finalS) break;

      this.sampleSpineFrame(candS, this.scratchFrameB);
      const dx1 = wx - this.scratchFrameB.posX;
      const dz1 = wz - this.scratchFrameB.posZ;
      const distSq1 = dx1 * dx1 + dz1 * dz1;
      if (distSq1 <= curDistSq) {
        finalS = candS;
        curDistSq = distSq1;
        curDx = dx1;
        curDz = dz1;
        this.sampleSpineFrame(finalS, this.scratchFrameA);
      } else {
        break;
      }
    }

    this.sampleSpineFrame(finalS, this.scratchFrameA);
    const cosY = Math.cos(this.scratchFrameA.yawRad);
    const sinY = Math.sin(this.scratchFrameA.yawRad);
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;

    const dx = wx - this.scratchFrameA.posX;
    const dz = wz - this.scratchFrameA.posZ;
    const alongFwd = dx * fwdX + dz * fwdZ;
    const signedX = dx * rightX + dz * rightZ;
    const distSq = dx * dx + dz * dz;

    let longExt = 0;
    if (finalS === 0 && alongFwd < 0) {
      longExt = alongFwd;
    } else if (finalS === this.length && alongFwd > 0) {
      longExt = alongFwd;
    }

    out.s = finalS;
    out.signedX = signedX;
    out.longExt = longExt;
    out.distSq = distSq;
    out.spineX = this.scratchFrameA.posX;
    out.spineY = this.scratchFrameA.posY;
    out.spineZ = this.scratchFrameA.posZ;
    out.forwardX = this.scratchFrameA.forwardX;
    out.forwardY = this.scratchFrameA.forwardY;
    out.forwardZ = this.scratchFrameA.forwardZ;
    out.rightX = rightX;
    out.rightZ = rightZ;
    out.pitchRad = this.scratchFrameA.pitchRad;
    out.halfWidth = this.scratchFrameA.halfWidth;
    out.dividerHalfWidth = this.scratchFrameA.dividerHalfWidth;
  }

  /**
   * Evaluates groomed piste elevation (spineY + x * rightY + moguls + divider) for MountainField,
   * intentionally omitting the legacy 3.6m outer ribbon snowbank wall.
   */
  evaluatePisteHeight(s: number, x: number, out: PisteHeightOut): void {
    const clampedS = clamp(s, 0, this.length);
    this.sampleSpineFrame(clampedS, this.scratchFrameA);
    const hw = this.scratchFrameA.halfWidth;
    const divHw = this.scratchFrameA.dividerHalfWidth;
    const coreH = this.computePisteCoreHeight(clampedS, x, hw, divHw);

    out.heightY = this.scratchFrameA.posY + x * this.scratchFrameA.rightY + coreH;
    out.dividerHalfWidth = divHw;
    out.inDivider = this.localHeightScratch.inDivider;
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
    if (divHw > 0.001 && absX < divHw && this.divider) {
      inDivider = true;
      const tDiv = 1 - absX / divHw;
      const heightScale = divHw / Math.max(0.01, this.divider.maxHalfWidth);
      h += this.divider.maxHeight * heightScale * tDiv * tDiv * (3 - 2 * tDiv);
    }

    this.localHeightScratch.h = h;
    this.localHeightScratch.inCorridor = absX <= hw && !inDivider;
    this.localHeightScratch.inDivider = inDivider;
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
