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
  type TopologyChangeListener,
  type TrailSlotRole,
  type TrailWindowView,
  type WorldDirtyRect,
} from './contracts';
import { TrailSegment, type TrailSegmentConfig } from './trailSegment';
import { TrailSpine, type TrailSpineConfig } from './trailSpine';

export const DEFAULT_FORK_PRUNE_DISTANCE_M = 40;
export const MAX_GHOST_SPINES = 44;
export const GHOST_SPINE_PRUNE_DISTANCE_M = 960;
const TOPOLOGY_DIRTY_PAD_M = 300;

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

  // Lightweight math-only 2nd lookahead tier (~600-950m ahead) so new spawns stay beyond R_macro + fog
  private horizon2LLL: TrailSpine | null = null;
  private horizon2LLR: TrailSpine | null = null;
  private horizon2LRL: TrailSpine | null = null;
  private horizon2LRR: TrailSpine | null = null;
  private horizon2RLL: TrailSpine | null = null;
  private horizon2RLR: TrailSpine | null = null;
  private horizon2RRL: TrailSpine | null = null;
  private horizon2RRR: TrailSpine | null = null;

  private readonly _horizonSpines: TrailSpine[] = [];
  private readonly _horizon2Spines: TrailSpine[] = [];
  private readonly _ghostSpines: TrailSpine[] = [];
  private readonly _elevationSpines: SpineView[] = [];
  private readonly topologyListeners: TopologyChangeListener[] = [];
  private readonly dirtyRectScratch: WorldDirtyRect[] = [];
  private readonly avoidSpinesScratch: TrailSpine[] = [];
  private readonly builtH2Scratch: TrailSpine[] = [];
  private readonly prunedParentIdsScratch = new Set<number>();

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
  private readonly breatherTargetsScratch: string[] = [];
  private readonly intenseTargetsScratch: string[] = [];
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

  get horizon2Spines(): readonly TrailSpine[] {
    return this._horizon2Spines;
  }

  get ghostSpines(): readonly TrailSpine[] {
    return this._ghostSpines;
  }

  addTopologyListener(listener: TopologyChangeListener): void {
    if (!this.topologyListeners.includes(listener)) {
      this.topologyListeners.push(listener);
    }
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
    this.horizon2LLL = null;
    this.horizon2LLR = null;
    this.horizon2LRL = null;
    this.horizon2LRR = null;
    this.horizon2RLL = null;
    this.horizon2RLR = null;
    this.horizon2RRL = null;
    this.horizon2RRR = null;
    this._horizonSpines.length = 0;
    this._horizon2Spines.length = 0;
    this._ghostSpines.length = 0;
    this._elevationSpines.length = 0;
    this.dirtyRectScratch.length = 0;
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
      hasUpstreamParent: false,
    });
    this.curr = curr;
    // S6 ordering fix: build lookahead & rebuild elevationSpines + notify MountainField BEFORE firing onSegmentCreated
    this.ensureLookaheadBranches(null, null);
    this.rebuildElevationSpines();
    this.notifyTopologyChanged(true);

    this.onSegmentCreated?.(curr);
    if (this.nextLeft) this.onSegmentCreated?.(this.nextLeft);
    if (this.nextRight) this.onSegmentCreated?.(this.nextRight);
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
      let sMinX = sp.boundsMinX;
      let sMaxX = sp.boundsMaxX;
      let sMinZ = sp.boundsMinZ;
      let sMaxZ = sp.boundsMaxZ;
      const mn = sp.macroNodes;
      if (mn !== undefined) {
        if (mn.useUpstreamExt && mn.upBoundsMinX <= mn.upBoundsMaxX) {
          if (mn.upBoundsMinX < sMinX) sMinX = mn.upBoundsMinX;
          if (mn.upBoundsMaxX > sMaxX) sMaxX = mn.upBoundsMaxX;
          if (mn.upBoundsMinZ < sMinZ) sMinZ = mn.upBoundsMinZ;
          if (mn.upBoundsMaxZ > sMaxZ) sMaxZ = mn.upBoundsMaxZ;
        }
        if (mn.useDownstreamExt && mn.downBoundsMinX <= mn.downBoundsMaxX) {
          if (mn.downBoundsMinX < sMinX) sMinX = mn.downBoundsMinX;
          if (mn.downBoundsMaxX > sMaxX) sMaxX = mn.downBoundsMaxX;
          if (mn.downBoundsMinZ < sMinZ) sMinZ = mn.downBoundsMinZ;
          if (mn.downBoundsMaxZ > sMaxZ) sMaxZ = mn.downBoundsMaxZ;
        }
      }
      const cl = sp.corridorLeft;
      if (cl !== undefined && cl.boundsMinX <= cl.boundsMaxX) {
        if (cl.boundsMinX < sMinX) sMinX = cl.boundsMinX;
        if (cl.boundsMaxX > sMaxX) sMaxX = cl.boundsMaxX;
        if (cl.boundsMinZ < sMinZ) sMinZ = cl.boundsMinZ;
        if (cl.boundsMaxZ > sMaxZ) sMaxZ = cl.boundsMaxZ;
      }
      const cr = sp.corridorRight;
      if (cr !== undefined && cr.boundsMinX <= cr.boundsMaxX) {
        if (cr.boundsMinX < sMinX) sMinX = cr.boundsMinX;
        if (cr.boundsMaxX > sMaxX) sMaxX = cr.boundsMaxX;
        if (cr.boundsMinZ < sMinZ) sMinZ = cr.boundsMinZ;
        if (cr.boundsMaxZ > sMaxZ) sMaxZ = cr.boundsMaxZ;
      }
      if (sMaxX >= qMinX && sMinX <= qMaxX && sMaxZ >= qMinZ && sMinZ <= qMaxZ) {
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
    for (let i = 0; i < this._horizon2Spines.length; i++) {
      this._horizon2Spines[i]!.rebaseOrigin(deltaX, deltaY, deltaZ);
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

    // Extract chosen vs unchosen Tier-1 horizon spines before clearing slots (strict single ownership).
    // Tier-2 horizon2 spines serve purely as the far macro apron and are rebuilt fresh rather than
    // promoted into Tier-1, so Tier-1 forks never inherit 8-rib pinched divergence angles.
    const choseLeft = chosenSide === 'left';
    const promotedLeft = choseLeft ? this.horizonLL : this.horizonRL;
    const promotedRight = choseLeft ? this.horizonLR : this.horizonRR;

    const unchosenHorizonA = choseLeft ? this.horizonRL : this.horizonLL;
    const unchosenHorizonB = choseLeft ? this.horizonRR : this.horizonLR;

    this.dirtyRectScratch.length = 0;
    for (let i = 0; i < this._horizon2Spines.length; i++) {
      this.recordSpineDirtyRect(this._horizon2Spines[i]!);
    }

    this.horizonLL = null;
    this.horizonLR = null;
    this.horizonRL = null;
    this.horizonRR = null;
    this.horizon2LLL = null;
    this.horizon2LLR = null;
    this.horizon2LRL = null;
    this.horizon2LRR = null;
    this.horizon2RLL = null;
    this.horizon2RLR = null;
    this.horizon2RRL = null;
    this.horizon2RRR = null;
    this._horizonSpines.length = 0;
    this._horizon2Spines.length = 0;

    // Move pruned active spines and unchosen Tier-1 horizon spines into ghostSpines so
    // unchosen branches never become truncated macro stubs and heightfield invariance within 280m
    // stays exact. Drop distant horizon2 spines (>480m ahead) and restore open-leaf downstream
    // extensions on unchosenHorizonA/B so ghosts extend seamlessly.
    if (this.prev) {
      this.prunedIdScratch.push(this.prev.id);
      this._ghostSpines.push(this.prev.spine);
    }
    if (unchosen) {
      this.prunedIdScratch.push(unchosen.id);
      this._ghostSpines.push(unchosen.spine);
    }
    if (unchosenHorizonA) {
      if (!unchosenHorizonA.macroNodes.useDownstreamExt) {
        unchosenHorizonA.setHasDownstreamChildren(false);
        this.recordDownstreamExtDirtyRect(unchosenHorizonA);
      }
      this._ghostSpines.push(unchosenHorizonA);
    }
    if (unchosenHorizonB) {
      if (!unchosenHorizonB.macroNodes.useDownstreamExt) {
        unchosenHorizonB.setHasDownstreamChildren(false);
        this.recordDownstreamExtDirtyRect(unchosenHorizonB);
      }
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
    // S6 ordering fix: rebuild elevationSpines & notify MountainField BEFORE firing onSegmentCreated
    this.rebuildElevationSpines();
    this.notifyTopologyChanged(false);

    for (let i = 0; i < this.spawnedSegScratch.length; i++) {
      this.onSegmentCreated?.(this.spawnedSegScratch[i]!);
    }

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
              hasUpstreamParent: true,
              targetBranchYawRad: clamp(endPose.yawRad * 0.5 + degToRad(22), -degToRad(44), degToRad(44)),
              bisectorYawRad: endPose.yawRad * 0.5,
            });
        this.nextLeft = segL;
        this.curr.nextLeftId = segL.id;
        if (!promotedLeft) this.recordSpineDirtyRect(segL.spine);
      }

      if (!this.nextRight) {
        this.avoidSpinesScratch.length = 0;
        if (this.nextLeft) this.avoidSpinesScratch.push(this.nextLeft.spine);
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
              hasUpstreamParent: true,
              targetBranchYawRad: clamp(endPose.yawRad * 0.5 - degToRad(22), -degToRad(44), degToRad(44)),
              bisectorYawRad: endPose.yawRad * 0.5,
              avoidSpines: this.avoidSpinesScratch,
            });
        this.nextRight = segR;
        this.curr.nextRightId = segR.id;
        if (!promotedRight) this.recordSpineDirtyRect(segR.spine);
      }
      this.curr.spine.setHasDownstreamChildren(true);
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
            hasUpstreamParent: true,
          });
      this.nextLeft = segNext;
      this.curr.nextLeftId = segNext.id;
      if (!promotedLeft) this.recordSpineDirtyRect(segNext.spine);
      this.curr.spine.setHasDownstreamChildren(true);
    }

    // Tier 1: Build 1-level deeper horizon TrailSpines fresh in symmetric CENTER-OUTWARD order
    // (LR -> RL -> LL -> RR) so left wings fan left and right wings fan right with wide twin divergence!
    // Stored in _horizonSpines in canonical [LL, LR, RL, RR] order.
    this._horizonSpines.length = 0;
    const spawnTier1Child = (
      parent: TrailSegment,
      side: 'left' | 'right',
      avoid: readonly TrailSpine[],
      maxBranchYawRad: number,
      targetBranchYawRad: number,
      bisectorYawRad: number,
    ): TrailSpine => {
      const nEnd = parent.getEndPose();
      const bhw = 0.5 * nEnd.halfWidth;
      const r0X = Math.cos(nEnd.yawRad);
      const r0Z = -Math.sin(nEnd.yawRad);
      const sign = side === 'left' ? -1 : 1;
      const stageId =
        side === 'left'
          ? (parent.fork.leftStageId ?? parent.stageId)
          : (parent.fork.rightStageId ?? parent.stageId);
      const stage = this.requireStage(stageId);
      const sp = this.createHorizonSpine({
        stage,
        parentSeed: parent.seed,
        parentId: parent.id,
        startPosX: nEnd.posX + sign * bhw * r0X,
        startPosY: nEnd.posY,
        startPosZ: nEnd.posZ + sign * bhw * r0Z,
        startYawRad: nEnd.yawRad,
        startPitchRad: nEnd.pitchRad,
        startHalfWidth: bhw,
        hasFork: true,
        isForkChild: true,
        forkSide: side,
        seamWorldX: nEnd.posX,
        seamWorldY: nEnd.posY,
        seamWorldZ: nEnd.posZ,
        seamYawRad: nEnd.yawRad,
        hasUpstreamParent: true,
        maxBranchYawRad,
        targetBranchYawRad,
        bisectorYawRad,
        avoidSpines: avoid,
      });
      this.recordSpineDirtyRect(sp);
      return sp;
    };

    const hasNextLFork = this.nextLeft !== null && this.nextLeft.fork.hasFork;
    const hasNextRFork = this.nextRight !== null && this.nextRight.fork.hasFork;
    const t1CenterYaw = clamp(
      0.25 *
        ((this.nextLeft ? this.nextLeft.getEndPose().yawRad : 0) +
          (this.nextRight ? this.nextRight.getEndPose().yawRad : 0)),
      -degToRad(5),
      degToRad(5),
    );

    let createdLL: TrailSpine | null = null;
    let createdLR: TrailSpine | null = null;
    let createdRL: TrailSpine | null = null;
    let createdRR: TrailSpine | null = null;

    if (hasNextLFork && !this.horizonLR) {
      this.avoidSpinesScratch.length = 0;
      if (this.nextRight) this.avoidSpinesScratch.push(this.nextRight.spine);
      this.appendGhostSpinesToAvoid();
      createdLR = spawnTier1Child(
        this.nextLeft!,
        'right',
        this.avoidSpinesScratch,
        degToRad(38),
        t1CenterYaw + degToRad(14),
        t1CenterYaw + degToRad(26),
      );
      this.horizonLR = createdLR;
    }
    if (hasNextRFork && !this.horizonRL) {
      this.avoidSpinesScratch.length = 0;
      if (this.horizonLR) this.avoidSpinesScratch.push(this.horizonLR);
      if (this.nextLeft) this.avoidSpinesScratch.push(this.nextLeft.spine);
      this.appendGhostSpinesToAvoid();
      createdRL = spawnTier1Child(
        this.nextRight!,
        'left',
        this.avoidSpinesScratch,
        degToRad(38),
        t1CenterYaw - degToRad(14),
        t1CenterYaw - degToRad(26),
      );
      this.horizonRL = createdRL;
    }
    if (hasNextLFork && !this.horizonLL) {
      this.avoidSpinesScratch.length = 0;
      if (this.horizonLR) this.avoidSpinesScratch.push(this.horizonLR);
      if (this.horizonRL) this.avoidSpinesScratch.push(this.horizonRL);
      if (this.nextRight) this.avoidSpinesScratch.push(this.nextRight.spine);
      this.appendGhostSpinesToAvoid();
      createdLL = spawnTier1Child(
        this.nextLeft!,
        'left',
        this.avoidSpinesScratch,
        degToRad(55),
        t1CenterYaw + degToRad(38),
        t1CenterYaw + degToRad(26),
      );
      this.horizonLL = createdLL;
    }
    if (hasNextRFork && !this.horizonRR) {
      this.avoidSpinesScratch.length = 0;
      if (this.horizonRL) this.avoidSpinesScratch.push(this.horizonRL);
      if (this.horizonLR) this.avoidSpinesScratch.push(this.horizonLR);
      if (this.horizonLL) this.avoidSpinesScratch.push(this.horizonLL);
      if (this.nextLeft) this.avoidSpinesScratch.push(this.nextLeft.spine);
      this.appendGhostSpinesToAvoid();
      createdRR = spawnTier1Child(
        this.nextRight!,
        'right',
        this.avoidSpinesScratch,
        degToRad(55),
        t1CenterYaw - degToRad(38),
        t1CenterYaw - degToRad(26),
      );
      this.horizonRR = createdRR;
    }

    if (hasNextLFork && this.horizonLL && this.horizonLR) {
      this.nextLeft!.spine.setHasDownstreamChildren(true);
      this._horizonSpines.push(this.horizonLL, this.horizonLR);
    }
    if (hasNextRFork && this.horizonRL && this.horizonRR) {
      this.nextRight!.spine.setHasDownstreamChildren(true);
      this._horizonSpines.push(this.horizonRL, this.horizonRR);
    }

    // Tier 2: Symmetric center-outward 8-rib umbrella fan with ghost-boundary anti-collision shift.
    // Targets decrease left-to-right (+47 > +34 > +17 > +5 > -5 > -17 > -34 > -47 deg),
    // with 17 deg cousin gaps, 10 deg center gap (LRR-RLL), and 12-13 deg twin splits.
    this._horizon2Spines.length = 0;
    const builtH2 = this.builtH2Scratch;
    builtH2.length = 0;
    const spawnTier2Child = (
      parent: TrailSpine | null,
      side: 'left' | 'right',
      existing: TrailSpine | null,
      twin: TrailSpine | null,
      maxBranchYawRad: number,
      targetBranchYawRad: number,
      bisectorYawRad: number,
    ): TrailSpine | null => {
      if (!parent || !parent.fork.hasFork) return null;
      if (existing) {
        builtH2.push(existing);
        return existing;
      }
      this.avoidSpinesScratch.length = 0;
      if (twin) {
        this.avoidSpinesScratch.push(twin);
      }
      for (let i = 0; i < builtH2.length; i++) {
        const sp = builtH2[i]!;
        if (sp !== twin) this.avoidSpinesScratch.push(sp);
      }
      for (let i = 0; i < this._horizonSpines.length; i++) {
        const sp = this._horizonSpines[i]!;
        if (sp !== parent) this.avoidSpinesScratch.push(sp);
      }
      for (let i = 0; i < this._ghostSpines.length; i++) {
        this.avoidSpinesScratch.push(this._ghostSpines[i]!);
      }

      const pEnd = parent.getEndPose();
      const bhw = 0.5 * pEnd.halfWidth;
      const r0X = Math.cos(pEnd.yawRad);
      const r0Z = -Math.sin(pEnd.yawRad);
      const sign = side === 'left' ? -1 : 1;
      const stageId =
        side === 'left'
          ? (parent.fork.leftStageId ?? parent.stageId)
          : (parent.fork.rightStageId ?? parent.stageId);
      const stage = this.requireStage(stageId);

      const child = this.createHorizonSpine({
        stage,
        parentSeed: parent.seed,
        parentId: parent.id,
        startPosX: pEnd.posX + sign * bhw * r0X,
        startPosY: pEnd.posY,
        startPosZ: pEnd.posZ + sign * bhw * r0Z,
        startYawRad: pEnd.yawRad,
        startPitchRad: pEnd.pitchRad,
        startHalfWidth: bhw,
        hasFork: true,
        isForkChild: true,
        forkSide: side,
        seamWorldX: pEnd.posX,
        seamWorldY: pEnd.posY,
        seamWorldZ: pEnd.posZ,
        seamYawRad: pEnd.yawRad,
        hasUpstreamParent: true,
        maxBranchYawRad,
        targetBranchYawRad,
        bisectorYawRad,
        avoidSpines: this.avoidSpinesScratch,
      });
      this.recordSpineDirtyRect(child);
      builtH2.push(child);
      return child;
    };

    let parentYawSum = 0;
    let parentYawCount = 0;
    if (this.horizonLL) {
      parentYawSum += this.horizonLL.getEndPose().yawRad;
      parentYawCount++;
    }
    if (this.horizonLR) {
      parentYawSum += this.horizonLR.getEndPose().yawRad;
      parentYawCount++;
    }
    if (this.horizonRL) {
      parentYawSum += this.horizonRL.getEndPose().yawRad;
      parentYawCount++;
    }
    if (this.horizonRR) {
      parentYawSum += this.horizonRR.getEndPose().yawRad;
      parentYawCount++;
    }
    const t2Shift =
      parentYawCount > 0 ? clamp((parentYawSum / parentYawCount) * 0.22, -degToRad(4), degToRad(4)) : 0;

    // 8-rib umbrella targets: strictly ordered left-to-right (+47 > +34 > +17 > +5 > -5 > -17 > -34 > -47 deg)
    // Wide 17 deg cousin gaps (LLR-LRL, RLR-RRL) + 10 deg center gap (LRR-RLL) + 12-13 deg twin splits.
    const lllT = clamp(t2Shift + degToRad(47), -degToRad(49), degToRad(49));
    const llrT = clamp(t2Shift + degToRad(34), -degToRad(38), degToRad(38));
    const lrlT = clamp(t2Shift + degToRad(17), -degToRad(22), degToRad(22));
    const lrrT = clamp(t2Shift + degToRad(5), -degToRad(16), degToRad(16));
    const rllT = clamp(t2Shift - degToRad(5), -degToRad(16), degToRad(16));
    const rlrT = clamp(t2Shift - degToRad(17), -degToRad(22), degToRad(22));
    const rrlT = clamp(t2Shift - degToRad(34), -degToRad(38), degToRad(38));
    const rrrT = clamp(t2Shift - degToRad(47), -degToRad(49), degToRad(49));

    // Strictly center-outward build order: LRR -> RLL -> LRL -> RLR -> LLR -> RRL -> LLL -> RRR.
    // Every inner cousin (LRR, RLL, LLR, RRL) avoids its adjacent already-built cousin freely,
    // and every outer twin (LRL, RLR, LLL, RRR) sees its exact twin in avoidSpines and fans outward!
    this.horizon2LRR = spawnTier2Child(this.horizonLR, 'right', this.horizon2LRR, null, degToRad(36), lrrT, 0.5 * (lrlT + lrrT));
    this.horizon2RLL = spawnTier2Child(this.horizonRL, 'left', this.horizon2RLL, null, degToRad(36), rllT, 0.5 * (rllT + rlrT));
    this.horizon2LRL = spawnTier2Child(this.horizonLR, 'left', this.horizon2LRL, this.horizon2LRR, degToRad(42), lrlT, 0.5 * (lrlT + lrrT));
    this.horizon2RLR = spawnTier2Child(this.horizonRL, 'right', this.horizon2RLR, this.horizon2RLL, degToRad(42), rlrT, 0.5 * (rllT + rlrT));
    this.horizon2LLR = spawnTier2Child(this.horizonLL, 'right', this.horizon2LLR, null, degToRad(46), llrT, 0.5 * (lllT + llrT));
    this.horizon2RRL = spawnTier2Child(this.horizonRR, 'left', this.horizon2RRL, null, degToRad(46), rrlT, 0.5 * (rrlT + rrrT));
    this.horizon2LLL = spawnTier2Child(this.horizonLL, 'left', this.horizon2LLL, this.horizon2LLR, degToRad(55), lllT, 0.5 * (lllT + llrT));
    this.horizon2RRR = spawnTier2Child(this.horizonRR, 'right', this.horizon2RRR, this.horizon2RRL, degToRad(55), rrrT, 0.5 * (rrlT + rrrT));

    for (let i = 0; i < this._horizonSpines.length; i++) {
      const parent = this._horizonSpines[i]!;
      if (parent.fork.hasFork) {
        const justRecorded =
          parent === createdLL ||
          parent === createdLR ||
          parent === createdRL ||
          parent === createdRR;
        if (parent.macroNodes.useDownstreamExt && !justRecorded) {
          this.recordDownstreamExtDirtyRect(parent);
        }
        parent.setHasDownstreamChildren(true);
      }
    }

    if (this.horizon2LLL) this._horizon2Spines.push(this.horizon2LLL);
    if (this.horizon2LLR) this._horizon2Spines.push(this.horizon2LLR);
    if (this.horizon2LRL) this._horizon2Spines.push(this.horizon2LRL);
    if (this.horizon2LRR) this._horizon2Spines.push(this.horizon2LRR);
    if (this.horizon2RLL) this._horizon2Spines.push(this.horizon2RLL);
    if (this.horizon2RLR) this._horizon2Spines.push(this.horizon2RLR);
    if (this.horizon2RRL) this._horizon2Spines.push(this.horizon2RRL);
    if (this.horizon2RRR) this._horizon2Spines.push(this.horizon2RRR);
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
    parentId?: number | null;
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
    hasUpstreamParent?: boolean;
    maxBranchYawRad?: number;
    targetBranchYawRad?: number;
    bisectorYawRad?: number;
    avoidSpines?: readonly TrailSpine[];
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
      hasUpstreamParent: params.hasUpstreamParent,
      parentId: params.parentId ?? null,
      maxBranchYawRad: params.maxBranchYawRad,
      targetBranchYawRad: params.targetBranchYawRad,
      bisectorYawRad: params.bisectorYawRad,
      avoidSpines: params.avoidSpines,
    };
  }

  private createHorizonSpine(params: {
    stage: StageDef;
    parentSeed: number;
    parentId?: number | null;
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
    hasUpstreamParent?: boolean;
    maxBranchYawRad?: number;
    targetBranchYawRad?: number;
    bisectorYawRad?: number;
    avoidSpines?: readonly TrailSpine[];
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
    hasUpstreamParent?: boolean;
    targetBranchYawRad?: number;
    bisectorYawRad?: number;
    avoidSpines?: readonly TrailSpine[];
  }): TrailSegment {
    const cfg = this.buildSpineConfig({ ...params, parentId: params.prevSegmentId });
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
        const breathers = this.breatherTargetsScratch;
        const intense = this.intenseTargetsScratch;
        breathers.length = 0;
        intense.length = 0;
        for (let i = 0; i < valid.length; i++) {
          const id = valid[i]!;
          const role = this.lookupStage(id)?.pacingRole;
          if (role === 'breather') breathers.push(id);
          else if (role === 'intense') intense.push(id);
        }

        if (breathers.length > 0 && intense.length > 0) {
          const targetA = breathers[rng.nextInt(0, breathers.length)]!;
          const targetB = intense[rng.nextInt(0, intense.length)]!;
          const swapSides = rng.nextBool(0.5);
          out.left = swapSides ? targetB : targetA;
          out.right = swapSides ? targetA : targetB;
        } else {
          const idxA = rng.nextInt(0, valid.length);
          const offset = rng.nextInt(1, valid.length);
          const idxB = (idxA + offset) % valid.length;
          const swapSides = rng.nextBool(0.5);
          out.left = swapSides ? valid[idxB]! : valid[idxA]!;
          out.right = swapSides ? valid[idxA]! : valid[idxB]!;
        }
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
    this.prunedParentIdsScratch.clear();
    let writeIdx = 0;
    for (let i = 0; i < this._ghostSpines.length; i++) {
      const sp = this._ghostSpines[i]!;
      if (this.computeAabbDistSq(sp, skierX, skierZ) <= maxDistSq) {
        this._ghostSpines[writeIdx++] = sp;
      } else {
        this.recordSpineDirtyRect(sp);
        if (sp.parentId !== null) this.prunedParentIdsScratch.add(sp.parentId);
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
      const removed = this._ghostSpines[maxIdx]!;
      this.recordSpineDirtyRect(removed);
      if (removed.parentId !== null) this.prunedParentIdsScratch.add(removed.parentId);
      const last = this._ghostSpines.pop()!;
      if (maxIdx < this._ghostSpines.length) {
        this._ghostSpines[maxIdx] = last;
      }
    }

    // If any surviving ghost lost all downstream children via pruning, restore its open-leaf extension
    // so no ghost spine ever remains a truncated uphill macro stub.
    if (this.prunedParentIdsScratch.size > 0) {
      for (let i = 0; i < this._ghostSpines.length; i++) {
        const g = this._ghostSpines[i]!;
        if (!this.prunedParentIdsScratch.has(g.id) || g.macroNodes.useDownstreamExt) continue;
        let hasSurvivingChild =
          (this.prev !== null && this.prev.spine.parentId === g.id) ||
          this.curr.spine.parentId === g.id ||
          (this.nextLeft !== null && this.nextLeft.spine.parentId === g.id) ||
          (this.nextRight !== null && this.nextRight.spine.parentId === g.id);
        if (!hasSurvivingChild) {
          for (let j = 0; j < this._ghostSpines.length; j++) {
            if (this._ghostSpines[j]!.parentId === g.id) {
              hasSurvivingChild = true;
              break;
            }
          }
        }
        if (!hasSurvivingChild) {
          g.setHasDownstreamChildren(false);
          this.recordDownstreamExtDirtyRect(g);
        }
      }
    }
  }

  private appendGhostSpinesToAvoid(): void {
    for (let i = 0; i < this._ghostSpines.length; i++) {
      this.avoidSpinesScratch.push(this._ghostSpines[i]!);
    }
  }

  private recordSpineDirtyRect(sp: TrailSpine): void {
    const mn = sp.macroNodes;
    let minX = sp.boundsMinX;
    let maxX = sp.boundsMaxX;
    let minZ = sp.boundsMinZ;
    let maxZ = sp.boundsMaxZ;
    if (mn.useUpstreamExt && mn.upBoundsMinX <= mn.upBoundsMaxX) {
      if (mn.upBoundsMinX < minX) minX = mn.upBoundsMinX;
      if (mn.upBoundsMaxX > maxX) maxX = mn.upBoundsMaxX;
      if (mn.upBoundsMinZ < minZ) minZ = mn.upBoundsMinZ;
      if (mn.upBoundsMaxZ > maxZ) maxZ = mn.upBoundsMaxZ;
    }
    if (mn.useDownstreamExt && mn.downBoundsMinX <= mn.downBoundsMaxX) {
      if (mn.downBoundsMinX < minX) minX = mn.downBoundsMinX;
      if (mn.downBoundsMaxX > maxX) maxX = mn.downBoundsMaxX;
      if (mn.downBoundsMinZ < minZ) minZ = mn.downBoundsMinZ;
      if (mn.downBoundsMaxZ > maxZ) maxZ = mn.downBoundsMaxZ;
    }
    const cl = sp.corridorLeft;
    if (cl.boundsMinX <= cl.boundsMaxX) {
      if (cl.boundsMinX < minX) minX = cl.boundsMinX;
      if (cl.boundsMaxX > maxX) maxX = cl.boundsMaxX;
      if (cl.boundsMinZ < minZ) minZ = cl.boundsMinZ;
      if (cl.boundsMaxZ > maxZ) maxZ = cl.boundsMaxZ;
    }
    const cr = sp.corridorRight;
    if (cr.boundsMinX <= cr.boundsMaxX) {
      if (cr.boundsMinX < minX) minX = cr.boundsMinX;
      if (cr.boundsMaxX > maxX) maxX = cr.boundsMaxX;
      if (cr.boundsMinZ < minZ) minZ = cr.boundsMinZ;
      if (cr.boundsMaxZ > maxZ) maxZ = cr.boundsMaxZ;
    }
    this.dirtyRectScratch.push({
      minX: minX - TOPOLOGY_DIRTY_PAD_M,
      maxX: maxX + TOPOLOGY_DIRTY_PAD_M,
      minZ: minZ - TOPOLOGY_DIRTY_PAD_M,
      maxZ: maxZ + TOPOLOGY_DIRTY_PAD_M,
    });
  }

  private recordDownstreamExtDirtyRect(sp: TrailSpine): void {
    const mn = sp.macroNodes;
    if (mn.downExtCount <= 0 || mn.downBoundsMinX > mn.downBoundsMaxX || mn.downBoundsMinZ > mn.downBoundsMaxZ) {
      return;
    }
    this.dirtyRectScratch.push({
      minX: mn.downBoundsMinX - TOPOLOGY_DIRTY_PAD_M,
      maxX: mn.downBoundsMaxX + TOPOLOGY_DIRTY_PAD_M,
      minZ: mn.downBoundsMinZ - TOPOLOGY_DIRTY_PAD_M,
      maxZ: mn.downBoundsMaxZ + TOPOLOGY_DIRTY_PAD_M,
    });
  }

  private notifyTopologyChanged(isReset: boolean): void {
    for (let i = 0; i < this.topologyListeners.length; i++) {
      this.topologyListeners[i]!(isReset, this.dirtyRectScratch);
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
    for (let i = 0; i < this._horizon2Spines.length; i++) {
      this._elevationSpines.push(this._horizon2Spines[i]!);
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
