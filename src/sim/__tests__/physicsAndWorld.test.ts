import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../../core/fixedLoop';
import { createMutablePlayerIntent, createSpineFrameOut, createSurfaceSample } from '../contracts';
import { SkiSimulation } from '../skiSimulation';
import { TrailWindow } from '../trailWindow';

describe('SkiPhysics, Entities, Bear, Rebase & CameraRig', () => {
  it('simulates carving, continuous downhill restoring torque without heading teleports, and ski track ring buffer', () => {
    const simAlpine = new SkiSimulation({ seed: 55, skierId: 'skier_alpine' });
    const intent = createMutablePlayerIntent();
    intent.steer = 1; // hard right carve for 60 ticks checking smooth restoring torque
    let maxStepHeadingJump = 0;
    for (let i = 0; i < 60; i++) {
      const preYaw = simAlpine.getState().currSkier.headingRad;
      simAlpine.savePreviousPoses();
      simAlpine.step(FIXED_DT, intent);
      const postYaw = simAlpine.getState().currSkier.headingRad;
      const stepDelta = Math.abs(
        Math.atan2(Math.sin(postYaw - preYaw), Math.cos(postYaw - preYaw)),
      );
      if (stepDelta > maxStepHeadingJump) maxStepHeadingJump = stepDelta;
    }

    const s1 = simAlpine.getState();
    const downhillYaw = Math.atan2(-s1.surfaceSample.tangentX, -s1.surfaceSample.tangentZ);
    const delta = Math.abs(
      Math.atan2(
        Math.sin(s1.currSkier.headingRad - downhillYaw),
        Math.cos(s1.currSkier.headingRad - downhillYaw),
      ),
    );
    // Continuous restoring torque smoothly bounds yaw within <= 115 deg with zero snap teleports
    expect(delta).toBeLessThanOrEqual((115 * Math.PI) / 180 + 1e-4);
    expect(maxStepHeadingJump).toBeLessThan((15 * Math.PI) / 180);
    expect(s1.currSkier.speed).toBeGreaterThan(10);
    expect(s1.entities.skiTracks.count).toBeGreaterThan(5);
    simAlpine.dispose();
  });

  it('reduces lateral ice drift with skier_carver iceGrip perk vs skier_alpine and handles V-wedge bumper deflection', () => {
    const simAlpine = new SkiSimulation({ seed: 10, skierId: 'skier_alpine' });
    const simCarver = new SkiSimulation({ seed: 10, skierId: 'skier_carver' });

    const setIceAndSteer = (sim: SkiSimulation): number => {
      const st = sim.getState() as unknown as {
        currSkier: {
          posX: number;
          posY: number;
          posZ: number;
          velX: number;
          velY: number;
          velZ: number;
          headingRad: number;
        };
        surfaceSample: ReturnType<typeof createSurfaceSample>;
      };
      // Set an ice patch directly on the segment so sampleSurface evaluates 'ice'
      const seg = sim.getState().trailWindow.curr as unknown as {
        patches: { s: number; x: number; radiusS: number; radiusX: number; surfaceType: 'ice' }[];
      };
      seg.patches.push({ s: 25, x: 0, radiusS: 40, radiusX: 25, surfaceType: 'ice' });

      const intent = createMutablePlayerIntent();
      intent.steer = 0.8;
      for (let i = 0; i < 45; i++) {
        sim.savePreviousPoses();
        sim.step(FIXED_DT, intent);
      }
      const post = sim.getState().currSkier;
      const rightX = Math.cos(post.headingRad);
      const rightZ = -Math.sin(post.headingRad);
      return Math.abs(post.velX * rightX + post.velZ * rightZ);
    };

    const latAlpine = setIceAndSteer(simAlpine);
    const latCarver = setIceAndSteer(simCarver);
    expect(latCarver).toBeLessThan(latAlpine);
    simAlpine.dispose();
    simCarver.dispose();

    // Test V-wedge soft bumper nose deflection near fork seam
    const simBumper = new SkiSimulation({ seed: 10 });
    const curr = simBumper.getState().trailWindow.curr;
    const fork = curr.fork;
    const internal = simBumper.getState() as unknown as {
      currSkier: { posX: number; posY: number; posZ: number; velX: number; velZ: number };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
    };
    const rightX = Math.cos(fork.seamYawRad);
    const rightZ = -Math.sin(fork.seamYawRad);
    internal.currSkier.posX = fork.seamWorldX - rightX * 0.4;
    internal.currSkier.posY = fork.seamWorldY;
    internal.currSkier.posZ = fork.seamWorldZ - rightZ * 0.4;
    internal.surfaceSample.segmentId = curr.id;
    internal.surfaceSample.s = curr.length;

    const zeroIntent = createMutablePlayerIntent();
    simBumper.savePreviousPoses();
    simBumper.step(FIXED_DT, zeroIntent);
    const distFromNose = Math.hypot(
      simBumper.getState().currSkier.posX - fork.seamWorldX,
      simBumper.getState().currSkier.posZ - fork.seamWorldZ,
    );
    expect(distFromNose).toBeGreaterThanOrEqual(fork.seamNoseRadius);
    simBumper.dispose();
  });

  it('supports scoreAttack lives decrement and gameOver on repeated wipeouts', () => {
    const sim = new SkiSimulation({ seed: 12, gameMode: 'scoreAttack' });
    const intent = createMutablePlayerIntent();

    for (let hit = 0; hit < 3; hit++) {
      const state = sim.getState();
      const hazards = state.entities.hazards;
      let idx = -1;
      for (let i = 0; i < hazards.count; i++) {
        if (hazards.triggered[i] === 0 && hazards.defIds[i] === 'pine_tree') {
          idx = i;
          break;
        }
      }
      expect(idx).toBeGreaterThanOrEqual(0);
      const internal = state as unknown as {
        currSkier: { posX: number; posY: number; posZ: number };
        surfaceSample: ReturnType<typeof createSurfaceSample>;
        invulnerableTimerSec: number;
      };
      internal.invulnerableTimerSec = 0;
      const hx = hazards.posX[idx]!;
      const hy = hazards.posY[idx]!;
      const hz = hazards.posZ[idx]!;
      const sHaz = sim.sampleSurface(hx, hz);
      internal.currSkier.posX = hx;
      internal.currSkier.posY = hy;
      internal.currSkier.posZ = hz;
      internal.surfaceSample.segmentId = sHaz.segmentId;
      internal.surfaceSample.s = sHaz.s;

      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
      for (let t = 0; t < 80; t++) {
        sim.savePreviousPoses();
        sim.step(FIXED_DT, intent);
      }
    }

    expect(sim.getState().livesRemaining).toBe(0);
    expect(sim.getState().gameOver).toBe(true);
    sim.dispose();
  });

  it('launches into true 3D ballistic airtime on jumps and clears low hazards when airborne', () => {
    const sim = new SkiSimulation({ seed: 88 });
    const intent = createMutablePlayerIntent();

    // Build downhill speed first
    for (let i = 0; i < 40; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }

    // Trigger jump
    intent.jumpPressed = true;
    sim.savePreviousPoses();
    sim.step(FIXED_DT, intent);
    intent.jumpPressed = false;

    let peakClearance = 0;
    for (let i = 0; i < 45; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
      const st = sim.getState();
      const clearance = st.currSkier.posY - st.currSkier.groundY;
      if (clearance > peakClearance) peakClearance = clearance;
    }

    // Standard ollie clears boulder_small (height = 0.72m) cleanly
    expect(peakClearance).toBeGreaterThan(0.8);

    // Verify ski tracks contain an airborne break (grounded === 0)
    const tracks = sim.getState().entities.skiTracks;
    let sawBreak = false;
    for (let i = 0; i < tracks.count; i++) {
      const slot = (tracks.head - tracks.count + i + tracks.capacity) % tracks.capacity;
      if (tracks.grounded[slot] === 0) {
        sawBreak = true;
        break;
      }
    }
    expect(sawBreak).toBe(true);
    sim.dispose();
  });

  it('launches off explicit ski ramps in RampPoolView and populates pitchRad & defIds', () => {
    // Find a seed whose icy-black or sunny-blue spawn has a ramp on segment 1
    let sim: SkiSimulation | null = null;
    let rampIdx = -1;
    for (let seed = 1; seed < 40; seed++) {
      const candidate = new SkiSimulation({ seed, startStageId: 'icy-black' });
      const ramps = candidate.getState().entities.ramps;
      if (ramps.count > 0) {
        sim = candidate;
        rampIdx = 0;
        break;
      }
      candidate.dispose();
    }
    expect(sim).not.toBeNull();
    const state = sim!.getState();
    const ramps = state.entities.ramps;
    expect(ramps.defIds[rampIdx]).toBe('ski_ramp_standard');
    expect(ramps.pitchRad[rampIdx]!).toBeLessThan(0);

    // Position skier just upstream of ramp entry aligned with ramp yaw
    const rx = ramps.posX[rampIdx]!;
    const rz = ramps.posZ[rampIdx]!;
    const ryaw = ramps.yawRad[rampIdx]!;
    const fwdX = -Math.sin(ryaw);
    const fwdZ = -Math.cos(ryaw);

    const internal = state as unknown as {
      currSkier: {
        posX: number;
        posY: number;
        posZ: number;
        velX: number;
        velY: number;
        velZ: number;
        headingRad: number;
        grounded: boolean;
      };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
    };

    const startX = rx - fwdX * 6;
    const startZ = rz - fwdZ * 6;
    const s = sim!.sampleSurface(startX, startZ);
    internal.currSkier.posX = startX;
    internal.currSkier.posY = s.groundY;
    internal.currSkier.posZ = startZ;
    internal.currSkier.headingRad = ryaw;
    internal.currSkier.velX = fwdX * 26;
    internal.currSkier.velZ = fwdZ * 26;
    internal.currSkier.velY = s.tangentY * 26;
    internal.currSkier.grounded = true;
    internal.surfaceSample.segmentId = s.segmentId;
    internal.surfaceSample.s = s.s;

    const intent = createMutablePlayerIntent();
    let maxAirClearance = 0;
    for (let i = 0; i < 70; i++) {
      sim!.savePreviousPoses();
      sim!.step(FIXED_DT, intent);
      const st = sim!.getState();
      const clr = st.currSkier.posY - st.currSkier.groundY;
      if (clr > maxAirClearance) maxAirClearance = clr;
    }

    expect(maxAirClearance).toBeGreaterThan(2.2);
    sim!.dispose();
  });

  it('collects presents, auto-tosses at Delivery Zones with combo, and triggers Wipeout-and-Recover onto safeX', () => {
    const sim = new SkiSimulation({ seed: 12 });
    const events: string[] = [];
    sim.eventBus.on('PRESENT_PICKED_UP', () => events.push('pickup'));
    sim.eventBus.on('PRESENT_DELIVERED', () => events.push('deliver'));
    sim.eventBus.on('PLAYER_WIPEOUT', () => events.push('wipeout'));
    sim.eventBus.on('PLAYER_RECOVERED', () => events.push('recover'));

    const state = sim.getState();
    const internal = state as unknown as {
      currSkier: {
        posX: number;
        posY: number;
        posZ: number;
        velX: number;
        velY: number;
        velZ: number;
      };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
    };

    // Move directly over first present
    const presents = state.entities.presents;
    expect(presents.count).toBeGreaterThan(0);
    const px = presents.posX[0]!;
    const py = presents.posY[0]!;
    const pz = presents.posZ[0]!;
    const sPres = sim.sampleSurface(px, pz);
    internal.currSkier.posX = px;
    internal.currSkier.posY = py;
    internal.currSkier.posZ = pz;
    internal.surfaceSample.segmentId = sPres.segmentId;
    internal.surfaceSample.s = sPres.s;

    const intent = createMutablePlayerIntent();
    sim.savePreviousPoses();
    sim.step(FIXED_DT, intent);
    expect(sim.getState().carriedCount).toBeGreaterThanOrEqual(1);
    expect(events).toContain('pickup');

    // Move directly into first active Delivery Zone
    const zones = state.entities.deliveryZones;
    expect(zones.count).toBeGreaterThan(0);
    const zx = zones.posX[0]!;
    const zy = zones.posY[0]!;
    const zz = zones.posZ[0]!;
    const sZone = sim.sampleSurface(zx, zz);
    internal.currSkier.posX = zx;
    internal.currSkier.posY = zy;
    internal.currSkier.posZ = zz;
    internal.surfaceSample.segmentId = sZone.segmentId;
    internal.surfaceSample.s = sZone.s;

    sim.savePreviousPoses();
    sim.step(FIXED_DT, intent);
    expect(sim.getState().carriedCount).toBe(0);
    expect(sim.getState().deliveredTotal).toBeGreaterThanOrEqual(1);
    expect(sim.getState().comboMultiplier).toBeGreaterThan(1);
    expect(sim.getState().comboDurationSec).toBeGreaterThan(0);
    expect(sim.getState().entities.tossedPresents.count).toBeGreaterThanOrEqual(1);
    expect(events).toContain('deliver');

    // Pick up another present and collide with a lethal hazard
    if (presents.count > 1 && presents.collected[1] === 0) {
      internal.currSkier.posX = presents.posX[1]!;
      internal.currSkier.posY = presents.posY[1]!;
      internal.currSkier.posZ = presents.posZ[1]!;
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }

    const hazards = state.entities.hazards;
    let lethalIdx = -1;
    for (let i = 0; i < hazards.count; i++) {
      if (hazards.defIds[i] === 'pine_tree' || hazards.defIds[i] === 'boulder_large') {
        lethalIdx = i;
        expect(hazards.normalY[i]!).toBeGreaterThan(0.5);
        break;
      }
    }
    expect(lethalIdx).toBeGreaterThanOrEqual(0);

    const hx = hazards.posX[lethalIdx]!;
    const hy = hazards.posY[lethalIdx]!;
    const hz = hazards.posZ[lethalIdx]!;
    const sHaz = sim.sampleSurface(hx, hz);
    internal.currSkier.posX = hx;
    internal.currSkier.posY = hy;
    internal.currSkier.posZ = hz;
    internal.surfaceSample.segmentId = sHaz.segmentId;
    internal.surfaceSample.s = sHaz.s;

    sim.savePreviousPoses();
    sim.step(FIXED_DT, intent);
    expect(sim.getState().skierState).toBe('wipeout');
    expect(sim.getState().comboCount).toBe(0);
    expect(events).toContain('wipeout');

    // Advance through recovery duration
    for (let i = 0; i < 90; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }
    expect(sim.getState().skierState).toBe('skiing');
    expect(sim.getState().invulnerableTimerSec).toBeGreaterThan(0);
    expect(events).toContain('recover');
    sim.dispose();
  });

  it('telegraphs and patrols Bear seamlessly in world space with normals populated', () => {
    let sim: SkiSimulation | null = null;
    for (let seed = 1; seed < 30; seed++) {
      const candidate = new SkiSimulation({ seed, startStageId: 'icy-black' });
      if (candidate.getState().entities.creatures.count > 0) {
        sim = candidate;
        break;
      }
      candidate.dispose();
    }
    expect(sim).not.toBeNull();
    let telegraphed = false;
    sim!.eventBus.on('CREATURE_TELEGRAPH', (ev) => {
      expect(ev.creatureDefId).toBe('bear_patrol');
      telegraphed = true;
    });

    const state = sim!.getState();
    const creatures = state.entities.creatures;
    expect(creatures.normalY[0]!).toBeGreaterThan(0.5);

    // Move skier within warningRange of the first Bear
    const bx = creatures.posX[0]!;
    const bz = creatures.posZ[0]!;
    const sBear = sim!.sampleSurface(bx, bz + 20);
    const internal = state as unknown as {
      currSkier: { posX: number; posY: number; posZ: number };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
    };
    internal.currSkier.posX = bx;
    internal.currSkier.posY = sBear.groundY;
    internal.currSkier.posZ = bz + 20;
    internal.surfaceSample.segmentId = sBear.segmentId;
    internal.surfaceSample.s = sBear.s;

    const intent = createMutablePlayerIntent();
    const initX = creatures.posX[0]!;
    for (let i = 0; i < 90; i++) {
      sim!.savePreviousPoses();
      sim!.step(FIXED_DT, intent);
      // Keep skier near bear's lane to avoid outrunning it during test
      internal.currSkier.posX = creatures.posX[0]!;
      internal.currSkier.posZ = creatures.posZ[0]! + 25;
    }

    expect(telegraphed).toBe(true);
    expect(Math.abs(creatures.posX[0]! - initX)).toBeGreaterThan(0.5);
    expect(creatures.normalY[0]!).toBeGreaterThan(0.5);

    // Place a Bear just upstream of the fork seam and confirm it crosses seamlessly onto child segment
    const curr = state.trailWindow.curr;
    const fork = curr.fork;
    const fwdX = -Math.sin(fork.seamYawRad);
    const fwdZ = -Math.cos(fork.seamYawRad);
    const rightX = Math.cos(fork.seamYawRad);
    const rightZ = -Math.sin(fork.seamYawRad);
    const cPool = state.entities.creatures as unknown as {
      posX: Float32Array;
      posY: Float32Array;
      posZ: Float32Array;
      hintSegId: Int32Array;
      hintS: Float32Array;
      segmentIds: Int32Array;
      stateCode: Uint8Array;
      patrolDir: Int8Array;
    };
    cPool.posX[0] = fork.seamWorldX - fwdX * 0.4 - rightX * 3.0;
    cPool.posY[0] = fork.seamWorldY;
    cPool.posZ[0] = fork.seamWorldZ - fwdZ * 0.4 - rightZ * 3.0;
    cPool.hintSegId[0] = curr.id;
    cPool.hintS[0] = curr.length - 0.4;
    cPool.segmentIds[0] = curr.id;
    cPool.stateCode[0] = 2; // CREATURE_PHASE_ATTACK
    cPool.patrolDir[0] = -1;

    // Position skier within the 85m creature active range upstream of the fork seam
    const skierForkX = fork.seamWorldX - fwdX * 50;
    const skierForkZ = fork.seamWorldZ - fwdZ * 50;
    const sNearFork = sim!.sampleSurface(skierForkX, skierForkZ, curr.id, curr.length - 50);
    internal.currSkier.posX = skierForkX;
    internal.currSkier.posY = sNearFork.groundY;
    internal.currSkier.posZ = skierForkZ;
    internal.surfaceSample.segmentId = sNearFork.segmentId;
    internal.surfaceSample.s = sNearFork.s;

    for (let i = 0; i < 60; i++) {
      sim!.savePreviousPoses();
      sim!.step(FIXED_DT, intent);
    }
    expect(cPool.segmentIds[0]).toBe(state.trailWindow.nextLeft!.id);
    expect(creatures.normalY[0]!).toBeGreaterThan(0.5);
    sim!.dispose();
  });

  it('performs translation-only 128m floating-origin rebase without pose discontinuity', () => {
    const sim = new SkiSimulation({ seed: 314, debugDrawEnabled: true });
    const rebasedEvents: { rebaseCount: number; deltaZ: number }[] = [];
    sim.eventBus.on('WORLD_REBASED', (ev) => {
      rebasedEvents.push({ rebaseCount: ev.rebaseCount, deltaZ: ev.deltaZ });
    });

    const intent = createMutablePlayerIntent();
    let sawRebase = false;
    for (let i = 0; i < 1500; i++) {
      const pre = sim.getState();
      const targetX = pre.trailWindow.curr.sampleSafeX(pre.surfaceSample.s + 10);
      intent.steer = Math.max(-1, Math.min(1, (targetX - pre.surfaceSample.x) * 0.12));

      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
      const st = sim.getState();

      if (st.rebase.rebaseCount > 0 && !sawRebase) {
        sawRebase = true;
        // Verify prevSkier and currSkier shifted together (no 128m interpolation jump)
        const dz = Math.abs(st.currSkier.posZ - st.prevSkier.posZ);
        expect(dz).toBeLessThan(2.0);
        const camDz = Math.abs(st.currCamera.posZ - st.prevCamera.posZ);
        expect(camDz).toBeLessThan(2.0);
        expect(Math.abs(st.currSkier.posZ)).toBeLessThan(128);
        expect(st.debugDraw.enabled).toBe(true);
        expect(st.debugDraw.safePathPointCount).toBeGreaterThan(0);
        expect(st.debugDraw.colliderCount).toBeGreaterThan(0);
        break;
      }
    }

    expect(sawRebase).toBe(true);
    expect(rebasedEvents.length).toBeGreaterThanOrEqual(1);
    expect(sim.getState().rebase.offsetZ).toBeLessThan(0); // Skied toward -Z
    sim.dispose();
  });

  it('updates CameraRig with responsive minHorizontalFovDeg, speed FOV boost, and blizzard fog floor >= 65m', () => {
    const sim = new SkiSimulation({ seed: 9 });
    sim.setBlizzardEnabled(true);
    const intent = createMutablePlayerIntent();

    for (let i = 0; i < 120; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }

    const st = sim.getState();
    expect(st.currCamera.minHorizontalFovDeg).toBeGreaterThanOrEqual(70);
    expect(st.currCamera.speedFovBoostDeg).toBeGreaterThan(0);
    expect(st.activeWeather.blizzardEnabled).toBe(true);
    expect(st.activeWeather.fogDistanceM).toBeGreaterThanOrEqual(65);
    expect(st.activeWeather.blizzardDim).toBeGreaterThan(0.2);
    sim.dispose();
  });

  it('keeps chase camera above terrain with front-facing normals on both sunny-blue and icy-black slopes', () => {
    const intent = createMutablePlayerIntent();
    const camSurfOut = createSurfaceSample();

    for (const stageId of ['sunny-blue', 'icy-black'] as const) {
      const sim = new SkiSimulation({ seed: 1337, startStageId: stageId });
      for (let tick = 0; tick < 600; tick++) {
        sim.savePreviousPoses();
        sim.step(FIXED_DT, intent);
        const st = sim.getState();
        const cam = st.currCamera;
        const sk = st.currSkier;
        const camSurf = sim.sampleSurface(
          cam.posX,
          cam.posZ,
          st.surfaceSample.segmentId,
          Math.max(0, st.surfaceSample.s - 10),
          camSurfOut,
        );
        expect(cam.posY - camSurf.groundY).toBeGreaterThanOrEqual(1.9);

        const toCamX = cam.posX - sk.posX;
        const toCamY = cam.posY - sk.posY;
        const toCamZ = cam.posZ - sk.posZ;
        const len = Math.hypot(toCamX, toCamY, toCamZ);
        expect(len).toBeGreaterThan(1e-3);
        const dot = (sk.normalX * toCamX + sk.normalY * toCamY + sk.normalZ * toCamZ) / len;
        expect(dot).toBeGreaterThan(0.1);
      }
      sim.dispose();
    }
  });

  it('allows open-mountain off-piste carving > 35m past corridor walls and off-piste fork branch switching/progression', () => {
    const sim = new SkiSimulation({ seed: 55, startStageId: 'sunny-blue' });
    const intent = createMutablePlayerIntent();
    intent.steer = 1; // carve right off-piste continuously

    let maxAbsX = 0;
    let sawOffPiste = false;
    for (let i = 0; i < 240; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
      const st = sim.getState();
      const absX = Math.abs(st.surfaceSample.x);
      if (absX > maxAbsX) maxAbsX = absX;
      if (!st.surfaceSample.onPiste) {
        sawOffPiste = true;
        const fieldH = st.mountainField.evaluateHeight(st.currSkier.posX, st.currSkier.posZ);
        expect(st.surfaceSample.groundY).toBeCloseTo(fieldH, 3);
      }
    }

    // Legacy corridor wall clamped at halfWidth + skirtWidth (~28m); open-mountain allows free travel
    expect(maxAbsX).toBeGreaterThan(35);
    expect(sawOffPiste).toBe(true);
    sim.dispose();

    // Pre-commit fork branch switching & progression while far off-piste (no safeX rail)
    const forkSim = new SkiSimulation({ seed: 777, startStageId: 'sunny-blue' });
    const fState = forkSim.getState();
    const curr = fState.trailWindow.curr;
    const nextLeft = fState.trailWindow.nextLeft!;
    const nextRight = fState.trailWindow.nextRight!;
    const fork = curr.fork;
    const fwdX = -Math.sin(fork.seamYawRad);
    const fwdZ = -Math.cos(fork.seamYawRad);
    const rightX = Math.cos(fork.seamYawRad);
    const rightZ = -Math.sin(fork.seamYawRad);

    // 15m past seam, 38m left off-piste -> resolves to nextLeft; 38m right -> resolves to nextRight
    const offLeft = forkSim.sampleSurface(
      fork.seamWorldX + fwdX * 15 - rightX * 38,
      fork.seamWorldZ + fwdZ * 15 - rightZ * 38,
      nextRight.id,
      15,
    );
    expect(offLeft.segmentId).toBe(nextLeft.id);
    expect(offLeft.onPiste).toBe(false);

    const offRight = forkSim.sampleSurface(
      fork.seamWorldX + fwdX * 15 + rightX * 38,
      fork.seamWorldZ + fwdZ * 15 + rightZ * 38,
      nextLeft.id,
      15,
    );
    expect(offRight.segmentId).toBe(nextRight.id);
    expect(offRight.onPiste).toBe(false);

    // Advance skier off-piste past 40m prune threshold -> TrailWindow promotes chosen branch
    let forkEntered = false;
    forkSim.eventBus.on('FORK_ENTERED', () => {
      forkEntered = true;
    });
    const internal = fState as unknown as {
      currSkier: {
        posX: number;
        posY: number;
        posZ: number;
        velX: number;
        velY: number;
        velZ: number;
        headingRad: number;
      };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
    };
    const startOffX = fork.seamWorldX + fwdX * 45 + rightX * 32;
    const startOffZ = fork.seamWorldZ + fwdZ * 45 + rightZ * 32;
    const sStart = forkSim.sampleSurface(startOffX, startOffZ, curr.id, curr.length);
    internal.currSkier.posX = startOffX;
    internal.currSkier.posY = sStart.groundY;
    internal.currSkier.posZ = startOffZ;
    internal.currSkier.headingRad = fork.seamYawRad;
    internal.currSkier.velX = fwdX * 18;
    internal.currSkier.velY = -4;
    internal.currSkier.velZ = fwdZ * 18;
    internal.surfaceSample.segmentId = sStart.segmentId;
    internal.surfaceSample.s = sStart.s;

    const zeroIntent = createMutablePlayerIntent();
    forkSim.savePreviousPoses();
    forkSim.step(FIXED_DT, zeroIntent);
    expect(forkEntered).toBe(true);
    expect(forkSim.getState().trailWindow.curr.id).toBe(nextRight.id);
    forkSim.dispose();

    // Explicitly verify left-branch off-piste updateProgression (activeSegmentId still curr.id) promotes horizonLL/horizonLR cleanly
    const leftWin = new TrailWindow(777, 'sunny-blue');
    const lCurr = leftWin.curr;
    const expectedChosenLeft = leftWin.nextLeft!;
    const expectedHorizonLL = leftWin.horizonSpines[0]!;
    const expectedHorizonLR = leftWin.horizonSpines[1]!;
    const lFork = lCurr.fork;
    const lFwdX = -Math.sin(lFork.seamYawRad);
    const lFwdZ = -Math.cos(lFork.seamYawRad);
    const lRightX = Math.cos(lFork.seamYawRad);
    const lRightZ = -Math.sin(lFork.seamYawRad);
    const offAdvanceLeft = leftWin.updateProgression(
      lCurr.id,
      lCurr.length,
      40,
      lFork.seamWorldX + lFwdX * 45 - lRightX * 32,
      lFork.seamWorldZ + lFwdZ * 45 - lRightZ * 32,
    );
    expect(offAdvanceLeft.forkEntered?.chosenSide).toBe('left');
    expect(leftWin.curr.id).toBe(expectedChosenLeft.id);
    expect(leftWin.nextLeft!.spine).toBe(expectedHorizonLL);
    expect(leftWin.nextRight!.spine).toBe(expectedHorizonLR);
    const chosenEnd = expectedChosenLeft.getEndPose();
    const childLeftStart = createSpineFrameOut();
    leftWin.nextLeft!.sampleSpineFrame(0, childLeftStart);
    expect(Math.hypot(childLeftStart.posX - chosenEnd.posX, childLeftStart.posZ - chosenEnd.posZ)).toBeLessThan(
      chosenEnd.halfWidth + 1.0,
    );
  });

  it('triggers chasm_fall even while invulnerable, falls continuously with gravity, and recovers onto safeX without prevSkier ghosting', () => {
    const sim = new SkiSimulation({ seed: 100, startStageId: 'icy-black', skierId: 'skier_alpine' });
    const state = sim.getState();
    const curr = state.trailWindow.curr;
    const frame = createSpineFrameOut();
    curr.sampleSpineFrame(120, frame);
    const rightX = Math.cos(frame.yawRad);
    const rightZ = -Math.sin(frame.yawRad);

    // Right side on icy-black is 'chasm' (chasmWipeoutDepth = 22m, reliefScale = 34m)
    let chasmX = 0;
    let chasmZ = 0;
    let chasmSample = createSurfaceSample();
    let foundDeepChasm = false;
    for (let s = 40; s <= 220 && !foundDeepChasm; s += 20) {
      curr.sampleSpineFrame(s, frame);
      const rightX = Math.cos(frame.yawRad);
      const rightZ = -Math.sin(frame.yawRad);
      for (let off = 24; off <= 56; off += 8) {
        const cx = frame.posX + rightX * (frame.halfWidth + off);
        const cz = frame.posZ + rightZ * (frame.halfWidth + off);
        const sample = sim.sampleSurface(cx, cz, curr.id, s);
        if (
          sample.inChasmZone &&
          sample.nearestSpineY - sample.groundY >= sample.chasmWipeoutDepth + 3.0
        ) {
          chasmX = cx;
          chasmZ = cz;
          chasmSample = sample;
          foundDeepChasm = true;
          break;
        }
      }
    }
    expect(foundDeepChasm).toBe(true);
    expect(chasmSample.chasmWipeoutDepth).toBe(22);

    const wipeouts: string[] = [];
    let recovered = false;
    sim.eventBus.on('PLAYER_WIPEOUT', (ev) => wipeouts.push(ev.hazardId));
    sim.eventBus.on('PLAYER_RECOVERED', () => {
      recovered = true;
    });

    const internal = state as unknown as {
      currSkier: {
        posX: number;
        posY: number;
        posZ: number;
        velX: number;
        velY: number;
        velZ: number;
        grounded: boolean;
      };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
      invulnerableTimerSec: number;
    };

    // Place skier airborne just past chasmWipeoutDepth (with >= 2.5m drop remaining) while invulnerable
    internal.invulnerableTimerSec = 2.0;
    internal.currSkier.posX = chasmX;
    internal.currSkier.posZ = chasmZ;
    internal.currSkier.posY = chasmSample.nearestSpineY - (chasmSample.chasmWipeoutDepth + 0.5);
    expect(internal.currSkier.posY - chasmSample.groundY).toBeGreaterThan(2.0);
    internal.currSkier.velX = 0;
    internal.currSkier.velY = -4;
    internal.currSkier.velZ = -4;
    internal.currSkier.grounded = false;
    internal.surfaceSample.segmentId = chasmSample.segmentId;
    internal.surfaceSample.s = chasmSample.s;

    const intent = createMutablePlayerIntent();
    sim.savePreviousPoses();
    sim.step(FIXED_DT, intent);

    expect(wipeouts).toEqual(['chasm_fall']);
    expect(state.skierState).toBe('wipeout');
    // Gravity integration: did NOT snap instantly down to chasm floor on tick 1
    expect(state.currSkier.posY).toBeGreaterThan(state.currSkier.groundY + 1.0);

    // Step through tumble recovery and verify prevSkier/currSkier snap onto safeX with no ghosting
    let sawRecover = false;
    for (let i = 0; i < 120; i++) {
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
      if (recovered && !sawRecover) {
        sawRecover = true;
        expect(state.skierState).toBe('skiing');
        expect(state.surfaceSample.onPiste).toBe(true);
        const safeX = curr.sampleSafeX(state.surfaceSample.s);
        expect(Math.abs(state.surfaceSample.x - safeX)).toBeLessThan(1.5);
        expect(state.prevSkier.posX).toBeCloseTo(state.currSkier.posX, 6);
        expect(state.prevSkier.posY).toBeCloseTo(state.currSkier.posY, 6);
        expect(state.prevSkier.posZ).toBeCloseTo(state.currSkier.posZ, 6);
        const camSurf = sim.sampleSurface(state.currCamera.posX, state.currCamera.posZ);
        expect(state.currCamera.posY - camSurf.groundY).toBeGreaterThanOrEqual(1.9);
        break;
      }
    }
    expect(sawRecover).toBe(true);
    sim.dispose();
  });

  it('slows steep canyon uphill climbs without uphill brake thrust or zero-clamp stall, and recovers skiable off-piste wipeouts locally', () => {
    // 1. Uphill brake & gravity slide-back on icy-black left canyonWalls
    const wallSim = new SkiSimulation({ seed: 100, startStageId: 'icy-black' });
    const wState = wallSim.getState();
    const frame = createSpineFrameOut();
    wState.trailWindow.curr.sampleSpineFrame(120, frame);
    const rightX = Math.cos(frame.yawRad);
    const rightZ = -Math.sin(frame.yawRad);

    // Find a steep skiable canyon wall column on the left side facing uphill into the wall
    let wallX = frame.posX - rightX * 32;
    let wallZ = frame.posZ - rightZ * 32;
    let wallSample = wallSim.sampleSurface(wallX, wallZ, wState.trailWindow.curr.id, 120);
    for (let d = 24; d <= 52; d += 2) {
      const cx = frame.posX - rightX * d;
      const cz = frame.posZ - rightZ * d;
      const s = wallSim.sampleSurface(cx, cz, wState.trailWindow.curr.id, 120);
      if (s.normalY < 0.78 && s.normalY >= 0.64) {
        wallX = cx;
        wallZ = cz;
        wallSample = s;
        break;
      }
    }
    const fallLineYaw = Math.atan2(-wallSample.fallLineX, -wallSample.fallLineZ);
    // Point nose-up into the canyon wall (opposite to true local fall-line descent)
    const wallHeading = Math.atan2(wallSample.fallLineX, wallSample.fallLineZ) - 0.35;
    const hFwdX = -Math.sin(wallHeading);
    const hFwdZ = -Math.cos(wallHeading);

    const wInternal = wState as unknown as {
      currSkier: {
        posX: number;
        posY: number;
        posZ: number;
        velX: number;
        velY: number;
        velZ: number;
        headingRad: number;
        grounded: boolean;
      };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
    };
    wInternal.currSkier.posX = wallX;
    wInternal.currSkier.posZ = wallZ;
    wInternal.currSkier.posY = wallSample.groundY;
    wInternal.currSkier.headingRad = wallHeading;
    wInternal.currSkier.velX = hFwdX * 2.0;
    wInternal.currSkier.velY = 0;
    wInternal.currSkier.velZ = hFwdZ * 2.0;
    wInternal.currSkier.grounded = true;
    wInternal.surfaceSample.segmentId = wallSample.segmentId;
    wInternal.surfaceSample.s = wallSample.s;

    // Braking slowly at low speed on steep terrain must decelerate toward 0, never boost to 4.5 m/s
    const brakeIntent = createMutablePlayerIntent();
    brakeIntent.brake = true;
    wallSim.savePreviousPoses();
    wallSim.step(FIXED_DT, brakeIntent);
    const postBrakeFwd =
      wState.currSkier.velX * -Math.sin(wState.currSkier.headingRad) +
      wState.currSkier.velZ * -Math.cos(wState.currSkier.headingRad);
    expect(postBrakeFwd).toBeLessThan(2.0);

    // Without braking, uphill stall pivots heading toward true local fallLine down the canyon wall
    const preHeadingErr = Math.abs(
      Math.atan2(
        Math.sin(wState.currSkier.headingRad - fallLineYaw),
        Math.cos(wState.currSkier.headingRad - fallLineYaw),
      ),
    );
    const freeIntent = createMutablePlayerIntent();
    for (let i = 0; i < 30; i++) {
      wallSim.savePreviousPoses();
      wallSim.step(FIXED_DT, freeIntent);
    }
    const postFallYaw = Math.atan2(-wState.surfaceSample.fallLineX, -wState.surfaceSample.fallLineZ);
    const postHeadingErr = Math.abs(
      Math.atan2(
        Math.sin(wState.currSkier.headingRad - postFallYaw),
        Math.cos(wState.currSkier.headingRad - postFallYaw),
      ),
    );
    expect(postHeadingErr).toBeLessThan(preHeadingErr);
    wallSim.dispose();

    // 2. Normal skiable off-piste wipeout recovers locally in place (sunny-blue, normalY >= 0.72)
    const offSim = new SkiSimulation({ seed: 12, startStageId: 'sunny-blue' });
    const oState = offSim.getState();
    const oFrame = createSpineFrameOut();
    oState.trailWindow.curr.sampleSpineFrame(80, oFrame);
    const oRightX = Math.cos(oFrame.yawRad);
    const oRightZ = -Math.sin(oFrame.yawRad);
    const offX = oFrame.posX + oRightX * 32;
    const offZ = oFrame.posZ + oRightZ * 32;
    const offSurf = offSim.sampleSurface(offX, offZ, oState.trailWindow.curr.id, 80);
    expect(offSurf.onPiste).toBe(false);
    expect(offSurf.inChasmZone).toBe(false);
    expect(offSurf.normalY).toBeGreaterThanOrEqual(0.72);

    let recoveredLocal = false;
    offSim.eventBus.on('PLAYER_RECOVERED', () => {
      recoveredLocal = true;
    });

    const oInternal = oState as unknown as {
      currSkier: {
        posX: number;
        posY: number;
        posZ: number;
        velX: number;
        velY: number;
        velZ: number;
        grounded: boolean;
      };
      surfaceSample: ReturnType<typeof createSurfaceSample>;
      skierState: 'skiing' | 'wipeout' | 'recovering';
      wipeoutTimerSec: number;
    };
    oInternal.currSkier.posX = offX;
    oInternal.currSkier.posZ = offZ;
    oInternal.currSkier.posY = offSurf.groundY;
    oInternal.currSkier.velX = 0;
    oInternal.currSkier.velY = 0;
    oInternal.currSkier.velZ = 0;
    oInternal.currSkier.grounded = true;
    oInternal.surfaceSample.segmentId = offSurf.segmentId;
    oInternal.surfaceSample.s = offSurf.s;
    oInternal.surfaceSample.onPiste = offSurf.onPiste;
    oInternal.surfaceSample.inChasmZone = offSurf.inChasmZone;
    oInternal.surfaceSample.normalY = offSurf.normalY;
    oInternal.skierState = 'wipeout';
    oInternal.wipeoutTimerSec = 0.04;

    const zeroIntent = createMutablePlayerIntent();
    for (let i = 0; i < 6 && !recoveredLocal; i++) {
      offSim.savePreviousPoses();
      offSim.step(FIXED_DT, zeroIntent);
    }
    expect(recoveredLocal).toBe(true);
    expect(oState.skierState).toBe('skiing');
    expect(oState.surfaceSample.onPiste).toBe(false);
    expect(Math.hypot(oState.currSkier.posX - offX, oState.currSkier.posZ - offZ)).toBeLessThan(3.0);
    offSim.dispose();
  });
});
