import { clamp, degToRad, lerp, smoothstep, smootherstep, wrapAngle } from '../core/math';
import { SeededRng } from '../core/rng';
import type { StageDef, SurfaceType } from '../content/types';
import type {
  ChunkRangeOut,
  RibbonPointOut,
  SegmentForkMeta,
  SegmentLandmarkRequirement,
  SpineFrameOut,
  TerrainSegmentView,
  TrailSlotRole,
} from './contracts';

export const DEFAULT_CHUNK_LENGTH_M = 35;
export const POLYLINE_SPACING_M = 3.0;
export const SPINE_LUT_STEP_M = 1.0;
export const SAFE_PATH_STEP_M = 2.0;
export const FORK_RUNWAY_OBSTACLE_FREE_M = 50;
export const INNER_WALL_RAMP_LENGTH_M = 25;
export const SEAM_NOSE_RADIUS_M = 1.5;
export const MAX_CURVATURE_RIBBON_RATIO = 0.4;
const SAFE_CURVATURE_RATIO = 0.395;

export interface SurfacePatch {
  readonly s: number;
  readonly x: number;
  readonly radiusS: number;
  readonly radiusX: number;
  readonly surfaceType: SurfaceType;
}

export interface IslandDividerConfig {
  readonly startS: number;
  readonly endS: number;
  readonly maxHalfWidth: number;
  readonly maxHeight: number;
  readonly leftLaneSurface: SurfaceType;
  readonly rightLaneSurface: SurfaceType;
}

export interface TrailSegmentConfig {
  readonly id: number;
  readonly slot: TrailSlotRole;
  readonly stage: StageDef;
  readonly seed: number;
  readonly length: number;
  readonly startPosX: number;
  readonly startPosY: number;
  readonly startPosZ: number;
  readonly startYawRad: number;
  readonly startPitchRad: number;
  readonly startHalfWidth: number;
  readonly endHalfWidth: number;
  readonly prevSegmentId: number | null;
  readonly hasFork: boolean;
  readonly archS: number;
  readonly leftStageId: string | null;
  readonly rightStageId: string | null;
  readonly isForkChild: boolean;
  readonly forkSide: 'none' | 'left' | 'right';
  readonly seamWorldX: number;
  readonly seamWorldY: number;
  readonly seamWorldZ: number;
  readonly seamYawRad: number;
  readonly initialSafeX?: number;
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
 * Trail segment parameterized by 3D arc length `s` with an up-locked Yaw-Pitch-Bank frame
 * (never Frenet-Serret) and enforced ribbon curvature invariant |k(s)| * (halfWidth + skirt) <= 0.4.
 */
export class TrailSegment implements TerrainSegmentView {
  readonly id: number;
  slot: TrailSlotRole;
  readonly stageId: string;
  readonly stage: StageDef;
  readonly seed: number;
  readonly length: number;
  readonly chunkLength = DEFAULT_CHUNK_LENGTH_M;
  readonly chunkCount: number;
  prevSegmentId: number | null;
  nextLeftId: number | null = null;
  nextRightId: number | null = null;

  private readonly _fork: {
    hasFork: boolean;
    archS: number;
    obstacleFreeStartS: number;
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

  readonly landmarks: SegmentLandmarkRequirement[] = [];
  readonly patches: readonly SurfacePatch[];
  readonly divider: IslandDividerConfig | null;
  readonly crestBrows: readonly number[];

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

  // Lightweight ~3m spacing centerline polyline for O(1) warm-started XZ queries
  readonly polyCount: number;
  readonly polyStep: number;
  readonly polyS: Float32Array;
  readonly polyX: Float64Array;
  readonly polyY: Float64Array;
  readonly polyZ: Float64Array;

  // Safe path spline LUT
  private readonly safeStep = SAFE_PATH_STEP_M;
  private readonly safeCount: number;
  private readonly safeXs: Float32Array;

  private readonly skirtWidth: number;
  private readonly mogulPhaseA: number;
  private readonly mogulPhaseB: number;
  private readonly mogulAmplitude: number;
  private readonly endYawRad: number;
  private readonly endPitchRad: number;
  private readonly endHalfWidthValue: number;

  // Instance-private scratch buffers for zero-alloc derivative normal evaluation
  private readonly scratchFrameA: SpineFrameOut = {
    posX: 0,
    posY: 0,
    posZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    yawRad: 0,
    pitchRad: 0,
    bankRad: 0,
    curvature: 0,
    halfWidth: 14,
    skirtWidth: 12,
    dividerHalfWidth: 0,
  };
  private readonly scratchFrameB: SpineFrameOut = {
    posX: 0,
    posY: 0,
    posZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    yawRad: 0,
    pitchRad: 0,
    bankRad: 0,
    curvature: 0,
    halfWidth: 14,
    skirtWidth: 12,
    dividerHalfWidth: 0,
  };
  private readonly scratchFrameC: SpineFrameOut = {
    posX: 0,
    posY: 0,
    posZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    yawRad: 0,
    pitchRad: 0,
    bankRad: 0,
    curvature: 0,
    halfWidth: 14,
    skirtWidth: 12,
    dividerHalfWidth: 0,
  };
  private readonly localHeightScratch = {
    h: 0,
    inCorridor: true,
    inDivider: false,
    isInnerFork: false,
  };

  constructor(config: TrailSegmentConfig) {
    this.id = config.id;
    this.slot = config.slot;
    this.stage = config.stage;
    this.stageId = config.stage.id;
    this.seed = config.seed;
    this.length = Math.max(60, config.length);
    this.chunkCount = Math.ceil(this.length / this.chunkLength);
    this.prevSegmentId = config.prevSegmentId;
    this.skirtWidth = config.stage.terrain.skirtWidth;
    this.endHalfWidthValue = config.endHalfWidth;

    const obstacleFreeStartS = config.hasFork
      ? Math.max(0, this.length - FORK_RUNWAY_OBSTACLE_FREE_M)
      : this.length;

    this._fork = {
      hasFork: config.hasFork,
      archS: config.archS,
      obstacleFreeStartS,
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

    const rng = new SeededRng(config.seed);
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
        divider = {
          startS: divStart,
          endS: divStart + divLen,
          maxHalfWidth: rng.nextRange(2.4, 3.4),
          maxHeight: 2.4,
          leftLaneSurface:
            config.stage.id === 'icy-black'
              ? iceLeft
                ? 'ice'
                : 'packed'
              : iceLeft
                ? 'packed'
                : 'powder',
          rightLaneSurface:
            config.stage.id === 'icy-black'
              ? iceLeft
                ? 'packed'
                : 'ice'
              : iceLeft
                ? 'powder'
                : 'packed',
        };
      }
    }
    this.divider = divider;

    // Generate smooth S-curve curvature lobes respecting ribbon curvature clamp
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
        hw = lerp(hw, config.endHalfWidth, widen);
      }
      return hw;
    };

    const evalCurvature = (s: number, hw: number): number => {
      // Seam curvature taper: strictly 0 at s = 0 and over final 16m before s = L
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

    for (let i = 0; i < this.lutCount; i++) {
      const s = Math.min(this.length, i * this.lutStep);
      const hw = evalHalfWidth(s);
      const divHw = evalDividerHalfWidth(s);
      const k = evalCurvature(s, hw);
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

      if (i < this.lutCount - 1) {
        const nextS = Math.min(this.length, (i + 1) * this.lutStep);
        const stepDs = nextS - s;
        const midS = s + 0.5 * stepDs;
        const midHw = evalHalfWidth(midS);
        const midK = evalCurvature(midS, midHw);
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

    // Detect convex crest brow drop-offs for post-brow sightline protection
    const brows: number[] = [];
    for (let i = 10; i < this.lutCount - 14; i += 4) {
      const pBefore = this.lutPitch[i - 6]!;
      const pAfter = this.lutPitch[i + 6]!;
      const dropSlope = (pAfter - pBefore) / (12 * this.lutStep);
      if (dropSlope < -0.0045) {
        const browS = i * this.lutStep;
        if (brows.length === 0 || browS - brows[brows.length - 1]! > 22) {
          brows.push(browS);
        }
      }
    }
    this.crestBrows = brows;

    // Build ~3m centerline polyline for O(1) warm-started XZ queries
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

    // Generate elliptical surface patches (ice / powder) avoiding immediate seam edges
    const patches: SurfacePatch[] = [];
    const patchCandidateCount = Math.floor(this.length / 28);
    for (let i = 1; i < patchCandidateCount; i++) {
      const sCenter = i * 28 + rng.nextRange(-6, 6);
      if (sCenter < 14 || sCenter > this.length - 16) continue;
      const roll = rng.next();
      let surfaceType: SurfaceType | null = null;
      if (roll < config.stage.terrain.icePatchChance) {
        surfaceType = 'ice';
      } else if (
        roll <
        config.stage.terrain.icePatchChance + config.stage.terrain.powderPatchChance
      ) {
        surfaceType = 'powder';
      }
      if (surfaceType) {
        this.sampleSpineFrame(sCenter, this.scratchFrameA);
        const hw = this.scratchFrameA.halfWidth;
        patches.push({
          s: sCenter,
          x: rng.nextRange(-hw * 0.65, hw * 0.65),
          radiusS: rng.nextRange(7.5, 13.5),
          radiusX: rng.nextRange(3.2, Math.min(7.5, hw * 0.55)),
          surfaceType,
        });
      }
    }
    this.patches = patches;

    // Pass 1: Carve smooth reachable safeX(s) spline respecting carve rate & IslandDivider
    this.safeCount = Math.ceil(this.length / this.safeStep) + 1;
    this.safeXs = new Float32Array(this.safeCount);
    let sx = config.initialSafeX ?? 0;
    let svx = 0;
    const laneSign = rng.nextBool(0.5) ? 1 : -1;
    const targetNodes = [
      rng.nextRange(-0.45, 0.45),
      rng.nextRange(-0.55, 0.55),
      rng.nextRange(-0.55, 0.55),
      rng.nextRange(-0.45, 0.45),
    ];

    for (let i = 0; i < this.safeCount; i++) {
      const s = Math.min(this.length, i * this.safeStep);
      this.sampleSpineFrame(s, this.scratchFrameA);
      const hw = this.scratchFrameA.halfWidth;
      const divHw = this.scratchFrameA.dividerHalfWidth;
      const margin = Math.min(3.5, hw * 0.25);
      const maxX = Math.max(1.0, hw - margin);

      const uSeg = (s / this.length) * (targetNodes.length - 1);
      const idx0 = Math.min(targetNodes.length - 2, Math.floor(uSeg));
      const frac = smoothstep(0, 1, uSeg - idx0);
      let desiredX = lerp(targetNodes[idx0]!, targetNodes[idx0 + 1]!, frac) * maxX;

      if (config.isForkChild && s < 24) {
        desiredX *= smoothstep(4, 24, s);
      }
      if (config.hasFork && s > this.length - 60) {
        // Approach seam near +/- 0.35 * branch width or smoothly center-split ready
        const forkApproach = smoothstep(this.length - 60, this.length - 12, s);
        desiredX = lerp(desiredX, laneSign * Math.min(8, maxX * 0.32), forkApproach);
      }

      if (divHw > 0.1) {
        const minLaneX = divHw + 2.8;
        const laneCenter = laneSign * clamp((minLaneX + maxX) * 0.5, minLaneX, maxX);
        desiredX = laneCenter;
      }

      desiredX = clamp(desiredX, -maxX, maxX);
      const accel = (desiredX - sx) * 0.045 - svx * 0.38;
      svx = clamp(svx + accel * this.safeStep, -0.32, 0.32);
      sx = clamp(sx + svx * this.safeStep, -maxX, maxX);

      if (divHw > 0.1 && Math.abs(sx) < divHw + 2.6) {
        sx = laneSign * Math.min(maxX, divHw + 2.8);
      }
      this.safeXs[i] = sx;
    }

    // Emit 'forkArch' landmark 150-200m ahead of fork seam
    if (config.hasFork && config.leftStageId && config.rightStageId) {
      this.sampleSpineFrame(config.archS, this.scratchFrameA);
      this.landmarks.push({
        id: `fork_arch_${this.id}`,
        kind: 'forkArch',
        segmentId: this.id,
        chunkIndex: Math.floor(config.archS / this.chunkLength),
        s: config.archS,
        x: 0,
        worldX: this.scratchFrameA.posX,
        worldY: this.scratchFrameA.posY,
        worldZ: this.scratchFrameA.posZ,
        yawRad: this.scratchFrameA.yawRad,
        clearanceRadius: 4.5,
        visual: {
          kind: 'procedural',
          preset: 'arch',
          palette: ['#78350f', '#fbbf24', '#fef3c7'],
          scale: 1.0,
          variant: 'fork_arch',
          outline: true,
        },
        leftBadgeStageId: config.leftStageId,
        rightBadgeStageId: config.rightStageId,
      });
    }
  }

  get fork(): SegmentForkMeta {
    return this._fork;
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

  addLandmarkRequirement(req: SegmentLandmarkRequirement): void {
    this.landmarks.push(req);
  }

  isNearCrestPocket(s: number): boolean {
    for (let i = 0; i < this.crestBrows.length; i++) {
      const brow = this.crestBrows[i]!;
      if (s >= brow && s <= brow + 26) {
        return true;
      }
    }
    return false;
  }

  /**
   * Shifts all stored world-space polyline points, LUT anchors, fork seam coordinates,
   * and landmarks by subtracting (deltaX, deltaY, deltaZ) during 128m floating-origin rebasing.
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
    this._fork.seamWorldX -= deltaX;
    this._fork.seamWorldY -= deltaY;
    this._fork.seamWorldZ -= deltaZ;

    for (let i = 0; i < this.landmarks.length; i++) {
      const lm = this.landmarks[i] as {
        worldX: number;
        worldY: number;
        worldZ: number;
      };
      lm.worldX -= deltaX;
      lm.worldY -= deltaY;
      lm.worldZ -= deltaZ;
    }
  }

  getChunkBounds(chunkIndex: number, out: ChunkRangeOut): void {
    const startS = clamp(chunkIndex * this.chunkLength, 0, this.length);
    const endS = clamp((chunkIndex + 1) * this.chunkLength, startS, this.length);
    out.startS = startS;
    out.endS = endS;
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

  sampleSafeX(s: number): number {
    const clampedS = clamp(s, 0, this.length);
    const fIdx = clampedS / this.safeStep;
    const i0 = Math.min(this.safeCount - 2, Math.floor(fIdx));
    const i1 = i0 + 1;
    const s0 = i0 * this.safeStep;
    const s1 = i1 === this.safeCount - 1 ? this.length : i1 * this.safeStep;
    const t = clamp((clampedS - s0) / Math.max(1e-6, s1 - s0), 0, 1);
    return lerp(this.safeXs[i0]!, this.safeXs[i1]!, t);
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

    const inCorridor = absX <= hw && !inDivider;
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
    this.localHeightScratch.inCorridor = inCorridor;
    this.localHeightScratch.inDivider = inDivider;
    this.localHeightScratch.isInnerFork = isInnerFork;
    return h;
  }

  private evaluateSurfaceType(s: number, x: number, hw: number, divHw: number): SurfaceType {
    if (Math.abs(x) > hw || (divHw > 0.05 && Math.abs(x) < divHw)) {
      return 'powder';
    }
    if (divHw > 0.1 && this.divider && s >= this.divider.startS && s <= this.divider.endS) {
      return x < 0 ? this.divider.leftLaneSurface : this.divider.rightLaneSurface;
    }
    for (let i = 0; i < this.patches.length; i++) {
      const p = this.patches[i]!;
      const ds = (s - p.s) / p.radiusS;
      const dx = (x - p.x) / p.radiusX;
      if (ds * ds + dx * dx <= 1.0) {
        return p.surfaceType;
      }
    }
    return 'packed';
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
    out.surfaceType = this.evaluateSurfaceType(s, x, hw, divHw);
    out.inPlayableCorridor = centerInCorridor;
    out.inDivider = centerInDivider;
    out.isInnerForkSlope = centerIsInnerFork;
  }
}
