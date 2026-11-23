import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../core/eventBus';
import { Profiler } from '../../../core/profiler';
import {
  CREATURE_PHASE_TELEGRAPH,
  type ChunkRangeOut,
  type ReadonlySimState,
  type RibbonPointOut,
  type SegmentLandmarkRequirement,
  type SimEvents,
  type SpineFrameOut,
  type TerrainSegmentView,
  type TrailSlotRole,
} from '../../../sim/contracts';
import { ThreeRenderer } from '../renderer';

function createMockSegment(
  id: number,
  slot: TrailSlotRole,
  stageId: string,
  startZ: number,
  length = 140,
  chunkLength = 35,
  landmarks: SegmentLandmarkRequirement[] = [],
): TerrainSegmentView {
  const chunkCount = Math.ceil(length / chunkLength);
  return {
    id,
    slot,
    stageId,
    seed: 100 + id,
    length,
    chunkLength,
    chunkCount,
    prevSegmentId: null,
    nextLeftId: null,
    nextRightId: null,
    fork: {
      hasFork: slot === 'curr',
      archS: length - 70,
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
    evaluateRibbonPoint(s: number, u: number, out: RibbonPointOut): void {
      const halfW = 14;
      const skirt = 12;
      const totalHalf = halfW + skirt;
      const x = (totalHalf * 0.5) * u * (1 + u * u);
      const bankRaise = Math.abs(x) > halfW ? (Math.abs(x) - halfW) * 0.18 : 0;
      out.posX = x;
      out.posY = -s * 0.25 + bankRaise;
      out.posZ = startZ - s;
      out.normalX = 0;
      out.normalY = 0.97;
      out.normalZ = 0.24;
      out.lateralX = x;
      out.halfWidth = halfW;
      out.skirtWidth = skirt;
      out.slopeDeg = 14;
      out.localHeight = bankRaise;
      out.surfaceType = Math.abs(x) < 3 && s > 40 && s < 70 ? 'ice' : 'packed';
      out.inPlayableCorridor = Math.abs(x) <= halfW;
      out.inDivider = false;
      out.isInnerForkSlope = false;
    },
    evaluateSurfaceAtX(s: number, x: number, out: RibbonPointOut): void {
      this.evaluateRibbonPoint(s, Math.max(-1, Math.min(1, x / 26)), out);
    },
    sampleSafeX(): number {
      return 0;
    },
  };
}

function createMockSimState(): ReadonlySimState {
  const currLandmarks: SegmentLandmarkRequirement[] = [
    {
      id: 'fork_arch_1',
      kind: 'forkArch',
      segmentId: 1,
      chunkIndex: 1,
      s: 55,
      x: 0,
      worldX: 0,
      worldY: -13.75,
      worldZ: -55,
      yawRad: 0,
      clearanceRadius: 4,
      visual: { kind: 'procedural', preset: 'arch', palette: ['#78350f'], outline: false },
      leftBadgeStageId: 'sunny-blue',
      rightBadgeStageId: 'icy-black',
    },
    {
      id: 'cabin_1',
      kind: 'deliveryLandmark',
      segmentId: 1,
      chunkIndex: 0,
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
      segmentId: 1,
      s: 10,
      x: 0.4,
      groundY: -2.5,
      normalX: 0,
      normalY: 0.97,
      normalZ: 0.24,
      tangentX: 0,
      tangentY: -0.24,
      tangentZ: -0.97,
      halfWidth: 14,
      surfaceType: 'packed',
      inBank: false,
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
      fogDistanceM: 40, // Intentionally < 65m to verify renderer clamps density safely >= 65m!
      blizzardDim: 0.35,
    },
    upcomingFork: {
      active: true,
      distanceM: 120,
      leftStageId: 'sunny-blue',
      rightStageId: 'icy-black',
    },
    trailWindow: { prev: null, curr, nextLeft, nextRight },
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

describe('ThreeRenderer, RibbonPool, ChunkStreamer & Floating Origin Rebase', () => {
  it('streams chunks within budget, packs pools, clamps fog >= 65m, and shifts ONLY container positions on WORLD_REBASED with ZERO vertex uploads', () => {
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

    // Force time budget expiry after 1 chunk yield by advancing mock clock during first sync
    clockMs = 0;
    renderer.sync(simState, 0.5, 1 / 60, 14);

    // Step enough frames to stream all 10 chunks (curr: 4 + nextLeft: 3 + nextRight: 3 = 10 <= 32)
    for (let f = 0; f < 16; f++) {
      clockMs += 16;
      renderer.sync(simState, 0.5, 1 / 60, 14);
    }

    expect(renderer.chunkStreamer.activeChunkCount).toBe(10);
    expect(renderer.chunkStreamer.queuedChunkCount).toBe(0);
    expect(renderer.chunkStreamer.ribbonPool.activeCount).toBe(10);
    expect(renderer.chunkStreamer.ribbonPool.capacity).toBe(48);

    // Fog density clamped >= 65m even though simState.activeWeather.fogDistanceM = 40
    const fog = renderer.scene.fog as THREE.FogExp2;
    expect(fog.density).toBeLessThanOrEqual(1.6 / 65 + 1e-4);

    // Verify instanced pools, contact shadows, ski tracks, backpack stack, and debug overlay populated cleanly
    const poolsRoot = renderer.scene.getObjectByName('InstancePoolsRoot')!;
    const boulderSmallPool = poolsRoot.getObjectByName('BoulderSmallPool') as THREE.InstancedMesh;
    const boulderLargePool = poolsRoot.getObjectByName('BoulderLargePool') as THREE.InstancedMesh;
    const presentStdPool = poolsRoot.getObjectByName('PresentStdPool') as THREE.InstancedMesh;
    const presentGoldPool = poolsRoot.getObjectByName('PresentGoldPool') as THREE.InstancedMesh;
    const rampPool = poolsRoot.getObjectByName('RampPool') as THREE.InstancedMesh;
    const dynBbPool = poolsRoot.getObjectByName('DynamicBillboardPool') as THREE.InstancedMesh;
    expect(boulderSmallPool.count).toBe(1);
    expect(boulderLargePool.count).toBe(1);
    expect(presentStdPool.count).toBe(1);
    expect(presentGoldPool.count).toBe(1);
    expect(rampPool.count).toBe(1);
    expect(dynBbPool.count).toBe(4); // 1 pine_tree + 2 sled_duo children + 1 bear_patrol
    expect(boulderSmallPool.frustumCulled).toBe(false);
    expect(dynBbPool.frustumCulled).toBe(false);

    const shadowsPool = renderer.scene.getObjectByName('ContactShadowsPool') as THREE.InstancedMesh;
    expect(shadowsPool.count).toBe(7); // skier + 3 hazards + 1 creature + 2 presents
    expect(shadowsPool.frustumCulled).toBe(false);

    const skiTracks = renderer.scene.getObjectByName('SkiTracksMesh') as THREE.Mesh;
    expect(skiTracks.geometry.drawRange.count).toBe(24); // (3 - 1) * 12 indices
    const trackPosAttr = skiTracks.geometry.getAttribute('position') as THREE.BufferAttribute;
    let trackNonZero = false;
    for (let k = 0; k < simState.entities.skiTracks.count * 4 * 3; k++) {
      const v = trackPosAttr.array[k]!;
      expect(Number.isFinite(v)).toBe(true);
      if (Math.abs(v) > 1e-4) trackNonZero = true;
    }
    expect(trackNonZero).toBe(true);

    const backpackStd = renderer.scene.getObjectByName('BackpackStackStd') as THREE.InstancedMesh;
    const backpackGold = renderer.scene.getObjectByName('BackpackStackGold') as THREE.InstancedMesh;
    expect(backpackStd.count).toBe(1);
    expect(backpackGold.count).toBe(1);

    const debugRoot = renderer.scene.getObjectByName('DebugOverlay3DRoot')!;
    expect(debugRoot.visible).toBe(true);
    const debugLines = renderer.scene.getObjectByName('DebugLinesMesh') as THREE.Line;
    const debugPosAttr = debugLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    let debugNonZero = false;
    for (let k = 0; k < debugLines.geometry.drawRange.count * 3; k++) {
      const v = debugPosAttr.array[k]!;
      expect(Number.isFinite(v)).toBe(true);
      if (Math.abs(v) > 1e-4) debugNonZero = true;
    }
    expect(debugNonZero).toBe(true);

    // Capture slot positions and upload counts BEFORE WORLD_REBASED
    const slot0 = renderer.chunkStreamer.ribbonPool.getSlot(0)!;
    expect(slot0.inUse).toBe(true);
    expect(slot0.posAttr.array).toBe(slot0.positions);
    expect(slot0.normAttr.array).toBe(slot0.normals);
    expect(slot0.colAttr.array).toBe(slot0.colors);

    const slotBs = slot0.geometry.boundingSphere;
    expect(slotBs).not.toBeNull();
    expect(Number.isFinite(slotBs!.radius)).toBe(true);
    expect(slotBs!.radius).toBeGreaterThan(10);

    const slotPosAttr = slot0.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(slotPosAttr.array).toBe(slot0.positions);
    let ribbonNonZero = false;
    for (let k = 0; k < slotPosAttr.array.length; k++) {
      const v = slotPosAttr.array[k]!;
      expect(Number.isFinite(v)).toBe(true);
      if (Math.abs(v) > 1e-4) ribbonNonZero = true;
    }
    expect(ribbonNonZero).toBe(true);

    const idxArr = slot0.geometry.getIndex()!.array;
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const triN = new THREE.Vector3();
    for (let k = 0; k < idxArr.length; k += 3) {
      const ia = idxArr[k]! * 3;
      const ib = idxArr[k + 1]! * 3;
      const ic = idxArr[k + 2]! * 3;
      vA.set(slotPosAttr.array[ia]!, slotPosAttr.array[ia + 1]!, slotPosAttr.array[ia + 2]!);
      vB.set(slotPosAttr.array[ib]!, slotPosAttr.array[ib + 1]!, slotPosAttr.array[ib + 2]!);
      vC.set(slotPosAttr.array[ic]!, slotPosAttr.array[ic + 1]!, slotPosAttr.array[ic + 2]!);
      e1.subVectors(vB, vA);
      e2.subVectors(vC, vA);
      triN.crossVectors(e1, e2);
      expect(triN.y).toBeGreaterThan(0);
    }
    const prevPosX = slot0.container.position.x;
    const prevPosY = slot0.container.position.y;
    const prevPosZ = slot0.container.position.z;
    const prevUploadCount = slot0.positionUploadCount;

    // Emit WORLD_REBASED: must translate chunk containers ONLY with ZERO vertex buffer re-uploads!
    eventBus.emit('WORLD_REBASED', {
      rebaseCount: 1,
      deltaX: 0,
      deltaY: -32,
      deltaZ: -128,
      totalOffsetX: 0,
      totalOffsetY: -32,
      totalOffsetZ: -128,
    });

    expect(slot0.container.position.x).toBeCloseTo(prevPosX, 5);
    expect(slot0.container.position.y).toBeCloseTo(prevPosY + 32, 5);
    expect(slot0.container.position.z).toBeCloseTo(prevPosZ + 128, 5);
    expect(slot0.positionUploadCount).toBe(prevUploadCount);

    // Leak check must report 0 leaks in steady state
    const leakReport = renderer.runLeakCheck(0, true);
    expect(leakReport.totalLeaks).toBe(0);

    // Resize updates camera aspect cleanly for 9:16 portrait mobile
    renderer.resize(450, 900);
    expect(renderer.camera.aspect).toBeCloseTo(0.5, 5);

    // Dispose cleans up every tracked object & resource
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

  it('respects frame time budget across multiple frames when streaming chunks', () => {
    let clockMs = 0;
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, {
      headless: true,
      nowMs: () => {
        // Advance clock by 2ms per check so budgetMs=3 yields after 1-2 generator steps!
        clockMs += 2;
        return clockMs;
      },
    });

    const simState = createMockSimState();
    renderer.sync(simState, 0, 1 / 60, 3);
    // With tight 3ms budget, not all 10 chunks finish on the very first frame!
    expect(renderer.chunkStreamer.queuedChunkCount).toBeGreaterThan(0);

    // Stepping subsequent frames finishes streaming smoothly without drops
    for (let i = 0; i < 40 && renderer.chunkStreamer.queuedChunkCount > 0; i++) {
      renderer.sync(simState, 0, 1 / 60, 14);
    }
    expect(renderer.chunkStreamer.queuedChunkCount).toBe(0);
    renderer.dispose();
  });

  it('prunes stale segments in O(1) and pauses only async-gated chunks on yielded Promises', async () => {
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });

    let resolveAsset!: () => void;
    const pendingAsset = new Promise<void>((res) => {
      resolveAsset = res;
    });

    // Test ChunkStreamer async Promise gatekeeper directly on a mesh-landmark chunk
    const { ChunkStreamer } = await import('../chunkStreamer');
    const { createSharedToonMaterials } = await import('../toonMaterials');
    const { createProceduralMeshAssets } = await import('../meshFactory');
    const { GraphicsTracker } = await import('../graphicsTracker');
    const { GraphicsUtils } = await import('../graphicsUtils');

    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const assets = createProceduralMeshAssets(gfx);

    const gatedStreamer = new ChunkStreamer(gfx, mats, assets, {
      assetWaiter: (modelId) => (modelId === 'hero_arch' ? pendingAsset : null),
    });

    const gatedLandmarks: SegmentLandmarkRequirement[] = [
      {
        id: 'mesh_arch',
        kind: 'forkArch',
        segmentId: 10,
        chunkIndex: 1,
        s: 50,
        x: 0,
        worldX: 0,
        worldY: -12.5,
        worldZ: -50,
        yawRad: 0,
        clearanceRadius: 4,
        visual: { kind: 'mesh', modelId: 'hero_arch' },
      },
    ];
    const seg10 = createMockSegment(10, 'curr', 'sunny-blue', 0, 105, 35, gatedLandmarks);
    const seg11 = createMockSegment(11, 'nextLeft', 'icy-black', -105, 70, 35);

    gatedStreamer.step({ prev: null, curr: seg10, nextLeft: seg11, nextRight: null }, 50);
    // Chunk 1 of seg10 yielded the asset Promise, so exactly 1 chunk remains queued while all others completed!
    expect(gatedStreamer.queuedChunkCount).toBe(1);
    expect(gatedStreamer.activeChunkCount).toBe(5);

    resolveAsset();
    await pendingAsset;

    gatedStreamer.step({ prev: null, curr: seg10, nextLeft: seg11, nextRight: null }, 50);
    expect(gatedStreamer.queuedChunkCount).toBe(0);

    // Pruning seg10 from trail window reclaims its 3 RibbonPool slots immediately
    gatedStreamer.step({ prev: null, curr: seg11, nextLeft: null, nextRight: null }, 50);
    expect(gatedStreamer.activeChunkCount).toBe(2);
    expect(gatedStreamer.ribbonPool.activeCount).toBe(2);

    gatedStreamer.clearAll();
    tracker.disposeAll();

    // Also test SkierRig wipeout/invulnerable blink + DebugOverlay3D toggle in ThreeRenderer
    const simState = createMockSimState();
    const wipeoutState: ReadonlySimState = {
      ...simState,
      skierState: 'wipeout',
      wipeoutTimerSec: 0.6,
      invulnerableTimerSec: 0.5,
      debugDraw: { ...simState.debugDraw, enabled: false },
    };
    renderer.sync(wipeoutState, 0.25, 1 / 60);
    expect(renderer.runLeakCheck(0, true).totalLeaks).toBe(0);
    renderer.dispose();
  });

  it('streams a full 44-chunk 4-slot fork window without pool exhaustion and never busy-spins when RibbonPool is full', async () => {
    const { ChunkStreamer } = await import('../chunkStreamer');
    const { createSharedToonMaterials } = await import('../toonMaterials');
    const { createProceduralMeshAssets } = await import('../meshFactory');
    const { GraphicsTracker } = await import('../graphicsTracker');
    const { GraphicsUtils } = await import('../graphicsUtils');

    // 1. 4 overlapping 360m segments (11 chunks each = 44 chunks <= 48 RibbonPool capacity)
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });
    const prev = createMockSegment(101, 'prev', 'sunny-blue', 360, 360, 35);
    const curr = createMockSegment(102, 'curr', 'sunny-blue', 0, 360, 35);
    const nextLeft = createMockSegment(103, 'nextLeft', 'sunny-blue', -360, 360, 35);
    const nextRight = createMockSegment(104, 'nextRight', 'icy-black', -360, 360, 35);

    const baseState = createMockSimState();
    const bigForkState: ReadonlySimState = {
      ...baseState,
      trailWindow: { prev, curr, nextLeft, nextRight },
    };

    for (let f = 0; f < 30; f++) {
      renderer.sync(bigForkState, 0.5, 1 / 60, 50);
    }
    expect(renderer.chunkStreamer.activeChunkCount).toBe(44);
    expect(renderer.chunkStreamer.queuedChunkCount).toBe(0);
    expect(renderer.chunkStreamer.ribbonPool.activeCount).toBe(44);
    renderer.dispose();

    // 2. Non-busy-spin when RibbonPool has only 1 slot and 3 chunks are queued
    let nowCalls = 0;
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const assets = createProceduralMeshAssets(gfx);
    const tinyStreamer = new ChunkStreamer(gfx, mats, assets, {
      ribbonPoolCapacity: 1,
      nowMs: () => {
        nowCalls++;
        return 0; // Clock stays 0; busy-spin would loop infinitely without breaking!
      },
    });

    const threeChunkSeg = createMockSegment(200, 'curr', 'sunny-blue', 0, 105, 35);
    tinyStreamer.step({ prev: null, curr: threeChunkSeg, nextLeft: null, nextRight: null }, 14);
    expect(tinyStreamer.ribbonPool.activeCount).toBe(1);
    expect(tinyStreamer.queuedChunkCount).toBe(2);
    // Bounded clock checks prove starved chunks broke immediately instead of spinning until 14ms
    expect(nowCalls).toBeLessThan(30);

    tinyStreamer.clearAll();
    tracker.disposeAll();
  });

  it('invalidates stale chunks when seed or stageId changes across reset and centers SnowVfx along camera forward', async () => {
    const { ChunkStreamer } = await import('../chunkStreamer');
    const { createSharedToonMaterials } = await import('../toonMaterials');
    const { createProceduralMeshAssets } = await import('../meshFactory');
    const { GraphicsTracker } = await import('../graphicsTracker');
    const { GraphicsUtils } = await import('../graphicsUtils');

    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const assets = createProceduralMeshAssets(gfx);
    const streamer = new ChunkStreamer(gfx, mats, assets);

    const run1Seg = createMockSegment(1, 'curr', 'sunny-blue', 0, 70, 35);
    streamer.step({ prev: null, curr: run1Seg, nextLeft: null, nextRight: null }, 50);
    expect(streamer.activeChunkCount).toBe(2);
    expect(streamer.queuedChunkCount).toBe(0);

    const slotBefore = streamer.ribbonPool.getSlot(0)!;
    const uploadBefore = slotBefore.positionUploadCount;

    // Reset with same segmentId=1 and rebaseCount=0, but new seed and stageId='icy-black'
    const run2SegBase = createMockSegment(1, 'curr', 'icy-black', 0, 70, 35);
    const run2Seg: TerrainSegmentView = { ...run2SegBase, seed: 9999 };
    streamer.step({ prev: null, curr: run2Seg, nextLeft: null, nextRight: null }, 50);
    expect(streamer.activeChunkCount).toBe(2);
    expect(streamer.queuedChunkCount).toBe(0);
    // Rebuilt chunk uploaded new vertex data for the new seed/stageId
    const totalUploads =
      (streamer.ribbonPool.getSlot(0)?.positionUploadCount ?? 0) +
      (streamer.ribbonPool.getSlot(1)?.positionUploadCount ?? 0) +
      (streamer.ribbonPool.getSlot(2)?.positionUploadCount ?? 0) +
      (streamer.ribbonPool.getSlot(3)?.positionUploadCount ?? 0);
    expect(totalUploads).toBeGreaterThan(uploadBefore * 2);

    streamer.clearAll();
    tracker.disposeAll();

    // SnowVfx camera-forward box centering on curved run looking toward +X
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });
    const baseState = createMockSimState();
    const curvedState: ReadonlySimState = {
      ...baseState,
      prevCamera: {
        ...baseState.prevCamera,
        posX: 0,
        posY: 4,
        posZ: 0,
        lookAtX: 25,
        lookAtY: 2,
        lookAtZ: 0,
      },
      currCamera: {
        ...baseState.currCamera,
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
    // Mean X must sit forward along +X (~11m) rather than centered at X=0
    expect(meanX).toBeGreaterThan(5);
    renderer.dispose();
  });
});
