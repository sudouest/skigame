import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../../core/fixedLoop';
import { createMutablePlayerIntent, createSurfaceSample } from '../contracts';
import { SkiSimulation } from '../skiSimulation';

describe('SkiPhysics, Entities, Bear, Rebase & CameraRig', () => {
  it('simulates carving, +/-80 deg downhill heading clamp, ice perk, and ski track ring buffer', () => {
    const simAlpine = new SkiSimulation({ seed: 55, skierId: 'skier_alpine' });
    const intent = createMutablePlayerIntent();
    intent.steer = 1; // hard right carve for 50 ticks then hold downhill check
    for (let i = 0; i < 60; i++) {
      simAlpine.savePreviousPoses();
      simAlpine.step(FIXED_DT, intent);
    }

    const s1 = simAlpine.getState();
    const downhillYaw = Math.atan2(-s1.surfaceSample.tangentX, -s1.surfaceSample.tangentZ);
    const delta = Math.abs(
      Math.atan2(
        Math.sin(s1.currSkier.headingRad - downhillYaw),
        Math.cos(s1.currSkier.headingRad - downhillYaw),
      ),
    );
    expect(delta).toBeLessThanOrEqual((80 * Math.PI) / 180 + 1e-4);
    expect(s1.currSkier.speed).toBeGreaterThan(10);
    expect(s1.entities.skiTracks.count).toBeGreaterThan(5);
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
  });

  it('telegraphs and patrols Bear seamlessly in world space with normals populated', () => {
    let sim: SkiSimulation | null = null;
    for (let seed = 1; seed < 30; seed++) {
      const candidate = new SkiSimulation({ seed, startStageId: 'icy-black' });
      if (candidate.getState().entities.creatures.count > 0) {
        sim = candidate;
        break;
      }
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

    for (let i = 0; i < 60; i++) {
      sim!.savePreviousPoses();
      sim!.step(FIXED_DT, intent);
    }
    expect(cPool.segmentIds[0]).toBe(state.trailWindow.nextLeft!.id);
    expect(creatures.normalY[0]!).toBeGreaterThan(0.5);
  });

  it('performs translation-only 128m floating-origin rebase without pose discontinuity', () => {
    const sim = new SkiSimulation({ seed: 314, debugDrawEnabled: true });
    const rebasedEvents: { rebaseCount: number; deltaZ: number }[] = [];
    sim.eventBus.on('WORLD_REBASED', (ev) => {
      rebasedEvents.push({ rebaseCount: ev.rebaseCount, deltaZ: ev.deltaZ });
    });

    const intent = createMutablePlayerIntent();
    let sawRebase = false;
    for (let i = 0; i < 600; i++) {
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
    }
  });
});
