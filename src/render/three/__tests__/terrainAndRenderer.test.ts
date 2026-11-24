import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  STAGE_BLIZZARD_RIDGE,
  STAGE_ICY_BLACK,
  STAGE_POWDER_BOWL,
  STAGE_SUNNY_BLUE,
} from '../../../content/stages';
import { DEFAULT_SCENERY_TIER_RULES } from '../../../content/sceneryRules';
import { EventBus } from '../../../core/eventBus';
import { FIXED_DT } from '../../../core/fixedLoop';
import { clamp } from '../../../core/math';
import { Profiler } from '../../../core/profiler';
import {
  CREATURE_PHASE_TELEGRAPH,
  createMountainColumnOut,
  createMountainSampleOut,
  createMutablePlayerIntent,
  createSurfaceSample,
  type ChunkRangeOut,
  type MountainColumnOut,
  type MountainFieldView,
  type MountainSampleOut,
  type ReadonlySimState,
  type RibbonPointOut,
  type SegmentLandmarkRequirement,
  type SimEvents,
  type SpineFrameOut,
  type SpineView,
  type TerrainSegmentView,
  type TrailSlotRole,
  type TrailWindowView,
} from '../../../sim/contracts';
import { MountainField } from '../../../sim/mountainField';
import { SkiSimulation } from '../../../sim/skiSimulation';
import { TrailWindow } from '../../../sim/trailWindow';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { InstancePools, MAX_STATIC_BILLBOARDS } from '../instancePools';
import { LandmarkStreamer } from '../landmarkStreamer';
import { createForkArchObject, createProceduralMeshAssets } from '../meshFactory';
import { ThreeRenderer } from '../renderer';
import {
  TerrainStreamer,
  packTileKey,
  type TileSceneryItem,
} from '../terrainStreamer';
import {
  evaluateSceneryRuleFitness,
  selectWinningSceneryRule,
  type SceneryEnvSignal,
} from '../scenerySelector';
import {
  CLIFF_ROCK_FULL_NY_INNER,
  CLIFF_ROCK_FULL_NY_OUTER,
  INNER_TILE_QUADS,
  INNER_TILE_SIZE_M,
  INNER_TILE_SPACING_M,
  OUTER_TILE_QUADS,
  OUTER_TILE_SIZE_M,
  TerrainTilePool,
} from '../terrainTilePool';
import { createSharedToonMaterials } from '../toonMaterials';

function createMockSegment(
  id: number,
  slot: TrailSlotRole,
  stageId: string,
  startZ: number,
  length = 140,
  chunkLength = 35,
  landmarks: SegmentLandmarkRequirement[] = [],
  seed = 100 + id,
): TerrainSegmentView {
  const chunkCount = Math.ceil(length / chunkLength);
  return {
    id,
    slot,
    stageId,
    seed,
    length,
    chunkLength,
    chunkCount,
    prevSegmentId: null,
    nextLeftId: null,
    nextRightId: null,
    fork: {
      hasFork: slot === 'curr',
      obstacleFreeStartS: length - 50,
      leftStageId: 'sunny-blue',
      rightStageId: 'icy-black',
      isForkChild: false,
      forkSide: 'none',
      innerWallRampLength: 25,
      seamNoseRadius: 1.5,
      seamWorldX: 0,
      seamWorldY: -length * 0.25,
      seamWorldZ: startZ - length,
      seamYawRad: 0,
    },
    landmarks,
    getChunkBounds(chunkIndex: number, out: ChunkRangeOut): void {
      out.startS = chunkIndex * chunkLength;
      out.endS = Math.min(length, (chunkIndex + 1) * chunkLength);
    },
    sampleSpineFrame(s: number, out: SpineFrameOut): void {
      out.posX = 0;
      out.posY = -s * 0.25;
      out.posZ = startZ - s;
      out.forwardX = 0;
      out.forwardY = -0.2425;
      out.forwardZ = -0.9701;
      out.rightX = 1;
      out.rightY = 0;
      out.rightZ = 0;
      out.yawRad = 0;
      out.pitchRad = -0.245;
      out.bankRad = 0;
      out.curvature = 0;
      out.halfWidth = 14;
      out.skirtWidth = 12;
      out.dividerHalfWidth = 0;
    },
    evaluateSurfaceAtX(s: number, x: number, out: RibbonPointOut): void {
      const halfW = 14;
      const skirt = 12;
      const clampedX = Math.max(-(halfW + skirt), Math.min(halfW + skirt, x));
      const bankRaise = Math.abs(clampedX) > halfW ? (Math.abs(clampedX) - halfW) * 0.18 : 0;
      out.posX = clampedX;
      out.posY = -s * 0.25 + bankRaise;
      out.posZ = startZ - s;
      out.normalX = 0;
      out.normalY = 0.97;
      out.normalZ = -0.24;
      out.lateralX = clampedX;
      out.halfWidth = halfW;
      out.skirtWidth = skirt;
      out.slopeDeg = 14;
      out.localHeight = bankRaise;
      out.surfaceType = Math.abs(clampedX) < 3 && s > 40 && s < 70 ? 'ice' : 'packed';
      out.inPlayableCorridor = Math.abs(clampedX) <= halfW;
      out.inDivider = false;
      out.isInnerForkSlope = false;
    },
    sampleSafeX(): number {
      return 0;
    },
  };
}

function createMockMountainField(worldSeed = 1337): MountainFieldView {
  const state = {
    worldSeed,
    originOffsetX: 0,
    originOffsetZ: 0,
  };
  return {
    get worldSeed(): number {
      return state.worldSeed;
    },
    get originOffsetX(): number {
      return state.originOffsetX;
    },
    get originOffsetZ(): number {
      return state.originOffsetZ;
    },
    collectSpinesInBounds(
      _minX: number,
      _maxX: number,
      _minZ: number,
      _maxZ: number,
      _padM: number,
      outSpines: SpineView[],
    ): void {
      outSpines.length = 0;
    },
    evaluateHeight(wx: number, wz: number): number {
      const absX = wx + state.originOffsetX;
      const absZ = wz + state.originOffsetZ;
      return absZ * 0.25 + Math.sin(absX * 0.08) * 1.5;
    },
    evaluateColumn(wx: number, wz: number, out: MountainColumnOut): MountainColumnOut {
      const base = createMountainColumnOut();
      Object.assign(out, base);
      const absX = wx + state.originOffsetX;
      const absZ = wz + state.originOffsetZ;
      const h = absZ * 0.25 + Math.sin(absX * 0.08) * 1.5;
      out.heightY = h;
      out.macroY = absZ * 0.25;
      out.onPiste = Math.abs(absX) <= 14;
      out.pisteWeight = out.onPiste ? 1 : 0;
      out.nearestSignedX = absX;
      return out;
    },
    evaluate(wx: number, wz: number, out: MountainSampleOut): MountainSampleOut {
      const base = createMountainSampleOut();
      Object.assign(out, base);
      const absX = wx + state.originOffsetX;
      const absZ = wz + state.originOffsetZ;
      out.heightY = absZ * 0.25 + Math.sin(absX * 0.08) * 1.5;
      out.macroY = absZ * 0.25;
      out.onPiste = Math.abs(absX) <= 14;
      out.pisteWeight = out.onPiste ? 1 : 0;
      out.nearestSignedX = absX;
      out.normalX = 0;
      out.normalY = 0.96;
      out.normalZ = -0.25;
      return out;
    },
  };
}

function createMockSimState(): ReadonlySimState {
  const currLandmarks: SegmentLandmarkRequirement[] = [
    {
      id: 'fork_arch_1_left',
      kind: 'forkArch',
      segmentId: 1,
      s: 140,
      x: -13,
      worldX: -13,
      worldY: -35,
      worldZ: -140,
      yawRad: 0,
      clearanceRadius: 4.5,
      visual: { kind: 'procedural', preset: 'arch', palette: ['#78350f'], outline: false },
      badgeStageId: 'sunny-blue',
      forkSide: 'left',
      gateHalfWidth: 13,
    },
    {
      id: 'fork_arch_1_right',
      kind: 'forkArch',
      segmentId: 1,
      s: 140,
      x: 13,
      worldX: 13,
      worldY: -35,
      worldZ: -140,
      yawRad: 0,
      clearanceRadius: 4.5,
      visual: { kind: 'procedural', preset: 'arch', palette: ['#78350f'], outline: false },
      badgeStageId: 'icy-black',
      forkSide: 'right',
      gateHalfWidth: 13,
    },
    {
      id: 'cabin_1',
      kind: 'deliveryLandmark',
      segmentId: 1,
      s: 20,
      x: -10,
      worldX: -10,
      worldY: -5,
      worldZ: -20,
      yawRad: 0,
      clearanceRadius: 4,
      visual: { kind: 'procedural', preset: 'cabin', palette: ['#7f4f24'], outline: true },
    },
  ];

  const curr = createMockSegment(1, 'curr', 'sunny-blue', 0, 140, 35, currLandmarks);
  const nextLeft = createMockSegment(2, 'nextLeft', 'sunny-blue', -140, 105, 35);
  const nextRight = createMockSegment(3, 'nextRight', 'icy-black', -140, 105, 35);

  return {
    tickCount: 120,
    elapsedSec: 2.0,
    distanceM: 50,
    paused: false,
    gameMode: 'endless',
    livesRemaining: 3,
    gameOver: false,
    skierId: 'skier_alpine',
    skierState: 'skiing',
    prevSkier: {
      posX: 0,
      posY: -2,
      posZ: -8,
      velX: 0,
      velY: -3,
      velZ: -20,
      headingRad: 0,
      carveAngleRad: 0.1,
      pitchRad: -0.24,
      speed: 20,
      groundY: -2,
      normalX: 0,
      normalY: 0.97,
      normalZ: 0.24,
      grounded: true,
      braking: false,
    },
    currSkier: {
      posX: 0.4,
      posY: -2.5,
      posZ: -10,
      velX: 1,
      velY: -3,
      velZ: -20,
      headingRad: -0.05,
      carveAngleRad: 0.15,
      pitchRad: -0.24,
      speed: 20.5,
      groundY: -2.5,
      normalX: 0,
      normalY: 0.97,
      normalZ: 0.24,
      grounded: true,
      braking: false,
    },
    surfaceSample: {
      ...createSurfaceSample(),
      segmentId: 1,
      s: 10,
      x: 0.4,
      groundY: -2.5,
      normalX: 0,
      normalY: 0.97,
      normalZ: -0.24,
      tangentX: 0,
      tangentY: -0.24,
      tangentZ: -0.97,
      halfWidth: 14,
      surfaceType: 'packed',
      onPiste: true,
      pisteWeight: 1,
      inDivider: false,
      valid: true,
    },
    wipeoutTimerSec: 0,
    wipeoutDurationSec: 1.2,
    invulnerableTimerSec: 0,
    invulnerableDurationSec: 1.5,
    prevCamera: {
      posX: 0,
      posY: 2,
      posZ: 2,
      lookAtX: 0,
      lookAtY: -6,
      lookAtZ: -26,
      rollRad: 0,
      minHorizontalFovDeg: 66,
      speedFovBoostDeg: 4,
    },
    currCamera: {
      posX: 0.4,
      posY: 1.5,
      posZ: 0,
      lookAtX: 0.4,
      lookAtY: -6.5,
      lookAtZ: -28,
      rollRad: 0.03,
      minHorizontalFovDeg: 66,
      speedFovBoostDeg: 5,
    },
    score: 250,
    highCombo: 3,
    comboCount: 2,
    comboMultiplier: 1.5,
    comboTimerSec: 3.0,
    comboDurationSec: 5.0,
    carriedCount: 2,
    maxCarryCapacity: 12,
    carriedPresentDefIds: ['gift_standard', 'gift_golden'],
    deliveredTotal: 1,
    activeStageId: 'sunny-blue',
    activeWeather: {
      profileId: 'weather_blizzard',
      blizzardEnabled: true,
      blizzardIntensity: 0.8,
      snowParticleCount: 240,
      windLateral: 10,
      fogDistanceM: 40, // Intentionally < 65m to verify renderer clamps density >= 65m
      blizzardDim: 0.35,
    },
    trailWindow: { prev: null, curr, nextLeft, nextRight },
    mountainField: createMockMountainField(1337),
    rebase: {
      rebaseCount: 0,
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
      lastDeltaX: 0,
      lastDeltaY: 0,
      lastDeltaZ: 0,
    },
    entities: {
      hazards: {
        count: 3,
        capacity: 16,
        defIds: ['boulder_small', 'boulder_large', 'pine_tree'],
        segmentIds: new Int32Array([1, 1, 1]),
        posX: new Float32Array([-2, 3, -6]),
        posY: new Float32Array([-4, -6, -8]),
        posZ: new Float32Array([-16, -24, -32]),
        normalX: new Float32Array([0, 0, 0]),
        normalY: new Float32Array([0.97, 0.97, 0.97]),
        normalZ: new Float32Array([0.24, 0.24, 0.24]),
        yawRad: new Float32Array([0.2, 1.1, 0]),
        scale: new Float32Array([0.85, 1.85, 1]),
        radius: new Float32Array([0.95, 1.85, 0.8]),
        height: new Float32Array([0.72, 2.35, 6.5]),
        triggered: new Uint8Array([0, 0, 0]),
      },
      presents: {
        count: 2,
        capacity: 16,
        defIds: ['gift_standard', 'gift_golden'],
        segmentIds: new Int32Array([1, 1]),
        posX: new Float32Array([0, 1]),
        posY: new Float32Array([-5, -7]),
        posZ: new Float32Array([-20, -28]),
        bobPhase: new Float32Array([0, 1.5]),
        collected: new Uint8Array([0, 0]),
      },
      tossedPresents: {
        count: 1,
        capacity: 8,
        defIds: ['gift_golden'],
        prevPosX: new Float32Array([0]),
        prevPosY: new Float32Array([-2]),
        prevPosZ: new Float32Array([-10]),
        posX: new Float32Array([-2]),
        posY: new Float32Array([0.5]),
        posZ: new Float32Array([-14]),
        prevSpinRad: new Float32Array([0]),
        spinRad: new Float32Array([1.2]),
        progress: new Float32Array([0.5]),
        kind: new Uint8Array([0]),
      },
      deliveryZones: {
        count: 1,
        capacity: 8,
        defIds: ['sled_duo'],
        segmentIds: new Int32Array([1]),
        posX: new Float32Array([-9]),
        posY: new Float32Array([-5]),
        posZ: new Float32Array([-20]),
        yawRad: new Float32Array([0]),
        radius: new Float32Array([8]),
        deliveredCount: new Uint8Array([0]),
        active: new Uint8Array([1]),
        celebratingTimer: new Float32Array([0]),
      },
      creatures: {
        count: 1,
        capacity: 8,
        defIds: ['bear_patrol'],
        segmentIds: new Int32Array([1]),
        prevPosX: new Float32Array([4]),
        prevPosY: new Float32Array([-9]),
        prevPosZ: new Float32Array([-36]),
        posX: new Float32Array([3.8]),
        posY: new Float32Array([-9]),
        posZ: new Float32Array([-36]),
        normalX: new Float32Array([0]),
        normalY: new Float32Array([0.97]),
        normalZ: new Float32Array([0.24]),
        prevHeadingRad: new Float32Array([1.5]),
        headingRad: new Float32Array([1.5]),
        groundY: new Float32Array([-9]),
        stateCode: new Uint8Array([CREATURE_PHASE_TELEGRAPH]),
        stateTimer: new Float32Array([0.4]),
        telegraphProgress: new Float32Array([0.6]),
        radius: new Float32Array([1.2]),
      },
      skiTracks: {
        count: 3,
        capacity: 16,
        head: 3,
        posX: new Float32Array([0, 0.2, 0.4]),
        posY: new Float32Array([-1.5, -2.0, -2.5]),
        posZ: new Float32Array([-6, -8, -10]),
        normalX: new Float32Array([0, 0, 0]),
        normalY: new Float32Array([0.97, 0.97, 0.97]),
        normalZ: new Float32Array([0.24, 0.24, 0.24]),
        rightX: new Float32Array([1, 1, 1]),
        rightY: new Float32Array([0, 0, 0]),
        rightZ: new Float32Array([0, 0, 0]),
        ageSec: new Float32Array([0.3, 0.15, 0]),
        grounded: new Uint8Array([1, 1, 1]),
      },
      ramps: {
        count: 1,
        capacity: 8,
        defIds: ['ski_ramp_standard'],
        segmentIds: new Int32Array([1]),
        posX: new Float32Array([2]),
        posY: new Float32Array([-10]),
        posZ: new Float32Array([-40]),
        yawRad: new Float32Array([0]),
        pitchRad: new Float32Array([-0.24]),
        width: new Float32Array([4.2]),
        length: new Float32Array([6.5]),
        height: new Float32Array([1.35]),
      },
    },
    debugDraw: {
      enabled: true,
      safePathPointCount: 3,
      safePathPoints: new Float32Array([0, -2, -8, 0, -5, -20, 0, -8, -32]),
      safePathSegmentIds: new Int32Array([1, 1, 1]),
      colliderCount: 2,
      colliderPositions: new Float32Array([-2, -4, -16, 3, -6, -24]),
      colliderRadii: new Float32Array([0.95, 1.85]),
      colliderHeights: new Float32Array([0.72, 2.35]),
      colliderKinds: new Uint8Array([0, 1]),
      deliveryZoneCount: 1,
      deliveryPositions: new Float32Array([-9, -5, -20]),
      deliveryRadii: new Float32Array([8]),
      forkCount: 1,
      forkApexPositions: new Float32Array([0, -35, -140]),
      forkLeftTargets: new Float32Array([-8, -36, -146]),
      forkRightTargets: new Float32Array([8, -36, -146]),
      forkNoseRadii: new Float32Array([1.5]),
      chunkBoundaryCount: 1,
      chunkBoundaryLines: new Float32Array([-14, -8.75, -35, 14, -8.75, -35]),
      skierPos: new Float32Array([0.4, -2.5, -10]),
      skierNormal: new Float32Array([0, 0.97, 0.24]),
      skierDownhill: new Float32Array([0, -0.24, -0.97]),
      skierVelocity: new Float32Array([1, -3, -20]),
    },
  };
}

describe('TerrainTilePool, TerrainStreamer, LandmarkStreamer & ThreeRenderer', () => {
  it('streams 2-tier world tiles with +Y CCW top winding, valid bounds, atomic 2x2 LOD swap, and zero GPU leaks', () => {
    let clockMs = 0;
    const eventBus = new EventBus<SimEvents>();
    const profiler = new Profiler();
    const renderer = new ThreeRenderer(null, eventBus, profiler, {
      headless: true,
      initialWidth: 390,
      initialHeight: 844,
      nowMs: () => clockMs,
    });

    const simState = createMockSimState();

    // Stream across multiple frames until all 36 inner + 49 outer = 85 tiles finish
    for (let f = 0; f < 30; f++) {
      clockMs += 16;
      renderer.sync(simState, 0.5, 1 / 60, 50);
      if (renderer.terrainStreamer.queuedTileCount === 0) break;
    }

    expect(renderer.terrainStreamer.activeTileCount).toBe(85);
    expect(renderer.terrainStreamer.queuedTileCount).toBe(0);
    expect(renderer.terrainStreamer.tilePool.innerActiveCount).toBe(36);
    expect(renderer.terrainStreamer.tilePool.outerActiveCount).toBe(49);
    expect(renderer.terrainStreamer.tilePool.innerCapacity).toBe(48);
    expect(renderer.terrainStreamer.tilePool.outerCapacity).toBe(96);

    // Check visible counts: all 36 lod=0 inner tiles visible, 9 inner parents hidden, 40 outer visible
    let innerVisible = 0;
    let outerVisible = 0;
    let outerHiddenReady = 0;
    for (let i = 0; i < renderer.terrainStreamer.tilePool.innerCapacity; i++) {
      const slot = renderer.terrainStreamer.tilePool.getSlot(0, i)!;
      if (slot.inUse && slot.container.visible) innerVisible++;
    }
    for (let i = 0; i < renderer.terrainStreamer.tilePool.outerCapacity; i++) {
      const slot = renderer.terrainStreamer.tilePool.getSlot(1, i)!;
      if (slot.inUse) {
        if (slot.container.visible) outerVisible++;
        else if (slot.ready) outerHiddenReady++;
      }
    }
    expect(innerVisible).toBe(36);
    expect(outerHiddenReady).toBe(9);
    expect(outerVisible).toBe(40);

    // Verify geometry buffers, bounding spheres, +Y CCW top surface winding, and outward skirts
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const triN = new THREE.Vector3();

    for (const lod of [0, 1] as const) {
      const slot = renderer.terrainStreamer.tilePool.getSlot(lod, 0)!;
      expect(slot.inUse).toBe(true);
      expect(slot.ready).toBe(true);
      expect(slot.posAttr.array).toBe(slot.positions);
      expect(slot.normAttr.array).toBe(slot.normals);
      expect(slot.colAttr.array).toBe(slot.colors);

      const bs = slot.geometry.boundingSphere;
      expect(bs).not.toBeNull();
      expect(Number.isFinite(bs!.radius)).toBe(true);
      expect(bs!.radius).toBeGreaterThan(15);

      for (let k = 0; k < slot.positions.length; k++) {
        expect(Number.isFinite(slot.positions[k]!)).toBe(true);
        expect(Number.isFinite(slot.normals[k]!)).toBe(true);
        expect(Number.isFinite(slot.colors[k]!)).toBe(true);
      }

      const idxArr = slot.geometry.getIndex()!.array;
      for (let k = 0; k < slot.spec.topIndexCount; k += 3) {
        const ia = idxArr[k]! * 3;
        const ib = idxArr[k + 1]! * 3;
        const ic = idxArr[k + 2]! * 3;
        vA.set(slot.positions[ia]!, slot.positions[ia + 1]!, slot.positions[ia + 2]!);
        vB.set(slot.positions[ib]!, slot.positions[ib + 1]!, slot.positions[ib + 2]!);
        vC.set(slot.positions[ic]!, slot.positions[ic + 1]!, slot.positions[ic + 2]!);
        e1.subVectors(vB, vA);
        e2.subVectors(vC, vA);
        triN.crossVectors(e1, e2);
        expect(triN.y).toBeGreaterThan(0);
      }

      // Skirt triangles sit immediately after topIndexCount and drop -skirtDepth vertically
      const skirtTrisPerEdge = slot.spec.quads * 2 * 3;
      for (let k = slot.spec.topIndexCount; k < slot.spec.totalIndexCount; k += 3) {
        const ia = idxArr[k]! * 3;
        const ib = idxArr[k + 1]! * 3;
        const ic = idxArr[k + 2]! * 3;
        vA.set(slot.positions[ia]!, slot.positions[ia + 1]!, slot.positions[ia + 2]!);
        vB.set(slot.positions[ib]!, slot.positions[ib + 1]!, slot.positions[ib + 2]!);
        vC.set(slot.positions[ic]!, slot.positions[ic + 1]!, slot.positions[ic + 2]!);
        e1.subVectors(vB, vA);
        e2.subVectors(vC, vA);
        triN.crossVectors(e1, e2);
        expect(Math.abs(triN.y)).toBeLessThan(1e-4);

        const edgeIdx = Math.floor((k - slot.spec.topIndexCount) / skirtTrisPerEdge);
        if (edgeIdx === 0) expect(triN.z).toBeLessThan(0); // North -Z
        if (edgeIdx === 1) expect(triN.z).toBeGreaterThan(0); // South +Z
        if (edgeIdx === 2) expect(triN.x).toBeLessThan(0); // West -X
        if (edgeIdx === 3) expect(triN.x).toBeGreaterThan(0); // East +X
      }
    }

    // Fog density clamped >= 65m
    const fog = renderer.scene.fog as THREE.FogExp2;
    expect(fog.density).toBeLessThanOrEqual(1.6 / 65 + 1e-4);

    // Verify instanced pools, landmarks, shadows, ski tracks, backpack stack, debug overlay
    const poolsRoot = renderer.scene.getObjectByName('InstancePoolsRoot')!;
    const boulderSmallPool = poolsRoot.getObjectByName('BoulderSmallPool') as THREE.InstancedMesh;
    const boulderLargePool = poolsRoot.getObjectByName('BoulderLargePool') as THREE.InstancedMesh;
    const presentStdPool = poolsRoot.getObjectByName('PresentStdPool') as THREE.InstancedMesh;
    const presentGoldPool = poolsRoot.getObjectByName('PresentGoldPool') as THREE.InstancedMesh;
    const rampPool = poolsRoot.getObjectByName('RampPool') as THREE.InstancedMesh;
    const dynBbPool = poolsRoot.getObjectByName('DynamicBillboardPool') as THREE.InstancedMesh;
    const staticBbPool = poolsRoot.getObjectByName('StaticSceneryBillboardPool') as THREE.InstancedMesh;
    expect(boulderSmallPool.count).toBe(1);
    expect(boulderLargePool.count).toBe(1);
    expect(presentStdPool.count).toBe(1);
    expect(presentGoldPool.count).toBe(1);
    expect(rampPool.count).toBe(1);
    expect(dynBbPool.count).toBe(4);
    expect(staticBbPool.count).toBeGreaterThan(0);
    expect(staticBbPool.count).toBeLessThanOrEqual(MAX_STATIC_BILLBOARDS);
    expect(boulderSmallPool.frustumCulled).toBe(false);
    expect(dynBbPool.frustumCulled).toBe(false);
    expect(staticBbPool.frustumCulled).toBe(false);

    const forkArches: THREE.Object3D[] = [];
    renderer.scene.traverse((obj) => {
      if (obj.name === 'ForkArchLandmark') forkArches.push(obj);
    });
    expect(forkArches).toHaveLength(2);
    expect(
      forkArches.some((a) => a.getObjectByName('ForkBadgeSquare')?.visible === true),
    ).toBe(true);
    expect(
      forkArches.some((a) => a.getObjectByName('ForkBadgeDiamond')?.visible === true),
    ).toBe(true);

    const shadowsPool = renderer.scene.getObjectByName('ContactShadowsPool') as THREE.InstancedMesh;
    expect(shadowsPool.count).toBe(7);

    const skiTracks = renderer.scene.getObjectByName('SkiTracksMesh') as THREE.Mesh;
    expect(skiTracks.geometry.drawRange.count).toBe(24);

    const backpackStd = renderer.scene.getObjectByName('BackpackStackStd') as THREE.InstancedMesh;
    const backpackGold = renderer.scene.getObjectByName('BackpackStackGold') as THREE.InstancedMesh;
    expect(backpackStd.count).toBe(1);
    expect(backpackGold.count).toBe(1);

    const debugRoot = renderer.scene.getObjectByName('DebugOverlay3DRoot')!;
    expect(debugRoot.visible).toBe(true);

    // Leak check & clean resize + dispose
    expect(renderer.runLeakCheck(0, true).totalLeaks).toBe(0);

    renderer.resize(450, 900);
    expect(renderer.camera.aspect).toBeCloseTo(0.5, 5);

    renderer.dispose();
    const afterDispose = renderer.getStats().graphics;
    expect(afterDispose.activeObjects).toBe(0);
    expect(afterDispose.activeGeometries).toBe(0);
    expect(afterDispose.activeMaterials).toBe(0);
    expect(afterDispose.activeTextures).toBe(0);
    expect(afterDispose.cachedGeometries).toBe(0);
    expect(afterDispose.cachedMaterials).toBe(0);
    expect(afterDispose.cachedTextures).toBe(0);
  });

  it('performs atomic 2x2 child vs 64m parent LOD visibility and scenery swap', () => {
    let clockMs = 0;
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const streamer = new TerrainStreamer(gfx, mats, {
      nowMs: () => {
        clockMs += 0.35;
        return clockMs;
      },
    });

    const simState = createMockSimState();
    // Run with tight budget so 3x3 inner lod=1 parents finish while lod=0 2x2 blocks are partial
    streamer.step(simState.trailWindow, simState.mountainField, 0, -10, 0, -1, 3);

    // For every 64m parent cell (px, pz), either all 4 children are visible + parent hidden,
    // OR all 4 children are hidden + ready parent is visible!
    const assertAtomicParents = (): void => {
      for (let pz = -2; pz <= 0; pz++) {
        for (let px = -1; px <= 1; px++) {
          let parentSlot = null;
          for (let i = 0; i < streamer.tilePool.outerCapacity; i++) {
            const s = streamer.tilePool.getSlot(1, i)!;
            if (s.inUse && s.absTileX === px && s.absTileZ === pz) {
              parentSlot = s;
              break;
            }
          }

          let childrenReady = 0;
          let childrenVisible = 0;
          for (let cz = 0; cz < 2; cz++) {
            for (let cx = 0; cx < 2; cx++) {
              const tx = px * 2 + cx;
              const tz = pz * 2 + cz;
              for (let i = 0; i < streamer.tilePool.innerCapacity; i++) {
                const cs = streamer.tilePool.getSlot(0, i)!;
                if (cs.inUse && cs.absTileX === tx && cs.absTileZ === tz) {
                  if (cs.ready) childrenReady++;
                  if (cs.container.visible) childrenVisible++;
                  break;
                }
              }
            }
          }

          if (childrenReady < 4) {
            expect(childrenVisible).toBe(0);
            if (parentSlot?.ready) {
              expect(parentSlot.container.visible).toBe(true);
            }
          } else {
            expect(childrenVisible).toBe(4);
            if (parentSlot) {
              expect(parentSlot.container.visible).toBe(false);
              expect(parentSlot.ready).toBe(true);
            }
          }
        }
      }
    };

    assertAtomicParents();
    let revAfterPartial = streamer.sceneryRevision;

    // Step slowly until all tiles finish, verifying atomic invariant at every step
    for (let f = 0; f < 160 && streamer.queuedTileCount > 0; f++) {
      streamer.step(simState.trailWindow, simState.mountainField, 0, -10, 0, -1, 3);
      assertAtomicParents();
    }
    expect(streamer.queuedTileCount).toBe(0);
    expect(streamer.sceneryRevision).toBeGreaterThan(revAfterPartial);

    streamer.clearAll();
    tracker.disposeAll();
  });

  it('preserves zero vertex uploads on WORLD_REBASED, mid-stream height invariance, and multi-rebase offset fallback', () => {
    // 1. Zero vertex buffer uploads on WORLD_REBASED
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });
    const simState = createMockSimState();

    for (let f = 0; f < 10; f++) {
      renderer.sync(simState, 0.5, 1 / 60, 50);
    }
    expect(renderer.terrainStreamer.queuedTileCount).toBe(0);

    const innerSlot = renderer.terrainStreamer.tilePool.getSlot(0, 0)!;
    const outerSlot = renderer.terrainStreamer.tilePool.getSlot(1, 0)!;
    expect(innerSlot.inUse).toBe(true);
    expect(outerSlot.inUse).toBe(true);

    const prevInnerPos = innerSlot.container.position.clone();
    const prevInnerUploads = innerSlot.positionUploadCount;
    const prevOuterPos = outerSlot.container.position.clone();
    const prevOuterUploads = outerSlot.positionUploadCount;
    const prevRev = renderer.terrainStreamer.sceneryRevision;

    eventBus.emit('WORLD_REBASED', {
      rebaseCount: 1,
      deltaX: 16,
      deltaY: -32,
      deltaZ: -128,
      totalOffsetX: 16,
      totalOffsetY: -32,
      totalOffsetZ: -128,
    });

    expect(innerSlot.container.position.x).toBeCloseTo(prevInnerPos.x - 16, 5);
    expect(innerSlot.container.position.y).toBeCloseTo(prevInnerPos.y + 32, 5);
    expect(innerSlot.container.position.z).toBeCloseTo(prevInnerPos.z + 128, 5);
    expect(innerSlot.positionUploadCount).toBe(prevInnerUploads);

    expect(outerSlot.container.position.x).toBeCloseTo(prevOuterPos.x - 16, 5);
    expect(outerSlot.container.position.y).toBeCloseTo(prevOuterPos.y + 32, 5);
    expect(outerSlot.container.position.z).toBeCloseTo(prevOuterPos.z + 128, 5);
    expect(outerSlot.positionUploadCount).toBe(prevOuterUploads);
    expect(renderer.terrainStreamer.sceneryRevision).toBeGreaterThan(prevRev);

    // 2. Multi-rebase fallback without EventBus notification (2 missed rebases accumulated in offsetX/Y/Z)
    const beforeFallbackPos = innerSlot.container.position.clone();
    const beforeFallbackUploads = innerSlot.positionUploadCount;
    const multiRebaseState: ReadonlySimState = {
      ...simState,
      rebase: {
        rebaseCount: 3, // jumped from 1 -> 3!
        offsetX: 16 + 10,
        offsetY: -32 - 40,
        offsetZ: -128 - 256,
        lastDeltaX: 5,
        lastDeltaY: -20,
        lastDeltaZ: -128,
      },
    };
    renderer.sync(multiRebaseState, 0.5, 1 / 60, 50);
    // Must shift by FULL (offset - lastOriginOffset) = (+10, -40, -256), not just lastDelta!
    expect(innerSlot.container.position.x).toBeCloseTo(beforeFallbackPos.x - 10, 5);
    expect(innerSlot.container.position.y).toBeCloseTo(beforeFallbackPos.y + 40, 5);
    expect(innerSlot.container.position.z).toBeCloseTo(beforeFallbackPos.z + 256, 5);
    expect(innerSlot.positionUploadCount).toBe(beforeFallbackUploads);

    renderer.dispose();

    // 3. Mid-stream rebase height invariance across TerrainTilePool.writeBorderRow yields
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const pool = new TerrainTilePool(gfx, mats.terrainMaterial, {
      innerCapacity: 4,
      outerCapacity: 2,
    });

    const trailWin = new TrailWindow(4242, 'icy-black');
    const field = new MountainField(trailWin);
    field.setWorldSeed(4242);

    const midSlot = pool.acquireSlot(0, 0, -2, field)!;
    const haloSpan = midSlot.spec.haloSpan;
    // Build first 9 halo rows pre-rebase
    for (let r = 0; r < 9; r++) {
      pool.writeBorderRow(midSlot, field, r);
    }

    // Trigger floating-origin rebase mid-tile!
    const dx = 12;
    const dy = -28;
    const dz = -128;
    trailWin.rebaseOrigin(dx, dy, dz);
    field.setOriginOffset(dx, dz);
    pool.shiftAllOrigins(dx, dy, dz);

    // Finish remaining rows post-rebase
    for (let r = 9; r < haloSpan; r++) {
      pool.writeBorderRow(midSlot, field, r);
    }
    pool.finishSlot(midSlot);

    // Reference tile built completely post-rebase at exact same (absTileX=0, absTileZ=-2)
    const refSlot = pool.acquireSlot(0, 0, -2, field)!;
    for (let r = 0; r < haloSpan; r++) {
      pool.writeBorderRow(refSlot, field, r);
    }
    pool.finishSlot(refSlot);

    expect(midSlot.originX).toBeCloseTo(refSlot.originX, 5);
    expect(midSlot.originZ).toBeCloseTo(refSlot.originZ, 5);
    for (let i = 0; i < midSlot.spec.topVertexCount; i++) {
      const idx3 = i * 3;
      const midWorldY = midSlot.originY + midSlot.positions[idx3 + 1]!;
      const refWorldY = refSlot.originY + refSlot.positions[idx3 + 1]!;
      expect(midWorldY).toBeCloseTo(refWorldY, 3);
      expect(midSlot.normals[idx3 + 1]!).toBeCloseTo(refSlot.normals[idx3 + 1]!, 3);
    }

    pool.releaseSlot(midSlot);
    pool.releaseSlot(refSlot);
    tracker.disposeAll();
  });

  it('respects frame budget across frames and never busy-spins when a tier pool is full', () => {
    let clockMs = 0;
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, {
      headless: true,
      nowMs: () => {
        clockMs += 2;
        return clockMs;
      },
    });

    const simState = createMockSimState();
    renderer.sync(simState, 0, 1 / 60, 3);
    expect(renderer.terrainStreamer.queuedTileCount).toBeGreaterThan(0);

    for (let f = 0; f < 60 && renderer.terrainStreamer.queuedTileCount > 0; f++) {
      renderer.sync(simState, 0, 1 / 60, 20);
    }
    expect(renderer.terrainStreamer.queuedTileCount).toBe(0);
    renderer.dispose();

    // Non-busy-spin when innerCapacity = 1 & outerCapacity = 1 and clock stays 0
    let nowCalls = 0;
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const tinyStreamer = new TerrainStreamer(gfx, mats, {
      innerCapacity: 1,
      outerCapacity: 1,
      nowMs: () => {
        nowCalls++;
        return 0;
      },
    });

    tinyStreamer.step(simState.trailWindow, simState.mountainField, 0, -10, 0, -1, 14);
    expect(tinyStreamer.tilePool.innerActiveCount).toBe(1);
    expect(tinyStreamer.tilePool.outerActiveCount).toBe(1);
    expect(tinyStreamer.queuedTileCount).toBe(83);
    expect(nowCalls).toBeLessThan(35);

    tinyStreamer.clearAll();
    tracker.disposeAll();
  });

  it('decouples LandmarkStreamer from tiles, handles async assetWaiter, O(1) prune, and reset() badge updates', async () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const assets = createProceduralMeshAssets(gfx);

    let resolveHero!: () => void;
    const heroPromise = new Promise<void>((res) => {
      resolveHero = res;
    });

    const landmarkStreamer = new LandmarkStreamer(gfx, mats, assets, {
      assetWaiter: (modelId) => (modelId === 'hero_arch' ? heroPromise : null),
    });

    const landmarks1: SegmentLandmarkRequirement[] = [
      {
        id: 'fork_arch_1_left',
        kind: 'forkArch',
        segmentId: 1,
        s: 140,
        x: -13,
        worldX: -13,
        worldY: -35,
        worldZ: -140,
        yawRad: 0,
        clearanceRadius: 4.5,
        visual: { kind: 'procedural', preset: 'arch', palette: ['#78350f'] },
        badgeStageId: 'sunny-blue',
        forkSide: 'left',
        gateHalfWidth: 13,
      },
      {
        id: 'cabin_1',
        kind: 'deliveryLandmark',
        segmentId: 1,
        s: 20,
        x: -10,
        worldX: -10,
        worldY: -5,
        worldZ: -20,
        yawRad: 0,
        clearanceRadius: 4,
        visual: { kind: 'procedural', preset: 'cabin', palette: ['#7f4f24'] },
      },
      {
        id: 'hero_gate',
        kind: 'deliveryLandmark',
        segmentId: 1,
        s: 55,
        x: 8,
        worldX: 8,
        worldY: -14,
        worldZ: -55,
        yawRad: 0,
        clearanceRadius: 4,
        visual: { kind: 'mesh', modelId: 'hero_arch' },
      },
    ];

    const seg1 = createMockSegment(1, 'curr', 'sunny-blue', 0, 140, 35, landmarks1, 100);
    const seg2 = createMockSegment(2, 'nextLeft', 'icy-black', -140, 105, 35, [], 101);
    const window1: TrailWindowView = { prev: null, curr: seg1, nextLeft: seg2, nextRight: null };

    // Sync once: procedural landmarks attach immediately while ONLY mesh landmark waits
    landmarkStreamer.sync(window1);
    expect(landmarkStreamer.activeCount).toBe(2);
    expect(landmarkStreamer.pendingCount).toBe(1);

    // Resolve async asset and re-sync
    resolveHero();
    await heroPromise;
    landmarkStreamer.sync(window1);
    expect(landmarkStreamer.pendingCount).toBe(0);
    expect(landmarkStreamer.activeCount).toBe(3);

    // Rebase shifts attached landmark positions directly
    landmarkStreamer.handleWorldRebased(5, -10, -20);
    const archObj = landmarkStreamer.rootGroup.getObjectByName('ForkArchLandmark')!;
    expect(archObj.position.x).toBeCloseTo(-18, 5);
    expect(archObj.position.y).toBeCloseTo(-25, 5);
    expect(archObj.position.z).toBeCloseTo(-120, 5);

    // Reset with SAME segmentId=1 and lm.id='fork_arch_1_left', but NEW seed and badgeStageId='icy-black'
    const resetLandmarks: SegmentLandmarkRequirement[] = [
      {
        id: 'fork_arch_1_left',
        kind: 'forkArch',
        segmentId: 1,
        s: 140,
        x: -10,
        worldX: 22,
        worldY: -12,
        worldZ: -110,
        yawRad: 0.35,
        clearanceRadius: 4.5,
        visual: { kind: 'procedural', preset: 'arch', palette: ['#78350f'] },
        badgeStageId: 'icy-black',
        forkSide: 'left',
        gateHalfWidth: 10,
      },
    ];
    const resetSeg = createMockSegment(1, 'curr', 'icy-black', 0, 140, 35, resetLandmarks, 999);
    landmarkStreamer.sync({ prev: null, curr: resetSeg, nextLeft: null, nextRight: null });

    expect(landmarkStreamer.activeCount).toBe(1);
    const updatedArch = landmarkStreamer.rootGroup.getObjectByName('ForkArchLandmark')!;
    expect(updatedArch.position.x).toBeCloseTo(22, 5);
    expect(updatedArch.position.y).toBeCloseTo(-12, 5);
    expect(updatedArch.position.z).toBeCloseTo(-110, 5);
    expect(updatedArch.rotation.y).toBeCloseTo(0.35, 5);
    expect(updatedArch.getObjectByName('ForkBadgeDiamond')?.visible).toBe(true);
    expect(updatedArch.getObjectByName('ForkBadgeSquare')?.visible).toBe(false);

    // Prune seg1 from window -> O(1) reclamation
    landmarkStreamer.sync({ prev: null, curr: seg2, nextLeft: null, nextRight: null });
    expect(landmarkStreamer.activeCount).toBe(0);

    landmarkStreamer.clearAll();
    tracker.disposeAll();
  });

  it('keeps scenery outside pisteWeight > 0.15 on wide-transition sunny-blue across both LOD tiers', () => {
    const sim = new SkiSimulation({ seed: 321, startStageId: 'sunny-blue' });
    const simState = sim.getState();
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const streamer = new TerrainStreamer(gfx, mats);

    for (let f = 0; f < 30; f++) {
      streamer.step(
        simState.trailWindow,
        simState.mountainField,
        simState.currSkier.posX,
        simState.currSkier.posZ,
        0,
        -1,
        50,
      );
      if (streamer.queuedTileCount === 0) break;
    }
    expect(streamer.queuedTileCount).toBe(0);

    const out = createMountainSampleOut();
    let count = 0;
    streamer.forEachActiveScenery((ox, _oy, oz, item) => {
      count++;
      simState.mountainField.evaluate(ox + item.localX, oz + item.localZ, out);
      expect(out.onPiste).toBe(false);
      expect(out.pisteWeight).toBeLessThanOrEqual(0.15);
      expect(out.inChasmZone).toBe(false);
    });
    expect(count).toBeGreaterThan(0);

    streamer.clearAll();
    tracker.disposeAll();
  });

  it('packs per-tile off-piste scenery lod=0 before lod=1 and excludes piste, cliffs, chasms, and landmarks', () => {
    const sim = new SkiSimulation({ seed: 777, startStageId: 'icy-black' });
    const simState = sim.getState();

    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const assets = createProceduralMeshAssets(gfx);
    const outlineMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(outlineMat, 'TestOutline');
    const bbMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(bbMat, 'TestBb');
    const bbQuad = new THREE.PlaneGeometry(1, 1);
    gfx.markAsCache(bbQuad, 'TestBbQuad');

    const streamer = new TerrainStreamer(gfx, mats);
    const pools = new InstancePools(gfx, mats, outlineMat, bbMat, bbQuad, assets);

    for (let f = 0; f < 30; f++) {
      streamer.step(
        simState.trailWindow,
        simState.mountainField,
        simState.currSkier.posX,
        simState.currSkier.posZ,
        0,
        -1,
        50,
      );
      if (streamer.queuedTileCount === 0) break;
    }
    expect(streamer.queuedTileCount).toBe(0);
    expect(streamer.sceneryRevision).toBeGreaterThan(0);

    // Collect active landmarks for clearance verification
    const activeLandmarks: SegmentLandmarkRequirement[] = [];
    for (const seg of [
      simState.trailWindow.prev,
      simState.trailWindow.curr,
      simState.trailWindow.nextLeft,
      simState.trailWindow.nextRight,
    ]) {
      if (seg) activeLandmarks.push(...seg.landmarks);
    }

    // Verify lod=0 items strictly precede lod=1 items, and every item satisfies exclusions
    const sampleOut = createMountainSampleOut();
    let seenOuter = false;
    let innerItemCount = 0;
    let outerItemCount = 0;
    let totalItems = 0;

    const innerBounds = new Set<number>();
    for (let i = 0; i < streamer.tilePool.innerCapacity; i++) {
      const s = streamer.tilePool.getSlot(0, i)!;
      if (s.inUse && s.container.visible) {
        innerBounds.add(packTileKey(0, s.absTileX, s.absTileZ));
      }
    }

    streamer.forEachActiveScenery((ox, oy, oz, item) => {
      totalItems++;
      const wx = ox + item.localX;
      const wy = oy + item.localY;
      const wz = oz + item.localZ;

      const absX = wx + simState.mountainField.originOffsetX;
      const absZ = wz + simState.mountainField.originOffsetZ;
      const innerKey = packTileKey(
        0,
        Math.floor(absX / INNER_TILE_SIZE_M),
        Math.floor(absZ / INNER_TILE_SIZE_M),
      );
      const isInner = innerBounds.has(innerKey);

      if (isInner) {
        expect(seenOuter).toBe(false);
        innerItemCount++;
      } else {
        seenOuter = true;
        outerItemCount++;
      }

      simState.mountainField.evaluate(wx, wz, sampleOut);
      expect(sampleOut.onPiste).toBe(false);
      expect(sampleOut.pisteWeight).toBeLessThanOrEqual(0.15);
      expect(sampleOut.normalY).toBeGreaterThanOrEqual(0.5);
      expect(sampleOut.inChasmZone).toBe(false);
      expect(Math.abs(wy - sampleOut.heightY)).toBeLessThan(2.5); // scenery follows the rendered (coarse LOD) mesh, not the analytic field

      for (let i = 0; i < activeLandmarks.length; i++) {
        const lm = activeLandmarks[i]!;
        const minR = Math.max(2.5, lm.clearanceRadius);
        const dist = Math.hypot(wx - lm.worldX, wz - lm.worldZ);
        expect(dist).toBeGreaterThanOrEqual(minR - 1e-3);
      }
    });

    expect(innerItemCount).toBeGreaterThan(0);
    expect(outerItemCount).toBeGreaterThan(0);
    expect(totalItems).toBeLessThanOrEqual(MAX_STATIC_BILLBOARDS);

    pools.sync(simState, 0.5, streamer);
    const staticMesh = pools.rootGroup.getObjectByName(
      'StaticSceneryBillboardPool',
    ) as THREE.InstancedMesh;
    expect(staticMesh.count).toBe(totalItems);

    // Deterministic seeding check: same seed -> identical scenery; different seed -> distinct scenery
    const streamerSame = new TerrainStreamer(gfx, mats);
    for (let f = 0; f < 40; f++) {
      streamerSame.step(
        simState.trailWindow,
        simState.mountainField,
        simState.currSkier.posX,
        simState.currSkier.posZ,
        0,
        -1,
        50,
      );
      if (streamerSame.queuedTileCount === 0) break;
    }
    expect(streamerSame.queuedTileCount).toBe(0);
    const itemsA: number[] = [];
    const itemsB: number[] = [];
    streamer.forEachActiveScenery((ox, _oy, oz, itItem) => {
      itemsA.push(ox + itItem.localX, oz + itItem.localZ);
    });
    streamerSame.forEachActiveScenery((ox, _oy, oz, itItem) => {
      itemsB.push(ox + itItem.localX, oz + itItem.localZ);
    });
    expect(itemsB).toEqual(itemsA);

    const simDiff = new SkiSimulation({ seed: 888, startStageId: 'icy-black' });
    const streamerDiff = new TerrainStreamer(gfx, mats);
    for (let f = 0; f < 40; f++) {
      streamerDiff.step(
        simDiff.getState().trailWindow,
        simDiff.getState().mountainField,
        simDiff.getState().currSkier.posX,
        simDiff.getState().currSkier.posZ,
        0,
        -1,
        50,
      );
      if (streamerDiff.queuedTileCount === 0) break;
    }
    expect(streamerDiff.queuedTileCount).toBe(0);
    const itemsC: number[] = [];
    streamerDiff.forEachActiveScenery((ox, _oy, oz, itItem) => {
      itemsC.push(ox + itItem.localX, oz + itItem.localZ);
    });
    expect(itemsC).not.toEqual(itemsA);

    streamer.clearAll();
    pools.sync(simState, 0.5, streamer);
    expect(staticMesh.count).toBe(0);

    streamerSame.clearAll();
    streamerDiff.clearAll();
    tracker.disposeAll();
  });

  it('integrates real SkiSimulation MountainField with ThreeRenderer for icy-black cliffs, chasms, zero leaks, and dispose', () => {
    const sim = new SkiSimulation({
      seed: 2025,
      startStageId: 'icy-black',
      debugDrawEnabled: true,
    });
    const intent = createMutablePlayerIntent();
    for (let i = 0; i < 60; i++) {
      const st = sim.getState();
      const targetX = st.trailWindow.curr.sampleSafeX(st.surfaceSample.s + 8);
      intent.steer = clamp((targetX - st.surfaceSample.x) * 0.14, -1, 1);
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }

    const renderer = new ThreeRenderer(null, sim.eventBus, undefined, { headless: true });
    const simState = sim.getState();

    for (let f = 0; f < 30; f++) {
      renderer.sync(simState, 0.5, 1 / 60, 50);
      if (renderer.terrainStreamer.queuedTileCount === 0) break;
    }
    expect(renderer.terrainStreamer.queuedTileCount).toBe(0);

    const cliffColor = new THREE.Color(STAGE_ICY_BLACK.palette.cliffColor);
    const snowColor = new THREE.Color(STAGE_ICY_BLACK.palette.snowColor);
    const chasmFloorColor = new THREE.Color(STAGE_ICY_BLACK.palette.chasmFloorColor!);
    const vColor = new THREE.Color();

    let sawCliffRock = false;
    let sawChasmDrop = false;
    let sawSnowColor = false;

    for (let i = 0; i < renderer.terrainStreamer.tilePool.innerCapacity; i++) {
      const slot = renderer.terrainStreamer.tilePool.getSlot(0, i)!;
      if (!slot.inUse || !slot.ready) continue;

      for (let v = 0; v < slot.spec.topVertexCount; v++) {
        const v3 = v * 3;
        const worldY = slot.originY + slot.positions[v3 + 1]!;
        const ny = slot.normals[v3 + 1]!;
        vColor.setRGB(slot.colors[v3]!, slot.colors[v3 + 1]!, slot.colors[v3 + 2]!);

        if (ny < 0.72) {
          const distCliff = Math.hypot(
            vColor.r - cliffColor.r,
            vColor.g - cliffColor.g,
            vColor.b - cliffColor.b,
          );
          if (distCliff < 0.15) sawCliffRock = true;
        }
        if (worldY < simState.currSkier.posY - 22) {
          const distChasm = Math.hypot(
            vColor.r - chasmFloorColor.r,
            vColor.g - chasmFloorColor.g,
            vColor.b - chasmFloorColor.b,
          );
          if (distChasm < 0.4) sawChasmDrop = true;
        }
        const distSnow = Math.hypot(
          vColor.r - snowColor.r,
          vColor.g - snowColor.g,
          vColor.b - snowColor.b,
        );
        if (distSnow < 0.12) sawSnowColor = true;
      }
    }

    expect(sawSnowColor).toBe(true);
    expect(sawCliffRock).toBe(true);
    expect(sawChasmDrop).toBe(true);

    // Also verify SnowVfx forward-centering on a curved camera looking along +X
    const curvedState: ReadonlySimState = {
      ...simState,
      prevCamera: {
        ...simState.prevCamera,
        posX: 0,
        posY: 4,
        posZ: 0,
        lookAtX: 25,
        lookAtY: 2,
        lookAtZ: 0,
      },
      currCamera: {
        ...simState.currCamera,
        posX: 0,
        posY: 4,
        posZ: 0,
        lookAtX: 25,
        lookAtY: 2,
        lookAtZ: 0,
      },
    };
    renderer.sync(curvedState, 1, 1 / 60, 50);

    const snowMesh = renderer.scene.getObjectByName('SnowVfxStreaks') as THREE.InstancedMesh;
    expect(snowMesh.count).toBeGreaterThan(0);
    const mat = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    let meanX = 0;
    for (let i = 0; i < snowMesh.count; i++) {
      snowMesh.getMatrixAt(i, mat);
      pos.setFromMatrixPosition(mat);
      meanX += pos.x;
    }
    meanX /= snowMesh.count;
    expect(meanX).toBeGreaterThan(5);

    expect(renderer.runLeakCheck(0, true).totalLeaks).toBe(0);
    renderer.dispose();
    const afterDispose = renderer.getStats().graphics;
    expect(afterDispose.activeObjects).toBe(0);
    expect(afterDispose.activeGeometries).toBe(0);
    expect(afterDispose.activeMaterials).toBe(0);
    expect(afterDispose.activeTextures).toBe(0);
    expect(afterDispose.cachedGeometries).toBe(0);
    expect(afterDispose.cachedMaterials).toBe(0);
    expect(afterDispose.cachedTextures).toBe(0);
  });

  it('evaluates SceneryTierRule slope gates, canopy suppression, and LOD margins accurately', () => {
    const talusSignal: SceneryEnvSignal = {
      minNormalY: 0.74,
      distFromTrail: 12,
      relElevation: 8,
      worldNoise01: 0.35,
      lod: 0,
      scenery: STAGE_ICY_BLACK.layout.scenery,
    };
    const pineRule = DEFAULT_SCENERY_TIER_RULES.find((r) => r.species === 'pine_green')!;
    const shrubRule = DEFAULT_SCENERY_TIER_RULES.find((r) => r.species === 'snow_shrub')!;
    const rockRule = DEFAULT_SCENERY_TIER_RULES.find((r) => r.species === 'alpine_rock')!;

    expect(evaluateSceneryRuleFitness(pineRule, talusSignal)).toBe(0);
    expect(evaluateSceneryRuleFitness(shrubRule, talusSignal)).toBe(0);
    expect(evaluateSceneryRuleFitness(rockRule, talusSignal)).toBeGreaterThan(0);

    // On outer lod = 1 (+0.07 margin), 0.80 allows alpine_rock (>= 0.79) while excluding pines (< 0.85)
    const outerSlopeSignal: SceneryEnvSignal = {
      ...talusSignal,
      minNormalY: 0.81,
      lod: 1,
    };
    expect(evaluateSceneryRuleFitness(pineRule, outerSlopeSignal)).toBe(0);
    expect(evaluateSceneryRuleFitness(rockRule, outerSlopeSignal)).toBeGreaterThan(0);

    // Canopy blocking forces ground-layer understory selection
    const flatForestSignal: SceneryEnvSignal = {
      minNormalY: 0.94,
      distFromTrail: 14,
      relElevation: 2,
      worldNoise01: 0.65,
      lod: 0,
      scenery: STAGE_POWDER_BOWL.layout.scenery,
    };
    for (const roll of [0.05, 0.35, 0.75, 0.95]) {
      const winner = selectWinningSceneryRule(
        DEFAULT_SCENERY_TIER_RULES,
        flatForestSignal,
        true,
        roll,
      );
      expect(winner).not.toBeNull();
      expect(winner!.layer).toBe('ground');
    }
  });

  it('supports cross-fork biome fidelity, exact spatial thinning, dual-radius spacing, granite rocks, and blizzard/green badges', () => {
    // 1. Single straddling tile with opposing left/right stages verifies local biome fidelity & exact thinning
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const streamer = new TerrainStreamer(gfx, mats);

    const mockSeg = createMockSegment(1, 'curr', 'powder-bowl', 0, 140, 35);
    const mockWindow: TrailWindowView = {
      prev: null,
      curr: mockSeg,
      nextLeft: null,
      nextRight: null,
    };
    const splitField: MountainFieldView = {
      worldSeed: 901,
      originOffsetX: 0,
      originOffsetZ: 0,
      collectSpinesInBounds(_minX, _maxX, _minZ, _maxZ, _padM, outSpines) {
        outSpines.length = 0;
      },
      evaluateHeight(wx, wz) {
        return wz * 0.1 + wx * 0.02;
      },
      evaluateColumn(wx, wz, out) {
        const base = createMountainColumnOut();
        Object.assign(out, base);
        out.heightY = wz * 0.1 + wx * 0.02;
        out.macroY = out.heightY;
        out.onPiste = false;
        out.pisteWeight = 0;
        out.nearestSignedX = wx < 16 ? -24 : 24;
        out.nearestHalfWidth = 10;
        out.nearestStageId = wx < 16 ? 'powder-bowl' : 'blizzard-ridge';
        return out;
      },
      evaluate(wx, wz, out) {
        const base = createMountainSampleOut();
        Object.assign(out, base);
        out.heightY = wz * 0.1 + wx * 0.02;
        out.macroY = out.heightY;
        out.nearestStageId = wx < 16 ? 'powder-bowl' : 'blizzard-ridge';
        return out;
      },
    };

    for (let f = 0; f < 30; f++) {
      streamer.step(mockWindow, splitField, 16, 16, 0, -1, 50);
      if (streamer.queuedTileCount === 0) break;
    }
    expect(streamer.queuedTileCount).toBe(0);

    // Inspect straddling inner tile at absTileX=0, absTileZ=0 (world X in [0, 32))
    let leftGreenCount = 0;
    let leftRockOrFrostedCount = 0;
    let rightRockOrFrostedCount = 0;
    let rightCount = 0;
    let leftCount = 0;
    streamer.forEachActiveScenery((ox, _oy, oz, item) => {
      const wx = ox + item.localX;
      const wz = oz + item.localZ;
      if (wx < 0 || wx >= 32 || wz < 0 || wz >= 32) return;
      if (wx < 15.5) {
        leftCount++;
        if (item.frame === 'pine_green' || item.frame === 'snow_shrub') leftGreenCount++;
        if (
          item.frame === 'alpine_rock' ||
          item.frame === 'rock_crag' ||
          item.frame === 'pine_frosted'
        ) {
          leftRockOrFrostedCount++;
        }
      } else if (wx > 16.5) {
        rightCount++;
        if (
          item.frame === 'alpine_rock' ||
          item.frame === 'rock_crag' ||
          item.frame === 'pine_frosted'
        ) {
          rightRockOrFrostedCount++;
        }
      }
    });
    expect(leftCount).toBeGreaterThan(2);
    expect(rightCount).toBeGreaterThan(0);
    expect(leftGreenCount).toBeGreaterThan(leftRockOrFrostedCount);
    expect(rightRockOrFrostedCount).toBeGreaterThanOrEqual(1);

    // Also verify tilePool.getSlotStageIds reports both stages on the straddling tile
    let straddleSlot = null;
    for (let i = 0; i < streamer.tilePool.innerCapacity; i++) {
      const s = streamer.tilePool.getSlot(0, i)!;
      if (s.inUse && s.absTileX === 0 && s.absTileZ === 0) {
        straddleSlot = s;
        break;
      }
    }
    expect(straddleSlot).not.toBeNull();
    const slotStages: string[] = [];
    streamer.tilePool.getSlotStageIds(straddleSlot!, slotStages);
    expect(slotStages).toContain('powder-bowl');
    expect(slotStages).toContain('blizzard-ridge');

    streamer.clearAll();

    // 2. Real SkiSimulation for powder-bowl (circle badge + dual-radius canopy/ground tucking)
    const simPowder = new SkiSimulation({ seed: 505, startStageId: 'powder-bowl' });
    const powderState = simPowder.getState();
    const rendererPowder = new ThreeRenderer(null, simPowder.eventBus, undefined, { headless: true });
    for (let f = 0; f < 30; f++) {
      rendererPowder.sync(powderState, 0.5, 1 / 60, 50);
      if (rendererPowder.terrainStreamer.queuedTileCount === 0) break;
    }
    expect(rendererPowder.terrainStreamer.queuedTileCount).toBe(0);

    // Check dual-radius spacing and understory placement per tile across visible powder-bowl tiles
    const itemsByTile = new Map<
      string,
      Array<{ wx: number; wz: number; item: TileSceneryItem }>
    >();
    let totalPowderItems = 0;
    rendererPowder.terrainStreamer.forEachActiveScenery((ox, _oy, oz, item) => {
      totalPowderItems++;
      const key = `${Math.round(ox)},${Math.round(oz)}`;
      let list = itemsByTile.get(key);
      if (!list) {
        list = [];
        itemsByTile.set(key, list);
      }
      list.push({ wx: ox + item.localX, wz: oz + item.localZ, item: { ...item } });
    });
    expect(totalPowderItems).toBeGreaterThan(20);

    const isCanopy = (f: string): boolean => f === 'pine_green' || f === 'pine_frosted';
    let minTreeDist = Infinity;
    let minItemDist = Infinity;
    let totalTrees = 0;
    let totalGroundProps = 0;
    let sawUnderstoryTucked = false;

    for (const tileItems of itemsByTile.values()) {
      const trees = tileItems.filter((e) => isCanopy(e.item.frame));
      const groundProps = tileItems.filter((e) => !isCanopy(e.item.frame));
      totalTrees += trees.length;
      totalGroundProps += groundProps.length;

      for (let i = 0; i < tileItems.length; i++) {
        for (let j = i + 1; j < tileItems.length; j++) {
          const d = Math.hypot(
            tileItems[i]!.wx - tileItems[j]!.wx,
            tileItems[i]!.wz - tileItems[j]!.wz,
          );
          if (d < minItemDist) minItemDist = d;
        }
      }

      for (let i = 0; i < trees.length; i++) {
        for (let j = i + 1; j < trees.length; j++) {
          const d = Math.hypot(trees[i]!.wx - trees[j]!.wx, trees[i]!.wz - trees[j]!.wz);
          if (d < minTreeDist) minTreeDist = d;
        }
        for (let g = 0; g < groundProps.length; g++) {
          const d = Math.hypot(trees[i]!.wx - groundProps[g]!.wx, trees[i]!.wz - groundProps[g]!.wz);
          if (
            d >= STAGE_POWDER_BOWL.layout.scenery.groundMinRadius - 1e-3 &&
            d < STAGE_POWDER_BOWL.layout.scenery.canopyMinRadius
          ) {
            sawUnderstoryTucked = true;
          }
        }
      }
    }
    expect(minItemDist).toBeGreaterThanOrEqual(STAGE_ICY_BLACK.layout.scenery.groundMinRadius - 1e-3);
    expect(minTreeDist).toBeGreaterThanOrEqual(4.19);
    expect(totalTrees).toBeGreaterThan(10);
    expect(totalGroundProps).toBeGreaterThan(3);
    expect(sawUnderstoryTucked).toBe(true);

    expect(rendererPowder.runLeakCheck(0, true).totalLeaks).toBe(0);
    rendererPowder.dispose();

    // Verify 'blizzard-ridge' weather fog clamp (>= 65m), #152033 chasm floor, and rocky scenery
    const archCheckSim = new SkiSimulation({ seed: 101, startStageId: 'blizzard-ridge' });
    const archState = archCheckSim.getState();
    const rendererBliz = new ThreeRenderer(null, archCheckSim.eventBus, undefined, {
      headless: true,
    });
    for (let f = 0; f < 30; f++) {
      rendererBliz.sync(archState, 0.5, 0.1, 50);
    }
    expect(rendererBliz.terrainStreamer.queuedTileCount).toBe(0);

    const fogBliz = rendererBliz.scene.fog as THREE.FogExp2;
    expect(fogBliz.density).toBeCloseTo(1.6 / STAGE_BLIZZARD_RIDGE.weather.fogMinDist, 2);

    const sampleOut = createMountainSampleOut();
    let sawRockScenery = false;
    rendererBliz.terrainStreamer.forEachActiveScenery((ox, _oy, oz, item) => {
      if (item.frame === 'alpine_rock' || item.frame === 'rock_crag') {
        sawRockScenery = true;
      }
      archState.mountainField.evaluate(ox + item.localX, oz + item.localZ, sampleOut);
      expect(sampleOut.normalY).toBeGreaterThanOrEqual(0.5);
    });
    expect(sawRockScenery).toBe(true);

    // Verify chasmFloorColor #152033 rendered in blizzard-ridge tiles
    const blizChasmColor = new THREE.Color(STAGE_BLIZZARD_RIDGE.palette.chasmFloorColor!);
    const vCol = new THREE.Color();
    let sawBlizChasm = false;
    for (let i = 0; i < rendererBliz.terrainStreamer.tilePool.innerCapacity; i++) {
      const slot = rendererBliz.terrainStreamer.tilePool.getSlot(0, i)!;
      if (!slot.inUse || !slot.ready) continue;
      for (let v = 0; v < slot.spec.topVertexCount; v++) {
        const v3 = v * 3;
        vCol.setRGB(slot.colors[v3]!, slot.colors[v3 + 1]!, slot.colors[v3 + 2]!);
        const distC = Math.hypot(
          vCol.r - blizChasmColor.r,
          vCol.g - blizChasmColor.g,
          vCol.b - blizChasmColor.b,
        );
        if (distC < 0.35 && slot.originY + slot.positions[v3 + 1]! < archState.currSkier.posY - 18) {
          sawBlizChasm = true;
          break;
        }
      }
      if (sawBlizChasm) break;
    }
    expect(sawBlizChasm).toBe(true);

    expect(rendererBliz.runLeakCheck(0, true).totalLeaks).toBe(0);

    // Explicitly verify green circle badge on 'powder-bowl' fork arch
    const powderAssets = createProceduralMeshAssets(gfx);
    const powderArch = createForkArchObject(
      gfx,
      powderAssets,
      mats.propToonMaterial,
      mats.propToonMaterial,
      'powder-bowl',
    );
    expect(powderArch.group.getObjectByName('ForkBadgeCircle')?.visible).toBe(true);
    expect(powderArch.group.getObjectByName('ForkBadgeSquare')?.visible).toBe(false);
    expect(powderArch.group.getObjectByName('ForkBadgeDiamond')?.visible).toBe(false);
    expect(powderArch.group.getObjectByName('ForkGateTrimCircle')?.visible).toBe(true);
    gfx.disposeObject(powderArch.group);

    // Also verify 'granite-gorge' canyon walls emit rock/crag scenery safely on both LOD tiers
    const simGorge = new SkiSimulation({ seed: 606, startStageId: 'granite-gorge' });
    const gorgeState = simGorge.getState();
    rendererBliz.sync(gorgeState, 0.5, 1 / 60, 50);
    for (let f = 0; f < 30; f++) {
      rendererBliz.sync(gorgeState, 0.5, 1 / 60, 50);
      if (rendererBliz.terrainStreamer.queuedTileCount === 0) break;
    }
    expect(rendererBliz.terrainStreamer.queuedTileCount).toBe(0);
    let sawGorgeRock = false;
    rendererBliz.terrainStreamer.forEachActiveScenery((ox, _oy, oz, item) => {
      if (item.frame === 'alpine_rock' || item.frame === 'rock_crag') {
        sawGorgeRock = true;
      }
      gorgeState.mountainField.evaluate(ox + item.localX, oz + item.localZ, sampleOut);
      expect(sampleOut.normalY).toBeGreaterThanOrEqual(0.5);
    });
    expect(sawGorgeRock).toBe(true);

    expect(rendererBliz.runLeakCheck(0, true).totalLeaks).toBe(0);
    rendererBliz.dispose();
    tracker.disposeAll();
  });

  it('renders bare rock (no snow) on steep off-piste cliff faces across both LODs while keeping steep pistes snowy', () => {
    const sim = new SkiSimulation({ seed: 2026, startStageId: 'granite-gorge' });
    const simState = sim.getState();
    const renderer = new ThreeRenderer(null, sim.eventBus, undefined, { headless: true });

    for (let f = 0; f < 40; f++) {
      renderer.sync(simState, 0.5, 1 / 60, 50);
      if (renderer.terrainStreamer.queuedTileCount === 0) break;
    }
    expect(renderer.terrainStreamer.queuedTileCount).toBe(0);

    const snowColor = new THREE.Color(STAGE_SUNNY_BLUE.palette.snowColor);
    let innerSteepCount = 0;
    let outerSteepCount = 0;
    let pisteVertCount = 0;

    for (const lod of [0, 1] as const) {
      const cap =
        lod === 0
          ? renderer.terrainStreamer.tilePool.innerCapacity
          : renderer.terrainStreamer.tilePool.outerCapacity;
      const fullRockNy = lod === 0 ? CLIFF_ROCK_FULL_NY_INNER : CLIFF_ROCK_FULL_NY_OUTER;

      for (let i = 0; i < cap; i++) {
        const slot = renderer.terrainStreamer.tilePool.getSlot(lod, i)!;
        if (!slot.inUse || !slot.ready) continue;
        expect(slot.geometry.getAttribute('aRockInfo')).toBe(slot.rockInfoAttr);

        for (let v = 0; v < slot.spec.topVertexCount; v++) {
          const v3 = v * 3;
          const v4 = v * 4;
          const ny = slot.normals[v3 + 1]!;
          const offPiste = slot.rockInfo[v4 + 3]!;
          const r = slot.colors[v3]!;
          const g = slot.colors[v3 + 1]!;
          const b = slot.colors[v3 + 2]!;
          const rockR = slot.rockInfo[v4]!;
          const rockG = slot.rockInfo[v4 + 1]!;
          const rockB = slot.rockInfo[v4 + 2]!;

          if (offPiste < 0.5) {
            pisteVertCount++;
            // Piste vertices must stay snowy/icy, never replaced by dark cliff rock
            const distFromRock = Math.hypot(r - rockR, g - rockG, b - rockB);
            expect(distFromRock).toBeGreaterThan(0.15);
          } else if (ny <= fullRockNy) {
            if (lod === 0) innerSteepCount++;
            else outerSteepCount++;
            // Steep off-piste cliff faces must be 100% rock color (no snow blend)
            expect(r).toBeCloseTo(rockR, 4);
            expect(g).toBeCloseTo(rockG, 4);
            expect(b).toBeCloseTo(rockB, 4);
            // Rock must be clearly darker than snow
            const distFromSnow = Math.hypot(r - snowColor.r, g - snowColor.g, b - snowColor.b);
            expect(distFromSnow).toBeGreaterThan(0.5);
          }
        }
      }
    }

    expect(pisteVertCount).toBeGreaterThan(0);
    expect(innerSteepCount).toBeGreaterThan(50);
    expect(outerSteepCount).toBeGreaterThan(50);

    renderer.dispose();
  });
});
