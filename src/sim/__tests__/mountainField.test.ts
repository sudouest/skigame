import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../../core/fixedLoop';
import { clamp, degToRad } from '../../core/math';
import { hashString } from '../../core/rng';
import { getStageDef, STAGE_ICY_BLACK, STAGE_SUNNY_BLUE } from '../../content/stages';
import type { StageDef } from '../../content/types';
import {
  createMountainColumnOut,
  createMountainSampleOut,
  createMutablePlayerIntent,
  createPisteHeightOut,
  createSpineFrameOut,
  createSpineProjectionOut,
  type SpineView,
} from '../contracts';
import { MountainField } from '../mountainField';
import { SkiSimulation } from '../skiSimulation';
import type { SurfacePatch } from '../trailSegment';
import { MAX_CURVATURE_RIBBON_RATIO, TrailSpine } from '../trailSpine';
import { MAX_GHOST_SPINES, TrailWindow } from '../trailWindow';

describe('TrailSpine, Horizon/Ghost Buffers, and MountainField', () => {
  it('enforces broad downhill fall-line invariant (|yaw| <= 60 deg, seam <= 48 deg, |k|*(hw+skirt) <= 0.4) across 65+ segments', () => {
    const trailWin = new TrailWindow(9001, 'icy-black');
    const field = new MountainField(trailWin);
    const frame = createSpineFrameOut();
    const maxYawRad = degToRad(60);
    const maxForkSeamYawRad = degToRad(48);

    const checkedIds = new Set<number>();
    const verifySpine = (sp: SpineView): void => {
      if (checkedIds.has(sp.id)) return;
      checkedIds.add(sp.id);

      for (let s = 0; s <= sp.length; s += 2) {
        sp.sampleSpineFrame(s, frame);
        expect(Math.abs(frame.yawRad)).toBeLessThanOrEqual(maxYawRad + 1e-4);
        const ratio = Math.abs(frame.curvature) * (frame.halfWidth + frame.skirtWidth);
        expect(ratio).toBeLessThanOrEqual(MAX_CURVATURE_RIBBON_RATIO);
      }

      sp.sampleSpineFrame(0, frame);
      expect(Math.abs(frame.curvature)).toBeLessThan(1e-6);
      expect(Math.abs(frame.bankRad)).toBeLessThan(1e-6);

      sp.sampleSpineFrame(sp.length, frame);
      expect(Math.abs(frame.curvature)).toBeLessThan(1e-6);
      expect(Math.abs(frame.bankRad)).toBeLessThan(1e-6);
      if (sp.fork.hasFork) {
        expect(Math.abs(frame.yawRad)).toBeLessThanOrEqual(maxForkSeamYawRad + 1e-4);
      }
    };

    for (let step = 0; step < 65; step++) {
      for (let i = 0; i < trailWin.elevationSpines.length; i++) {
        verifySpine(trailWin.elevationSpines[i]!);
      }
      const chooseLeft = step % 2 === 0;
      const next = chooseLeft ? trailWin.nextLeft! : (trailWin.nextRight ?? trailWin.nextLeft!);
      trailWin.updateProgression(next.id, 45);
    }

    expect(checkedIds.size).toBeGreaterThanOrEqual(65);
    expect(field.evaluateHeight(0, 0)).toBeDefined();

    // Stress-test extreme fork child starting right at +48 deg yaw on icy-black
    const extremeChild = new TrailSpine({
      id: 9999,
      stage: STAGE_ICY_BLACK,
      seed: 77777,
      length: 300,
      startPosX: 0,
      startPosY: 0,
      startPosZ: 0,
      startYawRad: degToRad(48),
      startPitchRad: -0.45,
      startHalfWidth: 10,
      endHalfWidth: 24,
      hasFork: true,
      leftStageId: 'sunny-blue',
      rightStageId: 'icy-black',
      isForkChild: true,
      forkSide: 'left',
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: 0,
      seamYawRad: degToRad(48),
    });
    for (let s = 0; s <= extremeChild.length; s += 1) {
      extremeChild.sampleSpineFrame(s, frame);
      expect(Math.abs(frame.yawRad)).toBeLessThanOrEqual(maxYawRad + 1e-4);
    }
    extremeChild.sampleSpineFrame(extremeChild.length, frame);
    expect(Math.abs(frame.yawRad)).toBeLessThanOrEqual(maxForkSeamYawRad + 1e-4);
  });

  it('pre-creates 1-level deeper horizon TrailSpines without firing onSegmentCreated and promotes them with 0-delta geometry', () => {
    const createdIds: number[] = [];
    const trailWin = new TrailWindow(4242, 'sunny-blue', (seg) => {
      createdIds.push(seg.id);
    });

    // Only curr, nextLeft, nextRight should have triggered onSegmentCreated
    expect(createdIds).toEqual([
      trailWin.curr.id,
      trailWin.nextLeft!.id,
      trailWin.nextRight!.id,
    ]);
    expect(trailWin.horizonSpines).toHaveLength(4);

    const chosen = trailWin.nextLeft!;
    const horizonLL = trailWin.horizonSpines[0]!;
    const horizonLR = trailWin.horizonSpines[1]!;

    expect(createdIds).not.toContain(horizonLL.id);
    expect(createdIds).not.toContain(horizonLR.id);

    // Record geometry samples prior to promotion
    const preFrameLL = createSpineFrameOut();
    const preFrameLR = createSpineFrameOut();
    const preHeightLL = createPisteHeightOut();
    horizonLL.sampleSpineFrame(horizonLL.length * 0.5, preFrameLL);
    horizonLR.sampleSpineFrame(horizonLR.length * 0.5, preFrameLR);
    horizonLL.evaluatePisteHeight(120, 4.5, preHeightLL);

    createdIds.length = 0;
    const adv = trailWin.updateProgression(chosen.id, 45);
    expect(adv.spawnedSegments).toHaveLength(2);
    expect(createdIds).toEqual([horizonLL.id, horizonLR.id]);

    // Promoted segments adopt the exact TrailSpine instances and IDs with 0-delta geometry
    expect(trailWin.nextLeft!.id).toBe(horizonLL.id);
    expect(trailWin.nextRight!.id).toBe(horizonLR.id);
    expect(trailWin.nextLeft!.spine).toBe(horizonLL);
    expect(trailWin.nextRight!.spine).toBe(horizonLR);
    expect(trailWin.horizonSpines).toHaveLength(4);

    const postFrameLL = createSpineFrameOut();
    const postFrameLR = createSpineFrameOut();
    const postHeightLL = createPisteHeightOut();
    trailWin.nextLeft!.sampleSpineFrame(horizonLL.length * 0.5, postFrameLL);
    trailWin.nextRight!.sampleSpineFrame(horizonLR.length * 0.5, postFrameLR);
    trailWin.nextLeft!.evaluatePisteHeight(120, 4.5, postHeightLL);

    expect(postFrameLL.posX).toBeCloseTo(preFrameLL.posX, 10);
    expect(postFrameLL.posY).toBeCloseTo(preFrameLL.posY, 10);
    expect(postFrameLL.posZ).toBeCloseTo(preFrameLL.posZ, 10);
    expect(postFrameLR.posX).toBeCloseTo(preFrameLR.posX, 10);
    expect(postFrameLR.posY).toBeCloseTo(preFrameLR.posY, 10);
    expect(postFrameLR.posZ).toBeCloseTo(preFrameLR.posZ, 10);
    expect(postHeightLL.heightY).toBeCloseTo(preHeightLL.heightY, 10);
  });

  it('maintains fork seam and V-wedge hillside continuity plus smooth inner-turn chasm far-wall curves', () => {
    const trailWin = new TrailWindow(2026, 'sunny-blue');
    const field = new MountainField(trailWin);
    const curr = trailWin.curr;
    const left = trailWin.nextLeft!;
    const right = trailWin.nextRight!;

    const endFrame = createSpineFrameOut();
    curr.sampleSpineFrame(curr.length, endFrame);
    const fwdX = -Math.sin(endFrame.yawRad);
    const fwdZ = -Math.cos(endFrame.yawRad);
    const rightX = Math.cos(endFrame.yawRad);
    const rightZ = -Math.sin(endFrame.yawRad);

    // Sample across the seam and through the V-wedge center between branches
    const prevSample = createMountainSampleOut();
    const curSample = createMountainSampleOut();
    for (let d = -12; d <= 60; d += 0.5) {
      const wx = endFrame.posX + fwdX * d;
      const wz = endFrame.posZ + fwdZ * d;
      field.evaluate(wx, wz, curSample);
      expect(Number.isFinite(curSample.heightY)).toBe(true);
      expect(Number.isFinite(curSample.normalY)).toBe(true);
      expect(curSample.normalY).toBeGreaterThan(0.35);

      if (d > -12) {
        const dot =
          prevSample.normalX * curSample.normalX +
          prevSample.normalY * curSample.normalY +
          prevSample.normalZ * curSample.normalZ;
        expect(Math.abs(curSample.heightY - prevSample.heightY)).toBeLessThan(0.45);
        expect(dot).toBeGreaterThan(0.95);
      }

      prevSample.heightY = curSample.heightY;
      prevSample.normalX = curSample.normalX;
      prevSample.normalY = curSample.normalY;
      prevSample.normalZ = curSample.normalZ;
    }

    // Sibling pistes immediately after the fork must remain groomed and un-cratered by sibling landscapes
    const leftBranchFrame = createSpineFrameOut();
    const rightBranchFrame = createSpineFrameOut();
    left.sampleSpineFrame(12, leftBranchFrame);
    right.sampleSpineFrame(12, rightBranchFrame);

    field.evaluate(leftBranchFrame.posX, leftBranchFrame.posZ, curSample);
    expect(curSample.onPiste).toBe(true);
    expect(curSample.pisteWeight).toBeCloseTo(1, 3);
    expect(Math.abs(curSample.heightY - leftBranchFrame.posY)).toBeLessThan(0.5);

    field.evaluate(rightBranchFrame.posX, rightBranchFrame.posZ, curSample);
    expect(curSample.onPiste).toBe(true);
    expect(curSample.pisteWeight).toBeCloseTo(1, 3);
    expect(Math.abs(curSample.heightY - rightBranchFrame.posY)).toBeLessThan(0.5);

    // Lateral scan across both branches at s = 25m must be C0 continuous with smooth normals
    left.sampleSpineFrame(25, leftBranchFrame);
    for (let x = -20; x <= 20; x += 0.5) {
      const wx = endFrame.posX + fwdX * 25 + rightX * x;
      const wz = endFrame.posZ + fwdZ * 25 + rightZ * x;
      field.evaluate(wx, wz, curSample);
      expect(Number.isFinite(curSample.heightY)).toBe(true);
      expect(curSample.normalY).toBeGreaterThan(0.35);
      if (x > -20) {
        expect(Math.abs(curSample.heightY - prevSample.heightY)).toBeLessThan(0.55);
      }
      prevSample.heightY = curSample.heightY;
    }

    // Inner-turn high-curvature chasm + farWallOffsetM (75m > min curve radius ~55m) smoothness check
    const sharpChasmSpine = new TrailSpine({
      id: 888,
      stage: STAGE_ICY_BLACK,
      seed: 17,
      length: 280,
      startPosX: 0,
      startPosY: 0,
      startPosZ: 0,
      startYawRad: degToRad(25),
      startPitchRad: -0.42,
      startHalfWidth: 10,
      endHalfWidth: 10,
      hasFork: false,
      leftStageId: null,
      rightStageId: null,
      isForkChild: true,
      forkSide: 'right',
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: 0,
      seamYawRad: degToRad(25),
      allowIslandDivider: false,
    });
    const singleSource = {
      elevationSpines: [sharpChasmSpine],
      collectSpinesInBounds(
        _minX: number,
        _maxX: number,
        _minZ: number,
        _maxZ: number,
        _padM: number,
        outSpines: SpineView[],
      ): void {
        outSpines.length = 0;
        outSpines.push(sharpChasmSpine);
      },
    };
    const singleField = new MountainField(singleSource);
    // Pick the sharpest right-turn sample (k < 0 => right-side chasm sits on the inner turn)
    const innerFrame = createSpineFrameOut();
    let bestInnerS = 45;
    let minK = Infinity;
    for (let s = 15; s <= 240; s += 2) {
      sharpChasmSpine.sampleSpineFrame(s, innerFrame);
      if (innerFrame.curvature < minK) {
        minK = innerFrame.curvature;
        bestInnerS = s;
      }
    }
    expect(minK).toBeLessThan(-0.01);
    sharpChasmSpine.sampleSpineFrame(bestInnerS, innerFrame);
    const inRightX = Math.cos(innerFrame.yawRad);
    const inRightZ = -Math.sin(innerFrame.yawRad);

    let prevInnerY = singleField.evaluateHeight(innerFrame.posX, innerFrame.posZ);
    for (let lat = 1; lat <= 115; lat += 1) {
      const wx = innerFrame.posX + inRightX * lat;
      const wz = innerFrame.posZ + inRightZ * lat;
      singleField.evaluate(wx, wz, curSample);
      expect(Number.isFinite(curSample.heightY)).toBe(true);
      expect(Number.isFinite(curSample.normalY)).toBe(true);
      expect(curSample.normalY).toBeGreaterThan(0.03);
      const diff = Math.abs(curSample.heightY - prevInnerY);
      // Gorge wall (lat <= 30) transitions 34m over 16m; outer caustic/farWall zone stays < 3.5m/m
      expect(diff).toBeLessThan(lat <= 30 ? 5.5 : 3.5);
      prevInnerY = curSample.heightY;
    }

    // Verify projectXZ longExt semantics (0 inside [0, L], < 0 behind start, > 0 past end) and exact distSq
    const proj = createSpineProjectionOut();
    const startFrame = createSpineFrameOut();
    sharpChasmSpine.sampleSpineFrame(0, startFrame);
    const sFwdX = -Math.sin(startFrame.yawRad);
    const sFwdZ = -Math.cos(startFrame.yawRad);
    sharpChasmSpine.projectXZ(startFrame.posX - sFwdX * 15, startFrame.posZ - sFwdZ * 15, proj);
    expect(proj.s).toBe(0);
    expect(proj.longExt).toBeCloseTo(-15, 4);
    expect(proj.distSq).toBeCloseTo(225, 2);

    sharpChasmSpine.projectXZ(innerFrame.posX + inRightX * 12, innerFrame.posZ + inRightZ * 12, proj);
    expect(proj.longExt).toBe(0);
    expect(proj.signedX).toBeCloseTo(12, 2);
    expect(proj.distSq).toBeCloseTo(144, 1);

    const termFrame = createSpineFrameOut();
    sharpChasmSpine.sampleSpineFrame(sharpChasmSpine.length, termFrame);
    const tFwdX = -Math.sin(termFrame.yawRad);
    const tFwdZ = -Math.cos(termFrame.yawRad);
    sharpChasmSpine.projectXZ(termFrame.posX + tFwdX * 20, termFrame.posZ + tFwdZ * 20, proj);
    expect(proj.s).toBe(sharpChasmSpine.length);
    expect(proj.longExt).toBeCloseTo(20, 4);
    expect(proj.distSq).toBeCloseTo(400, 2);
  });

  it('preserves heightfield invariance within 280m when pruning forks into ghostSpines and bounds ghostSpines <= 28 beyond 600m', () => {
    const trailWin = new TrailWindow(5150, 'sunny-blue');
    const field = new MountainField(trailWin);

    // First advance once so prev is populated, then measure invariance across next prune
    trailWin.updateProgression(trailWin.nextLeft!.id, 45);
    const chosen = trailWin.nextLeft!;
    const frame = createSpineFrameOut();
    chosen.sampleSpineFrame(42, frame);
    const skierX = frame.posX;
    const skierZ = frame.posZ;

    // Sample across the 280m radius covering the pruned prev / unchosen nextRight region
    // and check full-360 invariance over existing+promoted+ghost spines (excluding only newly spawned 2nd-ahead horizon)
    const preIds = new Set(trailWin.elevationSpines.map((sp) => sp.id));
    const probeFull360: Array<{ x: number; z: number; h: number }> = [];
    const probePrunedHalf: Array<{ x: number; z: number; h: number }> = [];
    const radii = [0, 35, 90, 160, 230, 275];
    for (let rIdx = 0; rIdx < radii.length; rIdx++) {
      const r = radii[rIdx]!;
      const angles = r === 0 ? 1 : 12;
      for (let a = 0; a < angles; a++) {
        const theta = (a * Math.PI * 2) / angles;
        const dx = Math.cos(theta) * r;
        const dz = Math.sin(theta) * r;
        const wx = skierX + dx;
        const wz = skierZ + dz;
        const h = field.evaluateHeight(wx, wz);
        probeFull360.push({ x: wx, z: wz, h });
        if (dz >= 0) {
          probePrunedHalf.push({ x: wx, z: wz, h });
        }
      }
    }

    const adv = trailWin.updateProgression(chosen.id, 42, 40, skierX, skierZ);
    expect(adv.prunedIds.length).toBeGreaterThanOrEqual(2);
    expect(trailWin.ghostSpines.length).toBeGreaterThan(0);

    // 1. Full 280m radius invariance across pruned/ghosted/promoted spines (same spine set before 2nd-level horizon spawn)
    const promotedAndGhostOnly = trailWin.elevationSpines.filter((sp) => preIds.has(sp.id));
    for (let i = 0; i < probeFull360.length; i++) {
      const p = probeFull360[i]!;
      const postH = field.evaluateHeight(p.x, p.z, promotedAndGhostOnly);
      expect(Math.abs(postH - p.h)).toBeLessThan(1e-10);
    }

    // 2. Full MountainField invariance inside 280m pruned half-space (behind & beside skier)
    for (let i = 0; i < probePrunedHalf.length; i++) {
      const p = probePrunedHalf[i]!;
      const postH = field.evaluateHeight(p.x, p.z);
      expect(Math.abs(postH - p.h)).toBeLessThan(1e-6);
    }

    // Verify collectSpinesInBounds filters accurately around skier
    const boundedSpines: SpineView[] = [];
    field.collectSpinesInBounds(skierX - 32, skierX + 32, skierZ - 32, skierZ + 32, 30, boundedSpines);
    expect(boundedSpines.length).toBeGreaterThan(0);
    expect(boundedSpines.length).toBeLessThan(trailWin.elevationSpines.length);

    // Advance many segments and verify ghostSpines stays strictly bounded <= 28 and old ghosts prune > 600m
    for (let step = 0; step < 35; step++) {
      const next = step % 2 === 0 ? trailWin.nextLeft! : (trailWin.nextRight ?? trailWin.nextLeft!);
      next.sampleSpineFrame(45, frame);
      trailWin.updateProgression(next.id, 45, 40, frame.posX, frame.posZ);
      expect(trailWin.ghostSpines.length).toBeLessThanOrEqual(MAX_GHOST_SPINES);
    }
    expect(trailWin.ghostSpines.length).toBeGreaterThan(0);
    expect(trailWin.ghostSpines.length).toBeLessThanOrEqual(MAX_GHOST_SPINES);

    // Every remaining ghost spine must be within 600m AABB distance of the last skier position
    for (let i = 0; i < trailWin.ghostSpines.length; i++) {
      const gs = trailWin.ghostSpines[i]!;
      const dx =
        frame.posX < gs.boundsMinX
          ? gs.boundsMinX - frame.posX
          : frame.posX > gs.boundsMaxX
            ? frame.posX - gs.boundsMaxX
            : 0;
      const dz =
        frame.posZ < gs.boundsMinZ
          ? gs.boundsMinZ - frame.posZ
          : frame.posZ > gs.boundsMaxZ
            ? frame.posZ - gs.boundsMaxZ
            : 0;
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(600 + 1e-6);
    }
  });

  it('maintains exact MountainField evaluation invariance across 128m floating-origin rebasing', () => {
    const sim = new SkiSimulation({ seed: 314, startStageId: 'icy-black' });
    const intent = createMutablePlayerIntent();

    // Advance along safeX until right before the first rebase triggers
    for (let i = 0; i < 600; i++) {
      const st = sim.getState();
      if (
        Math.abs(st.currSkier.posX) >= 122 ||
        Math.abs(st.currSkier.posY) >= 122 ||
        Math.abs(st.currSkier.posZ) >= 122
      ) {
        break;
      }
      const targetX = st.trailWindow.curr.sampleSafeX(st.surfaceSample.s + 10);
      intent.steer = clamp((targetX - st.surfaceSample.x) * 0.14, -1, 1);
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }

    const preState = sim.getState();
    const preSegId = preState.trailWindow.curr.id;
    const baseRebaseCount = preState.rebase.rebaseCount;
    const sk = preState.currSkier;

    // Sample multiple points (on-piste, left off-piste canyon, right off-piste chasm)
    const offsets = [
      { dx: 0, dz: 0 },
      { dx: -32, dz: -10 },
      { dx: 34, dz: -15 },
      { dx: 120, dz: -25 },
    ];
    const preSamples = offsets.map((o) => {
      const out = createMountainSampleOut();
      preState.mountainField.evaluate(sk.posX + o.dx, sk.posZ + o.dz, out);
      return { wx: sk.posX + o.dx, wz: sk.posZ + o.dz, sample: out };
    });

    // Step until WORLD_REBASED triggers (without crossing a fork progression change)
    let rebased = false;
    for (let i = 0; i < 60; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
      if (sim.getState().rebase.rebaseCount > baseRebaseCount) {
        rebased = true;
        break;
      }
    }
    expect(rebased).toBe(true);

    const postState = sim.getState();
    expect(postState.trailWindow.curr.id).toBe(preSegId);
    const { lastDeltaX, lastDeltaY, lastDeltaZ } = postState.rebase;
    expect(postState.mountainField.originOffsetX).toBeCloseTo(postState.rebase.offsetX, 8);
    expect(postState.mountainField.originOffsetZ).toBeCloseTo(postState.rebase.offsetZ, 8);

    const postOut = createMountainSampleOut();
    for (let i = 0; i < preSamples.length; i++) {
      const pre = preSamples[i]!;
      postState.mountainField.evaluate(pre.wx - lastDeltaX, pre.wz - lastDeltaZ, postOut);
      expect(postOut.heightY).toBeCloseTo(pre.sample.heightY - lastDeltaY, 5);
      expect(postOut.normalX).toBeCloseTo(pre.sample.normalX, 5);
      expect(postOut.normalY).toBeCloseTo(pre.sample.normalY, 5);
      expect(postOut.normalZ).toBeCloseTo(pre.sample.normalZ, 5);
      expect(postOut.surfaceType).toBe(pre.sample.surfaceType);
      expect(postOut.onPiste).toBe(pre.sample.onPiste);
      expect(postOut.inChasmZone).toBe(pre.sample.inChasmZone);
    }
  });

  it('evaluates landscape archetypes, rock steepness, outer valley funneling, active segment patches, and secondaryStageId', () => {
    const sample = createMountainSampleOut();
    const col = createMountainColumnOut();

    // 1. Icy Black: canyonWalls left (with rock normalY < 0.72), chasm right with farWallOffsetM=75
    const winBlack = new TrailWindow(100, 'icy-black');
    const fieldBlack = new MountainField(winBlack);
    const frame = createSpineFrameOut();
    winBlack.curr.sampleSpineFrame(120, frame);
    const rightX = Math.cos(frame.yawRad);
    const rightZ = -Math.sin(frame.yawRad);

    // On-piste
    fieldBlack.evaluate(frame.posX, frame.posZ, sample);
    expect(sample.onPiste).toBe(true);
    expect(sample.pisteWeight).toBeCloseTo(1, 4);
    expect(sample.inChasmZone).toBe(false);

    // Canyon wall left -> rises above spineY; check for steep rock classification across slope
    let sawCanyonRise = false;
    let sawRock = false;
    for (let d = 18; d <= 55; d += 2) {
      fieldBlack.evaluate(frame.posX - rightX * d, frame.posZ - rightZ * d, sample);
      if (sample.heightY > frame.posY + 10) sawCanyonRise = true;
      if (!sample.onPiste && sample.normalY < 0.72 && sample.surfaceType === 'rock') {
        sawRock = true;
      }
    }
    expect(sawCanyonRise).toBe(true);
    expect(sawRock).toBe(true);

    // Chasm right -> drops deeply inside farWallOffsetM and sets chasm metadata, then rises past farWallOffsetM
    fieldBlack.evaluate(frame.posX + rightX * (frame.halfWidth + 28), frame.posZ + rightZ * (frame.halfWidth + 28), sample);
    expect(sample.onPiste).toBe(false);
    expect(sample.inChasmZone).toBe(true);
    expect(sample.chasmWipeoutDepth).toBe(22);
    expect(sample.chasmDepthBelowSpine).toBeGreaterThan(15);
    expect(sample.heightY).toBeLessThan(frame.posY - 15);

    fieldBlack.evaluate(frame.posX + rightX * (frame.halfWidth + 112), frame.posZ + rightZ * (frame.halfWidth + 112), sample);
    expect(sample.inChasmZone).toBe(false);
    expect(sample.heightY).toBeGreaterThan(frame.posY - 12);

    // 2. RollingHills + Outer Valley Funneling (> 110m off-piste)
    const winBlue = new TrailWindow(200, 'sunny-blue');
    const fieldBlue = new MountainField(winBlue);
    winBlue.curr.sampleSpineFrame(120, frame);
    const bRightX = Math.cos(frame.yawRad);
    const bRightZ = -Math.sin(frame.yawRad);

    fieldBlue.evaluateColumn(frame.posX + bRightX * 45, frame.posZ + bRightZ * 45, col);
    expect(Math.abs(col.heightY - col.macroY)).toBeLessThanOrEqual(16);

    fieldBlue.evaluateColumn(frame.posX + bRightX * 225, frame.posZ + bRightZ * 225, col);
    expect(col.heightY - col.macroY).toBeGreaterThan(22);

    // 3. AlpineBowl custom stage
    const alpineStage: StageDef = {
      ...STAGE_SUNNY_BLUE,
      id: 'alpine-bowl-test',
      landscape: {
        left: { archetype: 'alpineBowl', reliefScale: 22, transitionWidth: 20, noiseFrequency: 0.015 },
        right: { archetype: 'alpineBowl', reliefScale: 22, transitionWidth: 20, noiseFrequency: 0.015 },
      },
      forkTargets: ['alpine-bowl-test'],
    };
    const winBowl = new TrailWindow(300, 'alpine-bowl-test', undefined, (id) =>
      id === 'alpine-bowl-test' ? alpineStage : getStageDef(id),
    );
    const fieldBowl = new MountainField(winBowl);
    winBowl.curr.sampleSpineFrame(120, frame);
    const bowlRightX = Math.cos(frame.yawRad);
    const bowlRightZ = -Math.sin(frame.yawRad);
    fieldBowl.evaluateColumn(frame.posX + bowlRightX * 45, frame.posZ + bowlRightZ * 45, col);
    expect(col.heightY).toBeGreaterThan(col.macroY + 3);

    // 4. Active TrailSegment.patches surface visibility ('ice' & 'powder')
    const segPatches = winBlue.curr.patches as SurfacePatch[];
    segPatches.push({ s: 120, x: 0, radiusS: 12, radiusX: 6, surfaceType: 'ice' });
    segPatches.push({ s: 150, x: 0, radiusS: 12, radiusX: 6, surfaceType: 'powder' });
    winBlue.curr.sampleSpineFrame(120, frame);
    fieldBlue.evaluate(frame.posX, frame.posZ, sample);
    expect(sample.pisteSurfaceType).toBe('ice');
    expect(sample.surfaceType).toBe('ice');
    winBlue.curr.sampleSpineFrame(150, frame);
    fieldBlue.evaluate(frame.posX, frame.posZ, sample);
    expect(sample.pisteSurfaceType).toBe('powder');
    expect(sample.surfaceType).toBe('powder');

    // 5. Distinct stage aggregation near fork transition (secondaryStageId & secondaryStageWeight)
    const endFrame = createSpineFrameOut();
    winBlue.curr.sampleSpineFrame(winBlue.curr.length, endFrame);
    fieldBlue.evaluateColumn(endFrame.posX, endFrame.posZ, col);
    expect(col.nearestStageId).toBe('sunny-blue');
    expect(col.secondaryStageId).toBe('icy-black');
    expect(col.secondaryStageWeight).toBeGreaterThan(0);
    expect(col.secondaryStageWeight).toBeLessThan(1);
  });

  it('produces zero elevation-drift trench across consecutive steep icy-black runs', () => {
    const steepOnlyStage: StageDef = {
      ...STAGE_ICY_BLACK,
      id: 'steep-only-black',
      forkTargets: ['steep-only-black'],
    };
    const trailWin = new TrailWindow(8080, 'steep-only-black', undefined, (id) =>
      id === 'steep-only-black' ? steepOnlyStage : getStageDef(id),
    );
    const field = new MountainField(trailWin);
    const col = createMountainColumnOut();
    const frame = createSpineFrameOut();

    const pisteOut = createPisteHeightOut();
    let maxAbsMacroDiff = 0;
    for (let step = 0; step < 10; step++) {
      const curr = trailWin.curr;
      for (let s = 0; s <= curr.length; s += 20) {
        curr.sampleSpineFrame(s, frame);
        curr.evaluatePisteHeight(s, 0, pisteOut);
        field.evaluateColumn(frame.posX, frame.posZ, col);
        expect(Number.isFinite(col.heightY)).toBe(true);
        expect(Number.isFinite(col.macroY)).toBe(true);
        const absDiff = Math.abs(col.macroY - col.nearestSpineY);
        if (absDiff > maxAbsMacroDiff) maxAbsMacroDiff = absDiff;
        expect(absDiff).toBeLessThan(12.0);
        expect(Math.abs(col.heightY - pisteOut.heightY)).toBeLessThan(0.15);
      }
      trailWin.updateProgression(trailWin.nextLeft!.id, 45);
    }
    expect(maxAbsMacroDiff).toBeLessThan(12.0);
  });

  it('wires stage.forkTargets dynamically without hardcoded stage IDs', () => {
    const customAlpha: StageDef = {
      ...STAGE_SUNNY_BLUE,
      id: 'alpine-alpha',
      forkTargets: ['canyon-beta', 'glacier-gamma'],
    };
    const customBeta: StageDef = {
      ...STAGE_ICY_BLACK,
      id: 'canyon-beta',
      forkTargets: ['alpine-alpha', 'glacier-gamma'],
    };
    const customGamma: StageDef = {
      ...STAGE_SUNNY_BLUE,
      id: 'glacier-gamma',
      landscape: {
        left: { archetype: 'alpineBowl', reliefScale: 18, transitionWidth: 22, noiseFrequency: 0.015 },
        right: { archetype: 'alpineBowl', reliefScale: 18, transitionWidth: 22, noiseFrequency: 0.015 },
      },
      forkTargets: ['alpine-alpha', 'canyon-beta'],
    };
    const customRegistry: Record<string, StageDef> = {
      'alpine-alpha': customAlpha,
      'canyon-beta': customBeta,
      'glacier-gamma': customGamma,
    };

    const trailWin = new TrailWindow(
      555,
      'alpine-alpha',
      undefined,
      (id) => customRegistry[id],
    );
    const field = new MountainField(trailWin);

    expect(trailWin.curr.stageId).toBe('alpine-alpha');
    expect(trailWin.curr.fork.leftStageId).not.toBe(trailWin.curr.fork.rightStageId);
    expect(['canyon-beta', 'glacier-gamma']).toContain(trailWin.curr.fork.leftStageId);
    expect(['canyon-beta', 'glacier-gamma']).toContain(trailWin.curr.fork.rightStageId);
    expect(['canyon-beta', 'glacier-gamma']).toContain(trailWin.nextLeft!.stageId);
    expect(['canyon-beta', 'glacier-gamma']).toContain(trailWin.nextRight!.stageId);

    // Advance into glacier-gamma and verify custom stage landscape + forkTargets propagate cleanly
    const gammaBranch =
      trailWin.nextLeft!.stageId === 'glacier-gamma' ? trailWin.nextLeft! : trailWin.nextRight!;
    trailWin.updateProgression(gammaBranch.id, 45);
    expect(trailWin.curr.stageId).toBe('glacier-gamma');
    expect(['alpine-alpha', 'canyon-beta']).toContain(trailWin.curr.fork.leftStageId);
    expect(['alpine-alpha', 'canyon-beta']).toContain(trailWin.curr.fork.rightStageId);

    const frame = createSpineFrameOut();
    trailWin.curr.sampleSpineFrame(120, frame);
    const rightX = Math.cos(frame.yawRad);
    const rightZ = -Math.sin(frame.yawRad);
    const col = createMountainColumnOut();
    field.evaluateColumn(frame.posX + rightX * 42, frame.posZ + rightZ * 42, col);
    expect(col.nearestStageId).toBe('glacier-gamma');
    expect(col.heightY).toBeGreaterThan(col.macroY + 2);
  });

  it('matches precomputed macroAnchor evaluation against sampleSpineFrame fallback and normalizes SkiSimulation worldSeed', () => {
    const simStr = new SkiSimulation({ seed: 'alpine-powder-99', startStageId: 'sunny-blue' });
    expect(simStr.getState().mountainField.worldSeed).toBe(hashString('alpine-powder-99'));

    simStr.reset(-42);
    expect(simStr.getState().mountainField.worldSeed).toBe((-42) >>> 0);

    // Compare precomputed macroAnchor SpineView vs SpineView wrapper omitting macroAnchorCount
    const win = new TrailWindow(31415, 'icy-black');
    const sp = win.curr;
    expect(sp.macroAnchorCount).toBeGreaterThan(40);
    expect(sp.macroAnchorX.length).toBe(sp.macroAnchorCount);
    expect(sp.macroAnchorY.length).toBe(sp.macroAnchorCount);
    expect(sp.macroAnchorZ.length).toBe(sp.macroAnchorCount);

    const fallbackSpine: SpineView = {
      id: sp.id,
      stageId: sp.stageId,
      seed: sp.seed,
      length: sp.length,
      skirtWidth: sp.skirtWidth,
      fork: sp.fork,
      landscape: sp.landscape,
      boundsMinX: sp.boundsMinX,
      boundsMaxX: sp.boundsMaxX,
      boundsMinZ: sp.boundsMinZ,
      boundsMaxZ: sp.boundsMaxZ,
      sampleSpineFrame: (s, out) => sp.sampleSpineFrame(s, out),
      projectXZ: (wx, wz, out) => sp.projectXZ(wx, wz, out),
      evaluatePisteHeight: (s, x, out) => sp.evaluatePisteHeight(s, x, out),
      evaluatePisteSurface: (s, x) => sp.evaluatePisteSurface(s, x),
    };

    const fastField = new MountainField({
      elevationSpines: [sp],
      collectSpinesInBounds: (_a, _b, _c, _d, _e, out) => {
        out.length = 0;
        out.push(sp);
      },
    });
    const slowField = new MountainField({
      elevationSpines: [fallbackSpine],
      collectSpinesInBounds: (_a, _b, _c, _d, _e, out) => {
        out.length = 0;
        out.push(fallbackSpine);
      },
    });

    const fOut = createMountainColumnOut();
    const sOut = createMountainColumnOut();
    for (let z = -220; z <= 40; z += 40) {
      for (let x = -90; x <= 90; x += 30) {
        fastField.evaluateColumn(x, z, fOut);
        slowField.evaluateColumn(x, z, sOut);
        expect(fOut.macroY).toBeCloseTo(sOut.macroY, 4);
        expect(fOut.heightY).toBeCloseTo(sOut.heightY, 4);
      }
    }

    // Rebase shifts macro anchors identically
    sp.rebaseOrigin(10, -25, -128);
    fastField.setOriginOffset(10, -128);
    slowField.setOriginOffset(10, -128);
    fastField.evaluateColumn(30, -40, fOut);
    slowField.evaluateColumn(30, -40, sOut);
    expect(fOut.macroY).toBeCloseTo(sOut.macroY, 4);
  });

  it('matches evaluate() interior-piste normals to central-difference evaluateHeight() normals on steep banked curves', () => {
    const win = new TrailWindow(17, 'icy-black');
    const field = new MountainField(win);
    const sp = win.curr;
    const frame = createSpineFrameOut();

    // Find a high-curvature interior point past s >= 30 (well away from fork seams)
    let bestS = 60;
    let maxAbsK = 0;
    for (let s = 30; s <= sp.length - 40; s += 4) {
      sp.sampleSpineFrame(s, frame);
      if (Math.abs(frame.curvature) > maxAbsK) {
        maxAbsK = Math.abs(frame.curvature);
        bestS = s;
      }
    }
    expect(maxAbsK).toBeGreaterThan(0.005);

    const sample = createMountainSampleOut();
    const eps = 0.5;
    for (const latFrac of [-0.6, 0, 0.6]) {
      sp.sampleSpineFrame(bestS, frame);
      const wx = frame.posX + frame.rightX * (frame.halfWidth * latFrac);
      const wz = frame.posZ + frame.rightZ * (frame.halfWidth * latFrac);

      field.evaluate(wx, wz, sample);
      const hL = field.evaluateHeight(wx - eps, wz);
      const hR = field.evaluateHeight(wx + eps, wz);
      const hD = field.evaluateHeight(wx, wz - eps);
      const hU = field.evaluateHeight(wx, wz + eps);
      const dHx = (hR - hL) / (2 * eps);
      const dHz = (hU - hD) / (2 * eps);
      const invLen = 1 / Math.hypot(-dHx, 1, -dHz);

      expect(sample.normalX).toBeCloseTo(-dHx * invLen, 5);
      expect(sample.normalY).toBeCloseTo(invLen, 5);
      expect(sample.normalZ).toBeCloseTo(-dHz * invLen, 5);
    }
  });
});
