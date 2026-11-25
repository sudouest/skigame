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
  createTerrainGridSampleOut,
  TERRAIN_FLAG_IN_CHASM,
  TERRAIN_FLAG_ON_PISTE,
  type SpineView,
} from '../contracts';
import { MountainField } from '../mountainField';
import { SkiSimulation } from '../skiSimulation';
import type { SurfacePatch } from '../trailSegment';
import { MAX_CURVATURE_RIBBON_RATIO, TrailSpine } from '../trailSpine';
import {
  GHOST_SPINE_PRUNE_DISTANCE_M,
  MAX_GHOST_SPINES,
  TrailWindow,
} from '../trailWindow';

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
      // Tightened Model 3 inner-turn slope invariant: < 68 deg (normalY >= 0.38) everywhere!
      expect(curSample.normalY).toBeGreaterThanOrEqual(0.38);
      const diff = Math.abs(curSample.heightY - prevInnerY);
      expect(diff).toBeLessThan(2.5);
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

    // Every remaining ghost spine must be within GHOST_SPINE_PRUNE_DISTANCE_M (960m) AABB distance
    expect(GHOST_SPINE_PRUNE_DISTANCE_M).toBe(960);
    expect(MAX_GHOST_SPINES).toBe(44);
    expect(trailWin.horizon2Spines).toHaveLength(8);
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
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(GHOST_SPINE_PRUNE_DISTANCE_M + 1e-6);
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
    sim.dispose();
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
    expect(col.secondaryStageId).not.toBeNull();
    expect(col.secondaryStageId).not.toBe('sunny-blue');
    expect(STAGE_SUNNY_BLUE.forkTargets).toContain(col.secondaryStageId!);
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

  it('matches precomputed coarse macroNodes evaluation against sampleSpineFrame fallback and normalizes SkiSimulation worldSeed', () => {
    const simStr = new SkiSimulation({ seed: 'alpine-powder-99', startStageId: 'sunny-blue' });
    expect(simStr.getState().mountainField.worldSeed).toBe(hashString('alpine-powder-99'));

    simStr.reset(-42);
    expect(simStr.getState().mountainField.worldSeed).toBe((-42) >>> 0);
    simStr.dispose();

    // Compare precomputed coarse 16m macroNodes SpineView vs SpineView wrapper omitting macroNodes
    const win = new TrailWindow(31415, 'icy-black');
    const sp = win.curr;
    expect(sp.macroNodes.count).toBeGreaterThan(10);
    expect(sp.macroNodes.posX.length).toBe(sp.macroNodes.count);
    expect(sp.macroNodes.posY.length).toBe(sp.macroNodes.count);
    expect(sp.macroNodes.posZ.length).toBe(sp.macroNodes.count);
    // Standalone test spine with both open-leaf extensions active for exact fallback parity
    const standalone = new TrailSpine({
      id: 777,
      stage: STAGE_ICY_BLACK,
      seed: 31415,
      length: 280,
      startPosX: 0,
      startPosY: 0,
      startPosZ: 0,
      startYawRad: 0,
      startPitchRad: -0.45,
      startHalfWidth: 10,
      endHalfWidth: 10,
      hasFork: false,
      leftStageId: null,
      rightStageId: null,
      isForkChild: false,
      forkSide: 'none',
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: 0,
      seamYawRad: 0,
      hasUpstreamParent: false,
    });

    const fallbackSpine: SpineView = {
      id: standalone.id,
      stageId: standalone.stageId,
      seed: standalone.seed,
      length: standalone.length,
      skirtWidth: standalone.skirtWidth,
      fork: standalone.fork,
      landscape: standalone.landscape,
      boundsMinX: standalone.boundsMinX,
      boundsMaxX: standalone.boundsMaxX,
      boundsMinZ: standalone.boundsMinZ,
      boundsMaxZ: standalone.boundsMaxZ,
      corridorLeft: standalone.corridorLeft,
      corridorRight: standalone.corridorRight,
      sampleSpineFrame: (s, out) => standalone.sampleSpineFrame(s, out),
      projectXZ: (wx, wz, out) => standalone.projectXZ(wx, wz, out),
      evaluatePisteHeight: (s, x, out) => standalone.evaluatePisteHeight(s, x, out),
      evaluatePisteSurface: (s, x) => standalone.evaluatePisteSurface(s, x),
    };

    const fastField = new MountainField({
      elevationSpines: [standalone],
      collectSpinesInBounds: (_a, _b, _c, _d, _e, out) => {
        out.length = 0;
        out.push(standalone);
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

    // Rebase shifts macro nodes and corridor chains identically
    standalone.rebaseOrigin(10, -25, -128);
    fastField.setOriginOffset(10, -128, -25);
    slowField.setOriginOffset(10, -128, -25);
    fastField.evaluateColumn(30, -40, fOut);
    slowField.evaluateColumn(30, -40, sOut);
    expect(fOut.macroY).toBeCloseTo(sOut.macroY, 4);
    expect(fOut.heightY).toBeCloseTo(sOut.heightY, 4);
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

  it('produces asymmetric left chasm + right bowl for blizzard-ridge and smooth icy-black -> blizzard-ridge fork continuity', () => {
    const icyDef = getStageDef('icy-black')!;
    const blizzardDef = getStageDef('blizzard-ridge')!;
    const powderDef = getStageDef('powder-bowl')!;
    const gorgeDef = getStageDef('granite-gorge')!;

    // Verify powder-bowl symmetric alpineBowl & granite-gorge symmetric canyonWalls
    const winPowder = new TrailWindow(41, 'powder-bowl');
    const fieldPowder = new MountainField(winPowder);
    const frame = createSpineFrameOut();
    const col = createMountainColumnOut();
    winPowder.curr.sampleSpineFrame(120, frame);
    const pRightX = Math.cos(frame.yawRad);
    const pRightZ = -Math.sin(frame.yawRad);
    fieldPowder.evaluateColumn(frame.posX - pRightX * 48, frame.posZ - pRightZ * 48, col);
    expect(col.heightY).toBeGreaterThan(col.macroY + 3);
    fieldPowder.evaluateColumn(frame.posX + pRightX * 48, frame.posZ + pRightZ * 48, col);
    expect(col.heightY).toBeGreaterThan(col.macroY + 3);

    const winGorge = new TrailWindow(43, 'granite-gorge');
    const fieldGorge = new MountainField(winGorge);
    winGorge.curr.sampleSpineFrame(120, frame);
    const gRightX = Math.cos(frame.yawRad);
    const gRightZ = -Math.sin(frame.yawRad);
    const gSample = createMountainSampleOut();
    let sawLeftRock = false;
    let sawRightRock = false;
    for (let d = frame.halfWidth + 4; d <= frame.halfWidth + 24; d += 3) {
      fieldGorge.evaluate(frame.posX - gRightX * d, frame.posZ - gRightZ * d, gSample);
      if (gSample.normalY < 0.72 && gSample.surfaceType === 'rock') sawLeftRock = true;
      fieldGorge.evaluate(frame.posX + gRightX * d, frame.posZ + gRightZ * d, gSample);
      if (gSample.normalY < 0.72 && gSample.surfaceType === 'rock') sawRightRock = true;
    }
    expect(sawLeftRock).toBe(true);
    expect(sawRightRock).toBe(true);

    // Verify blizzard-ridge left chasm & right alpineBowl, plus fork seam into blizzard-ridge
    const icyForkToBlizzard: StageDef = {
      ...icyDef,
      id: 'icy-fork-bliz',
      forkTargets: [powderDef.id, blizzardDef.id],
    };
    const blizzardLoop: StageDef = {
      ...blizzardDef,
      forkTargets: [gorgeDef.id, 'icy-fork-bliz'],
    };
    const resolver = (id: string): StageDef | undefined =>
      id === 'icy-fork-bliz'
        ? icyForkToBlizzard
        : id === blizzardDef.id
          ? blizzardLoop
          : getStageDef(id);

    const winFork = new TrailWindow(909, 'icy-fork-bliz', undefined, resolver);
    const blizBranch =
      winFork.nextLeft?.stageId === blizzardDef.id
        ? winFork.nextLeft
        : winFork.nextRight?.stageId === blizzardDef.id
          ? winFork.nextRight
          : null;
    expect(blizBranch).not.toBeNull();

    const fieldFork = new MountainField(winFork);
    const endF = createSpineFrameOut();
    winFork.curr.sampleSpineFrame(winFork.curr.length, endF);
    const bSampleBefore = createMountainSampleOut();
    const bSampleAt = createMountainSampleOut();
    const sFwdX = -Math.sin(endF.yawRad);
    const sFwdZ = -Math.cos(endF.yawRad);
    fieldFork.evaluate(endF.posX - sFwdX * 0.25, endF.posZ - sFwdZ * 0.25, bSampleBefore);
    fieldFork.evaluate(endF.posX + sFwdX * 0.25, endF.posZ + sFwdZ * 0.25, bSampleAt);
    expect(Math.abs(bSampleAt.heightY - bSampleBefore.heightY)).toBeLessThan(0.4);

    // Mid-segment on blizzard-ridge branch: left side drops into chasm zone, right side rises as alpineBowl
    blizBranch!.sampleSpineFrame(120, frame);
    const bRightX = Math.cos(frame.yawRad);
    const bRightZ = -Math.sin(frame.yawRad);
    fieldFork.evaluate(
      frame.posX - bRightX * (frame.halfWidth + 28),
      frame.posZ - bRightZ * (frame.halfWidth + 28),
      gSample,
    );
    expect(gSample.onPiste).toBe(false);
    expect(gSample.inChasmZone).toBe(true);
    expect(gSample.chasmWipeoutDepth).toBe(22);
    expect(gSample.heightY).toBeLessThan(gSample.macroY - 8);

    fieldFork.evaluateColumn(
      frame.posX + bRightX * (frame.halfWidth + 32),
      frame.posZ + bRightZ * (frame.halfWidth + 32),
      col,
    );
    expect(col.inChasmZone).toBe(false);
    expect(col.heightY).toBeGreaterThan(col.macroY + 3);

    // Standalone blizzard-ridge left chasm drops deeply below spine elevation
    const winBliz = new TrailWindow(909, blizzardDef.id);
    const fieldBliz = new MountainField(winBliz);
    winBliz.curr.sampleSpineFrame(120, frame);
    const sbRightX = Math.cos(frame.yawRad);
    const sbRightZ = -Math.sin(frame.yawRad);
    fieldBliz.evaluate(
      frame.posX - sbRightX * (frame.halfWidth + 28),
      frame.posZ - sbRightZ * (frame.halfWidth + 28),
      gSample,
    );
    expect(gSample.inChasmZone).toBe(true);
    expect(gSample.heightY).toBeLessThan(frame.posY - 15);
  });

  it('prevents a height-divergent foreign corridor from tearing a sinkhole in an active dominant piste', () => {
    const baseStage = getStageDef('sunny-blue')!;
    const activeSpine = new TrailSpine({
      id: 1,
      stage: baseStage,
      seed: 10,
      length: 200,
      startPosX: 0,
      startPosY: 0,
      startPosZ: 0,
      startYawRad: 0,
      startPitchRad: -0.22,
      startHalfWidth: 14,
      endHalfWidth: 14,
      hasFork: false,
      leftStageId: null,
      rightStageId: null,
      isForkChild: false,
      forkSide: 'none',
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: 0,
      seamYawRad: 0,
      allowIslandDivider: false,
    });
    const deepForeignSpine = new TrailSpine({
      id: 2,
      stage: baseStage,
      seed: 20,
      length: 200,
      startPosX: 20,
      startPosY: -40,
      startPosZ: 0,
      startYawRad: 0,
      startPitchRad: -0.22,
      startHalfWidth: 16,
      endHalfWidth: 16,
      hasFork: false,
      leftStageId: null,
      rightStageId: null,
      isForkChild: false,
      forkSide: 'none',
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: 0,
      seamYawRad: 0,
      allowIslandDivider: false,
    });

    const source = {
      elevationSpines: [deepForeignSpine, activeSpine],
      collectSpinesInBounds(
        _minX: number,
        _maxX: number,
        _minZ: number,
        _maxZ: number,
        _padM: number,
        outSpines: SpineView[],
      ): void {
        outSpines.length = 0;
        outSpines.push(deepForeignSpine, activeSpine);
      },
    };
    const field = new MountainField(source);
    const frame = createSpineFrameOut();
    const pisteOut = createPisteHeightOut();
    const sample = createMountainSampleOut();

    activeSpine.sampleSpineFrame(90, frame);
    activeSpine.evaluatePisteHeight(90, 0, pisteOut);
    field.evaluate(frame.posX, frame.posZ, sample);
    expect(sample.onPiste).toBe(true);
    expect(sample.heightY).toBeCloseTo(pisteOut.heightY, 4);
  });

  it('passes dense 2D grid C0/C1 continuity sweeps across asymmetric icy-black & blizzard-ridge fork V-wedges and tight inner turns (normalY >= 0.38)', () => {
    const sample = createMountainSampleOut();
    const frame = createSpineFrameOut();
    let globalMinNormalY = 1;
    let globalMaxStepPerM = 0;

    for (const [stageId, seed] of [
      ['icy-black', 2026],
      ['blizzard-ridge', 4040],
      ['icy-black', 777],
      ['blizzard-ridge', 1337],
    ] as const) {
      const win = new TrailWindow(seed, stageId);
      const field = new MountainField(win);

      // 1. 2D grid sweep centered on the asymmetric fork seam & V-wedge (along in [-24, 140], lat in [-80, 80])
      win.curr.sampleSpineFrame(win.curr.length, frame);
      const fwdX = -Math.sin(frame.yawRad);
      const fwdZ = -Math.cos(frame.yawRad);
      const rightX = Math.cos(frame.yawRad);
      const rightZ = -Math.sin(frame.yawRad);

      const gridStep = 2.0;
      const alongSteps = 82; // -24..140m
      const latSteps = 80; // -80..+80m
      const heights = new Float64Array((alongSteps + 1) * (latSteps + 1));

      for (let ia = 0; ia <= alongSteps; ia++) {
        const along = -24 + ia * gridStep;
        for (let il = 0; il <= latSteps; il++) {
          const lat = -80 + il * gridStep;
          const wx = frame.posX + fwdX * along + rightX * lat;
          const wz = frame.posZ + fwdZ * along + rightZ * lat;
          field.evaluate(wx, wz, sample);
          expect(Number.isFinite(sample.heightY)).toBe(true);
          expect(Number.isFinite(sample.normalY)).toBe(true);
          if (sample.normalY < globalMinNormalY) globalMinNormalY = sample.normalY;
          expect(sample.normalY).toBeGreaterThanOrEqual(0.38);
          const idx = ia * (latSteps + 1) + il;
          heights[idx] = sample.heightY;

          if (il > 0) {
            const stepLat = Math.abs(sample.heightY - heights[idx - 1]!) / gridStep;
            if (stepLat > globalMaxStepPerM) globalMaxStepPerM = stepLat;
            expect(stepLat).toBeLessThan(2.6);
          }
          if (ia > 0) {
            const stepAlong =
              Math.abs(sample.heightY - heights[idx - (latSteps + 1)]!) / gridStep;
            if (stepAlong > globalMaxStepPerM) globalMaxStepPerM = stepAlong;
            expect(stepAlong).toBeLessThan(2.6);
          }
        }
      }

      // 2. Tightest inner-turn 2D sweep along curr
      let bestS = 60;
      let maxAbsK = 0;
      for (let s = 25; s <= win.curr.length - 50; s += 3) {
        win.curr.sampleSpineFrame(s, frame);
        if (Math.abs(frame.curvature) > maxAbsK) {
          maxAbsK = Math.abs(frame.curvature);
          bestS = s;
        }
      }
      win.curr.sampleSpineFrame(bestS, frame);
      const tFwdX = -Math.sin(frame.yawRad);
      const tFwdZ = -Math.cos(frame.yawRad);
      const tRightX = Math.cos(frame.yawRad);
      const tRightZ = -Math.sin(frame.yawRad);

      for (let da = -30; da <= 30; da += 3) {
        let prevY = 0;
        for (let dl = -90; dl <= 90; dl += 2) {
          const wx = frame.posX + tFwdX * da + tRightX * dl;
          const wz = frame.posZ + tFwdZ * da + tRightZ * dl;
          field.evaluate(wx, wz, sample);
          expect(Number.isFinite(sample.heightY)).toBe(true);
          if (sample.normalY < globalMinNormalY) globalMinNormalY = sample.normalY;
          expect(sample.normalY).toBeGreaterThanOrEqual(0.38);
          if (dl > -90) {
            const slope = Math.abs(sample.heightY - prevY) / 2;
            expect(slope).toBeLessThan(2.6);
          }
          prevY = sample.heightY;
        }
      }
    }

    expect(globalMinNormalY).toBeGreaterThanOrEqual(0.38);
    expect(globalMaxStepPerM).toBeLessThan(2.6);
  });

  it('enforces LayoutEngine vs MountainField height parity (zero 3.6m snowbank drift) and S6 rebuildElevationSpines ordering', () => {
    // 1. Verify S6 ordering: elevationSpines is already populated BEFORE onSegmentCreated fires
    let callbacksFired = 0;
    const winOrder = new TrailWindow(303, 'icy-black', () => {
      callbacksFired++;
    });
    expect(callbacksFired).toBe(3);
    expect(winOrder.elevationSpines.length).toBeGreaterThanOrEqual(15);

    const winTracked = new TrailWindow(404, 'icy-black');
    const trackedField = new MountainField(winTracked);
    const revBeforeReset = trackedField.fieldRevision;
    winTracked.reset(505, 'icy-black');
    expect(trackedField.fieldRevision).toBeGreaterThan(revBeforeReset);
    expect(winTracked.elevationSpines.length).toBeGreaterThanOrEqual(15); // curr + 2 next + 4 horizon + 8 horizon2

    const orderObserved: number[] = [];
    let refWin: TrailWindow | null = null;
    refWin = new TrailWindow(606, 'icy-black', () => {
      if (refWin) {
        orderObserved.push(refWin.elevationSpines.length);
      }
    });
    refWin.reset(607, 'icy-black');
    refWin.updateProgression(refWin.nextLeft!.id, 45);
    expect(orderObserved.length).toBeGreaterThanOrEqual(5); // 3 from reset + 2 from updateProgression
    let minSpinesDuringCallback = Infinity;
    for (const c of orderObserved) {
      if (c < minSpinesDuringCallback) minSpinesDuringCallback = c;
    }
    expect(minSpinesDuringCallback).toBeGreaterThanOrEqual(15);

    // 2. Verify every baked hazard, present, ramp, delivery zone, and delivery landmark sits flush on MountainField
    const sim = new SkiSimulation({ seed: 2026, startStageId: 'icy-black' });
    const st = sim.getState();
    const mf = st.mountainField;
    const sample = createMountainSampleOut();

    const hazards = st.entities.hazards;
    expect(hazards.count).toBeGreaterThan(0);
    for (let i = 0; i < hazards.count; i++) {
      mf.evaluate(hazards.posX[i]!, hazards.posZ[i]!, sample);
      expect(Math.abs(hazards.posY[i]! - sample.heightY)).toBeLessThan(0.02);
      expect(hazards.normalY[i]!).toBeCloseTo(sample.normalY, 3);
    }

    const presents = st.entities.presents;
    expect(presents.count).toBeGreaterThan(0);
    for (let i = 0; i < presents.count; i++) {
      const groundY = mf.evaluateHeight(presents.posX[i]!, presents.posZ[i]!);
      expect(Math.abs(presents.posY[i]! - (groundY + 0.65))).toBeLessThan(0.02);
    }

    const ramps = st.entities.ramps;
    for (let i = 0; i < ramps.count; i++) {
      const groundY = mf.evaluateHeight(ramps.posX[i]!, ramps.posZ[i]!);
      expect(Math.abs(ramps.posY[i]! - groundY)).toBeLessThan(0.02);
    }

    const zones = st.entities.deliveryZones;
    expect(zones.count).toBeGreaterThan(0);
    for (let i = 0; i < zones.count; i++) {
      const groundY = mf.evaluateHeight(zones.posX[i]!, zones.posZ[i]!);
      expect(Math.abs(zones.posY[i]! - groundY)).toBeLessThan(0.02);
    }

    // Delivery landmarks (which sit up to hw + 2.0m outside the piste!) must match MountainField with zero 3.6m bank error
    let landmarkCount = 0;
    const segs = [st.trailWindow.curr, st.trailWindow.nextLeft, st.trailWindow.nextRight];
    for (const seg of segs) {
      if (!seg) continue;
      for (const lm of seg.landmarks) {
        if (lm.kind === 'deliveryLandmark' || lm.kind === 'forkArch') {
          landmarkCount++;
          const groundY = mf.evaluateHeight(lm.worldX, lm.worldZ);
          expect(Math.abs(lm.worldY - groundY)).toBeLessThan(0.05);
        }
      }
    }
    expect(landmarkCount).toBeGreaterThan(0);
    sim.dispose();
  });

  it('implements unified TerrainFieldView sampleColumnGrid contract with exact WORLD_REBASED invariance and dirtyRects tracking', () => {
    const sim = new SkiSimulation({ seed: 707, startStageId: 'icy-black' });
    const intent = createMutablePlayerIntent();

    // Advance close to first 128m rebase trigger
    for (let i = 0; i < 600; i++) {
      const st = sim.getState();
      if (
        Math.abs(st.currSkier.posX) >= 120 ||
        Math.abs(st.currSkier.posY) >= 120 ||
        Math.abs(st.currSkier.posZ) >= 120
      ) {
        break;
      }
      const targetX = st.trailWindow.curr.sampleSafeX(st.surfaceSample.s + 10);
      intent.steer = clamp((targetX - st.surfaceSample.x) * 0.14, -1, 1);
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }

    const preState = sim.getState();
    const mf = preState.mountainField;
    expect(mf.stageIdTable.length).toBeGreaterThanOrEqual(5);
    expect(mf.fieldRevision).toBeGreaterThanOrEqual(1);
    expect(mf.dirtyRects.length).toBeGreaterThan(0);

    const cols = 16;
    const rows = 16;
    const stepM = 4.0;
    const originAbsX = Math.floor(preState.currSkier.posX + mf.originOffsetX) - 32;
    const originAbsZ = Math.floor(preState.currSkier.posZ + mf.originOffsetZ) - 32;
    const blockOriginY = preState.currSkier.posY + mf.originOffsetY;

    const preGrid = createTerrainGridSampleOut(cols, rows);
    mf.sampleColumnGrid(originAbsX, originAbsZ, cols, rows, stepM, blockOriginY, preGrid);

    // Verify unpacked LinearFilter-safe channels match point queries and stay bounded
    const sample = createMountainSampleOut();
    let sawOnPiste = false;
    let sawChasm = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        expect(Number.isFinite(preGrid.heights[idx]!)).toBe(true);
        expect(Number.isFinite(preGrid.macroY[idx]!)).toBe(true);
        const nx = preGrid.normals[idx * 3]!;
        const ny = preGrid.normals[idx * 3 + 1]!;
        const nz = preGrid.normals[idx * 3 + 2]!;
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1.0, 4);
        expect(ny).toBeGreaterThanOrEqual(0.38);
        expect(preGrid.pisteWeight[idx]!).toBeGreaterThanOrEqual(0);
        expect(preGrid.pisteWeight[idx]!).toBeLessThanOrEqual(1);
        expect(preGrid.iceWeight[idx]!).toBeGreaterThanOrEqual(0);
        expect(preGrid.iceWeight[idx]!).toBeLessThanOrEqual(1);
        expect(preGrid.powderWeight[idx]!).toBeGreaterThanOrEqual(0);
        expect(preGrid.powderWeight[idx]!).toBeLessThanOrEqual(1);
        expect(preGrid.dividerMask[idx]!).toBeGreaterThanOrEqual(0);
        expect(preGrid.dividerMask[idx]!).toBeLessThanOrEqual(1);
        const fx = preGrid.flowXZ[idx * 2]!;
        const fz = preGrid.flowXZ[idx * 2 + 1]!;
        expect(Math.hypot(fx, fz)).toBeCloseTo(1.0, 4);
        expect(preGrid.primaryStageIdx[idx]!).toBeLessThan(mf.stageIdTable.length);
        if ((preGrid.flags[idx]! & TERRAIN_FLAG_ON_PISTE) !== 0) sawOnPiste = true;
        if ((preGrid.flags[idx]! & TERRAIN_FLAG_IN_CHASM) !== 0) sawChasm = true;
      }
    }
    expect(sawOnPiste).toBe(true);
    expect(sawChasm).toBe(true);

    // Spot-check exact parity between sampleColumnGrid and evaluateColumn/evaluateSample
    const checkCol = 8;
    const checkRow = 8;
    const checkIdx = checkRow * cols + checkCol;
    const wxCheck = originAbsX + checkCol * stepM - mf.originOffsetX;
    const wzCheck = originAbsZ + checkRow * stepM - mf.originOffsetZ;
    mf.evaluateSample(wxCheck, wzCheck, sample);
    expect(preGrid.heights[checkIdx]! + blockOriginY - mf.originOffsetY).toBeCloseTo(
      sample.heightY,
      3,
    );

    // Step across WORLD_REBASED and verify sampleColumnGrid returns identical values for same abs coords & blockOriginY
    const baseRebaseCount = preState.rebase.rebaseCount;
    const preRev = mf.fieldRevision;
    let rebased = false;
    for (let i = 0; i < 80; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
      if (sim.getState().rebase.rebaseCount > baseRebaseCount) {
        rebased = true;
        break;
      }
    }
    expect(rebased).toBe(true);
    const postState = sim.getState();
    expect(postState.mountainField.originOffsetX).toBeCloseTo(postState.rebase.offsetX, 8);
    expect(postState.mountainField.originOffsetY).toBeCloseTo(postState.rebase.offsetY, 8);
    expect(postState.mountainField.originOffsetZ).toBeCloseTo(postState.rebase.offsetZ, 8);
    expect(postState.mountainField.fieldRevision).toBe(preRev);

    const postGrid = createTerrainGridSampleOut(cols, rows);
    postState.mountainField.sampleColumnGrid(
      originAbsX,
      originAbsZ,
      cols,
      rows,
      stepM,
      blockOriginY,
      postGrid,
    );

    for (let i = 0; i < cols * rows; i++) {
      expect(postGrid.heights[i]!).toBeCloseTo(preGrid.heights[i]!, 3);
      expect(postGrid.macroY[i]!).toBeCloseTo(preGrid.macroY[i]!, 3);
      expect(postGrid.normals[i * 3 + 1]!).toBeCloseTo(preGrid.normals[i * 3 + 1]!, 3);
      expect(postGrid.pisteWeight[i]!).toBeCloseTo(preGrid.pisteWeight[i]!, 4);
      expect(postGrid.flags[i]!).toBe(preGrid.flags[i]!);
      expect(postGrid.primaryStageIdx[i]!).toBe(preGrid.primaryStageIdx[i]!);
    }
    sim.dispose();
  });

  it('enforces G1 delayed fork pitch divergence, G2 sibling XZ clearance, and G3 flattened IslandDivider slopes', () => {
    // G1 + G2 across 30 consecutive fork advances
    const win = new TrailWindow(8888, 'icy-black');
    const frameA = createSpineFrameOut();
    const frameB = createSpineFrameOut();
    const proj = createSpineProjectionOut();

    for (let step = 0; step < 30; step++) {
      const left = win.nextLeft!;
      const right = win.nextRight!;
      const parentEnd = win.curr.getEndPose();

      // G1: child pitch stays tightly locked to parent pitch over s in [0, 18]
      left.sampleSpineFrame(15, frameA);
      right.sampleSpineFrame(15, frameB);
      expect(Math.abs(frameA.pitchRad - parentEnd.pitchRad)).toBeLessThan(1e-4);
      expect(Math.abs(frameB.pitchRad - parentEnd.pitchRad)).toBeLessThan(1e-4);

      // G2: siblings diverge cleanly and never reconverge or cross (clear at s=85, >= +28m by s>=125)
      for (let s = 85; s <= Math.min(left.length, right.length) - 20; s += 20) {
        right.sampleSpineFrame(s, frameB);
        left.projectXZ(frameB.posX, frameB.posZ, proj);
        const dist = Math.sqrt(proj.distSq);
        expect(dist).toBeGreaterThan(frameB.halfWidth + proj.halfWidth + (s >= 125 ? 28 : 14));
      }

      const choose = step % 2 === 0 ? left : right;
      win.updateProgression(choose.id, 45);
    }

    // G3: Flattened IslandDivider slope stays <= 42 deg (normalY >= 0.74)
    const icyDef = getStageDef('icy-black')!;
    let checkedDividers = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sp = new TrailSpine({
        id: seed,
        stage: icyDef,
        seed: seed * 97,
        length: 280,
        startPosX: 0,
        startPosY: 0,
        startPosZ: 0,
        startYawRad: 0,
        startPitchRad: -0.45,
        startHalfWidth: 10,
        endHalfWidth: 20,
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
      if (!sp.divider) continue;
      checkedDividers++;
      expect(sp.divider.maxHeight).toBeLessThanOrEqual(1.36);
      expect(sp.divider.maxHalfWidth).toBeGreaterThanOrEqual(3.0);
      expect(sp.divider.maxHalfWidth).toBeLessThanOrEqual(3.8);

      const mf = new MountainField({
        elevationSpines: [sp],
        collectSpinesInBounds: (_a, _b, _c, _d, _e, out) => {
          out.length = 0;
          out.push(sp);
        },
      });
      const sample = createMountainSampleOut();
      const midS = 0.5 * (sp.divider.startS + sp.divider.endS);
      sp.sampleSpineFrame(midS, frameA);
      const rX = Math.cos(frameA.yawRad);
      const rZ = -Math.sin(frameA.yawRad);
      for (let x = -sp.divider.maxHalfWidth; x <= sp.divider.maxHalfWidth; x += 0.5) {
        mf.evaluate(frameA.posX + rX * x, frameA.posZ + rZ * x, sample);
        // Combined divider + steep icy-black pitch stays skiable (normalY >= 0.70, lateral <= 35 deg)
        expect(sample.normalY).toBeGreaterThanOrEqual(0.7);
      }
      if (checkedDividers >= 5) break;
    }
    expect(checkedDividers).toBeGreaterThanOrEqual(3);
  });

  it('enforces post-advance G2 Tier-1/Tier-2 cousin and twin clearance across 50 fork advances', () => {
    const fA = createSpineFrameOut();
    const proj = createSpineProjectionOut();

    const checkPairGroup = (spines: readonly SpineView[], checkTwins: boolean): number => {
      let overlaps = 0;
      for (let i = 0; i < spines.length; i++) {
        for (let j = i + 1; j < spines.length; j++) {
          const a = spines[i]!;
          const b = spines[j]!;
          const aPar =
            (a as { parentId?: number | null; spine?: { parentId?: number | null } }).parentId ??
            (a as { spine?: { parentId?: number | null } }).spine?.parentId ??
            null;
          const bPar =
            (b as { parentId?: number | null; spine?: { parentId?: number | null } }).parentId ??
            (b as { spine?: { parentId?: number | null } }).spine?.parentId ??
            null;
          const isTwin = a.fork.isForkChild && b.fork.isForkChild && aPar !== null && aPar === bPar;
          if (checkTwins !== isTwin) continue;

          let pairMinClear = Infinity;
          const startS = isTwin ? 70 : 15;
          for (let s = startS; s <= a.length - 10; s += 15) {
            a.sampleSpineFrame(s, fA);
            b.projectXZ(fA.posX, fA.posZ, proj);
            if (Math.abs(proj.longExt) > 15) continue;
            const clear = Math.sqrt(proj.distSq) - fA.halfWidth - proj.halfWidth;
            if (clear < pairMinClear) pairMinClear = clear;
          }
          if (pairMinClear < 0) overlaps++;
        }
      }
      return overlaps;
    };

    for (const [stage, seed] of [
      ['icy-black', 2026],
      ['sunny-blue', 1337],
      ['powder-bowl', 8888],
      ['blizzard-ridge', 4040],
      ['granite-gorge', 777],
    ] as const) {
      const win = new TrailWindow(seed, stage);
      let t1Overlaps = 0;
      let t2Overlaps = 0;
      let twinOverlaps = 0;

      for (let adv = 0; adv < 50; adv++) {
        t1Overlaps += checkPairGroup(win.horizonSpines, false);
        t2Overlaps += checkPairGroup(win.horizon2Spines, false);
        twinOverlaps += checkPairGroup(
          [win.nextLeft!, win.nextRight!, ...win.horizonSpines, ...win.horizon2Spines],
          true,
        );
        const next = adv % 2 === 0 ? win.nextLeft! : (win.nextRight ?? win.nextLeft!);
        next.sampleSpineFrame(45, fA);
        win.updateProgression(next.id, 45, 40, fA.posX, fA.posZ);
      }

      expect(t1Overlaps).toBe(0);
      expect(twinOverlaps).toBe(0);
      expect(t2Overlaps).toBeLessThanOrEqual(2);
    }
  });

  it('maintains exact tile-bounds parity (< 1e-6) across open-leaf extensions and far-field zones', () => {
    const win = new TrailWindow(2026, 'icy-black');
    const field = new MountainField(win);
    const fA = createSpineFrameOut();
    const cand: SpineView[] = [];
    let maxTileDiff = 0;

    for (let adv = 0; adv <= 5; adv++) {
      win.curr.sampleSpineFrame(100, fA);
      const cx = fA.posX;
      const cz = fA.posZ;
      for (let tx = -4; tx <= 4; tx++) {
        for (let tz = -14; tz <= 4; tz++) {
          const bx = Math.floor(cx / 64) * 64 + tx * 64;
          const bz = Math.floor(cz / 64) * 64 + tz * 64;
          field.collectSpinesInBounds(bx, bx + 64, bz, bz + 64, 310, cand);
          for (let ox = 0; ox <= 64; ox += 32) {
            for (let oz = 0; oz <= 64; oz += 32) {
              const wx = bx + ox;
              const wz = bz + oz;
              const diff = Math.abs(field.evaluateHeight(wx, wz) - field.evaluateHeight(wx, wz, cand));
              if (diff > maxTileDiff) maxTileDiff = diff;
            }
          }
        }
      }
      const next = adv % 2 === 0 ? win.nextLeft! : win.nextRight!;
      next.sampleSpineFrame(45, fA);
      win.updateProgression(next.id, 45, 40, fA.posX, fA.posZ);
    }

    expect(maxTileDiff).toBeLessThan(1e-6);
  });

  it('maintains post-advance radial 2D continuity (normalY >= 0.38) and zero 280m advance pop', () => {
    const fA = createSpineFrameOut();
    const samp = createMountainSampleOut();

    for (const [stage, seed] of [
      ['icy-black', 2026],
      ['blizzard-ridge', 4040],
      ['sunny-blue', 1337],
    ] as const) {
      const win = new TrailWindow(seed, stage);
      const field = new MountainField(win);
      let maxPop280 = 0;
      let minNormalY = 1;

      for (let adv = 0; adv < 8; adv++) {
        const chosen = adv % 2 === 0 ? win.nextLeft! : win.nextRight!;
        chosen.sampleSpineFrame(42, fA);
        const sx = fA.posX;
        const sz = fA.posZ;

        const pre: Array<{ x: number; z: number; h: number }> = [];
        for (const r of [0, 60, 120, 180, 240, 276]) {
          const n = r === 0 ? 1 : 20;
          for (let a = 0; a < n; a++) {
            const th = (a * Math.PI * 2) / n;
            const wx = sx + Math.cos(th) * r;
            const wz = sz + Math.sin(th) * r;
            pre.push({ x: wx, z: wz, h: field.evaluateHeight(wx, wz) });
          }
        }

        win.updateProgression(chosen.id, 42, 40, sx, sz);

        for (let i = 0; i < pre.length; i++) {
          const pt = pre[i]!;
          const pop = Math.abs(field.evaluateHeight(pt.x, pt.z) - pt.h);
          if (pop > maxPop280) maxPop280 = pop;
        }

        if (adv >= 4) {
          for (const seg of [win.curr, win.nextLeft!, win.nextRight!]) {
            for (let s = 20; s <= seg.length - 20; s += 30) {
              seg.sampleSpineFrame(s, fA);
              const rx = Math.cos(fA.yawRad);
              const rz = -Math.sin(fA.yawRad);
              for (let lat = -260; lat <= 260; lat += 4) {
                field.evaluate(fA.posX + rx * lat, fA.posZ + rz * lat, samp);
                expect(Number.isFinite(samp.heightY)).toBe(true);
                expect(Number.isFinite(samp.normalY)).toBe(true);
                if (samp.normalY < minNormalY) minNormalY = samp.normalY;
              }
            }
          }
        }
      }

      expect(maxPop280).toBeLessThan(0.05);
      expect(minNormalY).toBeGreaterThanOrEqual(0.38);
    }
  });

  it('maintains wide twin fork divergence and preserves native stage pitch next to gentle twins', () => {
    const fA = createSpineFrameOut();
    const fB = createSpineFrameOut();
    const proj = createSpineProjectionOut();

    const gap100: number[] = [];
    const gap180: number[] = [];
    const yawDiff120Deg: number[] = [];
    const pitchByStage = new Map<string, number[]>();
    const icyNextToGentle: number[] = [];
    const blizzardNextToGentle: number[] = [];

    for (const [stage, seed] of [
      ['icy-black', 2026],
      ['sunny-blue', 1337],
      ['powder-bowl', 8888],
      ['blizzard-ridge', 4040],
      ['granite-gorge', 777],
    ] as const) {
      const win = new TrailWindow(seed, stage);
      for (let adv = 0; adv < 25; adv++) {
        const left = win.nextLeft;
        const right = win.nextRight;
        if (left && right) {
          left.sampleSpineFrame(100, fA);
          right.projectXZ(fA.posX, fA.posZ, proj);
          gap100.push(Math.sqrt(proj.distSq) - fA.halfWidth - proj.halfWidth);

          left.sampleSpineFrame(180, fA);
          right.projectXZ(fA.posX, fA.posZ, proj);
          gap180.push(Math.sqrt(proj.distSq) - fA.halfWidth - proj.halfWidth);

          left.sampleSpineFrame(120, fA);
          right.sampleSpineFrame(120, fB);
          yawDiff120Deg.push((Math.abs(fA.yawRad - fB.yawRad) * 180) / Math.PI);

          for (const [seg, twin] of [
            [left, right],
            [right, left],
          ] as const) {
            let sumDeg = 0;
            let count = 0;
            for (let s = 80; s <= seg.length - 50; s += 20) {
              seg.sampleSpineFrame(s, fA);
              sumDeg += (-fA.pitchRad * 180) / Math.PI;
              count++;
            }
            const midRunPitch = sumDeg / count;
            let arr = pitchByStage.get(seg.stageId);
            if (!arr) {
              arr = [];
              pitchByStage.set(seg.stageId, arr);
            }
            arr.push(midRunPitch);

            const twinIsGentle =
              twin.stageId === 'powder-bowl' || twin.stageId === 'sunny-blue';
            if (seg.stageId === 'icy-black' && twinIsGentle) {
              icyNextToGentle.push(midRunPitch);
            } else if (seg.stageId === 'blizzard-ridge' && twinIsGentle) {
              blizzardNextToGentle.push(midRunPitch);
            }
          }
        }

        const next = adv % 2 === 0 ? win.nextLeft! : (win.nextRight ?? win.nextLeft!);
        next.sampleSpineFrame(45, fA);
        win.updateProgression(next.id, 45, 40, fA.posX, fA.posZ);
      }
    }

    const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sortedGap100 = [...gap100].sort((a, b) => a - b);
    const p10Gap100 = sortedGap100[Math.floor(sortedGap100.length * 0.1)]!;

    expect(gap100.length).toBeGreaterThan(0);
    expect(mean(gap100)).toBeGreaterThanOrEqual(58);
    expect(p10Gap100).toBeGreaterThanOrEqual(50);
    expect(mean(gap180)).toBeGreaterThanOrEqual(115);
    expect(mean(yawDiff120Deg)).toBeGreaterThanOrEqual(52);

    const icySamples = pitchByStage.get('icy-black') ?? [];
    const blzSamples = pitchByStage.get('blizzard-ridge') ?? [];
    const powderSamples = pitchByStage.get('powder-bowl') ?? [];
    expect(icySamples.length).toBeGreaterThan(0);
    expect(blzSamples.length).toBeGreaterThan(0);
    expect(powderSamples.length).toBeGreaterThan(0);
    expect(mean(icySamples)).toBeGreaterThanOrEqual(25.0);
    expect(mean(blzSamples)).toBeGreaterThanOrEqual(21.0);
    expect(mean(powderSamples)).toBeLessThanOrEqual(13.0);

    expect(icyNextToGentle.length).toBeGreaterThan(0);
    expect(mean(icyNextToGentle)).toBeGreaterThanOrEqual(24.5);
    expect(Math.min(...icyNextToGentle)).toBeGreaterThanOrEqual(19.0);

    expect(blizzardNextToGentle.length).toBeGreaterThan(0);
    expect(mean(blizzardNextToGentle)).toBeGreaterThanOrEqual(20.5);
    expect(Math.min(...blizzardNextToGentle)).toBeGreaterThanOrEqual(17.0);

    // Verify unchosen Tier-1 horizon ghosts restore open-leaf downstream extensions with valid dirtyRects
    // and exact incremental-vs-fresh MountainField height parity.
    const win = new TrailWindow(2026, 'icy-black');
    const field = new MountainField(win);
    field.ackDirtyRects();
    const unchosenH1 = [win.horizonSpines[2]!, win.horizonSpines[3]!];
    const h2Ids = new Set(win.horizon2Spines.map((sp) => sp.id));
    expect(h2Ids.size).toBe(8);
    expect(unchosenH1.every((sp) => !sp.macroNodes.useDownstreamExt)).toBe(true);

    win.nextLeft!.sampleSpineFrame(45, fA);
    win.updateProgression(win.nextLeft!.id, 45, 40, fA.posX, fA.posZ);

    for (const sp of unchosenH1) {
      expect(win.ghostSpines).toContain(sp);
      expect(sp.macroNodes.useDownstreamExt).toBe(true);
    }
    for (const id of h2Ids) {
      expect(win.ghostSpines.some((sp) => sp.id === id)).toBe(false);
    }
    expect(field.dirtyRects.length).toBeGreaterThan(0);
    for (const r of field.dirtyRects) {
      expect(Number.isFinite(r.minAbsX)).toBe(true);
      expect(Number.isFinite(r.maxAbsX)).toBe(true);
      expect(Number.isFinite(r.minAbsZ)).toBe(true);
      expect(Number.isFinite(r.maxAbsZ)).toBe(true);
      expect(r.minAbsX).toBeLessThanOrEqual(r.maxAbsX);
      expect(r.minAbsZ).toBeLessThanOrEqual(r.maxAbsZ);
    }

    const freshField = new MountainField(win);
    for (const sp of unchosenH1) {
      const mn = sp.macroNodes;
      const dMid = Math.floor(mn.downExtCount * 0.5);
      const wx = mn.downExtX[dMid]!;
      const wz = mn.downExtZ[dMid]!;
      expect(Math.abs(field.evaluateHeight(wx, wz) - freshField.evaluateHeight(wx, wz))).toBeLessThan(1e-10);
    }
  });
});
