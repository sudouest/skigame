import { clamp, lerp, smoothstep } from '../core/math';
import { SeededRng } from '../core/rng';
import type { LandscapeProfile, PisteSurfaceType, StageDef } from '../content/types';
import {
  createSpineFrameOut,
  type ChunkRangeOut,
  type PisteHeightOut,
  type RibbonPointOut,
  type SegmentForkMeta,
  type SegmentLandmarkRequirement,
  type SpineFrameOut,
  type SpineProjectionOut,
  type SpineView,
  type TerrainSegmentView,
  type TrailSlotRole,
} from './contracts';
import {
  INNER_WALL_RAMP_LENGTH_M,
  MAX_CURVATURE_RIBBON_RATIO,
  POLYLINE_SPACING_M,
  SEAM_NOSE_RADIUS_M,
  SPINE_LUT_STEP_M,
  TrailSpine,
  mapRibbonUtoX,
  type IslandDividerConfig,
} from './trailSpine';

export {
  INNER_WALL_RAMP_LENGTH_M,
  MAX_CURVATURE_RIBBON_RATIO,
  POLYLINE_SPACING_M,
  SEAM_NOSE_RADIUS_M,
  SPINE_LUT_STEP_M,
  mapRibbonUtoX,
  type IslandDividerConfig,
};

export const DEFAULT_CHUNK_LENGTH_M = 35;
export const SAFE_PATH_STEP_M = 2.0;
export const FORK_RUNWAY_OBSTACLE_FREE_M = 50;

export interface SurfacePatch {
  readonly s: number;
  readonly x: number;
  readonly radiusS: number;
  readonly radiusX: number;
  readonly surfaceType: PisteSurfaceType;
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
  /** Optional pre-computed horizon spine adopted directly with zero geometry recomputation. */
  readonly existingSpine?: TrailSpine;
}

/**
 * Trail segment parameterized by 3D arc length `s`, composing a `TrailSpine` for
 * geometric frames/piste evaluation while owning gameplay safeX splines, surface patches,
 * crest brow clearances, and chunk landmark metadata.
 */
export class TrailSegment implements TerrainSegmentView, SpineView {
  readonly id: number;
  slot: TrailSlotRole;
  readonly spine: TrailSpine;
  readonly stageId: string;
  readonly stage: StageDef;
  readonly landscape: LandscapeProfile;
  readonly seed: number;
  readonly length: number;
  readonly skirtWidth: number;
  readonly chunkLength = DEFAULT_CHUNK_LENGTH_M;
  readonly chunkCount: number;
  prevSegmentId: number | null;
  nextLeftId: number | null = null;
  nextRightId: number | null = null;

  private readonly _fork: {
    hasFork: boolean;
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
  readonly crestBrows: readonly number[];

  // Safe path spline LUT
  private readonly safeStep = SAFE_PATH_STEP_M;
  private readonly safeCount: number;
  private readonly safeXs: Float32Array;

  private readonly scratchFrameA: SpineFrameOut = createSpineFrameOut();

  constructor(config: TrailSegmentConfig) {
    this.spine = config.existingSpine ?? new TrailSpine(config);
    this.id = this.spine.id;
    this.slot = config.slot;
    this.stage = this.spine.stage;
    this.stageId = this.spine.stageId;
    this.landscape = this.spine.landscape;
    this.seed = this.spine.seed;
    this.length = this.spine.length;
    this.skirtWidth = this.spine.skirtWidth;
    this.chunkCount = Math.ceil(this.length / this.chunkLength);
    this.prevSegmentId = config.prevSegmentId;

    const spineFork = this.spine.fork;
    const obstacleFreeStartS = spineFork.hasFork
      ? Math.max(0, this.length - FORK_RUNWAY_OBSTACLE_FREE_M)
      : this.length;

    this._fork = {
      hasFork: spineFork.hasFork,
      obstacleFreeStartS,
      leftStageId: spineFork.leftStageId,
      rightStageId: spineFork.rightStageId,
      isForkChild: spineFork.isForkChild,
      forkSide: spineFork.forkSide,
      innerWallRampLength: spineFork.innerWallRampLength,
      seamNoseRadius: spineFork.seamNoseRadius,
      seamWorldX: spineFork.seamWorldX,
      seamWorldY: spineFork.seamWorldY,
      seamWorldZ: spineFork.seamWorldZ,
      seamYawRad: spineFork.seamYawRad,
    };

    // Derive gameplay RNG strictly from '.fork("gameplay")' independent of spine generation
    const rng = new SeededRng(this.seed).fork('gameplay');

    // Detect convex crest brow drop-offs for post-brow sightline protection
    const brows: number[] = [];
    this.spine.collectCrestBrows(brows);
    this.crestBrows = brows;

    // Generate elliptical surface patches (ice / powder) avoiding immediate seam edges
    const patches: SurfacePatch[] = [];
    const patchCandidateCount = Math.floor(this.length / 28);
    for (let i = 1; i < patchCandidateCount; i++) {
      const sCenter = i * 28 + rng.nextRange(-6, 6);
      if (sCenter < 14 || sCenter > this.length - 16) continue;
      const roll = rng.next();
      let surfaceType: PisteSurfaceType | null = null;
      if (roll < this.stage.terrain.icePatchChance) {
        surfaceType = 'ice';
      } else if (
        roll <
        this.stage.terrain.icePatchChance + this.stage.terrain.powderPatchChance
      ) {
        surfaceType = 'powder';
      }
      if (surfaceType) {
        this.spine.sampleSpineFrame(sCenter, this.scratchFrameA);
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
      this.spine.sampleSpineFrame(s, this.scratchFrameA);
      const hw = this.scratchFrameA.halfWidth;
      const divHw = this.scratchFrameA.dividerHalfWidth;
      const margin = Math.min(3.5, hw * 0.25);
      const maxX = Math.max(1.0, hw - margin);

      const uSeg = (s / this.length) * (targetNodes.length - 1);
      const idx0 = Math.min(targetNodes.length - 2, Math.floor(uSeg));
      const frac = smoothstep(0, 1, uSeg - idx0);
      let desiredX = lerp(targetNodes[idx0]!, targetNodes[idx0 + 1]!, frac) * maxX;

      if (spineFork.isForkChild && s < 24) {
        desiredX *= smoothstep(4, 24, s);
      }
      if (spineFork.hasFork && s > this.length - 60) {
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

    // Emit two 'forkArch' entrance gates right at the fork seam (s = length), one per branch
    if (spineFork.hasFork && spineFork.leftStageId && spineFork.rightStageId) {
      this.spine.sampleSpineFrame(this.length, this.scratchFrameA);
      const branchHalfWidth = 0.5 * this.spine.getEndPose().halfWidth;
      const branchDefs: ReadonlyArray<{ side: 'left' | 'right'; sign: -1 | 1; stageId: string }> = [
        { side: 'left', sign: -1, stageId: spineFork.leftStageId },
        { side: 'right', sign: 1, stageId: spineFork.rightStageId },
      ];
      for (let i = 0; i < branchDefs.length; i++) {
        const branch = branchDefs[i]!;
        const lateralX = branch.sign * branchHalfWidth;
        this.landmarks.push({
          id: `fork_arch_${this.id}_${branch.side}`,
          kind: 'forkArch',
          segmentId: this.id,
          s: this.length,
          x: lateralX,
          worldX: this.scratchFrameA.posX + lateralX * this.scratchFrameA.rightX,
          worldY: this.scratchFrameA.posY + lateralX * this.scratchFrameA.rightY,
          worldZ: this.scratchFrameA.posZ + lateralX * this.scratchFrameA.rightZ,
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
          badgeStageId: branch.stageId,
          forkSide: branch.side,
          gateHalfWidth: branchHalfWidth,
        });
      }
    }
  }

  get fork(): SegmentForkMeta {
    return this._fork;
  }

  get divider(): IslandDividerConfig | null {
    return this.spine.divider;
  }

  get polyCount(): number {
    return this.spine.polyCount;
  }

  get polyStep(): number {
    return this.spine.polyStep;
  }

  get polyS(): Float32Array {
    return this.spine.polyS;
  }

  get polyX(): Float64Array {
    return this.spine.polyX;
  }

  get polyY(): Float64Array {
    return this.spine.polyY;
  }

  get polyZ(): Float64Array {
    return this.spine.polyZ;
  }

  get macroAnchorCount(): number {
    return this.spine.macroAnchorCount;
  }

  get macroAnchorX(): Float64Array {
    return this.spine.macroAnchorX;
  }

  get macroAnchorY(): Float64Array {
    return this.spine.macroAnchorY;
  }

  get macroAnchorZ(): Float64Array {
    return this.spine.macroAnchorZ;
  }

  get boundsMinX(): number {
    return this.spine.boundsMinX;
  }

  get boundsMaxX(): number {
    return this.spine.boundsMaxX;
  }

  get boundsMinZ(): number {
    return this.spine.boundsMinZ;
  }

  get boundsMaxZ(): number {
    return this.spine.boundsMaxZ;
  }

  getEndPose(): {
    posX: number;
    posY: number;
    posZ: number;
    yawRad: number;
    pitchRad: number;
    halfWidth: number;
  } {
    return this.spine.getEndPose();
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
   * Shifts the composed TrailSpine, fork seam anchor, and landmarks by subtracting (deltaX, deltaY, deltaZ).
   */
  rebaseOrigin(deltaX: number, deltaY: number, deltaZ: number): void {
    this.spine.rebaseOrigin(deltaX, deltaY, deltaZ);
    this._fork.seamWorldX = this.spine.fork.seamWorldX;
    this._fork.seamWorldY = this.spine.fork.seamWorldY;
    this._fork.seamWorldZ = this.spine.fork.seamWorldZ;

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
    this.spine.sampleSpineFrame(s, out);
  }

  projectXZ(wx: number, wz: number, out: SpineProjectionOut): void {
    this.spine.projectXZ(wx, wz, out);
  }

  evaluatePisteHeight(s: number, x: number, out: PisteHeightOut): void {
    this.spine.evaluatePisteHeight(s, x, out);
  }

  evaluatePisteSurface(s: number, x: number): PisteSurfaceType {
    if (this.patches.length === 0) {
      return this.spine.evaluatePisteSurface(s, x);
    }
    const clampedS = clamp(s, 0, this.length);
    this.spine.sampleSpineFrame(clampedS, this.scratchFrameA);
    const hw = this.scratchFrameA.halfWidth;
    const divHw = this.scratchFrameA.dividerHalfWidth;
    const base = this.spine.evaluatePisteSurfaceWithFrame(clampedS, x, hw, divHw);
    const div = this.spine.divider;
    if (
      base !== 'packed' ||
      (divHw > 0.1 && div !== null && clampedS >= div.startS && clampedS <= div.endS)
    ) {
      return base;
    }
    for (let i = 0; i < this.patches.length; i++) {
      const p = this.patches[i]!;
      const ds = (clampedS - p.s) / p.radiusS;
      const dx = (x - p.x) / p.radiusX;
      if (ds * ds + dx * dx <= 1.0) {
        return p.surfaceType;
      }
    }
    return 'packed';
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
    this.spine.evaluateRibbonPoint(s, u, out);
    if (this.patches.length > 0) {
      out.surfaceType = this.evaluatePisteSurface(s, out.lateralX);
    }
  }

  evaluateSurfaceAtX(s: number, x: number, out: RibbonPointOut): void {
    this.spine.evaluateSurfaceAtX(s, x, out);
    if (this.patches.length > 0) {
      out.surfaceType = this.evaluatePisteSurface(s, out.lateralX);
    }
  }
}
