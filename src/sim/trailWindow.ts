import { clamp, degToRad } from '../core/math';
import { SeededRng } from '../core/rng';
import { getStageDef } from '../content/stages';
import type { StageDef } from '../content/types';
import {
  createRibbonPointOut,
  createSpineFrameOut,
  type RibbonPointOut,
  type SpineFrameOut,
  type SurfaceSample,
  type TrailSlotRole,
  type TrailWindowView,
} from './contracts';
import { TrailSegment, type TrailSegmentConfig } from './trailSegment';

export const DEFAULT_FORK_PRUNE_DISTANCE_M = 40;

export interface SegmentInitData {
  readonly segment: TrailSegment;
  readonly isInitial: boolean;
}

export interface AdvanceWindowResult {
  readonly prunedIds: readonly number[];
  readonly spawnedSegments: readonly TrailSegment[];
  readonly forkEntered: {
    readonly chosenSide: 'left' | 'right';
    readonly newSegment: TrailSegment;
    readonly previousStageId: string;
  } | null;
}

interface PolyQueryOut {
  s: number;
  x: number;
  distSq: number;
}

/**
 * 4-slot sliding segment window [prev, curr, nextLeft, nextRight] with O(1) warm-started
 * zero-allocation surface sampling and seamless Model A fork crossing.
 */
export class TrailWindow implements TrailWindowView {
  prev: TrailSegment | null = null;
  curr!: TrailSegment;
  nextLeft: TrailSegment | null = null;
  nextRight: TrailSegment | null = null;

  private nextSegmentId = 1;
  private rng: SeededRng;
  private readonly initialStageId: string;
  private readonly onSegmentCreated: ((segment: TrailSegment) => void) | undefined;

  // Pre-allocated query scratch structs (zero hot-loop heap allocations)
  private readonly queryScratchA: PolyQueryOut = { s: 0, x: 0, distSq: Infinity };
  private readonly queryScratchB: PolyQueryOut = { s: 0, x: 0, distSq: Infinity };
  private readonly queryScratchC: PolyQueryOut = { s: 0, x: 0, distSq: Infinity };
  private readonly frameScratch: SpineFrameOut = createSpineFrameOut();
  private readonly ribbonScratch: RibbonPointOut = createRibbonPointOut();
  private readonly prunedIdScratch: number[] = [];
  private readonly spawnedSegScratch: TrailSegment[] = [];
  private readonly advanceResultScratch: {
    prunedIds: number[];
    spawnedSegments: TrailSegment[];
    forkEntered: {
      chosenSide: 'left' | 'right';
      newSegment: TrailSegment;
      previousStageId: string;
    } | null;
  } = {
    prunedIds: this.prunedIdScratch,
    spawnedSegments: this.spawnedSegScratch,
    forkEntered: null,
  };

  private forkAnnouncedOnCurr = false;

  constructor(
    seed: number | string = 1,
    initialStageId = 'sunny-blue',
    onSegmentCreated?: (segment: TrailSegment) => void,
  ) {
    this.rng = new SeededRng(seed);
    this.initialStageId = initialStageId;
    this.onSegmentCreated = onSegmentCreated;
    this.reset(seed, initialStageId);
  }

  reset(seed: number | string, startStageId = this.initialStageId): void {
    this.rng = new SeededRng(seed);
    this.nextSegmentId = 1;
    this.prev = null;
    this.nextLeft = null;
    this.nextRight = null;
    this.forkAnnouncedOnCurr = false;

    const stage = this.requireStage(startStageId);
    const startHalfWidth = 0.5 * (stage.terrain.halfWidth[0] + stage.terrain.halfWidth[1]);
    const startPitch = -degToRad(0.5 * (stage.terrain.pitchDeg[0] + stage.terrain.pitchDeg[1]));

    const curr = this.createSegment({
      slot: 'curr',
      stage,
      startPosX: 0,
      startPosY: 0,
      startPosZ: 0,
      startYawRad: 0,
      startPitchRad: startPitch,
      startHalfWidth,
      prevSegmentId: null,
      hasFork: true,
      isForkChild: false,
      forkSide: 'none',
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: 0,
      seamYawRad: 0,
      allowIslandDivider: true,
    });
    this.curr = curr;
    this.onSegmentCreated?.(curr);
    this.ensureLookaheadBranches();
  }

  getActiveSegmentById(segmentId: number): TrailSegment | null {
    if (this.curr.id === segmentId) return this.curr;
    if (this.prev && this.prev.id === segmentId) return this.prev;
    if (this.nextLeft && this.nextLeft.id === segmentId) return this.nextLeft;
    if (this.nextRight && this.nextRight.id === segmentId) return this.nextRight;
    return null;
  }

  /**
   * Shifts all active segment polylines, spine LUTs, landmarks, and fork seam anchors
   * when floating-origin rebasing subtracts (deltaX, deltaY, deltaZ).
   */
  rebaseOrigin(deltaX: number, deltaY: number, deltaZ: number): void {
    this.curr.rebaseOrigin(deltaX, deltaY, deltaZ);
    this.prev?.rebaseOrigin(deltaX, deltaY, deltaZ);
    this.nextLeft?.rebaseOrigin(deltaX, deltaY, deltaZ);
    this.nextRight?.rebaseOrigin(deltaX, deltaY, deltaZ);
  }

  /**
   * Warm-started O(1) zero-allocation surface query mapping world (posX, posZ) onto
   * the active TrailWindow, resolving fork seams continuously across grounded/straddling/airborne states.
   */
  sampleSurface(
    posX: number,
    posZ: number,
    hintSegmentId: number,
    hintS: number,
    out: SurfaceSample,
  ): SurfaceSample {
    const hintSeg = hintSegmentId >= 0 ? this.getActiveSegmentById(hintSegmentId) : null;
    let bestSeg: TrailSegment = this.curr;
    let bestS = 0;
    let bestDistSq = Infinity;

    if (hintSeg !== null) {
      // Inspect ~5 adjacent polyline edges around hintS
      this.projectLocalWindow(hintSeg, posX, posZ, hintS, 3, this.queryScratchA);
      bestSeg = hintSeg;
      bestS = this.queryScratchA.s;
      bestDistSq = this.queryScratchA.distSq;

      // Also check connected child/parent near segment ends
      if (hintSeg.id === this.curr.id && bestS >= this.curr.length - 18) {
        const fork = this.curr.fork;
        const seamFwdX = -Math.sin(fork.seamYawRad);
        const seamFwdZ = -Math.cos(fork.seamYawRad);
        const alongSeam =
          (posX - fork.seamWorldX) * seamFwdX + (posZ - fork.seamWorldZ) * seamFwdZ;

        if (alongSeam > 0 && this.nextLeft !== null) {
          if (this.nextRight !== null) {
            this.projectLocalWindow(this.nextLeft, posX, posZ, 0, 5, this.queryScratchB);
            this.projectLocalWindow(this.nextRight, posX, posZ, 0, 5, this.queryScratchC);
            if (Math.abs(this.queryScratchB.x) <= Math.abs(this.queryScratchC.x)) {
              bestSeg = this.nextLeft;
              bestS = this.queryScratchB.s;
              bestDistSq = this.queryScratchB.distSq;
            } else {
              bestSeg = this.nextRight;
              bestS = this.queryScratchC.s;
              bestDistSq = this.queryScratchC.distSq;
            }
          } else {
            this.projectLocalWindow(this.nextLeft, posX, posZ, 0, 5, this.queryScratchB);
            bestSeg = this.nextLeft;
            bestS = this.queryScratchB.s;
            bestDistSq = this.queryScratchB.distSq;
          }
        }
      } else if (this.prev && hintSeg.id === this.prev.id && bestS >= this.prev.length - 15) {
        this.projectLocalWindow(this.curr, posX, posZ, 0, 5, this.queryScratchB);
        if (this.queryScratchB.distSq < bestDistSq) {
          bestSeg = this.curr;
          bestS = this.queryScratchB.s;
          bestDistSq = this.queryScratchB.distSq;
        }
      } else if (
        (hintSeg.id === this.nextLeft?.id || hintSeg.id === this.nextRight?.id) &&
        bestS <= 10
      ) {
        // Check if skier moved back slightly upstream of seam or switched sides at s ~ 0
        const fork = this.curr.fork;
        const seamFwdX = -Math.sin(fork.seamYawRad);
        const seamFwdZ = -Math.cos(fork.seamYawRad);
        const alongSeam =
          (posX - fork.seamWorldX) * seamFwdX + (posZ - fork.seamWorldZ) * seamFwdZ;
        if (alongSeam <= 0) {
          this.projectLocalWindow(this.curr, posX, posZ, this.curr.length, 4, this.queryScratchB);
          bestSeg = this.curr;
          bestS = this.queryScratchB.s;
          bestDistSq = this.queryScratchB.distSq;
        } else if (this.nextLeft && this.nextRight) {
          const sibling = hintSeg.id === this.nextLeft.id ? this.nextRight : this.nextLeft;
          this.projectLocalWindow(sibling, posX, posZ, bestS, 4, this.queryScratchB);
          if (Math.abs(this.queryScratchB.x) < Math.abs(this.queryScratchA.x)) {
            bestSeg = sibling;
            bestS = this.queryScratchB.s;
            bestDistSq = this.queryScratchB.distSq;
          }
        }
      }

      // Fallback full-active scan only when hint misses far (e.g., teleport)
      if (bestDistSq > 1600) {
        this.findBestAcrossWindow(posX, posZ, out);
        return out;
      }
    } else {
      this.findBestAcrossWindow(posX, posZ, out);
      return out;
    }

    this.populateSurfaceSample(bestSeg, bestS, posX, posZ, out);
    return out;
  }

  /**
   * Probes terrain groundY `lookAheadM` meters ahead of `(segmentId, s, lateralX)`,
   * seamlessly stepping into `nextLeft`/`nextRight` across seams.
   */
  probeAheadGroundY(segmentId: number, s: number, lateralX: number, lookAheadM: number): number {
    const seg = this.getActiveSegmentById(segmentId) ?? this.curr;
    const targetS = s + lookAheadM;
    if (targetS <= seg.length) {
      seg.evaluateSurfaceAtX(targetS, lateralX, this.ribbonScratch);
      return this.ribbonScratch.posY;
    }

    const overflow = targetS - seg.length;
    if (seg.id === this.curr.id && this.nextLeft) {
      let targetBranch = this.nextLeft;
      let childX = lateralX;
      if (this.nextRight) {
        const pickRight = lateralX > 0;
        targetBranch = pickRight ? this.nextRight : this.nextLeft;
        const offset = 0.5 * this.curr.getEndPose().halfWidth;
        childX = pickRight ? lateralX - offset : lateralX + offset;
      }
      targetBranch.evaluateSurfaceAtX(
        clamp(overflow, 0, targetBranch.length),
        childX,
        this.ribbonScratch,
      );
      return this.ribbonScratch.posY;
    }

    seg.evaluateSurfaceAtX(seg.length, lateralX, this.ribbonScratch);
    return this.ribbonScratch.posY;
  }

  /**
   * Advances the sliding window when the skier passes `pruneDistanceM` (~40m) onto a chosen branch,
   * pruning the unchosen sibling and old `prev` segment for O(1) memory.
   */
  updateProgression(
    activeSegmentId: number,
    activeS: number,
    pruneDistanceM = DEFAULT_FORK_PRUNE_DISTANCE_M,
  ): AdvanceWindowResult {
    this.prunedIdScratch.length = 0;
    this.spawnedSegScratch.length = 0;
    this.advanceResultScratch.forkEntered = null;

    const onLeft = this.nextLeft !== null && activeSegmentId === this.nextLeft.id;
    const onRight = this.nextRight !== null && activeSegmentId === this.nextRight.id;
    if (!onLeft && !onRight) {
      return this.advanceResultScratch;
    }

    const chosen = onLeft ? this.nextLeft! : this.nextRight!;
    const unchosen = onLeft ? this.nextRight : this.nextLeft;
    const chosenSide: 'left' | 'right' = onLeft ? 'left' : 'right';

    if (!this.forkAnnouncedOnCurr && activeS > 0.2) {
      this.forkAnnouncedOnCurr = true;
      this.advanceResultScratch.forkEntered = {
        chosenSide,
        newSegment: chosen,
        previousStageId: this.curr.stageId,
      };
    }

    const pruneThreshold = Math.min(pruneDistanceM, chosen.length * 0.35);
    if (activeS < pruneThreshold) {
      return this.advanceResultScratch;
    }

    // Prune old prev and unchosen sibling branch
    if (this.prev) {
      this.prunedIdScratch.push(this.prev.id);
    }
    if (unchosen) {
      this.prunedIdScratch.push(unchosen.id);
    }

    this.curr.slot = 'prev';
    this.prev = this.curr;
    chosen.slot = 'curr';
    this.curr = chosen;
    this.nextLeft = null;
    this.nextRight = null;
    this.forkAnnouncedOnCurr = false;

    this.ensureLookaheadBranches();
    if (this.nextLeft) this.spawnedSegScratch.push(this.nextLeft);
    if (this.nextRight) this.spawnedSegScratch.push(this.nextRight);

    return this.advanceResultScratch;
  }

  private ensureLookaheadBranches(): void {
    const endPose = this.curr.getEndPose();
    if (this.curr.fork.hasFork) {
      const leftId = this.curr.fork.leftStageId ?? 'sunny-blue';
      const rightId = this.curr.fork.rightStageId ?? 'icy-black';
      const leftStage = this.requireStage(leftId);
      const rightStage = this.requireStage(rightId);

      const branchHalfWidth = 0.5 * endPose.halfWidth;
      const r0X = Math.cos(endPose.yawRad);
      const r0Z = -Math.sin(endPose.yawRad);

      if (!this.nextLeft) {
        const segL = this.createSegment({
          slot: 'nextLeft',
          stage: leftStage,
          startPosX: endPose.posX - branchHalfWidth * r0X,
          startPosY: endPose.posY,
          startPosZ: endPose.posZ - branchHalfWidth * r0Z,
          startYawRad: endPose.yawRad,
          startPitchRad: endPose.pitchRad,
          startHalfWidth: branchHalfWidth,
          prevSegmentId: this.curr.id,
          hasFork: true,
          isForkChild: true,
          forkSide: 'left',
          seamWorldX: endPose.posX,
          seamWorldY: endPose.posY,
          seamWorldZ: endPose.posZ,
          seamYawRad: endPose.yawRad,
        });
        this.nextLeft = segL;
        this.curr.nextLeftId = segL.id;
        this.onSegmentCreated?.(segL);
      }

      if (!this.nextRight) {
        const segR = this.createSegment({
          slot: 'nextRight',
          stage: rightStage,
          startPosX: endPose.posX + branchHalfWidth * r0X,
          startPosY: endPose.posY,
          startPosZ: endPose.posZ + branchHalfWidth * r0Z,
          startYawRad: endPose.yawRad,
          startPitchRad: endPose.pitchRad,
          startHalfWidth: branchHalfWidth,
          prevSegmentId: this.curr.id,
          hasFork: true,
          isForkChild: true,
          forkSide: 'right',
          seamWorldX: endPose.posX,
          seamWorldY: endPose.posY,
          seamWorldZ: endPose.posZ,
          seamYawRad: endPose.yawRad,
        });
        this.nextRight = segR;
        this.curr.nextRightId = segR.id;
        this.onSegmentCreated?.(segR);
      }
    } else if (!this.nextLeft) {
      const segNext = this.createSegment({
        slot: 'nextLeft',
        stage: this.curr.stage,
        startPosX: endPose.posX,
        startPosY: endPose.posY,
        startPosZ: endPose.posZ,
        startYawRad: endPose.yawRad,
        startPitchRad: endPose.pitchRad,
        startHalfWidth: endPose.halfWidth,
        prevSegmentId: this.curr.id,
        hasFork: true,
        isForkChild: false,
        forkSide: 'none',
        seamWorldX: endPose.posX,
        seamWorldY: endPose.posY,
        seamWorldZ: endPose.posZ,
        seamYawRad: endPose.yawRad,
        initialSafeX: this.curr.sampleSafeX(this.curr.length),
      });
      this.nextLeft = segNext;
      this.curr.nextLeftId = segNext.id;
      this.onSegmentCreated?.(segNext);
    }
  }

  private createSegment(params: {
    slot: TrailSlotRole;
    stage: StageDef;
    startPosX: number;
    startPosY: number;
    startPosZ: number;
    startYawRad: number;
    startPitchRad: number;
    startHalfWidth: number;
    prevSegmentId: number | null;
    hasFork: boolean;
    isForkChild: boolean;
    forkSide: 'none' | 'left' | 'right';
    seamWorldX: number;
    seamWorldY: number;
    seamWorldZ: number;
    seamYawRad: number;
    initialSafeX?: number;
    allowIslandDivider?: boolean;
  }): TrailSegment {
    const id = this.nextSegmentId++;
    const segRng = this.rng.fork(id);
    // Keep segment lengths aligned with 250-320m Model A fork intervals
    const minLen = Math.max(250, params.stage.layout.forkIntervalM[0]);
    const maxLen = Math.min(320, params.stage.layout.forkIntervalM[1]);
    const length = Math.round(segRng.nextRange(minLen, Math.max(minLen + 10, maxLen)));

    let leftStageId: string | null = null;
    let rightStageId: string | null = null;
    let endHalfWidth = 0.5 * (params.stage.terrain.halfWidth[0] + params.stage.terrain.halfWidth[1]);
    let archS = length;

    if (params.hasFork) {
      const swapSides = segRng.nextBool(0.5);
      leftStageId = swapSides ? 'icy-black' : 'sunny-blue';
      rightStageId = swapSides ? 'sunny-blue' : 'icy-black';
      const leftStage = this.requireStage(leftStageId);
      const rightStage = this.requireStage(rightStageId);
      const wL = 0.5 * (leftStage.terrain.halfWidth[0] + leftStage.terrain.halfWidth[1]);
      const wR = 0.5 * (rightStage.terrain.halfWidth[0] + rightStage.terrain.halfWidth[1]);
      endHalfWidth = wL + wR;
      archS = length - segRng.nextRange(155, 195);
    }

    const segConfig: TrailSegmentConfig = {
      id,
      slot: params.slot,
      stage: params.stage,
      seed: segRng.getState(),
      length,
      startPosX: params.startPosX,
      startPosY: params.startPosY,
      startPosZ: params.startPosZ,
      startYawRad: params.startYawRad,
      startPitchRad: params.startPitchRad,
      startHalfWidth: params.startHalfWidth,
      endHalfWidth,
      prevSegmentId: params.prevSegmentId,
      hasFork: params.hasFork,
      archS,
      leftStageId,
      rightStageId,
      isForkChild: params.isForkChild,
      forkSide: params.forkSide,
      seamWorldX: params.seamWorldX,
      seamWorldY: params.seamWorldY,
      seamWorldZ: params.seamWorldZ,
      seamYawRad: params.seamYawRad,
      initialSafeX: params.initialSafeX,
      allowIslandDivider: params.allowIslandDivider,
    };

    return new TrailSegment(segConfig);
  }

  private projectLocalWindow(
    seg: TrailSegment,
    posX: number,
    posZ: number,
    hintS: number,
    edgeRadius: number,
    out: PolyQueryOut,
  ): void {
    const maxEdge = seg.polyCount - 2;
    const centerEdge = clamp(Math.floor(hintS / seg.polyStep), 0, maxEdge);
    const startEdge = Math.max(0, centerEdge - edgeRadius);
    const endEdge = Math.min(maxEdge, centerEdge + edgeRadius);
    this.projectEdgeRange(seg, posX, posZ, startEdge, endEdge, out);
  }

  private projectEdgeRange(
    seg: TrailSegment,
    posX: number,
    posZ: number,
    startEdge: number,
    endEdge: number,
    out: PolyQueryOut,
  ): void {
    let bestDistSq = Infinity;
    let bestS = 0;

    for (let i = startEdge; i <= endEdge; i++) {
      const ax = seg.polyX[i]!;
      const az = seg.polyZ[i]!;
      const bx = seg.polyX[i + 1]!;
      const bz = seg.polyZ[i + 1]!;
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq > 1e-8 ? clamp(((posX - ax) * dx + (posZ - az) * dz) / lenSq, 0, 1) : 0;
      const px = ax + t * dx;
      const pz = az + t * dz;
      const ex = posX - px;
      const ez = posZ - pz;
      const dSq = ex * ex + ez * ez;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        const sA = seg.polyS[i]!;
        const sB = seg.polyS[i + 1]!;
        bestS = sA + t * (sB - sA);
      }
    }

    // Refine `s` once against continuous spine tangent for sub-millimeter accuracy on turns
    seg.sampleSpineFrame(bestS, this.frameScratch);
    const cosY = Math.cos(this.frameScratch.yawRad);
    const sinY = Math.sin(this.frameScratch.yawRad);
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const r0X = cosY;
    const r0Z = -sinY;
    const dx = posX - this.frameScratch.posX;
    const dz = posZ - this.frameScratch.posZ;
    const xApprox = (dx * r0X + dz * r0Z) / Math.max(0.5, Math.cos(this.frameScratch.bankRad));
    const remX = posX - (this.frameScratch.posX + xApprox * this.frameScratch.rightX);
    const remZ = posZ - (this.frameScratch.posZ + xApprox * this.frameScratch.rightZ);
    const cosP = Math.max(0.3, Math.cos(this.frameScratch.pitchRad));
    const deltaS = (remX * fwdX + remZ * fwdZ) / cosP;

    bestS = clamp(bestS + deltaS, 0, seg.length);
    seg.sampleSpineFrame(bestS, this.frameScratch);
    const rx = posX - this.frameScratch.posX;
    const rz = posZ - this.frameScratch.posZ;
    const r0Xf = Math.cos(this.frameScratch.yawRad);
    const r0Zf = -Math.sin(this.frameScratch.yawRad);
    const refinedX = (rx * r0Xf + rz * r0Zf) / Math.max(0.5, Math.cos(this.frameScratch.bankRad));

    out.s = bestS;
    out.x = refinedX;
    out.distSq = bestDistSq;
  }

  private findBestAcrossWindow(posX: number, posZ: number, out: SurfaceSample): void {
    const fork = this.curr.fork;
    const seamFwdX = -Math.sin(fork.seamYawRad);
    const seamFwdZ = -Math.cos(fork.seamYawRad);
    const alongSeam = (posX - fork.seamWorldX) * seamFwdX + (posZ - fork.seamWorldZ) * seamFwdZ;

    if (fork.hasFork && alongSeam > 0 && this.nextLeft && this.nextRight) {
      this.projectEdgeRange(
        this.nextLeft,
        posX,
        posZ,
        0,
        this.nextLeft.polyCount - 2,
        this.queryScratchB,
      );
      this.projectEdgeRange(
        this.nextRight,
        posX,
        posZ,
        0,
        this.nextRight.polyCount - 2,
        this.queryScratchC,
      );
      if (Math.abs(this.queryScratchB.x) <= Math.abs(this.queryScratchC.x)) {
        this.populateSurfaceSample(this.nextLeft, this.queryScratchB.s, posX, posZ, out);
      } else {
        this.populateSurfaceSample(this.nextRight, this.queryScratchC.s, posX, posZ, out);
      }
      return;
    }

    let bestSeg = this.curr;
    this.projectEdgeRange(this.curr, posX, posZ, 0, this.curr.polyCount - 2, this.queryScratchA);
    let bestS = this.queryScratchA.s;
    let bestDistSq = this.queryScratchA.distSq;

    if (this.prev) {
      this.projectEdgeRange(this.prev, posX, posZ, 0, this.prev.polyCount - 2, this.queryScratchB);
      if (this.queryScratchB.distSq < bestDistSq) {
        bestSeg = this.prev;
        bestS = this.queryScratchB.s;
        bestDistSq = this.queryScratchB.distSq;
      }
    }
    if (this.nextLeft && alongSeam > 0) {
      this.projectEdgeRange(
        this.nextLeft,
        posX,
        posZ,
        0,
        this.nextLeft.polyCount - 2,
        this.queryScratchB,
      );
      if (this.queryScratchB.distSq < bestDistSq) {
        bestSeg = this.nextLeft;
        bestS = this.queryScratchB.s;
        bestDistSq = this.queryScratchB.distSq;
      }
    }

    this.populateSurfaceSample(bestSeg, bestS, posX, posZ, out);
  }

  private populateSurfaceSample(
    seg: TrailSegment,
    s: number,
    posX: number,
    posZ: number,
    out: SurfaceSample,
  ): void {
    seg.sampleSpineFrame(s, this.frameScratch);
    const dx = posX - this.frameScratch.posX;
    const dz = posZ - this.frameScratch.posZ;
    const r0X = Math.cos(this.frameScratch.yawRad);
    const r0Z = -Math.sin(this.frameScratch.yawRad);
    const x = (dx * r0X + dz * r0Z) / Math.max(0.5, Math.cos(this.frameScratch.bankRad));

    seg.evaluateSurfaceAtX(s, x, this.ribbonScratch);
    out.segmentId = seg.id;
    out.s = s;
    out.x = x;
    out.groundY = this.ribbonScratch.posY;
    out.normalX = this.ribbonScratch.normalX;
    out.normalY = this.ribbonScratch.normalY;
    out.normalZ = this.ribbonScratch.normalZ;
    out.tangentX = this.frameScratch.forwardX;
    out.tangentY = this.frameScratch.forwardY;
    out.tangentZ = this.frameScratch.forwardZ;
    out.halfWidth = this.ribbonScratch.halfWidth;
    out.surfaceType = this.ribbonScratch.surfaceType;
    out.inBank = Math.abs(x) > this.ribbonScratch.halfWidth;
    out.inDivider = this.ribbonScratch.inDivider;
    out.valid = true;
  }

  private requireStage(id: string): StageDef {
    const stage = getStageDef(id) ?? getStageDef('sunny-blue');
    if (!stage) {
      throw new Error(`Missing stage definition for '${id}'`);
    }
    return stage;
  }
}
