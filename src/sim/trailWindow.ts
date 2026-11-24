import { clamp, degToRad } from '../core/math';
import { SeededRng } from '../core/rng';
import { getAllStages, getStageDef } from '../content/stages';
import type { StageDef } from '../content/types';
import {
  createSpineFrameOut,
  createSpineProjectionOut,
  type ActiveTrackProjectionOut,
  type ActiveTrackProjector,
  type MountainSpineSource,
  type SpineFrameOut,
  type SpineProjectionOut,
  type SpineView,
  type TrailSlotRole,
  type TrailWindowView,
} from './contracts';
import { TrailSegment, type TrailSegmentConfig } from './trailSegment';
import { TrailSpine, type TrailSpineConfig } from './trailSpine';

export const DEFAULT_FORK_PRUNE_DISTANCE_M = 40;
export const MAX_GHOST_SPINES = 28;
export const GHOST_SPINE_PRUNE_DISTANCE_M = 600;

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
  hitInteriorBound: boolean;
}

/**
 * 4-slot sliding segment window [prev, curr, nextLeft, nextRight] paired with
 * 1-level deeper horizon spine lookahead and bounded ghost-spine elevation history,
 * providing O(1) warm-started active-track projection and seamless Model A fork crossing.
 */
export class TrailWindow implements TrailWindowView, MountainSpineSource, ActiveTrackProjector {
  prev: TrailSegment | null = null;
  curr!: TrailSegment;
  nextLeft: TrailSegment | null = null;
  nextRight: TrailSegment | null = null;

  private horizonLL: TrailSpine | null = null;
  private horizonLR: TrailSpine | null = null;
  private horizonRL: TrailSpine | null = null;
  private horizonRR: TrailSpine | null = null;

  private readonly _horizonSpines: TrailSpine[] = [];
  private readonly _ghostSpines: TrailSpine[] = [];
  private readonly _elevationSpines: SpineView[] = [];

  private nextSegmentId = 1;
  private rng: SeededRng;
  private readonly initialStageId: string;
  private readonly onSegmentCreated: ((segment: TrailSegment) => void) | undefined;
  private readonly stageResolver: ((id: string) => StageDef | undefined) | undefined;

  // Pre-allocated query scratch structs (zero hot-loop heap allocations)
  private readonly queryScratchA: PolyQueryOut = { s: 0, x: 0, distSq: Infinity, hitInteriorBound: false };
  private readonly queryScratchB: PolyQueryOut = { s: 0, x: 0, distSq: Infinity, hitInteriorBound: false };
  private readonly queryScratchC: PolyQueryOut = { s: 0, x: 0, distSq: Infinity, hitInteriorBound: false };
  private readonly frameScratch: SpineFrameOut = createSpineFrameOut();
  private readonly spineProjScratch: SpineProjectionOut = createSpineProjectionOut();
  private readonly validForkTargetsScratch: string[] = [];
  private readonly forkPairScratch: { left: string; right: string } = { left: '', right: '' };
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
    stageResolver?: (id: string) => StageDef | undefined,
  ) {
    this.rng = new SeededRng(seed);
    this.initialStageId = initialStageId;
    this.onSegmentCreated = onSegmentCreated;
    this.stageResolver = stageResolver;
    this.reset(seed, initialStageId);
  }

  get elevationSpines(): readonly SpineView[] {
    return this._elevationSpines;
  }

  get horizonSpines(): readonly TrailSpine[] {
    return this._horizonSpines;
  }

  get ghostSpines(): readonly TrailSpine[] {
    return this._ghostSpines;
  }

  reset(seed: number | string, startStageId = this.initialStageId): void {
    this.rng = new SeededRng(seed);
    this.nextSegmentId = 1;
    this.prev = null;
    this.nextLeft = null;
    this.nextRight = null;
    this.horizonLL = null;
    this.horizonLR = null;
    this.horizonRL = null;
    this.horizonRR = null;
    this._horizonSpines.length = 0;
    this._ghostSpines.length = 0;
    this._elevationSpines.length = 0;
    this.forkAnnouncedOnCurr = false;

    const stage = this.requireStage(startStageId);
    const startHalfWidth = 0.5 * (stage.terrain.halfWidth[0] + stage.terrain.halfWidth[1]);
    const startPitch = -degToRad(0.5 * (stage.terrain.pitchDeg[0] + stage.terrain.pitchDeg[1]));

    const curr = this.createSegment({
      slot: 'curr',
      stage,
      parentSeed: null,
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
    this.ensureLookaheadBranches(null, null);
    this.rebuildElevationSpines();
  }

  getActiveSegmentById(segmentId: number): TrailSegment | null {
    if (this.curr.id === segmentId) return this.curr;
    if (this.prev && this.prev.id === segmentId) return this.prev;
    if (this.nextLeft && this.nextLeft.id === segmentId) return this.nextLeft;
    if (this.nextRight && this.nextRight.id === segmentId) return this.nextRight;
    return null;
  }

  collectSpinesInBounds(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    padM: number,
    outSpines: SpineView[],
  ): void {
    outSpines.length = 0;
    const qMinX = minX - padM;
    const qMaxX = maxX + padM;
    const qMinZ = minZ - padM;
    const qMaxZ = maxZ + padM;

    for (let i = 0; i < this._elevationSpines.length; i++) {
      const sp = this._elevationSpines[i]!;
      if (
        sp.boundsMaxX >= qMinX &&
        sp.boundsMinX <= qMaxX &&
        sp.boundsMaxZ >= qMinZ &&
        sp.boundsMinZ <= qMaxZ
      ) {
        outSpines.push(sp);
      }
    }
  }

  /**
   * Shifts all active segment polylines, spine LUTs, landmarks, fork seam anchors,
   * horizon spines, and ghost spines once each when floating-origin rebasing subtracts (deltaX, deltaY, deltaZ).
   */
  rebaseOrigin(deltaX: number, deltaY: number, deltaZ: number): void {
    this.curr.rebaseOrigin(deltaX, deltaY, deltaZ);
    this.prev?.rebaseOrigin(deltaX, deltaY, deltaZ);
    this.nextLeft?.rebaseOrigin(deltaX, deltaY, deltaZ);
    this.nextRight?.rebaseOrigin(deltaX, deltaY, deltaZ);

    for (let i = 0; i < this._horizonSpines.length; i++) {
      this._horizonSpines[i]!.rebaseOrigin(deltaX, deltaY, deltaZ);
    }
    for (let i = 0; i < this._ghostSpines.length; i++) {
      this._ghostSpines[i]!.rebaseOrigin(deltaX, deltaY, deltaZ);
    }
  }

  /**
   * Warm-started O(1) zero-allocation active-window projection mapping world (posX, posZ)
   * onto [prev, curr, nextLeft, nextRight] across on-piste, off-piste, and Model A fork seams.
   */
  projectActiveWindow(
    posX: number,
    posZ: number,
    hintSegmentId: number,
    hintS: number,
    out: ActiveTrackProjectionOut,
  ): ActiveTrackProjectionOut {
    const hintSeg = hintSegmentId >= 0 ? this.getActiveSegmentById(hintSegmentId) : null;
    if (hintSeg === null) {
      this.findBestAcrossWindow(posX, posZ, out);
      return out;
    }

    const overflowed = this.projectLocalWindow(hintSeg, posX, posZ, hintS, 3, this.queryScratchA);
    let bestSeg: TrailSegment = hintSeg;
    let bestS = this.queryScratchA.s;
    let bestDistSq = this.queryScratchA.distSq;

    if (this.prev && bestSeg.id === this.prev.id) {
      const pf = this.prev.fork;
      let alongPrevSeam = -1;
      if (pf.hasFork) {
        const pfFwdX = -Math.sin(pf.seamYawRad);
        const pfFwdZ = -Math.cos(pf.seamYawRad);
        alongPrevSeam = (posX - pf.seamWorldX) * pfFwdX + (posZ - pf.seamWorldZ) * pfFwdZ;
      }
      if (alongPrevSeam > 0 || bestS >= this.prev.length - 15) {
        this.projectFullSegment(this.curr, posX, posZ, this.queryScratchB);
        if (alongPrevSeam > 0 || this.queryScratchB.distSq < bestDistSq) {
          bestSeg = this.curr;
          bestS = this.queryScratchB.s;
          bestDistSq = this.queryScratchB.distSq;
        }
      }
    }

    if (bestSeg.id === this.curr.id && this.nextLeft !== null) {
      if (this.curr.fork.hasFork) {
        const fork = this.curr.fork;
        const seamFwdX = -Math.sin(fork.seamYawRad);
        const seamFwdZ = -Math.cos(fork.seamYawRad);
        const alongSeam =
          (posX - fork.seamWorldX) * seamFwdX + (posZ - fork.seamWorldZ) * seamFwdZ;

        if (alongSeam > 0) {
          if (this.nextRight !== null) {
            this.projectFullSegment(this.nextLeft, posX, posZ, this.queryScratchB);
            this.projectFullSegment(this.nextRight, posX, posZ, this.queryScratchC);
            if (this.queryScratchB.distSq <= this.queryScratchC.distSq) {
              bestSeg = this.nextLeft;
              bestS = this.queryScratchB.s;
              bestDistSq = this.queryScratchB.distSq;
            } else {
              bestSeg = this.nextRight;
              bestS = this.queryScratchC.s;
              bestDistSq = this.queryScratchC.distSq;
            }
          } else {
            this.projectFullSegment(this.nextLeft, posX, posZ, this.queryScratchB);
            bestSeg = this.nextLeft;
            bestS = this.queryScratchB.s;
            bestDistSq = this.queryScratchB.distSq;
          }
        } else if (this.prev && bestS <= 12) {
          this.projectFullSegment(this.prev, posX, posZ, this.queryScratchB);
          if (this.queryScratchB.distSq < bestDistSq) {
            bestSeg = this.prev;
            bestS = this.queryScratchB.s;
            bestDistSq = this.queryScratchB.distSq;
          }
        }
      } else {
        const endPose = this.curr.getEndPose();
        const seamFwdX = -Math.sin(endPose.yawRad);
        const seamFwdZ = -Math.cos(endPose.yawRad);
        const alongSeam = (posX - endPose.posX) * seamFwdX + (posZ - endPose.posZ) * seamFwdZ;
        if (alongSeam > 0 || bestS >= this.curr.length - 15) {
          this.projectFullSegment(this.nextLeft, posX, posZ, this.queryScratchB);
          if (alongSeam > 0 || this.queryScratchB.distSq < bestDistSq) {
            bestSeg = this.nextLeft;
            bestS = this.queryScratchB.s;
            bestDistSq = this.queryScratchB.distSq;
          }
        } else if (this.prev && bestS <= 12) {
          this.projectFullSegment(this.prev, posX, posZ, this.queryScratchB);
          if (this.queryScratchB.distSq < bestDistSq) {
            bestSeg = this.prev;
            bestS = this.queryScratchB.s;
            bestDistSq = this.queryScratchB.distSq;
          }
        }
      }
    } else if (
      bestSeg.id === this.nextLeft?.id ||
      bestSeg.id === this.nextRight?.id
    ) {
      const fork = this.curr.fork;
      let seamX = fork.seamWorldX;
      let seamZ = fork.seamWorldZ;
      let seamYaw = fork.seamYawRad;
      if (!fork.hasFork) {
        const endPose = this.curr.getEndPose();
        seamX = endPose.posX;
        seamZ = endPose.posZ;
        seamYaw = endPose.yawRad;
      }
      const seamFwdX = -Math.sin(seamYaw);
      const seamFwdZ = -Math.cos(seamYaw);
      const alongSeam = (posX - seamX) * seamFwdX + (posZ - seamZ) * seamFwdZ;

      if (alongSeam <= 0) {
        this.projectFullSegment(this.curr, posX, posZ, this.queryScratchB);
        bestSeg = this.curr;
        bestS = this.queryScratchB.s;
        bestDistSq = this.queryScratchB.distSq;
      } else if (
        this.nextLeft &&
        this.nextRight &&
        bestS < DEFAULT_FORK_PRUNE_DISTANCE_M
      ) {
        const sibling = bestSeg.id === this.nextLeft.id ? this.nextRight : this.nextLeft;
        this.projectFullSegment(sibling, posX, posZ, this.queryScratchB);
        if (this.queryScratchB.distSq < bestDistSq) {
          bestSeg = sibling;
          bestS = this.queryScratchB.s;
          bestDistSq = this.queryScratchB.distSq;
        }
      }
    }

    if (overflowed && (bestS <= 1e-4 || bestS >= bestSeg.length - 1e-4)) {
      this.findBestAcrossWindow(posX, posZ, out);
      return out;
    }

    this.populateTrackProjection(bestSeg, bestS, bestDistSq, posX, posZ, out);
    return out;
  }

  /**
   * Advances the sliding window when the skier passes `pruneDistanceM` (~40m) onto a chosen branch
   * (either on-piste or off-piste past the fork seam plane), promoting horizon spines and pruning old segments.
   */
  updateProgression(
    activeSegmentId: number,
    activeS: number,
    pruneDistanceM = DEFAULT_FORK_PRUNE_DISTANCE_M,
    skierPosX?: number,
    skierPosZ?: number,
  ): AdvanceWindowResult {
    this.prunedIdScratch.length = 0;
    this.spawnedSegScratch.length = 0;
    this.advanceResultScratch.forkEntered = null;

    const onLeft = this.nextLeft !== null && activeSegmentId === this.nextLeft.id;
    const onRight = this.nextRight !== null && activeSegmentId === this.nextRight.id;

    let chosen: TrailSegment | null = onLeft ? this.nextLeft : onRight ? this.nextRight : null;
    let unchosen: TrailSegment | null = onLeft ? this.nextRight : onRight ? this.nextLeft : null;
    let chosenSide: 'left' | 'right' = onLeft ? 'left' : 'right';
    let effectiveS = activeS;

    if (!chosen) {
      if (skierPosX === undefined || skierPosZ === undefined || this.nextLeft === null) {
        return this.advanceResultScratch;
      }
      const fork = this.curr.fork;
      let seamX = fork.seamWorldX;
      let seamZ = fork.seamWorldZ;
      let seamYaw = fork.seamYawRad;
      if (!fork.hasFork) {
        const endPose = this.curr.getEndPose();
        seamX = endPose.posX;
        seamZ = endPose.posZ;
        seamYaw = endPose.yawRad;
      }
      const seamFwdX = -Math.sin(seamYaw);
      const seamFwdZ = -Math.cos(seamYaw);
      const alongSeam = (skierPosX - seamX) * seamFwdX + (skierPosZ - seamZ) * seamFwdZ;
      if (alongSeam <= 0.2) {
        return this.advanceResultScratch;
      }

      if (this.nextRight !== null) {
        this.projectFullSegment(this.nextLeft, skierPosX, skierPosZ, this.queryScratchB);
        this.projectFullSegment(this.nextRight, skierPosX, skierPosZ, this.queryScratchC);
        if (this.queryScratchB.distSq <= this.queryScratchC.distSq) {
          chosen = this.nextLeft;
          unchosen = this.nextRight;
          chosenSide = 'left';
          effectiveS = Math.max(this.queryScratchB.s, alongSeam);
        } else {
          chosen = this.nextRight;
          unchosen = this.nextLeft;
          chosenSide = 'right';
          effectiveS = Math.max(this.queryScratchC.s, alongSeam);
        }
      } else {
        this.projectFullSegment(this.nextLeft, skierPosX, skierPosZ, this.queryScratchB);
        chosen = this.nextLeft;
        unchosen = null;
        chosenSide = 'left';
        effectiveS = Math.max(this.queryScratchB.s, alongSeam);
      }
    }

    if (!this.forkAnnouncedOnCurr && effectiveS > 0.2) {
      this.forkAnnouncedOnCurr = true;
      this.advanceResultScratch.forkEntered = {
        chosenSide,
        newSegment: chosen,
        previousStageId: this.curr.stageId,
      };
    }

    const pruneThreshold = Math.min(pruneDistanceM, chosen.length * 0.35);
    if (effectiveS < pruneThreshold) {
      return this.advanceResultScratch;
    }

    // Extract chosen vs unchosen horizon spines before clearing slots (strict single ownership)
    const choseLeft = chosenSide === 'left';
    const promotedLeft = choseLeft ? this.horizonLL : this.horizonRL;
    const promotedRight = choseLeft ? this.horizonLR : this.horizonRR;
    const unchosenHorizonA = choseLeft ? this.horizonRL : this.horizonLL;
    const unchosenHorizonB = choseLeft ? this.horizonRR : this.horizonLR;

    this.horizonLL = null;
    this.horizonLR = null;
    this.horizonRL = null;
    this.horizonRR = null;
    this._horizonSpines.length = 0;

    // Move pruned active spines and unchosen horizon spines into ghostSpines
    if (this.prev) {
      this.prunedIdScratch.push(this.prev.id);
      this._ghostSpines.push(this.prev.spine);
    }
    if (unchosen) {
      this.prunedIdScratch.push(unchosen.id);
      this._ghostSpines.push(unchosen.spine);
    }
    if (unchosenHorizonA) {
      this._ghostSpines.push(unchosenHorizonA);
    }
    if (unchosenHorizonB) {
      this._ghostSpines.push(unchosenHorizonB);
    }

    this.curr.slot = 'prev';
    this.prev = this.curr;
    chosen.slot = 'curr';
    this.curr = chosen;
    this.nextLeft = null;
    this.nextRight = null;
    this.forkAnnouncedOnCurr = false;

    this.ensureLookaheadBranches(promotedLeft, promotedRight);
    if (this.nextLeft) this.spawnedSegScratch.push(this.nextLeft);
    if (this.nextRight) this.spawnedSegScratch.push(this.nextRight);

    let refX = skierPosX;
    let refZ = skierPosZ;
    if (refX === undefined || refZ === undefined) {
      chosen.sampleSpineFrame(activeS, this.frameScratch);
      refX = this.frameScratch.posX;
      refZ = this.frameScratch.posZ;
    }
    this.pruneGhostSpines(refX, refZ);
    this.rebuildElevationSpines();

    return this.advanceResultScratch;
  }

  private ensureLookaheadBranches(
    promotedLeft: TrailSpine | null,
    promotedRight: TrailSpine | null,
  ): void {
    const endPose = this.curr.getEndPose();
    if (this.curr.fork.hasFork) {
      const leftId = this.curr.fork.leftStageId ?? this.curr.stageId;
      const rightId = this.curr.fork.rightStageId ?? this.curr.stageId;
      const leftStage = this.requireStage(leftId);
      const rightStage = this.requireStage(rightId);

      const branchHalfWidth = 0.5 * endPose.halfWidth;
      const r0X = Math.cos(endPose.yawRad);
      const r0Z = -Math.sin(endPose.yawRad);

      if (!this.nextLeft) {
        const segL = promotedLeft
          ? new TrailSegment(
              this.segmentConfigFromSpine(promotedLeft, 'nextLeft', this.curr.id),
            )
          : this.createSegment({
              slot: 'nextLeft',
              stage: leftStage,
              parentSeed: this.curr.seed,
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
        const segR = promotedRight
          ? new TrailSegment(
              this.segmentConfigFromSpine(promotedRight, 'nextRight', this.curr.id),
            )
          : this.createSegment({
              slot: 'nextRight',
              stage: rightStage,
              parentSeed: this.curr.seed,
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
      const segNext = promotedLeft
        ? new TrailSegment(
            this.segmentConfigFromSpine(
              promotedLeft,
              'nextLeft',
              this.curr.id,
              this.curr.sampleSafeX(this.curr.length),
            ),
          )
        : this.createSegment({
            slot: 'nextLeft',
            stage: this.curr.stage,
            parentSeed: this.curr.seed,
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

    // Build 1-level deeper lightweight horizon TrailSpines (never firing onSegmentCreated)
    this._horizonSpines.length = 0;
    if (this.nextLeft && this.nextLeft.fork.hasFork) {
      const nEnd = this.nextLeft.getEndPose();
      const bhw = 0.5 * nEnd.halfWidth;
      const r0X = Math.cos(nEnd.yawRad);
      const r0Z = -Math.sin(nEnd.yawRad);
      const lStage = this.requireStage(this.nextLeft.fork.leftStageId ?? this.nextLeft.stageId);
      const rStage = this.requireStage(this.nextLeft.fork.rightStageId ?? this.nextLeft.stageId);

      if (!this.horizonLL) {
        this.horizonLL = this.createHorizonSpine({
          stage: lStage,
          parentSeed: this.nextLeft.seed,
          startPosX: nEnd.posX - bhw * r0X,
          startPosY: nEnd.posY,
          startPosZ: nEnd.posZ - bhw * r0Z,
          startYawRad: nEnd.yawRad,
          startPitchRad: nEnd.pitchRad,
          startHalfWidth: bhw,
          hasFork: true,
          isForkChild: true,
          forkSide: 'left',
          seamWorldX: nEnd.posX,
          seamWorldY: nEnd.posY,
          seamWorldZ: nEnd.posZ,
          seamYawRad: nEnd.yawRad,
        });
      }
      if (!this.horizonLR) {
        this.horizonLR = this.createHorizonSpine({
          stage: rStage,
          parentSeed: this.nextLeft.seed,
          startPosX: nEnd.posX + bhw * r0X,
          startPosY: nEnd.posY,
          startPosZ: nEnd.posZ + bhw * r0Z,
          startYawRad: nEnd.yawRad,
          startPitchRad: nEnd.pitchRad,
          startHalfWidth: bhw,
          hasFork: true,
          isForkChild: true,
          forkSide: 'right',
          seamWorldX: nEnd.posX,
          seamWorldY: nEnd.posY,
          seamWorldZ: nEnd.posZ,
          seamYawRad: nEnd.yawRad,
        });
      }
      this._horizonSpines.push(this.horizonLL, this.horizonLR);
    }

    if (this.nextRight && this.nextRight.fork.hasFork) {
      const nEnd = this.nextRight.getEndPose();
      const bhw = 0.5 * nEnd.halfWidth;
      const r0X = Math.cos(nEnd.yawRad);
      const r0Z = -Math.sin(nEnd.yawRad);
      const lStage = this.requireStage(this.nextRight.fork.leftStageId ?? this.nextRight.stageId);
      const rStage = this.requireStage(this.nextRight.fork.rightStageId ?? this.nextRight.stageId);

      if (!this.horizonRL) {
        this.horizonRL = this.createHorizonSpine({
          stage: lStage,
          parentSeed: this.nextRight.seed,
          startPosX: nEnd.posX - bhw * r0X,
          startPosY: nEnd.posY,
          startPosZ: nEnd.posZ - bhw * r0Z,
          startYawRad: nEnd.yawRad,
          startPitchRad: nEnd.pitchRad,
          startHalfWidth: bhw,
          hasFork: true,
          isForkChild: true,
          forkSide: 'left',
          seamWorldX: nEnd.posX,
          seamWorldY: nEnd.posY,
          seamWorldZ: nEnd.posZ,
          seamYawRad: nEnd.yawRad,
        });
      }
      if (!this.horizonRR) {
        this.horizonRR = this.createHorizonSpine({
          stage: rStage,
          parentSeed: this.nextRight.seed,
          startPosX: nEnd.posX + bhw * r0X,
          startPosY: nEnd.posY,
          startPosZ: nEnd.posZ + bhw * r0Z,
          startYawRad: nEnd.yawRad,
          startPitchRad: nEnd.pitchRad,
          startHalfWidth: bhw,
          hasFork: true,
          isForkChild: true,
          forkSide: 'right',
          seamWorldX: nEnd.posX,
          seamWorldY: nEnd.posY,
          seamWorldZ: nEnd.posZ,
          seamYawRad: nEnd.yawRad,
        });
      }
      this._horizonSpines.push(this.horizonRL, this.horizonRR);
    }
  }

  private segmentConfigFromSpine(
    spine: TrailSpine,
    slot: TrailSlotRole,
    prevSegmentId: number | null,
    initialSafeX?: number,
  ): TrailSegmentConfig {
    spine.sampleSpineFrame(0, this.frameScratch);
    const endPose = spine.getEndPose();
    return {
      id: spine.id,
      slot,
      stage: spine.stage,
      seed: spine.seed,
      length: spine.length,
      startPosX: this.frameScratch.posX,
      startPosY: this.frameScratch.posY,
      startPosZ: this.frameScratch.posZ,
      startYawRad: this.frameScratch.yawRad,
      startPitchRad: this.frameScratch.pitchRad,
      startHalfWidth: this.frameScratch.halfWidth,
      endHalfWidth: endPose.halfWidth,
      prevSegmentId,
      hasFork: spine.fork.hasFork,
      leftStageId: spine.fork.leftStageId,
      rightStageId: spine.fork.rightStageId,
      isForkChild: spine.fork.isForkChild,
      forkSide: spine.fork.forkSide,
      seamWorldX: spine.fork.seamWorldX,
      seamWorldY: spine.fork.seamWorldY,
      seamWorldZ: spine.fork.seamWorldZ,
      seamYawRad: spine.fork.seamYawRad,
      initialSafeX,
      existingSpine: spine,
    };
  }

  private buildSpineConfig(params: {
    stage: StageDef;
    parentSeed: number | null;
    startPosX: number;
    startPosY: number;
    startPosZ: number;
    startYawRad: number;
    startPitchRad: number;
    startHalfWidth: number;
    hasFork: boolean;
    isForkChild: boolean;
    forkSide: 'none' | 'left' | 'right';
    seamWorldX: number;
    seamWorldY: number;
    seamWorldZ: number;
    seamYawRad: number;
    allowIslandDivider?: boolean;
  }): TrailSpineConfig & { readonly endHalfWidth: number } {
    const id = this.nextSegmentId++;
    let segRng: SeededRng;
    if (params.parentSeed !== null) {
      const salt =
        params.forkSide === 'left'
          ? 'fork_left'
          : params.forkSide === 'right'
            ? 'fork_right'
            : 'fork_next';
      segRng = new SeededRng(params.parentSeed).fork(salt);
    } else {
      segRng = this.rng.fork(id);
    }

    // Keep segment lengths aligned with 250-320m Model A fork intervals
    const minLen = Math.max(250, params.stage.layout.forkIntervalM[0]);
    const maxLen = Math.min(320, params.stage.layout.forkIntervalM[1]);
    const length = Math.round(segRng.nextRange(minLen, Math.max(minLen + 10, maxLen)));

    let leftStageId: string | null = null;
    let rightStageId: string | null = null;
    let endHalfWidth =
      0.5 * (params.stage.terrain.halfWidth[0] + params.stage.terrain.halfWidth[1]);

    if (params.hasFork) {
      this.pickForkTargets(params.stage, segRng, this.forkPairScratch);
      leftStageId = this.forkPairScratch.left;
      rightStageId = this.forkPairScratch.right;
      const leftStage = this.requireStage(leftStageId);
      const rightStage = this.requireStage(rightStageId);
      const wL = 0.5 * (leftStage.terrain.halfWidth[0] + leftStage.terrain.halfWidth[1]);
      const wR = 0.5 * (rightStage.terrain.halfWidth[0] + rightStage.terrain.halfWidth[1]);
      endHalfWidth = wL + wR;
    }

    return {
      id,
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
      hasFork: params.hasFork,
      leftStageId,
      rightStageId,
      isForkChild: params.isForkChild,
      forkSide: params.forkSide,
      seamWorldX: params.seamWorldX,
      seamWorldY: params.seamWorldY,
      seamWorldZ: params.seamWorldZ,
      seamYawRad: params.seamYawRad,
      allowIslandDivider: params.allowIslandDivider,
    };
  }

  private createHorizonSpine(params: {
    stage: StageDef;
    parentSeed: number;
    startPosX: number;
    startPosY: number;
    startPosZ: number;
    startYawRad: number;
    startPitchRad: number;
    startHalfWidth: number;
    hasFork: boolean;
    isForkChild: boolean;
    forkSide: 'none' | 'left' | 'right';
    seamWorldX: number;
    seamWorldY: number;
    seamWorldZ: number;
    seamYawRad: number;
  }): TrailSpine {
    const cfg = this.buildSpineConfig(params);
    return new TrailSpine(cfg);
  }

  private createSegment(params: {
    slot: TrailSlotRole;
    stage: StageDef;
    parentSeed: number | null;
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
    const cfg = this.buildSpineConfig(params);
    const segConfig: TrailSegmentConfig = {
      ...cfg,
      slot: params.slot,
      prevSegmentId: params.prevSegmentId,
      initialSafeX: params.initialSafeX,
    };
    return new TrailSegment(segConfig);
  }

  private pickForkTargets(
    stage: StageDef,
    rng: SeededRng,
    out: { left: string; right: string },
  ): void {
    const valid = this.validForkTargetsScratch;
    valid.length = 0;

    for (let i = 0; i < stage.forkTargets.length; i++) {
      const targetId = stage.forkTargets[i]!;
      if (this.lookupStage(targetId) === undefined) continue;
      let duplicate = false;
      for (let j = 0; j < valid.length; j++) {
        if (valid[j] === targetId) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) {
        valid.push(targetId);
      }
    }

    if (valid.length >= 2) {
      if (valid.length === 2) {
        const swapSides = rng.nextBool(0.5);
        out.left = swapSides ? valid[1]! : valid[0]!;
        out.right = swapSides ? valid[0]! : valid[1]!;
      } else {
        const idxA = rng.nextInt(0, valid.length);
        const offset = rng.nextInt(1, valid.length);
        const idxB = (idxA + offset) % valid.length;
        const swapSides = rng.nextBool(0.5);
        out.left = swapSides ? valid[idxB]! : valid[idxA]!;
        out.right = swapSides ? valid[idxA]! : valid[idxB]!;
      }
      return;
    }

    if (valid.length === 1) {
      out.left = valid[0]!;
      out.right = valid[0]!;
      return;
    }

    out.left = stage.id;
    out.right = stage.id;
  }

  private pruneGhostSpines(skierX: number, skierZ: number): void {
    const maxDistSq = GHOST_SPINE_PRUNE_DISTANCE_M * GHOST_SPINE_PRUNE_DISTANCE_M;
    let writeIdx = 0;
    for (let i = 0; i < this._ghostSpines.length; i++) {
      const sp = this._ghostSpines[i]!;
      if (this.computeAabbDistSq(sp, skierX, skierZ) <= maxDistSq) {
        this._ghostSpines[writeIdx++] = sp;
      }
    }
    this._ghostSpines.length = writeIdx;

    while (this._ghostSpines.length > MAX_GHOST_SPINES) {
      let maxIdx = 0;
      let maxVal = -1;
      for (let i = 0; i < this._ghostSpines.length; i++) {
        const dSq = this.computeAabbDistSq(this._ghostSpines[i]!, skierX, skierZ);
        if (dSq > maxVal) {
          maxVal = dSq;
          maxIdx = i;
        }
      }
      const last = this._ghostSpines.pop()!;
      if (maxIdx < this._ghostSpines.length) {
        this._ghostSpines[maxIdx] = last;
      }
    }
  }

  private computeAabbDistSq(sp: TrailSpine, wx: number, wz: number): number {
    const dx = wx < sp.boundsMinX ? sp.boundsMinX - wx : wx > sp.boundsMaxX ? wx - sp.boundsMaxX : 0;
    const dz = wz < sp.boundsMinZ ? sp.boundsMinZ - wz : wz > sp.boundsMaxZ ? wz - sp.boundsMaxZ : 0;
    return dx * dx + dz * dz;
  }

  private rebuildElevationSpines(): void {
    this._elevationSpines.length = 0;
    for (let i = 0; i < this._ghostSpines.length; i++) {
      this._elevationSpines.push(this._ghostSpines[i]!);
    }
    if (this.prev) this._elevationSpines.push(this.prev);
    this._elevationSpines.push(this.curr);
    if (this.nextLeft) this._elevationSpines.push(this.nextLeft);
    if (this.nextRight) this._elevationSpines.push(this.nextRight);
    for (let i = 0; i < this._horizonSpines.length; i++) {
      this._elevationSpines.push(this._horizonSpines[i]!);
    }
  }

  private projectLocalWindow(
    seg: TrailSegment,
    posX: number,
    posZ: number,
    hintS: number,
    edgeRadius: number,
    out: PolyQueryOut,
  ): boolean {
    const maxEdge = seg.polyCount - 2;
    const centerEdge = clamp(Math.floor(hintS / seg.polyStep), 0, maxEdge);
    const startEdge = Math.max(0, centerEdge - edgeRadius);
    const endEdge = Math.min(maxEdge, centerEdge + edgeRadius);
    this.projectEdgeRange(seg, posX, posZ, startEdge, endEdge, out);

    const hitInteriorLeft = startEdge > 0 && out.s <= seg.polyS[startEdge]! + 1e-4;
    const hitInteriorRight = endEdge < maxEdge && out.s >= seg.polyS[endEdge + 1]! - 1e-4;
    if (hitInteriorLeft || hitInteriorRight) {
      this.projectFullSegment(seg, posX, posZ, out);
      return true;
    }
    return false;
  }

  private projectFullSegment(
    seg: TrailSegment,
    posX: number,
    posZ: number,
    out: PolyQueryOut,
  ): void {
    seg.projectXZ(posX, posZ, this.spineProjScratch);
    out.s = this.spineProjScratch.s;
    out.distSq = this.spineProjScratch.distSq;
    out.hitInteriorBound = false;

    seg.sampleSpineFrame(out.s, this.frameScratch);
    const dx = posX - this.frameScratch.posX;
    const dz = posZ - this.frameScratch.posZ;
    const r0X = Math.cos(this.frameScratch.yawRad);
    const r0Z = -Math.sin(this.frameScratch.yawRad);
    out.x = (dx * r0X + dz * r0Z) / Math.max(0.5, Math.cos(this.frameScratch.bankRad));
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

    // Refine `s` once against continuous spine tangent while keeping distSq non-increasing
    seg.sampleSpineFrame(bestS, this.frameScratch);
    const curDx = posX - this.frameScratch.posX;
    const curDz = posZ - this.frameScratch.posZ;
    const curDistSq = curDx * curDx + curDz * curDz;

    const fwdX0 = -Math.sin(this.frameScratch.yawRad);
    const fwdZ0 = -Math.cos(this.frameScratch.yawRad);
    const cosP0 = Math.max(0.3, Math.cos(this.frameScratch.pitchRad));
    const remFwd0 = curDx * fwdX0 + curDz * fwdZ0;
    const deltaS = clamp(remFwd0 / cosP0, -seg.polyStep, seg.polyStep);
    const candS = clamp(bestS + deltaS, 0, seg.length);

    if (candS !== bestS) {
      seg.sampleSpineFrame(candS, this.frameScratch);
      const candDx = posX - this.frameScratch.posX;
      const candDz = posZ - this.frameScratch.posZ;
      const candDistSq = candDx * candDx + candDz * candDz;
      if (candDistSq <= curDistSq) {
        bestS = candS;
        bestDistSq = candDistSq;
      } else {
        seg.sampleSpineFrame(bestS, this.frameScratch);
        bestDistSq = curDistSq;
      }
    } else {
      bestDistSq = curDistSq;
    }

    const rx = posX - this.frameScratch.posX;
    const rz = posZ - this.frameScratch.posZ;
    const r0Xf = Math.cos(this.frameScratch.yawRad);
    const r0Zf = -Math.sin(this.frameScratch.yawRad);
    const refinedX = (rx * r0Xf + rz * r0Zf) / Math.max(0.5, Math.cos(this.frameScratch.bankRad));

    out.s = bestS;
    out.x = refinedX;
    out.distSq = bestDistSq;
    out.hitInteriorBound = false;
  }

  private findBestAcrossWindow(posX: number, posZ: number, out: ActiveTrackProjectionOut): void {
    const fork = this.curr.fork;
    const seamFwdX = -Math.sin(fork.seamYawRad);
    const seamFwdZ = -Math.cos(fork.seamYawRad);
    const alongSeam = (posX - fork.seamWorldX) * seamFwdX + (posZ - fork.seamWorldZ) * seamFwdZ;

    if (fork.hasFork && alongSeam > 0 && this.nextLeft && this.nextRight) {
      this.projectFullSegment(this.nextLeft, posX, posZ, this.queryScratchB);
      this.projectFullSegment(this.nextRight, posX, posZ, this.queryScratchC);
      if (this.queryScratchB.distSq <= this.queryScratchC.distSq) {
        this.populateTrackProjection(
          this.nextLeft,
          this.queryScratchB.s,
          this.queryScratchB.distSq,
          posX,
          posZ,
          out,
        );
      } else {
        this.populateTrackProjection(
          this.nextRight,
          this.queryScratchC.s,
          this.queryScratchC.distSq,
          posX,
          posZ,
          out,
        );
      }
      return;
    }

    let bestSeg = this.curr;
    this.projectFullSegment(this.curr, posX, posZ, this.queryScratchA);
    let bestS = this.queryScratchA.s;
    let bestDistSq = this.queryScratchA.distSq;

    if (this.prev) {
      this.projectFullSegment(this.prev, posX, posZ, this.queryScratchB);
      if (this.queryScratchB.distSq < bestDistSq) {
        bestSeg = this.prev;
        bestS = this.queryScratchB.s;
        bestDistSq = this.queryScratchB.distSq;
      }
    }
    if (this.nextLeft && alongSeam > 0) {
      this.projectFullSegment(this.nextLeft, posX, posZ, this.queryScratchB);
      if (this.queryScratchB.distSq < bestDistSq) {
        bestSeg = this.nextLeft;
        bestS = this.queryScratchB.s;
        bestDistSq = this.queryScratchB.distSq;
      }
    }

    this.populateTrackProjection(bestSeg, bestS, bestDistSq, posX, posZ, out);
  }

  private populateTrackProjection(
    seg: TrailSegment,
    s: number,
    distSq: number,
    posX: number,
    posZ: number,
    out: ActiveTrackProjectionOut,
  ): void {
    seg.sampleSpineFrame(s, this.frameScratch);
    const dx = posX - this.frameScratch.posX;
    const dz = posZ - this.frameScratch.posZ;
    const r0X = Math.cos(this.frameScratch.yawRad);
    const r0Z = -Math.sin(this.frameScratch.yawRad);
    const x = (dx * r0X + dz * r0Z) / Math.max(0.5, Math.cos(this.frameScratch.bankRad));

    out.segmentId = seg.id;
    out.s = s;
    out.x = x;
    out.halfWidth = this.frameScratch.halfWidth;
    out.tangentX = this.frameScratch.forwardX;
    out.tangentY = this.frameScratch.forwardY;
    out.tangentZ = this.frameScratch.forwardZ;
    out.distSq = distSq;
    out.valid = true;
  }

  private lookupStage(id: string): StageDef | undefined {
    return this.stageResolver ? this.stageResolver(id) : getStageDef(id);
  }

  private requireStage(id: string): StageDef {
    const stage =
      this.lookupStage(id) ?? this.lookupStage(this.initialStageId) ?? getAllStages()[0];
    if (!stage) {
      throw new Error(`Missing stage definition for '${id}'`);
    }
    return stage;
  }
}
