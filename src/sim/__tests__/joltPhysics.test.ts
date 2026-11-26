import { describe, expect, it } from 'vitest';
import { getSkierDef } from '../../content/characters';
import { FIXED_DT } from '../../core/fixedLoop';
import { degToRad } from '../../core/math';
import {
  createMountainColumnOut,
  createMountainSampleOut,
  createMutablePlayerIntent,
  createSpineFrameOut,
  createSurfaceSample,
  type MountainColumnOut,
  type MountainSampleOut,
  type SpineView,
  type SurfaceQueryView,
  type SurfaceSample,
  type TerrainDirtyRect,
  type TerrainFieldView,
  type TerrainGridSampleOut,
} from '../contracts';
import { EntityPools } from '../entityPools';
import {
  COS_MAX_CLIMBABLE_SLOPE,
  JoltContactSolver,
} from '../physics/joltContactSolver';
import { resolveDefaultPhysicsRuntime } from '../physics/joltRuntime';
import {
  createMutableSkierPose,
  createPhysicsStepOutcome,
  SkiPhysics,
  type PhysicsStepContext,
} from '../skiPhysics';
import { SkiSimulation } from '../skiSimulation';

interface AnalyticTerrainSpec {
  readonly heightAt: (x: number, z: number) => number;
  readonly surfaceTypeAt?: (x: number, z: number, normalY: number) => 'packed' | 'powder' | 'ice' | 'rock';
  readonly onPisteAt?: (x: number, z: number) => boolean;
}

/**
 * Deterministic analytic TerrainFieldView + SurfaceQueryView for exact physics invariant tests
 * (65 deg rock cliffs, 48 deg rock walls, flat-to-48 deg crests, isolated ramp wedges, solid wipeout tumbles).
 */
function createAnalyticHarness(spec: AnalyticTerrainSpec): {
  terrain: TerrainFieldView;
  surfaceQuery: SurfaceQueryView;
} {
  const eps = 0.25;
  const dirtyRects: TerrainDirtyRect[] = [];
  const stageIdTable = ['sunny-blue'];

  const evalNormal = (x: number, z: number): [number, number, number] => {
    const hL = spec.heightAt(x - eps, z);
    const hR = spec.heightAt(x + eps, z);
    const hD = spec.heightAt(x, z - eps);
    const hU = spec.heightAt(x, z + eps);
    const dhdx = (hR - hL) / (2 * eps);
    const dhdz = (hU - hD) / (2 * eps);
    const invLen = 1 / Math.hypot(dhdx, 1, dhdz);
    return [-dhdx * invLen, invLen, -dhdz * invLen];
  };

  const evaluateSample = (wx: number, wz: number, out: MountainSampleOut): MountainSampleOut => {
    const h = spec.heightAt(wx, wz);
    const [nx, ny, nz] = evalNormal(wx, wz);
    const onPiste = spec.onPisteAt ? spec.onPisteAt(wx, wz) : true;
    const sType = spec.surfaceTypeAt
      ? spec.surfaceTypeAt(wx, wz, ny)
      : ny < 0.72
        ? 'rock'
        : 'packed';

    out.heightY = h;
    out.macroY = h;
    out.pisteWeight = onPiste ? 1 : 0;
    out.onPiste = onPiste;
    out.pisteSurfaceType = sType === 'rock' ? 'packed' : sType;
    out.inDivider = false;
    out.dividerMask = 0;
    out.inChasmZone = false;
    out.chasmWipeoutDepth = 0;
    out.chasmRelief = 0;
    out.chasmDepthBelowSpine = 0;
    out.nearestSpineY = h;
    out.nearestSegmentId = 1;
    out.nearestStageId = 'sunny-blue';
    out.secondaryStageId = null;
    out.secondaryStageWeight = 0;
    out.nearestS = Math.max(0, -wz);
    out.nearestSignedX = wx;
    out.nearestHalfWidth = 14;
    out.downhillX = 0;
    out.downhillY = 0;
    out.downhillZ = -1;
    out.normalX = nx;
    out.normalY = ny;
    out.normalZ = nz;
    out.surfaceType = sType;
    return out;
  };

  const terrain: TerrainFieldView = {
    worldSeed: 1,
    originOffsetX: 0,
    originOffsetY: 0,
    originOffsetZ: 0,
    fieldRevision: 1,
    dirtyRects,
    stageIdTable,
    collectSpinesInBounds(_minX: number, _maxX: number, _minZ: number, _maxZ: number, _padM: number, outSpines: SpineView[]) {
      outSpines.length = 0;
    },
    evaluateHeight(wx: number, wz: number): number {
      return spec.heightAt(wx, wz);
    },
    evaluateColumn(wx: number, wz: number, out: MountainColumnOut): MountainColumnOut {
      const s = evaluateSample(wx, wz, createMountainSampleOut());
      Object.assign(out, s);
      return out;
    },
    evaluate(wx: number, wz: number, out: MountainSampleOut): MountainSampleOut {
      return evaluateSample(wx, wz, out);
    },
    evaluateSample(wx: number, wz: number, out: MountainSampleOut): MountainSampleOut {
      return evaluateSample(wx, wz, out);
    },
    sampleColumnGrid(
      originAbsX: number,
      originAbsZ: number,
      cols: number,
      rows: number,
      stepM: number,
      blockOriginY: number,
      out: TerrainGridSampleOut,
    ): void {
      for (let r = 0; r < rows; r++) {
        const wz = originAbsZ + r * stepM;
        const rowOff = r * cols;
        for (let c = 0; c < cols; c++) {
          const wx = originAbsX + c * stepM;
          const idx = rowOff + c;
          const h = spec.heightAt(wx, wz);
          const [nx, ny, nz] = evalNormal(wx, wz);
          out.heights[idx] = h - blockOriginY;
          out.macroY[idx] = h - blockOriginY;
          out.normals[idx * 3] = nx;
          out.normals[idx * 3 + 1] = ny;
          out.normals[idx * 3 + 2] = nz;
          out.pisteWeight[idx] = 1;
        }
      }
    },
  };

  const sampleScratch = createMountainSampleOut();
  const surfaceQuery: SurfaceQueryView = {
    evaluateHeight: (wx: number, wz: number) => spec.heightAt(wx, wz),
    sampleSurface(posX: number, posZ: number, _hSeg: number, _hS: number, out: SurfaceSample): SurfaceSample {
      const m = evaluateSample(posX, posZ, sampleScratch);
      out.segmentId = 1;
      out.s = Math.max(0, -posZ);
      out.x = posX;
      out.groundY = m.heightY;
      out.macroY = m.macroY;
      out.normalX = m.normalX;
      out.normalY = m.normalY;
      out.normalZ = m.normalZ;
      out.tangentX = 0;
      out.tangentY = 0;
      out.tangentZ = -1;
      const fx = m.normalX * m.normalY;
      const fy = -(1 - m.normalY * m.normalY);
      const fz = m.normalZ * m.normalY;
      const fLen = Math.hypot(fx, fy, fz);
      if (fLen > 1e-4) {
        out.fallLineX = fx / fLen;
        out.fallLineY = fy / fLen;
        out.fallLineZ = fz / fLen;
      } else {
        out.fallLineX = 0;
        out.fallLineY = 0;
        out.fallLineZ = -1;
      }
      out.halfWidth = 14;
      out.surfaceType = m.surfaceType;
      out.onPiste = m.onPiste;
      out.pisteWeight = m.pisteWeight;
      out.inDivider = false;
      out.inChasmZone = false;
      out.chasmWipeoutDepth = 0;
      out.chasmRelief = 0;
      out.nearestSpineY = m.heightY;
      out.valid = true;
      return out;
    },
  };

  return { terrain, surfaceQuery };
}

describe('Jolt Physics WASM (M3) — Zero-Leak, 3D Dynamics, Ramps, Crests & Solid Wipeouts', () => {
  it('enforces exact 0-byte WASM memory leak across multi-cycle create/simulate/reset/dispose', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    expect(runtime).not.toBeNull();
    expect(runtime.getActiveWorldSlotCount()).toBe(0);

    // Warm up one complete simulation pass so Jolt's internal BroadPhase/BodyManager high-water-mark settles
    const intent = createMutablePlayerIntent();
    const runCycleBatch = (): void => {
      for (let cycle = 0; cycle < 6; cycle++) {
        const sim = new SkiSimulation({
          seed: 1000 + cycle,
          startStageId: cycle % 2 === 0 ? 'icy-black' : 'sunny-blue',
          physicsRuntime: runtime,
        });
        for (let t = 0; t < 180; t++) {
          sim.savePreviousPoses();
          sim.step(FIXED_DT, intent);
        }
        sim.reset(2000 + cycle);
        for (let t = 0; t < 120; t++) {
          sim.savePreviousPoses();
          sim.step(FIXED_DT, intent);
        }
        sim.dispose();
      }
    };
    runCycleBatch();
    expect(runtime.getActiveWorldSlotCount()).toBe(0);

    const freeBefore = runtime.getFreeMemory();

    // Run 6 full create -> simulate -> reset -> simulate -> dispose cycles and verify exact 0 B delta!
    runCycleBatch();

    const freeAfter = runtime.getFreeMemory();
    expect(runtime.getActiveWorldSlotCount()).toBe(0);
    expect(freeBefore - freeAfter).toBe(0);
  });

  it('rejects >52 deg cliff wall-climbing at 30 m/s, conserves energy, and gates wall impact tiers', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;
    // Flat floor for z >= -6, then a steep 65 deg rock cliff rising toward -Z
    const wallSlope = Math.tan(degToRad(65)); // ~2.1445 -> ny = cos(65 deg) = 0.4226 < 0.6157
    const { terrain, surfaceQuery } = createAnalyticHarness({
      heightAt: (_x, z) => (z < -6 ? (-6 - z) * wallSlope : 0),
      surfaceTypeAt: (_x, _z, ny) => (ny < 0.72 ? 'rock' : 'packed'),
    });

    const pools = new EntityPools();
    const solver = new JoltContactSolver(runtime, {
      skierRadius: skierDef.stats.collisionRadius,
      skierHeight: skierDef.stats.skierHeight,
    });
    const physics = new SkiPhysics();
    const pose = createMutableSkierPose();
    const surface = createSurfaceSample();
    const intent = createMutablePlayerIntent();
    const outcome = createPhysicsStepOutcome();

    const ctx: PhysicsStepContext = {
      skierDef,
      surfaceQuery,
      terrain,
      pools,
      contactSolver: solver,
      forkBumper: null,
      surface,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      // 1. Direct 30 m/s hit into 65 deg cliff: NEVER climbs wall, NEVER creates free vertical KE, triggers wall_crash
      pose.posX = 0;
      pose.posY = 0;
      pose.posZ = -2;
      pose.velX = 0;
      pose.velY = 0;
      pose.velZ = -30;
      pose.headingRad = 0;
      pose.grounded = true;
      physics.reset();
      solver.reset();

      let sawWallCrash = false;
      let maxHeightClimbed = 0;
      let maxUpwardVelY = 0;
      for (let t = 0; t < 45; t++) {
        const preSpeed = Math.hypot(pose.velX, pose.velY, pose.velZ);
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        const postSpeed = Math.hypot(pose.velX, pose.velY, pose.velZ);
        if (outcome.wallImpactKind === 'wall_crash') {
          sawWallCrash = true;
        }
        // Hard climbability invariant: never grounded on >52 deg wall
        if (surface.normalY < COS_MAX_CLIMBABLE_SLOPE) {
          expect(pose.grounded).toBe(false);
        }
        // Never creates free kinetic energy on wall collision
        if (pose.posZ < -5.0) {
          expect(postSpeed).toBeLessThanOrEqual(preSpeed + 0.5);
        }
        if (pose.posY > maxHeightClimbed) maxHeightClimbed = pose.posY;
        if (pose.velY > maxUpwardVelY) maxUpwardVelY = pose.velY;
      }

      expect(sawWallCrash).toBe(true);
      expect(maxHeightClimbed).toBeLessThan(1.0);
      expect(maxUpwardVelY).toBeLessThan(1.0);
      expect(pose.posZ).toBeGreaterThan(-7.5); // Blocked at cliff base, did NOT climb up the cliff!

      // 2. Glancing < 13 m/s hit into 65 deg cliff: deflects without triggering wall_scrape or wall_crash
      pose.posX = 0;
      pose.posY = 0;
      pose.posZ = -4.5;
      pose.velX = 12;
      pose.velY = 0;
      pose.velZ = -8; // closing normal speed ~8*sin(65) = 7.25 m/s < 13 m/s
      pose.headingRad = -Math.atan2(12, 8);
      pose.grounded = true;
      physics.reset();
      solver.reset();

      let sawGlancingPenalty = false;
      for (let t = 0; t < 25; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        if (outcome.wallImpactKind !== 'none') sawGlancingPenalty = true;
      }
      expect(sawGlancingPenalty).toBe(false);
    } finally {
      solver.dispose();
    }

    // 3. Off-grid 65 deg cliff at z = -5 (off 2m lattice!) at 30 m/s: MUST NOT ramp or climb!
    const offGridHarness = createAnalyticHarness({
      heightAt: (_x, z) => (z < -5 ? (-5 - z) * wallSlope : 0),
      surfaceTypeAt: (_x, _z, ny) => (ny < 0.72 ? 'rock' : 'packed'),
    });
    const solverOffGrid = new JoltContactSolver(runtime, {
      skierRadius: skierDef.stats.collisionRadius,
      skierHeight: skierDef.stats.skierHeight,
    });
    const physicsOffGrid = new SkiPhysics();
    const ctxOffGrid: PhysicsStepContext = {
      skierDef,
      surfaceQuery: offGridHarness.surfaceQuery,
      terrain: offGridHarness.terrain,
      pools,
      contactSolver: solverOffGrid,
      forkBumper: null,
      surface: createSurfaceSample(),
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };
    try {
      pose.posX = 0;
      pose.posY = 0;
      pose.posZ = -1;
      pose.velX = 0;
      pose.velY = 0;
      pose.velZ = -30;
      pose.headingRad = 0;
      pose.grounded = true;
      let sawOffGridCrash = false;
      let maxOffGridY = 0;
      let maxOffGridVy = 0;
      for (let t = 0; t < 40; t++) {
        physicsOffGrid.stepSkiing(FIXED_DT, intent, pose, ctxOffGrid, outcome);
        if (outcome.wallImpactKind === 'wall_crash') sawOffGridCrash = true;
        if (pose.posY > maxOffGridY) maxOffGridY = pose.posY;
        if (pose.velY > maxOffGridVy) maxOffGridVy = pose.velY;
      }
      expect(sawOffGridCrash).toBe(true);
      expect(maxOffGridY).toBeLessThan(1.0);
      expect(maxOffGridVy).toBeLessThan(2.5);
    } finally {
      solverOffGrid.dispose();
    }

    // 4. 55 deg DIAGONAL cliff ((x + z) / sqrt(2) < -6) at 30 m/s: 2D gradient catches it & ZERO crease launch!
    const diagSlope = Math.tan(degToRad(55));
    const invSqrt2 = Math.SQRT1_2;
    const diagHarness = createAnalyticHarness({
      heightAt: (x, z) => {
        const d = (x + z) * invSqrt2;
        return d < -6 ? (-6 - d) * diagSlope : 0;
      },
      surfaceTypeAt: (_x, _z, ny) => (ny < 0.72 ? 'rock' : 'packed'),
    });
    const solverDiag = new JoltContactSolver(runtime, {
      skierRadius: skierDef.stats.collisionRadius,
      skierHeight: skierDef.stats.skierHeight,
    });
    const physicsDiag = new SkiPhysics();
    const ctxDiag: PhysicsStepContext = {
      skierDef,
      surfaceQuery: diagHarness.surfaceQuery,
      terrain: diagHarness.terrain,
      pools,
      contactSolver: solverDiag,
      forkBumper: null,
      surface: createSurfaceSample(),
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };
    try {
      pose.posX = -1.5;
      pose.posY = 0;
      pose.posZ = -1.5;
      pose.velX = -30 * invSqrt2;
      pose.velY = 0;
      pose.velZ = -30 * invSqrt2;
      pose.headingRad = Math.PI * 0.25;
      pose.grounded = true;
      let sawDiagCrash = false;
      let maxDiagY = 0;
      let maxDiagVy = 0;
      for (let t = 0; t < 40; t++) {
        physicsDiag.stepSkiing(FIXED_DT, intent, pose, ctxDiag, outcome);
        if (outcome.wallImpactKind === 'wall_crash') sawDiagCrash = true;
        if (pose.posY > maxDiagY) maxDiagY = pose.posY;
        if (pose.velY > maxDiagVy) maxDiagVy = pose.velY;
      }
      expect(sawDiagCrash).toBe(true);
      expect(maxDiagY).toBeLessThan(1.0);
      expect(maxDiagVy).toBeLessThan(2.5);
    } finally {
      solverDiag.dispose();
    }
  });

  it('maintains <= 5 cm Jolt heightfield parity against MountainField across powder-bowl, icy-black, blizzard-ridge, and fork IslandDivider', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const out = { valid: false, normalX: 0, normalY: 1, normalZ: 0, heightY: 0 };
    const intent = createMutablePlayerIntent();
    const frameOut = createSpineFrameOut();

    for (const stageId of ['powder-bowl', 'icy-black', 'blizzard-ridge'] as const) {
      const sim = new SkiSimulation({ seed: 2026, startStageId: stageId, physicsRuntime: runtime });
      // Advance 60 ticks so skier moves onto live slope & rolling heightfield updates
      for (let t = 0; t < 60; t++) {
        sim.savePreviousPoses();
        sim.step(FIXED_DT, intent);
      }
      const st = sim.getState();
      const mf = st.mountainField;
      const internals = sim as unknown as {
        contactSolver: JoltContactSolver;
        pools: EntityPools;
      };
      const solver = internals.contactSolver;
      const sx = st.currSkier.posX;
      const sz = st.currSkier.posZ;

      let maxErrM = 0;
      for (let dz = -5; dz <= 5; dz += 0.5) {
        for (let dx = -5; dx <= 5; dx += 0.5) {
          const wx = sx + dx;
          const wz = sz + dz;
          solver.samplePatchNormal(wx, wz, out);
          if (!out.valid) continue;
          const exactH = mf.evaluateHeight(wx, wz);
          const err = Math.abs(out.heightY - exactH);
          if (err > maxErrM) maxErrM = err;
        }
      }
      expect(maxErrM).toBeLessThanOrEqual(0.05);

      // Also verify <= 5 cm parity right across the fork V-wedge / IslandDivider
      const seg = st.trailWindow.curr;
      seg.sampleSpineFrame(Math.max(0, seg.length - 6), frameOut);
      const divY = mf.evaluateHeight(frameOut.posX, frameOut.posZ);
      solver.syncWorld(frameOut.posX, divY, frameOut.posZ, FIXED_DT, mf, internals.pools, null, true);
      let maxDivErrM = 0;
      for (let dz = -5; dz <= 5; dz += 0.5) {
        for (let dx = -5; dx <= 5; dx += 0.5) {
          const wx = frameOut.posX + dx;
          const wz = frameOut.posZ + dz;
          solver.samplePatchNormal(wx, wz, out);
          if (!out.valid) continue;
          const exactH = mf.evaluateHeight(wx, wz);
          const err = Math.abs(out.heightY - exactH);
          if (err > maxDivErrM) maxDivErrM = err;
        }
      }
      expect(maxDivErrM).toBeLessThanOrEqual(0.05);
      sim.dispose();
    }
  });

  it('enforces energy-conserving carving, zero uphill poling, high rock drag, and blocks 48 deg rock bunny-hop climbs', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;

    // 1. 20 deg uphill snow slope (rising along -Z): carving uphill & poling NEVER gain speed
    const upSlope = Math.tan(degToRad(20));
    const uphillHarness = createAnalyticHarness({
      heightAt: (_x, z) => -z * upSlope,
      surfaceTypeAt: () => 'packed',
    });
    const pools = new EntityPools();
    const solverUp = new JoltContactSolver(runtime);
    const physicsUp = new SkiPhysics();
    const poseUp = createMutableSkierPose();
    const surfUp = createSurfaceSample();
    const outcome = createPhysicsStepOutcome();
    const ctxUp: PhysicsStepContext = {
      skierDef,
      surfaceQuery: uphillHarness.surfaceQuery,
      terrain: uphillHarness.terrain,
      pools,
      contactSolver: solverUp,
      forkBumper: null,
      surface: surfUp,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      // Point uphill with slow speed (where old poling assist pushed uphill!) + hard carve steer
      poseUp.posX = 0;
      poseUp.posY = 0;
      poseUp.posZ = 0;
      poseUp.headingRad = 0; // faces -Z (uphill!)
      poseUp.velX = 4.0;
      poseUp.velY = 4.0 * Math.sin(degToRad(20));
      poseUp.velZ = -4.0 * Math.cos(degToRad(20));
      poseUp.grounded = true;

      const carveIntent = createMutablePlayerIntent();
      carveIntent.steer = 0.6;
      const startSpeed = Math.hypot(poseUp.velX, poseUp.velY, poseUp.velZ);
      let prevForwardSpeed = 4.0;
      for (let t = 0; t < 35; t++) {
        physicsUp.stepSkiing(FIXED_DT, carveIntent, poseUp, ctxUp, outcome);
        const speedNow = Math.hypot(poseUp.velX, poseUp.velY, poseUp.velZ);
        expect(speedNow).toBeLessThanOrEqual(startSpeed + 0.05);
        // Velocity along uphill -Z strictly decreases under gravity + drag (zero uphill poling)
        const upComponent = -poseUp.velZ;
        expect(upComponent).toBeLessThanOrEqual(prevForwardSpeed + 0.05);
        prevForwardSpeed = upComponent;
      }
      expect(-poseUp.velZ).toBeLessThan(1.0);
    } finally {
      solverUp.dispose();
    }

    // 2. 48 deg rock slope: high rock drag AND jumping cannot bunny-hop climb
    const rockSlope = Math.tan(degToRad(48)); // ny = cos(48 deg) = 0.669 < 0.72 -> 'rock'
    const rockHarness = createAnalyticHarness({
      heightAt: (_x, z) => -z * rockSlope,
      surfaceTypeAt: () => 'rock',
      onPisteAt: () => false,
    });
    const solverRock = new JoltContactSolver(runtime);
    const physicsRock = new SkiPhysics();
    const poseRock = createMutableSkierPose();
    const surfRock = createSurfaceSample();
    const ctxRock: PhysicsStepContext = {
      skierDef,
      surfaceQuery: rockHarness.surfaceQuery,
      terrain: rockHarness.terrain,
      pools,
      contactSolver: solverRock,
      forkBumper: null,
      surface: surfRock,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      poseRock.posX = 0;
      poseRock.posY = 0;
      poseRock.posZ = 0;
      poseRock.headingRad = 0;
      poseRock.velX = 0;
      poseRock.velY = 8 * Math.sin(degToRad(48));
      poseRock.velZ = -8 * Math.cos(degToRad(48));
      poseRock.grounded = true;

      const jumpIntent = createMutablePlayerIntent();
      let maxClearanceOnRock = 0;
      for (let t = 0; t < 20; t++) {
        jumpIntent.jumpPressed = t === 1;
        physicsRock.stepSkiing(FIXED_DT, jumpIntent, poseRock, ctxRock, outcome);
        const clr = poseRock.posY - poseRock.groundY;
        if (clr > maxClearanceOnRock) maxClearanceOnRock = clr;
      }
      // 48 deg rock jump is attenuated to zero -> no bunny-hop launch!
      expect(maxClearanceOnRock).toBeLessThan(0.25);
    } finally {
      solverRock.dispose();
    }

    // 3. 9 deg powder-bowl carving stays lively (does not dead-stop!)
    const simPowder = new SkiSimulation({ seed: 42, startStageId: 'powder-bowl', physicsRuntime: runtime });
    const pIntent = createMutablePlayerIntent();
    for (let t = 0; t < 180; t++) {
      pIntent.steer = Math.sin(t * 0.08) * 0.65;
      simPowder.savePreviousPoses();
      simPowder.step(FIXED_DT, pIntent);
    }
    expect(simPowder.getState().currSkier.speed).toBeGreaterThan(10);
    simPowder.dispose();
  });

  it('simulates 3D ConvexHull ramp wedge: clean launch, airborne mid-ramp landing, side/back deflection, and safe high-speed icy-black jump', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;
    const slopePitchRad = -degToRad(14);
    const slopeTan = Math.tan(degToRad(14));
    const { terrain, surfaceQuery } = createAnalyticHarness({
      heightAt: (_x, z) => z * slopeTan, // drops downhill along -Z
      surfaceTypeAt: () => 'packed',
    });

    const pools = new EntityPools();
    // Place standard 4.2 x 6.5 x 1.35 m ramp at (0, groundY, -10) facing -Z
    const rampZ = -10;
    const rampY = rampZ * slopeTan;
    pools.ramps.add('ski_ramp_standard', 1, 0, rampY, rampZ, 0, slopePitchRad, 4.2, 6.5, 1.35, 18);

    const solver = new JoltContactSolver(runtime);
    const physics = new SkiPhysics();
    const pose = createMutableSkierPose();
    const surf = createSurfaceSample();
    const outcome = createPhysicsStepOutcome();
    const intent = createMutablePlayerIntent();
    const ctx: PhysicsStepContext = {
      skierDef,
      surfaceQuery,
      terrain,
      pools,
      contactSolver: solver,
      forkBumper: null,
      surface: surf,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      // 1. Clean deck ride -> lip launch
      pose.posX = 0;
      pose.posZ = -3.0;
      pose.posY = pose.posZ * slopeTan;
      pose.headingRad = 0;
      pose.velX = 0;
      pose.velY = 22 * Math.sin(slopePitchRad);
      pose.velZ = -22 * Math.cos(slopePitchRad);
      pose.grounded = true;
      physics.reset();
      solver.reset();

      let maxClearance = 0;
      let sawLaunch = false;
      for (let t = 0; t < 75; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        if (outcome.rampLaunched) sawLaunch = true;
        const clr = pose.posY - pose.groundY;
        if (clr > maxClearance) maxClearance = clr;
      }
      expect(sawLaunch).toBe(true);
      expect(maxClearance).toBeGreaterThan(2.2);

      // 2. Airborne mid-ramp landing -> lands cleanly onto sloped deck and launches off lip
      pose.posX = 0;
      pose.posZ = -7.8;
      pose.posY = pose.posZ * slopeTan + 1.8;
      pose.headingRad = 0;
      pose.velX = 0;
      pose.velY = -5.0;
      pose.velZ = -18.0;
      pose.grounded = false;
      physics.reset();
      solver.reset();

      let landedOnRampAndLaunched = false;
      for (let t = 0; t < 75; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        if (outcome.rampLaunched) landedOnRampAndLaunched = true;
      }
      expect(landedOnRampAndLaunched).toBe(true);

      // 3. Side face deflection: skiing sideways into the vertical x = +2.1m side wall deflects & never ghosts through
      pose.posX = 3.4;
      pose.posZ = -11.5;
      pose.posY = pose.posZ * slopeTan;
      pose.headingRad = Math.PI * 0.5; // faces -X into ramp right side wall
      pose.velX = -10;
      pose.velY = 0;
      pose.velZ = 0;
      pose.grounded = true;
      physics.reset();
      solver.reset();

      let ghostedInside = false;
      let sideLaunched = false;
      for (let t = 0; t < 20; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        if (outcome.rampLaunched) sideLaunched = true;
        if (pose.posX < 1.8 && pose.posY < pose.groundY + 0.5) ghostedInside = true;
      }
      expect(ghostedInside).toBe(false);
      expect(sideLaunched).toBe(false);

      // 4. Back face deflection: skiing backward (+Z) into vertical front kicker wall at z = -13.25m deflects cleanly
      pose.posX = 0;
      pose.posZ = -15.0;
      pose.posY = pose.posZ * slopeTan;
      pose.headingRad = Math.PI; // faces +Z
      pose.velX = 0;
      pose.velY = 0;
      pose.velZ = 10;
      pose.grounded = true;
      physics.reset();
      solver.reset();

      let passedBackWall = false;
      for (let t = 0; t < 20; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        if (pose.posZ > -13.0 && pose.posY < pose.groundY + 0.6) passedBackWall = true;
      }
      expect(passedBackWall).toBe(false);
    } finally {
      solver.dispose();
    }

    // 5. High-speed icy-black ramp + player jump survives on-piste landing without self-wipeout!
    const steepPitch = -degToRad(28);
    const steepTan = Math.tan(degToRad(28));
    const icyHarness = createAnalyticHarness({
      heightAt: (_x, z) => z * steepTan,
      surfaceTypeAt: () => 'packed',
      onPisteAt: () => true,
    });
    const icyPools = new EntityPools();
    icyPools.ramps.add('ski_ramp_standard', 1, 0, -10 * steepTan, -10, 0, steepPitch, 4.2, 6.5, 1.35, 18);
    const icySolver = new JoltContactSolver(runtime);
    const icyPhysics = new SkiPhysics();
    const icyPose = createMutableSkierPose();
    const icySurf = createSurfaceSample();
    const icyCtx: PhysicsStepContext = {
      skierDef,
      surfaceQuery: icyHarness.surfaceQuery,
      terrain: icyHarness.terrain,
      pools: icyPools,
      contactSolver: icySolver,
      forkBumper: null,
      surface: icySurf,
      ramps: icyPools.ramps,
      skiTracks: icyPools.skiTracks,
      invulnerable: false,
    };

    try {
      icyPose.posX = 0;
      icyPose.posZ = -4.0;
      icyPose.posY = icyPose.posZ * steepTan;
      icyPose.headingRad = 0;
      icyPose.velX = 0;
      icyPose.velY = 33 * Math.sin(steepPitch);
      icyPose.velZ = -33 * Math.cos(steepPitch);
      icyPose.grounded = true;

      let peakAir = 0;
      let sawSelfWipeout = false;
      let landedAgain = false;
      let jumpedOnRamp = false;
      for (let t = 0; t < 160; t++) {
        intent.jumpPressed = !jumpedOnRamp && icyPose.posZ < -10.5 && icyPose.posZ > -13.0;
        if (intent.jumpPressed) jumpedOnRamp = true;
        icyPhysics.stepSkiing(FIXED_DT, intent, icyPose, icyCtx, outcome);
        const clr = icyPose.posY - icyPose.groundY;
        if (clr > peakAir) peakAir = clr;
        if (outcome.landingImpactKind === 'hard_landing_wipeout') {
          sawSelfWipeout = true;
        }
        if (peakAir > 2.5 && icyPose.grounded) {
          landedAgain = true;
          break;
        }
      }
      expect(peakAir).toBeGreaterThan(2.5);
      expect(landedAgain).toBe(true);
      expect(sawSelfWipeout).toBe(false);
    } finally {
      icySolver.dispose();
    }
  });

  it('detaches unconditionally over steep convex crests at slow speed (< 13 m/s) and deflects solid 3D wipeout tumbles off boulders', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;

    // 1. Sharp convex crest: 5 deg mild lead-in (z >= -6), dropping to 48 deg steep slope (z < -6)
    const leadTan = Math.tan(degToRad(5));
    const dropTan = Math.tan(degToRad(48));
    const crestHarness = createAnalyticHarness({
      heightAt: (_x, z) => (z >= -6 ? z * leadTan : -6 * leadTan + (z + 6) * dropTan),
      surfaceTypeAt: () => 'packed',
    });

    const pools = new EntityPools();
    const solver = new JoltContactSolver(runtime);
    const physics = new SkiPhysics();
    const pose = createMutableSkierPose();
    const surf = createSurfaceSample();
    const outcome = createPhysicsStepOutcome();
    const intent = createMutablePlayerIntent();
    const ctx: PhysicsStepContext = {
      skierDef,
      surfaceQuery: crestHarness.surfaceQuery,
      terrain: crestHarness.terrain,
      pools,
      contactSolver: solver,
      forkBumper: null,
      surface: surf,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      // Approach crest at SLOW speed (9.5 m/s < 13 m/s legacy threshold!)
      pose.posX = 0;
      pose.posZ = -3.0;
      pose.posY = crestHarness.terrain.evaluateHeight(0, -3.0);
      pose.headingRad = 0;
      pose.velX = 0;
      pose.velY = -9.5 * Math.sin(degToRad(5));
      pose.velZ = -9.5 * Math.cos(degToRad(5));
      pose.grounded = true;

      let sawAirborne = false;
      let maxCrestClearance = 0;
      for (let t = 0; t < 45; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        const clr = pose.posY - pose.groundY;
        if (clr > maxCrestClearance) maxCrestClearance = clr;
        if (!pose.grounded && clr > 0.2) sawAirborne = true;
      }
      expect(sawAirborne).toBe(true);
      expect(maxCrestClearance).toBeGreaterThan(0.35);
    } finally {
      solver.dispose();
    }

    // 2. Solid 3D wipeout tumble: slides downhill (never uphill) and physically deflects off a solid boulder
    const slopeTan = Math.tan(degToRad(22));
    const tumbleHarness = createAnalyticHarness({
      heightAt: (_x, z) => z * slopeTan,
      surfaceTypeAt: () => 'packed',
    });
    const tumblePools = new EntityPools();
    const boulderZ = -7.0;
    const boulderY = boulderZ * slopeTan;
    tumblePools.hazards.add(
      'boulder_large',
      1,
      0.35, // slightly off-center so tumbling skier deflects sideways around solid granite boulder
      boulderY,
      boulderZ,
      0,
      Math.cos(degToRad(22)),
      -Math.sin(degToRad(22)),
      0,
      1.0,
      1.85,
      2.35,
      true,
    );
    const tumbleSolver = new JoltContactSolver(runtime);
    const tumblePhysics = new SkiPhysics();
    const tumblePose = createMutableSkierPose();
    const tumbleSurf = createSurfaceSample();
    const tumbleCtx: PhysicsStepContext = {
      skierDef,
      surfaceQuery: tumbleHarness.surfaceQuery,
      terrain: tumbleHarness.terrain,
      pools: tumblePools,
      contactSolver: tumbleSolver,
      forkBumper: null,
      surface: tumbleSurf,
      ramps: tumblePools.ramps,
      skiTracks: tumblePools.skiTracks,
      invulnerable: true,
    };

    try {
      tumblePose.posX = 0;
      tumblePose.posZ = -2.0;
      tumblePose.posY = -2.0 * slopeTan;
      tumblePose.velX = 0;
      tumblePose.velY = -16 * Math.sin(degToRad(22));
      tumblePose.velZ = -16 * Math.cos(degToRad(22));
      tumblePose.grounded = true;

      let minDistToBoulderCenter = Infinity;
      for (let t = 0; t < 60; t++) {
        tumblePhysics.stepWipeout(FIXED_DT, tumblePose, tumbleCtx);
        const d = Math.hypot(tumblePose.posX - 0.35, tumblePose.posZ - boulderZ);
        if (d < minDistToBoulderCenter) minDistToBoulderCenter = d;
      }

      // Tumbling skier NEVER ghosted inside the 1.85m solid boulder and decelerated via tumble friction
      expect(minDistToBoulderCenter).toBeGreaterThan(1.75);
      expect(tumblePose.speed).toBeLessThan(8.0);
    } finally {
      tumbleSolver.dispose();
    }
  });

  it('refreshes heightfield patch on overlapping dirtyRects after ackDirtyRects() resets dirtyRects.length to 0', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    let baseElevation = 0;
    const dirtyRects: TerrainDirtyRect[] = [];
    let fieldRevision = 1;

    const baseHarness = createAnalyticHarness({
      heightAt: () => baseElevation,
      surfaceTypeAt: () => 'packed',
    });
    const terrain: TerrainFieldView = {
      ...baseHarness.terrain,
      get fieldRevision() {
        return fieldRevision;
      },
      dirtyRects,
      ackDirtyRects() {
        dirtyRects.length = 0;
      },
    };

    const pools = new EntityPools();
    const solver = new JoltContactSolver(runtime);
    const patchOut = { valid: false, normalX: 0, normalY: 1, normalZ: 0, heightY: 0 };

    try {
      // 1. Initial sync at origin (fieldRevision=1, dirtyRects=[])
      solver.syncWorld(0, 0, 0, FIXED_DT, terrain, pools, null);
      solver.samplePatchNormal(0, 0, patchOut);
      expect(patchOut.valid).toBe(true);
      expect(patchOut.heightY).toBeCloseTo(0, 3);

      // 2. Non-overlapping topology update (fieldRevision=2, 1 rect far away)
      dirtyRects.push({ minAbsX: 250, maxAbsX: 280, minAbsZ: 250, maxAbsZ: 280 });
      fieldRevision = 2;
      solver.syncWorld(0, 0, 0, FIXED_DT, terrain, pools, null);

      // 3. Renderer acknowledges dirty rects -> dirtyRects.length drops 1 -> 0
      terrain.ackDirtyRects?.();
      expect(dirtyRects.length).toBe(0);

      // 4. Next topology change mutates height at (0, 0) and pushes 1 overlapping rect
      baseElevation = 2.5;
      dirtyRects.push({ minAbsX: -4, maxAbsX: 4, minAbsZ: -4, maxAbsZ: 4 });
      fieldRevision = 3;
      solver.syncWorld(0, 0, 0, FIXED_DT, terrain, pools, null);

      solver.samplePatchNormal(0, 0, patchOut);
      expect(patchOut.valid).toBe(true);
      expect(patchOut.heightY).toBeCloseTo(2.5, 2);
    } finally {
      solver.dispose();
    }
  });

  it('keeps hard sideways carving within <= 6 cm of MountainField.evaluateHeight across sharp shoulders', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;
    const out = { valid: false, normalX: 0, normalY: 1, normalZ: 0, heightY: 0 };

    // 1. Analytic sharp lateral shoulder peaking at x = +3.0m (off 2m lattice!) after initial -Z travel
    const sharpShoulderHarness = createAnalyticHarness({
      heightAt: (x, z) => {
        const dx = Math.abs(x - 3.0);
        const ridge = dx < 1.2 ? 0.45 * (1 - dx / 1.2) : 0;
        return z * Math.tan(degToRad(14)) + ridge;
      },
      surfaceTypeAt: () => 'packed',
    });
    const pools = new EntityPools();
    const solver = new JoltContactSolver(runtime);
    const physics = new SkiPhysics();
    const pose = createMutableSkierPose();
    const surf = createSurfaceSample();
    const outcome = createPhysicsStepOutcome();
    const intent = createMutablePlayerIntent();
    const ctx: PhysicsStepContext = {
      skierDef,
      surfaceQuery: sharpShoulderHarness.surfaceQuery,
      terrain: sharpShoulderHarness.terrain,
      pools,
      contactSolver: solver,
      forkBumper: null,
      surface: surf,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      pose.posX = 0;
      pose.posZ = 0;
      pose.posY = sharpShoulderHarness.terrain.evaluateHeight(0, 0);
      pose.headingRad = 0;
      pose.velX = 0;
      pose.velY = -16 * Math.sin(degToRad(14));
      pose.velZ = -16 * Math.cos(degToRad(14));
      pose.grounded = true;

      // First establish -Z moveDir, then hard carve right (+X) across the sharp off-lattice shoulder
      let maxPatchErrM = 0;
      for (let t = 0; t < 45; t++) {
        intent.steer = t < 5 ? 0 : -1.0;
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        solver.samplePatchNormal(pose.posX, pose.posZ, out);
        expect(out.valid).toBe(true);
        const exactH = sharpShoulderHarness.terrain.evaluateHeight(pose.posX, pose.posZ);
        const err = Math.abs(out.heightY - exactH);
        if (err > maxPatchErrM) maxPatchErrM = err;
      }
      expect(maxPatchErrM).toBeLessThanOrEqual(0.06);
    } finally {
      solver.dispose();
    }

    // 2. Live MountainField hard sideways carving on granite-gorge & sunny-blue
    for (const stageId of ['granite-gorge', 'sunny-blue'] as const) {
      const sim = new SkiSimulation({ seed: 1337, startStageId: stageId, physicsRuntime: runtime });
      const st = sim.getState();
      const mf = st.mountainField;
      const internals = sim as unknown as { contactSolver: JoltContactSolver };
      let maxLiveErrM = 0;
      let worstClipM = 0;
      for (let t = 0; t < 240; t++) {
        intent.steer = t % 80 < 40 ? 1.0 : -1.0;
        sim.savePreviousPoses();
        sim.step(FIXED_DT, intent);
        const sx = st.currSkier.posX;
        const sz = st.currSkier.posZ;
        const exactH = mf.evaluateHeight(sx, sz);
        internals.contactSolver.samplePatchNormal(sx, sz, out);
        if (out.valid) {
          const err = Math.abs(out.heightY - exactH);
          if (err > maxLiveErrM) maxLiveErrM = err;
        }
        const clip = exactH - st.currSkier.posY;
        if (clip > worstClipM) worstClipM = clip;
      }
      expect(maxLiveErrM).toBeLessThanOrEqual(0.06);
      expect(worstClipM).toBeLessThanOrEqual(0.06);
      sim.dispose();
    }
  });

  it('recovers skier onto terrain via defense-in-depth floor safety clamp when forced 1.2 m below groundY', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;
    const slopeTan = Math.tan(degToRad(18));
    const { terrain, surfaceQuery } = createAnalyticHarness({
      heightAt: (_x, z) => z * slopeTan,
      surfaceTypeAt: () => 'packed',
    });

    const pools = new EntityPools();
    const solver = new JoltContactSolver(runtime);
    const physics = new SkiPhysics();
    const pose = createMutableSkierPose();
    const surf = createSurfaceSample();
    const outcome = createPhysicsStepOutcome();
    const intent = createMutablePlayerIntent();
    const ctx: PhysicsStepContext = {
      skierDef,
      surfaceQuery,
      terrain,
      pools,
      contactSolver: solver,
      forkBumper: null,
      surface: surf,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      // 1. Skiing recovery after being forced 1.2m below groundY with downward velocity
      pose.posX = 0;
      pose.posZ = -4;
      pose.posY = terrain.evaluateHeight(0, -4) - 1.2;
      pose.headingRad = 0;
      pose.velX = 0;
      pose.velY = -12.0;
      pose.velZ = -14.0;
      pose.grounded = false;

      for (let t = 0; t < 20; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        expect(pose.posY).toBeGreaterThanOrEqual(pose.groundY - 0.05);
      }
      expect(pose.grounded).toBe(true);
      expect(Math.abs(pose.posY - pose.groundY)).toBeLessThanOrEqual(0.06);

      // 2. Wipeout tumble recovery after being forced 1.2m below groundY
      pose.posX = 0;
      pose.posZ = -10;
      pose.posY = terrain.evaluateHeight(0, -10) - 1.2;
      pose.velX = 0;
      pose.velY = -10.0;
      pose.velZ = -8.0;
      pose.grounded = false;

      for (let t = 0; t < 20; t++) {
        physics.stepWipeout(FIXED_DT, pose, ctx);
        expect(pose.posY).toBeGreaterThanOrEqual(pose.groundY - 0.05);
      }
      expect(pose.grounded).toBe(true);
      expect(Math.abs(pose.posY - pose.groundY)).toBeLessThanOrEqual(0.06);
    } finally {
      solver.dispose();
    }
  });

  it('walks uphill over a crest when stalled anywhere (off-piste and on-piste), respects gentle vs steep rock, brake, and jump exits', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;

    // 1. Off-piste ridge profile: rises 10 deg uphill from z=0 to z=-8, then drops 14 deg downhill past z=-8
    const upTan = Math.tan(degToRad(10));
    const downTan = Math.tan(degToRad(14));
    let onPisteMode = false;
    const ridgeHarness = createAnalyticHarness({
      heightAt: (_x, z) => (z >= -8 ? -z * upTan : 8 * upTan + (z + 8) * downTan),
      surfaceTypeAt: () => (onPisteMode ? 'packed' : 'powder'),
      onPisteAt: () => onPisteMode,
    });

    const pools = new EntityPools();
    const solver = new JoltContactSolver(runtime);
    const physics = new SkiPhysics();
    const pose = createMutableSkierPose();
    const surf = createSurfaceSample();
    const outcome = createPhysicsStepOutcome();
    const intent = createMutablePlayerIntent();
    const ctx: PhysicsStepContext = {
      skierDef,
      surfaceQuery: ridgeHarness.surfaceQuery,
      terrain: ridgeHarness.terrain,
      pools,
      contactSolver: solver,
      forkBumper: null,
      surface: surf,
      ramps: pools.ramps,
      skiTracks: pools.skiTracks,
      invulnerable: false,
    };

    try {
      // Off-piste stall at z = -1 facing uphill (-Z)
      pose.posX = 0;
      pose.posZ = -1;
      pose.posY = ridgeHarness.terrain.evaluateHeight(0, -1);
      pose.velX = 0;
      pose.velY = 0;
      pose.velZ = 0;
      pose.headingRad = 0;
      pose.grounded = true;
      pose.walking = false;
      pose.walkPhaseRad = 0;
      physics.reset();
      solver.reset();

      let enteredWalk = false;
      let trackCountDuringWalkStart = -1;
      let trackCountDuringWalkEnd = -1;
      let maxPhase = 0;
      let resumedSkiingAfterCrest = false;
      for (let t = 0; t < 420; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
        if (pose.walking && !enteredWalk) {
          enteredWalk = true;
          trackCountDuringWalkStart = pools.skiTracks.count;
        }
        if (pose.walking) {
          if (pose.walkPhaseRad > maxPhase) maxPhase = pose.walkPhaseRad;
          trackCountDuringWalkEnd = pools.skiTracks.count;
        } else if (enteredWalk && pose.posZ < -8.5 && pose.speed > 3.5) {
          resumedSkiingAfterCrest = true;
          break;
        }
      }

      expect(enteredWalk).toBe(true);
      expect(maxPhase).toBeGreaterThan(Math.PI * 2);
      expect(pose.posZ).toBeLessThan(-8.5);
      expect(resumedSkiingAfterCrest).toBe(true);
      // Only at most the clean track-break sample pushed when walk starts
      expect(trackCountDuringWalkEnd - trackCountDuringWalkStart).toBeLessThanOrEqual(1);

      // 2. Trigger anywhere: flat on-piste stall enters walking, brake cancels walking, jump exits walking
      onPisteMode = true;
      const flatHarness = createAnalyticHarness({
        heightAt: () => 0,
        surfaceTypeAt: () => 'packed',
        onPisteAt: () => true,
      });
      const flatCtx: PhysicsStepContext = {
        ...ctx,
        surfaceQuery: flatHarness.surfaceQuery,
        terrain: flatHarness.terrain,
      };
      pose.posX = 0;
      pose.posY = 0;
      pose.posZ = 0;
      pose.velX = 0;
      pose.velY = 0;
      pose.velZ = 0;
      pose.headingRad = 0;
      pose.grounded = true;
      pose.walking = false;
      pose.walkPhaseRad = 0;
      physics.reset();
      solver.reset();

      for (let t = 0; t < 30; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, flatCtx, outcome);
      }
      expect(pose.walking).toBe(true);
      expect(pose.speed).toBeGreaterThan(2.5);

      // Brake stops walking and brings skier to a halt -> releasing brake re-enters walking -> jump exits walking into air
      const brakeIntent = createMutablePlayerIntent();
      brakeIntent.brake = true;
      for (let t = 0; t < 15; t++) {
        physics.stepSkiing(FIXED_DT, brakeIntent, pose, flatCtx, outcome);
      }
      expect(pose.walking).toBe(false);
      expect(pose.speed).toBeLessThan(0.5);

      for (let t = 0; t < 30; t++) {
        physics.stepSkiing(FIXED_DT, intent, pose, flatCtx, outcome);
      }
      expect(pose.walking).toBe(true);
      const jumpIntent = createMutablePlayerIntent();
      jumpIntent.jumpPressed = true;
      physics.stepSkiing(FIXED_DT, jumpIntent, pose, flatCtx, outcome);
      expect(pose.walking).toBe(false);
      expect(pose.grounded).toBe(false);
    } finally {
      solver.dispose();
    }

    // 3. Gentle rock (20 deg) allows slower walking; steep rock (45 deg) blocks walking
    const testRockSlope = (slopeDeg: number): { walking: boolean; speed: number } => {
      const slopeTan = Math.tan(degToRad(slopeDeg));
      const rockH = createAnalyticHarness({
        heightAt: (_x, z) => -z * slopeTan,
        surfaceTypeAt: () => 'rock',
        onPisteAt: () => false,
      });
      const rSolver = new JoltContactSolver(runtime);
      const rPhysics = new SkiPhysics();
      const rPose = createMutableSkierPose();
      const rSurf = createSurfaceSample();
      const rOut = createPhysicsStepOutcome();
      const rPools = new EntityPools();
      const rCtx: PhysicsStepContext = {
        skierDef,
        surfaceQuery: rockH.surfaceQuery,
        terrain: rockH.terrain,
        pools: rPools,
        contactSolver: rSolver,
        forkBumper: null,
        surface: rSurf,
        ramps: rPools.ramps,
        skiTracks: rPools.skiTracks,
        invulnerable: false,
      };
      try {
        rPose.posX = 0;
        rPose.posY = 0;
        rPose.posZ = 0;
        rPose.velX = 0;
        rPose.velY = 0;
        rPose.velZ = 0;
        rPose.headingRad = 0;
        rPose.grounded = true;
        rPose.walking = false;
        rPose.walkPhaseRad = 0;
        for (let t = 0; t < 40; t++) {
          rPhysics.stepSkiing(FIXED_DT, intent, rPose, rCtx, rOut);
        }
        return { walking: rPose.walking, speed: rPose.speed };
      } finally {
        rSolver.dispose();
      }
    };

    const gentleRock = testRockSlope(20);
    expect(gentleRock.walking).toBe(true);
    expect(gentleRock.speed).toBeGreaterThan(0.8);
    expect(gentleRock.speed).toBeLessThan(2.5);

    const steepRock = testRockSlope(45);
    expect(steepRock.walking).toBe(false);

    // 4. Gliding onto flat on-piste snow ('packed' and 'ice') from positive speed decelerates cleanly into walk
    for (const flatSurface of ['packed', 'ice'] as const) {
      const flatIceHarness = createAnalyticHarness({
        heightAt: () => 0,
        surfaceTypeAt: () => flatSurface,
        onPisteAt: () => true,
      });
      const fSolver = new JoltContactSolver(runtime);
      const fPhysics = new SkiPhysics();
      const fPose = createMutableSkierPose();
      const fSurf = createSurfaceSample();
      const fOut = createPhysicsStepOutcome();
      const fPools = new EntityPools();
      const fCtx: PhysicsStepContext = {
        skierDef,
        surfaceQuery: flatIceHarness.surfaceQuery,
        terrain: flatIceHarness.terrain,
        pools: fPools,
        contactSolver: fSolver,
        forkBumper: null,
        surface: fSurf,
        ramps: fPools.ramps,
        skiTracks: fPools.skiTracks,
        invulnerable: false,
      };
      try {
        fPose.posX = 0;
        fPose.posY = 0;
        fPose.posZ = 0;
        fPose.velX = 0;
        fPose.velY = 0;
        fPose.velZ = -1.6;
        fPose.headingRad = 0;
        fPose.grounded = true;
        fPose.walking = false;
        fPose.walkPhaseRad = 0;
        for (let t = 0; t < 300 && !fPose.walking; t++) {
          fPhysics.stepSkiing(FIXED_DT, intent, fPose, fCtx, fOut);
        }
        expect(fPose.walking, `flat ${flatSurface} transitions from glide into walking`).toBe(true);
      } finally {
        fSolver.dispose();
      }
    }
  });

  it('blocks skier movement, downhill undercutting, and wipeout tumbles with solid rotated building OBBs (0 B WASM leak)', () => {
    const runtime = resolveDefaultPhysicsRuntime()!;
    const skierDef = getSkierDef('skier_alpine')!;
    const slopeTan = Math.tan(degToRad(25));
    const harness = createAnalyticHarness({
      heightAt: (_x, z) => z * slopeTan,
      surfaceTypeAt: () => 'packed',
    });

    const yaw = 0.7;
    const hw = 2.55;
    const hd = 3.3;
    const h = 5.4;
    const skirt = 2.0;
    const structX = 0;
    const structZ = -24;
    const structY = structZ * slopeTan;

    const obbSignedDist = (px: number, pz: number): number => {
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const dx = px - structX;
      const dz = pz - structZ;
      const lx = dx * cosY - dz * sinY;
      const lz = dx * sinY + dz * cosY;
      const ax = Math.abs(lx) - hw;
      const az = Math.abs(lz) - hd;
      return ax > 0 || az > 0 ? Math.hypot(Math.max(0, ax), Math.max(0, az)) : Math.max(ax, az);
    };

    const runStructureProbe = (): void => {
      const pools = new EntityPools();
      pools.structures.add(
        'building_folk_log',
        1,
        structX,
        structY,
        structZ,
        yaw,
        hw,
        hd,
        h,
        skirt,
        Math.hypot(hw, hd),
        true,
        3,
        0,
      );
      const solver = new JoltContactSolver(runtime, {
        skierRadius: skierDef.stats.collisionRadius,
        skierHeight: skierDef.stats.skierHeight,
      });
      const physics = new SkiPhysics();
      const pose = createMutableSkierPose();
      const surf = createSurfaceSample();
      const outcome = createPhysicsStepOutcome();
      const intent = createMutablePlayerIntent();
      const ctx: PhysicsStepContext = {
        skierDef,
        surfaceQuery: harness.surfaceQuery,
        terrain: harness.terrain,
        pools,
        contactSolver: solver,
        forkBumper: null,
        surface: surf,
        ramps: pools.ramps,
        skiTracks: pools.skiTracks,
        invulnerable: false,
      };

      try {
        // 1. High-speed uphill approach at 24 m/s stops outside rotated building OBB and reports hitStructureIndex === 0
        pose.posX = 0;
        pose.posZ = -12;
        pose.posY = -12 * slopeTan;
        pose.headingRad = 0;
        pose.velX = 0;
        pose.velY = -24 * Math.sin(degToRad(25));
        pose.velZ = -24 * Math.cos(degToRad(25));
        pose.grounded = true;

        let sawStructureHit = false;
        let firstHitPosZ = NaN;
        let minSignedDist = Infinity;
        for (let t = 0; t < 45; t++) {
          physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
          if (outcome.hitStructureIndex === 0) {
            if (!sawStructureHit) firstHitPosZ = pose.posZ;
            sawStructureHit = true;
          }
          minSignedDist = Math.min(minSignedDist, obbSignedDist(pose.posX, pose.posZ));
        }
        expect(sawStructureHit).toBe(true);
        expect(firstHitPosZ).toBeGreaterThan(structZ);
        expect(minSignedDist).toBeGreaterThanOrEqual(skierDef.stats.collisionRadius - 0.12);
        // Rotated front wall deflects skier laterally outside around the corner rather than straight through
        expect(pose.posZ > structZ || Math.abs(pose.posX) > 2.0).toBe(true);

        // 2. Downhill-side approach cannot undercut beneath sloped floor thanks to skirtDepth = 2.0
        physics.reset();
        pose.posX = 0;
        pose.posZ = -29.0;
        pose.posY = -29.0 * slopeTan;
        pose.headingRad = Math.PI;
        pose.carveAngleRad = 0;
        pose.braking = false;
        pose.walking = false;
        pose.walkPhaseRad = 0;
        pose.velX = 0;
        pose.velY = 12 * Math.sin(degToRad(25));
        pose.velZ = 12 * Math.cos(degToRad(25));
        pose.grounded = true;

        let sawDownhillHit = false;
        let firstDownhillHitZ = NaN;
        let minDownhillDist = Infinity;
        for (let t = 0; t < 45; t++) {
          physics.stepSkiing(FIXED_DT, intent, pose, ctx, outcome);
          if (outcome.hitStructureIndex === 0) {
            if (!sawDownhillHit) firstDownhillHitZ = pose.posZ;
            sawDownhillHit = true;
          }
          minDownhillDist = Math.min(minDownhillDist, obbSignedDist(pose.posX, pose.posZ));
        }
        expect(sawDownhillHit).toBe(true);
        expect(firstDownhillHitZ).toBeLessThan(structZ);
        expect(minDownhillDist).toBeGreaterThanOrEqual(skierDef.stats.collisionRadius - 0.12);
        expect(pose.posZ < structZ || Math.abs(pose.posX) > 2.0).toBe(true);

        // 3. Wipeout tumble (invulnerable) still physically deflects outside OBB
        physics.reset();
        pose.carveAngleRad = 0;
        pose.braking = false;
        pose.walking = false;
        pose.posX = 1.0;
        pose.posZ = -17;
        pose.posY = -17 * slopeTan;
        pose.velX = 0;
        pose.velY = -18 * Math.sin(degToRad(25));
        pose.velZ = -18 * Math.cos(degToRad(25));
        pose.grounded = true;
        let minTumbleDist = Infinity;
        for (let t = 0; t < 60; t++) {
          physics.stepWipeout(FIXED_DT, pose, ctx);
          minTumbleDist = Math.min(minTumbleDist, obbSignedDist(pose.posX, pose.posZ));
        }
        expect(minTumbleDist).toBeGreaterThanOrEqual(skierDef.stats.collisionRadius - 0.15);
      } finally {
        solver.dispose();
      }
    };

    // Warmup shape/body allocations then verify exact 0 B WASM memory delta on full structure probe
    runStructureProbe();
    const freeBefore = runtime.getFreeMemory();
    runStructureProbe();
    const freeAfter = runtime.getFreeMemory();
    expect(freeBefore - freeAfter).toBe(0);
  });
});
