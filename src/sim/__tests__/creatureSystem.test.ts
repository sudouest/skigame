import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/eventBus';
import { FIXED_DT } from '../../core/fixedLoop';
import {
  CREATURE_PHASE_ATTACK,
  CREATURE_PHASE_IDLE,
  CREATURE_PHASE_RECOVER,
  CREATURE_PHASE_TELEGRAPH,
  type SimEventMap,
  type SurfaceQueryView,
  type SurfaceSample,
} from '../contracts';
import { CreatureSystem } from '../creatureSystem';
import { CreaturePool } from '../entityPools';

interface MockSurfaceOptions {
  readonly slopeX?: number;
  readonly slopeZ?: number;
  readonly baseY?: number;
  readonly halfWidth?: number;
}

function createCountingSurfaceQuery(options: MockSurfaceOptions = {}) {
  const slopeX = options.slopeX ?? 0;
  const slopeZ = options.slopeZ ?? 0;
  const baseY = options.baseY ?? 0;
  const halfWidth = options.halfWidth ?? 12;

  const nLen = Math.hypot(-slopeX, 1, -slopeZ);
  const nx = -slopeX / nLen;
  const ny = 1 / nLen;
  const nz = -slopeZ / nLen;

  let sampleCount = 0;

  const surfaceQuery: SurfaceQueryView = {
    evaluateHeight(wx: number, wz: number): number {
      return baseY + slopeX * wx + slopeZ * wz;
    },
    sampleSurface(
      posX: number,
      posZ: number,
      hintSegmentId: number,
      _hintS: number,
      out: SurfaceSample,
    ): SurfaceSample {
      sampleCount++;
      out.valid = true;
      out.segmentId = hintSegmentId > 0 ? hintSegmentId : 1;
      out.s = -posZ;
      out.x = posX;
      out.halfWidth = halfWidth;
      out.groundY = baseY + slopeX * posX + slopeZ * posZ;
      out.normalX = nx;
      out.normalY = ny;
      out.normalZ = nz;
      out.tangentX = 0;
      out.tangentY = -slopeZ;
      out.tangentZ = -1;
      out.surfaceType = 'packed';
      out.onPiste = true;
      out.pisteWeight = 1;
      out.inDivider = false;
      out.inChasmZone = false;
      out.chasmWipeoutDepth = 0;
      out.nearestSpineY = out.groundY;
      return out;
    },
  };

  return {
    surfaceQuery,
    getSampleCount: () => sampleCount,
    resetSampleCount: () => {
      sampleCount = 0;
    },
  };
}

function addBear(pool: CreaturePool, x: number, y: number, z: number, phase = CREATURE_PHASE_IDLE): number {
  const idx = pool.add('bear_patrol', 1, x, y, z, 0, 1, 0, 0, 1.2, 1.85, 50, 1);
  pool.stateCode[idx] = phase;
  return idx;
}

describe('CreatureSystem sleep gating and single-sample patrol', () => {
  it('skips AI, movement, telegraphs, and surface queries for bears farther than 85m horizontally', () => {
    const system = new CreatureSystem();
    const pool = new CreaturePool();
    const bus = new EventBus<SimEventMap>();
    const { surfaceQuery, getSampleCount } = createCountingSurfaceQuery();

    let telegraphCount = 0;
    bus.on('CREATURE_TELEGRAPH', () => {
      telegraphCount++;
    });

    const idleFar = addBear(pool, 0, 5, -90, CREATURE_PHASE_IDLE);
    const attackFar = addBear(pool, 0, 5, -86, CREATURE_PHASE_ATTACK);
    const diagFar = addBear(pool, 61, 5, -61, CREATURE_PHASE_ATTACK); // 61^2 + 61^2 = 7442 > 85^2
    pool.stateTimer[attackFar] = 1.25;

    for (let t = 0; t < 120; t++) {
      system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    }

    expect(getSampleCount()).toBe(0);
    expect(telegraphCount).toBe(0);
    expect(pool.stateCode[idleFar]).toBe(CREATURE_PHASE_IDLE);
    expect(pool.stateTimer[idleFar]).toBe(0);
    expect(pool.posX[attackFar]).toBe(0);
    expect(pool.posZ[attackFar]).toBe(-86);
    expect(pool.stateCode[attackFar]).toBe(CREATURE_PHASE_ATTACK);
    expect(pool.stateTimer[attackFar]).toBeCloseTo(1.25, 6);
    expect(pool.posX[diagFar]).toBe(61);
    expect(pool.posZ[diagFar]).toBe(-61);
  });

  it('runs full IDLE -> TELEGRAPH -> ATTACK -> RECOVER -> ATTACK lifecycle within 85m using <= 1 sample/tick at 60 Hz', () => {
    const system = new CreatureSystem();
    const pool = new CreaturePool();
    const bus = new EventBus<SimEventMap>();
    const { surfaceQuery, getSampleCount, resetSampleCount } = createCountingSurfaceQuery({
      slopeX: -0.25,
      slopeZ: 0.35,
      baseY: 10,
    });

    const telegraphs: { distanceToPlayerM: number; edgeSide: string }[] = [];
    bus.on('CREATURE_TELEGRAPH', (ev) => {
      telegraphs.push({ distanceToPlayerM: ev.distanceToPlayerM, edgeSide: ev.edgeSide });
    });

    const idx = addBear(pool, 0, 10 - 0.35 * 40, -40, CREATURE_PHASE_IDLE);

    // Tick 1: enters TELEGRAPH without querying surface yet
    system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    expect(pool.stateCode[idx]).toBe(CREATURE_PHASE_TELEGRAPH);
    expect(telegraphs).toHaveLength(1);
    expect(telegraphs[0]!.distanceToPlayerM).toBeCloseTo(40, 4);
    expect(telegraphs[0]!.edgeSide).toBe('center');
    expect(getSampleCount()).toBe(0);

    // Complete 0.75s telegraph (46 ticks at 60 Hz avoids float 45/60 < 0.75 edge)
    for (let t = 0; t < 46; t++) {
      system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    }
    expect(pool.stateCode[idx]).toBe(CREATURE_PHASE_ATTACK);

    // Measure 60 ticks of ATTACK: strictly 1 sampleSurface per tick + accurate slope-projected groundY
    resetSampleCount();
    const startX = pool.posX[idx]!;
    for (let t = 0; t < 60; t++) {
      system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    }
    expect(getSampleCount()).toBe(60);
    expect(Math.abs(pool.posX[idx]! - startX)).toBeGreaterThan(2.0);
    const exactY = surfaceQuery.evaluateHeight(pool.posX[idx]!, pool.posZ[idx]!);
    expect(pool.posY[idx]!).toBeCloseTo(exactY, 3);
    expect(pool.groundY[idx]!).toBeCloseTo(exactY, 3);

    // Advance past 5.0s attack duration into RECOVER (0 samples during RECOVER)
    for (let t = 0; t < 250; t++) {
      system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    }
    expect(pool.stateCode[idx]).toBe(CREATURE_PHASE_RECOVER);
    resetSampleCount();
    system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    expect(getSampleCount()).toBe(0);

    // Complete 0.8s recover back to ATTACK
    for (let t = 0; t < 49; t++) {
      system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    }
    expect(pool.stateCode[idx]).toBe(CREATURE_PHASE_ATTACK);
  });

  it('wakes and sleeps cleanly across the 85m boundary without losing state', () => {
    const system = new CreatureSystem();
    const pool = new CreaturePool();
    const bus = new EventBus<SimEventMap>();
    const { surfaceQuery, getSampleCount, resetSampleCount } = createCountingSurfaceQuery();

    const idx = addBear(pool, 0, 0, -84.9, CREATURE_PHASE_ATTACK);

    // Active at 84.9m
    system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    expect(getSampleCount()).toBe(1);
    const activeX = pool.posX[idx]!;
    expect(activeX).toBeGreaterThan(0);

    // Skier moves away -> > 85m -> sleeps
    resetSampleCount();
    system.step(FIXED_DT, 0, 2.0, 0, pool, surfaceQuery, bus);
    expect(getSampleCount()).toBe(0);
    expect(pool.posX[idx]).toBe(activeX);

    // Skier moves back within 85m -> resumes patrolling
    system.step(FIXED_DT, 0, 0, 0, pool, surfaceQuery, bus);
    expect(getSampleCount()).toBe(1);
    expect(pool.posX[idx]!).toBeGreaterThan(activeX);
  });

  it('re-samples destination when a single step exceeds the reuse distance threshold', () => {
    const system = new CreatureSystem();
    const pool = new CreaturePool();
    const bus = new EventBus<SimEventMap>();
    const { surfaceQuery, getSampleCount } = createCountingSurfaceQuery({ slopeX: 0.3 });

    const idx = addBear(pool, 0, 0, -20, CREATURE_PHASE_ATTACK);
    // dt = 0.1s moves ~0.438m (> 0.25m), triggering destination re-sample
    system.step(0.1, 0, 0, 0, pool, surfaceQuery, bus);

    expect(getSampleCount()).toBe(2);
    expect(pool.posY[idx]!).toBeCloseTo(surfaceQuery.evaluateHeight(pool.posX[idx]!, pool.posZ[idx]!), 4);
  });
});
