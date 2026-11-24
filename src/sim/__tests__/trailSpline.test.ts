import { describe, expect, it } from 'vitest';
import { getStageDef } from '../../content/stages';
import {
  createChunkRangeOut,
  createMutablePlayerIntent,
  createRibbonPointOut,
  createSpineFrameOut,
  createSurfaceSample,
} from '../contracts';
import { PacingDirector } from '../layoutEngine';
import { MountainField } from '../mountainField';
import { MountainSurfaceSampler } from '../surfaceSampler';
import { SkiSimulation } from '../skiSimulation';
import {
  FORK_RUNWAY_OBSTACLE_FREE_M,
  INNER_WALL_RAMP_LENGTH_M,
  MAX_CURVATURE_RIBBON_RATIO,
  SEAM_NOSE_RADIUS_M,
  TrailSegment,
  mapRibbonUtoX,
} from '../trailSegment';
import { TrailWindow } from '../trailWindow';

describe('TrailSegment & TrailWindow invariants', () => {
  it('maintains up-locked Yaw-Pitch-Bank frames and curvature clamp |k|*(W_half+W_skirt) <= 0.4', () => {
    const trailWin = new TrailWindow(42, 'icy-black');
    const frame = createSpineFrameOut();
    const ribbon = createRibbonPointOut();
    const chunkRange = createChunkRangeOut();

    const checkSegment = (seg: TrailSegment): void => {
      expect(seg.chunkLength).toBe(35);
      seg.getChunkBounds(0, chunkRange);
      expect(chunkRange.startS).toBe(0);
      expect(chunkRange.endS).toBe(Math.min(35, seg.length));

      for (let s = 0; s <= seg.length; s += 2) {
        seg.sampleSpineFrame(s, frame);
        // Up-locked frame: forwardY < 0 (downhill -Z/+Y right-handed), right vector orthogonal to forward
        expect(frame.forwardY).toBeLessThan(0);
        const dotFR =
          frame.forwardX * frame.rightX +
          frame.forwardY * frame.rightY +
          frame.forwardZ * frame.rightZ;
        expect(Math.abs(dotFR)).toBeLessThan(1e-5);

        // Enforce ribbon non-self-intersection clamp everywhere
        const ratio = Math.abs(frame.curvature) * (frame.halfWidth + frame.skirtWidth);
        expect(ratio).toBeLessThanOrEqual(MAX_CURVATURE_RIBBON_RATIO);

        // Normal never flips (always +Y upward) even across k=0 inflection points
        seg.evaluateSurfaceAtX(s, 0, ribbon);
        expect(ribbon.normalY).toBeGreaterThan(0.5);
      }

      // Verify non-linear cubic u mapping on non-fork or outer side
      seg.evaluateRibbonPoint(seg.length * 0.5, -1, ribbon);
      const expectedOuter = -(ribbon.halfWidth + ribbon.skirtWidth);
      expect(ribbon.lateralX).toBeCloseTo(expectedOuter, 4);
      expect(mapRibbonUtoX(0.5, 20)).toBeCloseTo(0.5 * 20 * 0.5 * 1.25, 6);
    };

    checkSegment(trailWin.curr);
    if (trailWin.nextLeft) checkSegment(trailWin.nextLeft);
    if (trailWin.nextRight) checkSegment(trailWin.nextRight);
  });

  it('enforces Model A fork invariants (k=0, beta=0 at seam, twin split-seam gates, 25m inner wall ramp, 1.5m nose)', () => {
    const trailWin = new TrailWindow(2025, 'sunny-blue');
    const curr = trailWin.curr;
    const left = trailWin.nextLeft!;
    const right = trailWin.nextRight!;

    expect(curr.fork.hasFork).toBe(true);
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(curr.fork.leftStageId).not.toBe(curr.fork.rightStageId);
    expect(curr.length - curr.fork.obstacleFreeStartS).toBe(FORK_RUNWAY_OBSTACLE_FREE_M);

    // k = 0, bank = 0 at seam end of parent and seam start of both children
    const endFrame = createSpineFrameOut();
    const leftStart = createSpineFrameOut();
    const rightStart = createSpineFrameOut();
    curr.sampleSpineFrame(curr.length, endFrame);
    left.sampleSpineFrame(0, leftStart);
    right.sampleSpineFrame(0, rightStart);

    const archLandmarks = curr.landmarks.filter((l) => l.kind === 'forkArch');
    expect(archLandmarks).toHaveLength(2);
    const leftArch = archLandmarks.find((l) => l.forkSide === 'left');
    const rightArch = archLandmarks.find((l) => l.forkSide === 'right');
    expect(leftArch).toBeDefined();
    expect(rightArch).toBeDefined();
    expect(leftArch!.s).toBe(curr.length);
    expect(rightArch!.s).toBe(curr.length);
    expect(leftArch!.chunkIndex).toBe(curr.chunkCount - 1);
    expect(rightArch!.chunkIndex).toBe(curr.chunkCount - 1);
    expect(leftArch!.badgeStageId).toBe(curr.fork.leftStageId);
    expect(rightArch!.badgeStageId).toBe(curr.fork.rightStageId);
    expect(leftArch!.worldX).toBeCloseTo(leftStart.posX, 4);
    expect(leftArch!.worldY).toBeCloseTo(leftStart.posY, 4);
    expect(leftArch!.worldZ).toBeCloseTo(leftStart.posZ, 4);
    expect(rightArch!.worldX).toBeCloseTo(rightStart.posX, 4);
    expect(rightArch!.worldY).toBeCloseTo(rightStart.posY, 4);
    expect(rightArch!.worldZ).toBeCloseTo(rightStart.posZ, 4);

    // Verify seam chunkIndex stays in bounds when length is an exact multiple of 35m (280m)
    const exactMultSeg = new TrailSegment({
      id: 99,
      slot: 'curr',
      stage: getStageDef('sunny-blue')!,
      seed: 123,
      length: 280,
      startPosX: 0,
      startPosY: 0,
      startPosZ: 0,
      startYawRad: 0,
      startPitchRad: -0.22,
      startHalfWidth: 15,
      endHalfWidth: 26,
      prevSegmentId: null,
      hasFork: true,
      leftStageId: 'sunny-blue',
      rightStageId: 'icy-black',
      isForkChild: false,
      forkSide: 'none',
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: 0,
      seamYawRad: 0,
    });
    const exactArches = exactMultSeg.landmarks.filter((l) => l.kind === 'forkArch');
    expect(exactArches).toHaveLength(2);
    expect(exactArches[0]!.chunkIndex).toBeLessThan(exactMultSeg.chunkCount);
    expect(exactArches[0]!.chunkIndex).toBe(exactMultSeg.chunkCount - 1);

    expect(Math.abs(endFrame.curvature)).toBeLessThan(1e-6);
    expect(Math.abs(endFrame.bankRad)).toBeLessThan(1e-6);
    expect(Math.abs(leftStart.curvature)).toBeLessThan(1e-6);
    expect(Math.abs(leftStart.bankRad)).toBeLessThan(1e-6);
    expect(Math.abs(rightStart.curvature)).toBeLessThan(1e-6);
    expect(Math.abs(rightStart.bankRad)).toBeLessThan(1e-6);

    expect(left.fork.innerWallRampLength).toBe(INNER_WALL_RAMP_LENGTH_M);
    expect(left.fork.seamNoseRadius).toBe(SEAM_NOSE_RADIUS_M);

    // Inner snowbank suppressed at s = 0 and rises by s = 25m
    const leftAt25 = createSpineFrameOut();
    left.sampleSpineFrame(25, leftAt25);
    const innerAt0 = createRibbonPointOut();
    const innerAt25 = createRibbonPointOut();
    left.evaluateSurfaceAtX(0, leftStart.halfWidth + 2.0, innerAt0);
    left.evaluateSurfaceAtX(25, leftAt25.halfWidth + 2.0, innerAt25);
    expect(innerAt0.localHeight).toBeCloseTo(0, 5);
    expect(innerAt25.localHeight).toBeGreaterThan(0.5);
  });

  it('provides continuous O(1) warm-started MountainSurfaceSampler across Model A forks (grounded, straddling, airborne) and prunes at ~40m', () => {
    const trailWin = new TrailWindow(777, 'sunny-blue');
    const field = new MountainField(trailWin);
    const sampler = new MountainSurfaceSampler(trailWin, field);
    const curr = trailWin.curr;
    const left = trailWin.nextLeft!;
    const right = trailWin.nextRight!;
    const endFrame = createSpineFrameOut();
    curr.sampleSpineFrame(curr.length, endFrame);

    const fwdX = -Math.sin(endFrame.yawRad);
    const fwdZ = -Math.cos(endFrame.yawRad);
    const rightX = Math.cos(endFrame.yawRad);
    const rightZ = -Math.sin(endFrame.yawRad);

    const sampleBefore = createSurfaceSample();
    const sampleAfterLeft = createSurfaceSample();
    const sampleAfterRight = createSurfaceSample();
    const sampleStraddle = createSurfaceSample();

    // 0.25m before seam on centerline (straddling x ~ 0)
    sampler.sampleSurface(
      endFrame.posX - fwdX * 0.25,
      endFrame.posZ - fwdZ * 0.25,
      curr.id,
      curr.length - 0.5,
      sampleBefore,
    );
    expect(sampleBefore.segmentId).toBe(curr.id);

    // 0.25m past seam slightly left, slightly right, and straddling center
    sampler.sampleSurface(
      endFrame.posX + fwdX * 0.25 - rightX * 1.2,
      endFrame.posZ + fwdZ * 0.25 - rightZ * 1.2,
      curr.id,
      curr.length - 0.25,
      sampleAfterLeft,
    );
    sampler.sampleSurface(
      endFrame.posX + fwdX * 0.25 + rightX * 1.2,
      endFrame.posZ + fwdZ * 0.25 + rightZ * 1.2,
      curr.id,
      curr.length - 0.25,
      sampleAfterRight,
    );
    sampler.sampleSurface(
      endFrame.posX + fwdX * 0.25 - rightX * 0.01,
      endFrame.posZ + fwdZ * 0.25 - rightZ * 0.01,
      curr.id,
      curr.length - 0.25,
      sampleStraddle,
    );

    expect(sampleAfterLeft.segmentId).toBe(left.id);
    expect(sampleAfterRight.segmentId).toBe(right.id);
    expect(sampleStraddle.segmentId).toBe(left.id);

    // Ground elevation and surface normal must be continuous across the seam (even airborne!)
    expect(Math.abs(sampleAfterLeft.groundY - sampleBefore.groundY)).toBeLessThan(0.35);
    expect(Math.abs(sampleAfterRight.groundY - sampleBefore.groundY)).toBeLessThan(0.35);
    expect(Math.abs(sampleStraddle.groundY - sampleBefore.groundY)).toBeLessThan(0.35);
    const dotNormals =
      sampleBefore.normalX * sampleAfterLeft.normalX +
      sampleBefore.normalY * sampleAfterLeft.normalY +
      sampleBefore.normalZ * sampleAfterLeft.normalZ;
    expect(dotNormals).toBeGreaterThan(0.998);

    // Advancing 42m down left branch prunes unchosen right branch
    const advEarly = trailWin.updateProgression(left.id, 15);
    expect(advEarly.prunedIds).toHaveLength(0);

    const advPrune = trailWin.updateProgression(left.id, 42);
    expect(advPrune.prunedIds).toContain(right.id);
    expect(trailWin.curr.id).toBe(left.id);
    expect(trailWin.prev!.id).toBe(curr.id);
    expect(trailWin.nextLeft).not.toBeNull();
    expect(trailWin.nextRight).not.toBeNull();
  });

  it('supports Model B inline IslandDivider with independent lane surface types', () => {
    const stage = getStageDef('icy-black')!;
    let dividerSeg: TrailSegment | null = null;
    for (let s = 1; s < 30; s++) {
      const candidate = new TrailSegment({
        id: s,
        slot: 'curr',
        stage,
        seed: s * 101,
        length: 280,
        startPosX: 0,
        startPosY: 0,
        startPosZ: 0,
        startYawRad: 0,
        startPitchRad: -0.45,
        startHalfWidth: 10,
        endHalfWidth: 20,
        prevSegmentId: null,
        hasFork: false,
        leftStageId: null,
        rightStageId: null,
        isForkChild: false,
        forkSide: 'none',
        seamWorldX: 0,
        seamWorldY: 0,
        seamWorldZ: 0,
        seamYawRad: 0,
        allowIslandDivider: true,
      });
      if (candidate.divider) {
        dividerSeg = candidate;
        break;
      }
    }
    expect(dividerSeg).not.toBeNull();
    const div = dividerSeg!.divider!;
    const midS = 0.5 * (div.startS + div.endS);
    const outCenter = createRibbonPointOut();
    const outLeft = createRibbonPointOut();
    const outRight = createRibbonPointOut();

    dividerSeg!.evaluateSurfaceAtX(midS, 0, outCenter);
    dividerSeg!.evaluateSurfaceAtX(midS, -(div.maxHalfWidth + 3), outLeft);
    dividerSeg!.evaluateSurfaceAtX(midS, div.maxHalfWidth + 3, outRight);

    expect(outCenter.inDivider).toBe(true);
    expect(outCenter.localHeight).toBeGreaterThan(1.0);
    expect(outLeft.inDivider).toBe(false);
    expect(outLeft.surfaceType).toBe(div.leftLaneSurface);
    expect(outRight.surfaceType).toBe(div.rightLaneSurface);
    expect(outLeft.surfaceType).not.toBe(outRight.surfaceType);

    // safeX routes cleanly around divider
    const sx = dividerSeg!.sampleSafeX(midS);
    expect(Math.abs(sx)).toBeGreaterThan(div.maxHalfWidth + 1.5);
  });

  it('respects 50m obstacle-free fork runway, post-brow crest clearance, and backpack >= 75% delivery acceleration', () => {
    const sim = new SkiSimulation({ seed: 101 });
    const state = sim.getState();
    const curr = state.trailWindow.curr;
    const hazards = state.entities.hazards;
    const sample = createSurfaceSample();

    for (let i = 0; i < hazards.count; i++) {
      if (hazards.segmentIds[i] !== curr.id) continue;
      sim.sampleSurface(hazards.posX[i]!, hazards.posZ[i]!, curr.id, curr.length * 0.5, sample);
      expect(sample.s).toBeLessThan(curr.fork.obstacleFreeStartS);
      if (hazards.defIds[i] === 'pine_tree' || hazards.defIds[i] === 'boulder_large') {
        expect((curr as TrailSegment).isNearCrestPocket(sample.s)).toBe(false);
      }
    }

    // Verify PacingDirector accelerates Delivery Zone spawns when backpack fill >= 75%
    const normalDelivs: number[] = [];
    const accelDelivs: number[] = [];
    const pacingNormal = new PacingDirector(77);
    const pacingAccel = new PacingDirector(77);
    pacingNormal.planDeliveryPositions(curr as TrailSegment, 0.2, normalDelivs);
    pacingAccel.planDeliveryPositions(curr as TrailSegment, 0.85, accelDelivs);
    expect(accelDelivs[0]!).toBeLessThan(normalDelivs[0]!);

    // Also verify zero-allocation intent path runs cleanly
    const intent = createMutablePlayerIntent();
    sim.savePreviousPoses();
    sim.step(1 / 60, intent);
    expect(sim.getState().tickCount).toBe(1);
  });
});
