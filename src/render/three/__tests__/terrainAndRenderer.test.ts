import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENERY_TIER_RULES } from '../../../content/sceneryRules';
import {
  STAGE_BLIZZARD_RIDGE,
  STAGE_ICY_BLACK,
  STAGE_POWDER_BOWL,
  STAGE_SUNNY_BLUE,
} from '../../../content/stages';
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
  TERRAIN_FLAG_ON_PISTE,
  type ChunkRangeOut,
  type MountainColumnOut,
  type MountainSampleOut,
  type ReadonlySimState,
  type RibbonPointOut,
  type SegmentLandmarkRequirement,
  type SimEvents,
  type SpineFrameOut,
  type SpineView,
  type TerrainDirtyRect,
  type TerrainFieldView,
  type TerrainGridSampleOut,
  type TerrainSegmentView,
  type TrailSlotRole,
  type TrailWindowView,
} from '../../../sim/contracts';
import { SkiSimulation } from '../../../sim/skiSimulation';
import {
  CLIPMAP_LAYERS,
  CLIPMAP_PATCH_QUADS,
  CLIPMAP_SPACINGS_M,
  CLIPMAP_TEX_SIZE,
  ClipmapDataStore,
  linearToSRGBChannel,
  srgbToLinearChannel,
} from '../clipmapDataStore';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { InstancePools, MAX_STATIC_BILLBOARDS } from '../instancePools';
import { LandmarkStreamer } from '../landmarkStreamer';
import { createProceduralMeshAssets } from '../meshFactory';
import { createTrailGateAssets, createTrailGateObject } from '../models/trailGateModel';
import { createSmoothOutlineMaterial } from '../outlineShader';
import { CAMERA_FAR_M, ThreeRenderer } from '../renderer';
import { SkierRig } from '../skierRig';
import { CarveSprayVfx } from '../carveSprayVfx';
import {
  SceneryCellStreamer,
  type TileSceneryItem,
} from '../sceneryCellStreamer';
import {
  evaluateSceneryRuleFitness,
  selectWinningSceneryRule,
  type SceneryEnvSignal,
} from '../scenerySelector';
import {
  ALL_TREE_FRAMES,
  isFrostedTreeFrame,
  isGreenTreeFrame,
  isTreeBillboardFrame,
  TREE_FRAME_PROPORTIONS,
} from '../spriteAtlas';
import {
  buildClipmapPatchBaseGeometry,
  CLIPMAP_LOD_RANGES_M,
  CLIPMAP_PATCH_TRIANGLE_COUNT,
  CLIPMAP_PATCH_VERTEX_COUNT,
  MAX_CLIPMAP_PATCHES,
  TerrainClipmap,
} from '../terrainClipmap';
import {
  bindClipmapStoreToMaterial,
  createSharedToonMaterials,
  NOISE_ORIGIN_MOD_PERIOD,
  positiveMod,
} from '../toonMaterials';

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

interface MutableMockField extends TerrainFieldView {
  setOffset(ox: number, oy: number, oz: number): void;
  addHeightBump(minAbsX: number, maxAbsX: number, minAbsZ: number, maxAbsZ: number, deltaH: number): void;
  readonly ackCount: number;
}

function createMockMountainField(worldSeed = 1337): MutableMockField {
  const state = {
    worldSeed,
    originOffsetX: 0,
    originOffsetY: 0,
    originOffsetZ: 0,
    fieldRevision: 1,
    ackCount: 0,
    bumpRect: null as { minX: number; maxX: number; minZ: number; maxZ: number; deltaH: number } | null,
  };
  const dirtyRects: TerrainDirtyRect[] = [];
  const stageIdTable = ['powder-bowl', 'sunny-blue', 'granite-gorge', 'icy-black', 'blizzard-ridge'];

  const heightAbs = (absX: number, absZ: number): number => {
    let h = absZ * 0.25 + Math.sin(absX * 0.08) * 1.5;
    const b = state.bumpRect;
    if (b && absX >= b.minX && absX <= b.maxX && absZ >= b.minZ && absZ <= b.maxZ) {
      h += b.deltaH;
    }
    return h;
  };

  const evalSample = (wx: number, wz: number, out: MountainSampleOut): MountainSampleOut => {
    const base = createMountainSampleOut();
    Object.assign(out, base);
    const absX = wx + state.originOffsetX;
    const absZ = wz + state.originOffsetZ;
    out.heightY = heightAbs(absX, absZ) - state.originOffsetY;
    out.macroY = absZ * 0.25 - state.originOffsetY;
    out.onPiste = Math.abs(absX) <= 14;
    out.pisteWeight = out.onPiste ? 1 : 0;
    out.nearestSignedX = absX;
    out.nearestHalfWidth = 14;
    out.nearestStageId = 'sunny-blue';
    out.normalX = 0;
    out.normalY = 0.96;
    out.normalZ = -0.25;
    return out;
  };

  return {
    get worldSeed(): number {
      return state.worldSeed;
    },
    get originOffsetX(): number {
      return state.originOffsetX;
    },
    get originOffsetY(): number {
      return state.originOffsetY;
    },
    get originOffsetZ(): number {
      return state.originOffsetZ;
    },
    get fieldRevision(): number {
      return state.fieldRevision;
    },
    get dirtyRects(): readonly TerrainDirtyRect[] {
      return dirtyRects;
    },
    get ackCount(): number {
      return state.ackCount;
    },
    stageIdTable,
    setOffset(ox: number, oy: number, oz: number): void {
      state.originOffsetX = ox;
      state.originOffsetY = oy;
      state.originOffsetZ = oz;
    },
    addHeightBump(minX: number, maxX: number, minZ: number, maxZ: number, deltaH: number): void {
      state.bumpRect = { minX, maxX, minZ, maxZ, deltaH };
      dirtyRects.push({ minAbsX: minX, maxAbsX: maxX, minAbsZ: minZ, maxAbsZ: maxZ });
      state.fieldRevision++;
    },
    ackDirtyRects(): void {
      dirtyRects.length = 0;
      state.ackCount++;
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
      return heightAbs(absX, absZ) - state.originOffsetY;
    },
    evaluateColumn(wx: number, wz: number, out: MountainColumnOut): MountainColumnOut {
      const base = createMountainColumnOut();
      Object.assign(out, base);
      const absX = wx + state.originOffsetX;
      const absZ = wz + state.originOffsetZ;
      out.heightY = heightAbs(absX, absZ) - state.originOffsetY;
      out.macroY = absZ * 0.25 - state.originOffsetY;
      out.onPiste = Math.abs(absX) <= 14;
      out.pisteWeight = out.onPiste ? 1 : 0;
      out.nearestSignedX = absX;
      out.nearestHalfWidth = 14;
      out.nearestStageId = 'sunny-blue';
      return out;
    },
    evaluate: evalSample,
    evaluateSample: evalSample,
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
        const absZ = originAbsZ + r * stepM;
        for (let c = 0; c < cols; c++) {
          const absX = originAbsX + c * stepM;
          const idx = r * cols + c;
          const macroY = absZ * 0.25;
          const h = heightAbs(absX, absZ);
          out.heights[idx] = h - blockOriginY;
          out.macroY[idx] = macroY - blockOriginY;
          out.normals[idx * 3] = 0;
          out.normals[idx * 3 + 1] = 0.96;
          out.normals[idx * 3 + 2] = -0.25;
          const onPiste = Math.abs(absX) <= 14;
          out.pisteWeight[idx] = onPiste ? 1 : 0;
          out.iceWeight[idx] = 0;
          out.powderWeight[idx] = onPiste ? 0 : 1;
          out.dividerMask[idx] = 0;
          out.flowXZ[idx * 2] = 0;
          out.flowXZ[idx * 2 + 1] = -1;
          out.offPisteDist[idx] = Math.max(0, Math.abs(absX) - 14);
          out.primaryStageIdx[idx] = 1; // sunny-blue
          out.secondaryStageIdx[idx] = 1;
          out.secondaryStageWeightU8[idx] = 0;
          out.flags[idx] = onPiste ? TERRAIN_FLAG_ON_PISTE : 0;
        }
      }
    },
  };
}

function createMockSimState(fieldOverride?: TerrainFieldView): ReadonlySimState {
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
      walking: false,
      walkPhaseRad: 0,
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
      walking: false,
      walkPhaseRad: 0,
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
    mountainField: fieldOverride ?? createMockMountainField(1337),
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
      structures: {
        count: 0,
        capacity: 32,
        defIds: [],
        segmentIds: new Int32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        yawRad: new Float32Array(0),
        halfWidth: new Float32Array(0),
        halfDepth: new Float32Array(0),
        height: new Float32Array(0),
        skirtDepth: new Float32Array(0),
        boundingRadius: new Float32Array(0),
        lethalFlags: new Uint8Array(0),
        presentsDropped: new Uint8Array(0),
        speedRetention: new Float32Array(0),
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

interface MockGlUploadCall {
  x: number;
  y: number;
  layer: number;
  w: number;
  h: number;
  format: number;
  type: number;
  srcOffset: number;
}

function createMockWebGL2Renderer(): {
  renderer: THREE.WebGLRenderer;
  initCalls: Array<{ tex: THREE.Texture; versionAtInit: number }>;
  subUploads: MockGlUploadCall[];
  pixelStoreCalls: Array<[number, number]>;
  clearProps(): void;
} {
  const initCalls: Array<{ tex: THREE.Texture; versionAtInit: number }> = [];
  const subUploads: MockGlUploadCall[] = [];
  const pixelStoreCalls: Array<[number, number]> = [];
  const propsMap = new WeakMap<object, Record<string, unknown>>();
  let nextHandleId = 1;
  let boundArrayTex: unknown = { id: 999, sentinel: true };

  const gl = {
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNPACK_ROW_LENGTH: 0x0cf2,
    UNPACK_IMAGE_HEIGHT: 0x806e,
    UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3,
    UNPACK_SKIP_IMAGES: 0x806d,
    RED: 0x1903,
    RGBA: 0x1908,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    getParameter(pname: number): unknown {
      if (pname === 0x8c1d) return boundArrayTex;
      return null;
    },
    pixelStorei(pname: number, param: number): void {
      pixelStoreCalls.push([pname, param]);
    },
    bindTexture(_target: number, tex: unknown): void {
      boundArrayTex = tex;
    },
    texSubImage3D(
      _target: number,
      _level: number,
      x: number,
      y: number,
      layer: number,
      w: number,
      h: number,
      _depth: number,
      format: number,
      type: number,
      _srcData: ArrayBufferView,
      srcOffset = 0,
    ): void {
      subUploads.push({ x, y, layer, w, h, format, type, srcOffset });
    },
  };

  let propStore = propsMap;
  const renderer = {
    getContext: () => gl,
    properties: {
      get(obj: object): Record<string, unknown> {
        let p = propStore.get(obj);
        if (!p) {
          p = {};
          propStore.set(obj, p);
        }
        return p;
      },
    },
    initTexture(tex: THREE.Texture): void {
      initCalls.push({ tex, versionAtInit: tex.version });
      if (tex.version > 0) {
        const p = renderer.properties.get(tex) as Record<string, unknown>;
        p.__webglTexture = { id: nextHandleId++ };
      }
    },
  } as unknown as THREE.WebGLRenderer;

  return {
    renderer,
    initCalls,
    subUploads,
    pixelStoreCalls,
    clearProps(): void {
      propStore = new WeakMap<object, Record<string, unknown>>();
    },
  };
}

function expandThreeShaderIncludes(source: string): string {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  let result = source;
  for (let depth = 0; depth < 8; depth++) {
    const next = result.replace(/#include\s+<([\w_]+)>/g, (_m, name: string) => {
      return chunks[name] ?? `#include <${name}>`;
    });
    if (next === result) break;
    result = next;
  }
  return result;
}

describe('CDLOD TerrainClipmap, ClipmapDataStore, SceneryCellStreamer, LandmarkStreamer & ThreeRenderer', () => {
  it('builds 1-draw-call 16x16 CDLOD InstancedMesh with +Y CCW diagonals, camera.far=750, non-overflowing quadtree, and zero GPU leaks', () => {
    let clockMs = 0;
    const eventBus = new EventBus<SimEvents>();
    const profiler = new Profiler();
    const renderer = new ThreeRenderer(null, eventBus, profiler, {
      headless: true,
      initialWidth: 390,
      initialHeight: 844,
      nowMs: () => clockMs,
    });

    expect(renderer.camera.far).toBe(CAMERA_FAR_M);
    expect(renderer.camera.far).toBe(750);

    const simState = createMockSimState();
    for (let f = 0; f < 12; f++) {
      clockMs += 16;
      renderer.sync(simState, 0.5, 1 / 60, 50);
      if (renderer.clipmapStore.pendingWorkCount === 0 && renderer.sceneryStreamer.queuedCellCount === 0) {
        break;
      }
    }

    // 1. Verify 1-draw-call InstancedMesh base patch geometry & +Y CCW uniform v00->v11 winding
    const clipMesh = renderer.terrainClipmap.mesh;
    expect(clipMesh.isInstancedMesh).toBe(true);
    expect(clipMesh.frustumCulled).toBe(false);
    expect(clipMesh.receiveShadow).toBe(true);
    expect(clipMesh.castShadow).toBe(false);
    expect(clipMesh.count).toBe(renderer.terrainClipmap.patchCount);
    expect(clipMesh.count).toBeGreaterThan(20);
    expect(clipMesh.count).toBeLessThanOrEqual(MAX_CLIPMAP_PATCHES);

    const baseGeo = buildClipmapPatchBaseGeometry();
    const posAttr = baseGeo.getAttribute('position') as THREE.BufferAttribute;
    const idxAttr = baseGeo.getIndex()!;
    expect(posAttr.count).toBe(CLIPMAP_PATCH_VERTEX_COUNT); // 289
    expect(idxAttr.count).toBe(CLIPMAP_PATCH_TRIANGLE_COUNT * 3); // 1536 (512 tris)

    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const triN = new THREE.Vector3();
    for (let k = 0; k < idxAttr.count; k += 3) {
      const ia = idxAttr.getX(k);
      const ib = idxAttr.getX(k + 1);
      const ic = idxAttr.getX(k + 2);
      vA.fromBufferAttribute(posAttr, ia);
      vB.fromBufferAttribute(posAttr, ib);
      vC.fromBufferAttribute(posAttr, ic);
      e1.subVectors(vB, vA);
      e2.subVectors(vC, vA);
      triN.crossVectors(e1, e2);
      expect(triN.y).toBeGreaterThan(0);
    }
    baseGeo.dispose();

    // 2. Verify fog density clamp (>= 65m), pools, landmarks, shadows, ski tracks, backpack, debug overlay
    const fog = renderer.scene.fog as THREE.FogExp2;
    expect(fog.density).toBeLessThanOrEqual(1.6 / 65 + 1e-4);

    const poolsRoot = renderer.scene.getObjectByName('InstancePoolsRoot')!;
    const boulderSmallPool = poolsRoot.getObjectByName('BoulderSmallPool') as THREE.InstancedMesh;
    const boulderLargePool = poolsRoot.getObjectByName('BoulderLargePool') as THREE.InstancedMesh;
    const presentStdPool = poolsRoot.getObjectByName('PresentStdPool') as THREE.InstancedMesh;
    const presentGoldPool = poolsRoot.getObjectByName('PresentGoldPool') as THREE.InstancedMesh;
    const rampPool = poolsRoot.getObjectByName('RampPool') as THREE.InstancedMesh;
    const dynBbPool = poolsRoot.getObjectByName('DynamicBillboardPool') as THREE.InstancedMesh;
    const charBbPool = poolsRoot.getObjectByName('CharacterBillboardPool') as THREE.InstancedMesh;
    const staticBbPool = poolsRoot.getObjectByName('StaticSceneryBillboardPool') as THREE.InstancedMesh;
    expect(boulderSmallPool.count).toBe(1);
    expect(boulderLargePool.count).toBe(1);
    expect(presentStdPool.count).toBe(1);
    expect(presentGoldPool.count).toBe(1);
    expect(rampPool.count).toBe(1);
    expect(dynBbPool.count).toBe(1);
    expect(charBbPool.count).toBe(3);
    expect(staticBbPool.count).toBeGreaterThan(0);
    expect(staticBbPool.count).toBeLessThanOrEqual(MAX_STATIC_BILLBOARDS);
    expect(boulderSmallPool.frustumCulled).toBe(false);
    expect(dynBbPool.frustumCulled).toBe(false);
    expect(charBbPool.frustumCulled).toBe(false);
    expect(charBbPool.castShadow).toBe(false);
    expect(staticBbPool.frustumCulled).toBe(false);

    const forkArches: THREE.Object3D[] = [];
    renderer.scene.traverse((obj) => {
      if (obj.name === 'ForkArchLandmark') forkArches.push(obj);
    });
    expect(forkArches).toHaveLength(2);
    expect(forkArches.some((a) => a.getObjectByName('ForkBadgeSquare')?.visible === true)).toBe(true);
    expect(forkArches.some((a) => a.getObjectByName('ForkBadgeDiamond')?.visible === true)).toBe(true);

    const shadowsPool = renderer.scene.getObjectByName('ContactShadowsPool') as THREE.InstancedMesh;
    expect(shadowsPool.count).toBe(9);

    const skiTracks = renderer.scene.getObjectByName('SkiTracksMesh') as THREE.Mesh;
    expect(skiTracks.geometry.drawRange.count).toBe(24);

    const backpackStd = renderer.scene.getObjectByName('BackpackStackStd') as THREE.InstancedMesh;
    const backpackGold = renderer.scene.getObjectByName('BackpackStackGold') as THREE.InstancedMesh;
    expect(backpackStd.count).toBe(1);
    expect(backpackGold.count).toBe(1);

    const debugRoot = renderer.scene.getObjectByName('DebugOverlay3DRoot')!;
    expect(debugRoot.visible).toBe(true);

    // 3. Leak check, resize, and complete disposal
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

  it('enforces CDLOD quadtree lodRange non-overflow bounds across all 5 tiers and worst-case snap offsets (farCorner <= committedHalfSpan)', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const store = new ClipmapDataStore(gfx);
    bindClipmapStoreToMaterial(gfx, mats, store);
    const clipmap = new TerrainClipmap(gfx, mats.terrainMaterial, mats.clipmapUniforms);
    const field = createMockMountainField(42);

    // Worst-case focus positions right before 16-texel snap boundaries (positive and negative!)
    const testPositions: Array<[number, number]> = [
      [0, 0],
      [7.99, 7.99],
      [-0.01, -7.99],
      [127.99, -255.99],
      [-511.95, 1023.95],
    ];

    for (const [fx, fz] of testPositions) {
      store.reset();
      store.update(field, fx, 0, fz, null, 50);
      // Full 360-degree quadtree (no frustum culling) to stress-test every single emitted patch
      clipmap.update(store, fx, fz, 0, 0, 0, null);

      expect(clipmap.patchCount).toBeGreaterThan(80);
      expect(clipmap.patchCount).toBeLessThanOrEqual(MAX_CLIPMAP_PATCHES);

      // Every single LOD tier L0..L4 must be represented in full 360-degree traversal
      for (let L = 0; L < CLIPMAP_LAYERS; L++) {
        expect(clipmap.patchCountsByLod[L]!).toBeGreaterThan(0);
      }

      // Verify EVERY emitted patch corner fits strictly inside its committed toroidal texture radius!
      const pw = clipmap.patchWorldArray;
      const pt = clipmap.patchTexArray;
      for (let i = 0; i < clipmap.patchCount; i++) {
        const o4 = i * 4;
        const originX = pw[o4]!;
        const originZ = pw[o4 + 2]!;
        const spacing = pw[o4 + 3]!;
        const modX = pt[o4]!;
        const modZ = pt[o4 + 1]!;
        const lod = Math.round(pt[o4 + 2]!);

        expect(lod).toBeGreaterThanOrEqual(0);
        expect(lod).toBeLessThan(CLIPMAP_LAYERS);
        expect(spacing).toBe(CLIPMAP_SPACINGS_M[lod]!);
        expect(Number.isInteger(modX)).toBe(true);
        expect(Number.isInteger(modZ)).toBe(true);
        expect(modX).toBeGreaterThanOrEqual(0);
        expect(modX).toBeLessThan(CLIPMAP_TEX_SIZE);
        expect(modZ).toBeGreaterThanOrEqual(0);
        expect(modZ).toBeLessThan(CLIPMAP_TEX_SIZE);

        const patchSizeM = CLIPMAP_PATCH_QUADS * spacing;
        const absTx0 = Math.round(originX / spacing);
        const absTz0 = Math.round(originZ / spacing);
        expect(absTx0 & (CLIPMAP_PATCH_QUADS - 1)).toBe(0);
        expect(absTz0 & (CLIPMAP_PATCH_QUADS - 1)).toBe(0);
        expect((absTx0 & 255)).toBe(modX);
        expect((absTz0 & 255)).toBe(modZ);

        // Hard committed-window non-overflow check (includes right/bottom border vertex +16!)
        expect(
          store.isRectCommitted(
            lod,
            absTx0,
            absTx0 + CLIPMAP_PATCH_QUADS,
            absTz0,
            absTz0 + CLIPMAP_PATCH_QUADS,
          ),
        ).toBe(true);

        // Far corner horizontal distance from focus MUST stay strictly <= committedHalfSpanM (<= 52m on L0!)
        const farCornerDist = Math.max(
          Math.hypot(originX - fx, originZ - fz),
          Math.hypot(originX + patchSizeM - fx, originZ - fz),
          Math.hypot(originX - fx, originZ + patchSizeM - fz),
          Math.hypot(originX + patchSizeM - fx, originZ + patchSizeM - fz),
        );
        const maxAllowedDist = lod === 0 ? 52 : store.getCommittedHalfSpanM(lod);
        expect(farCornerDist).toBeLessThanOrEqual(maxAllowedDist);
      }
    }

    expect(CLIPMAP_LOD_RANGES_M[0]).toBeLessThanOrEqual(28);
    clipmap.dispose();
    tracker.disposeAll();
  });

  it('produces 0 cracked vertices and 0 uncollapsed odd T-junctions across all L<->L and L<->L+1 shared patch borders (steady-state and forced scroll lag)', () => {
    const sim = new SkiSimulation({ seed: 2025, startStageId: 'icy-black' });
    const simState = sim.getState();

    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    let clockMs = 0;
    const store = new ClipmapDataStore(gfx, {
      nowMs: () => {
        clockMs += 1.0;
        return clockMs;
      },
    });
    bindClipmapStoreToMaterial(gfx, mats, store);
    const clipmap = new TerrainClipmap(gfx, mats.terrainMaterial, mats.clipmapUniforms);

    const ox = simState.mountainField.originOffsetX;
    const oy = simState.mountainField.originOffsetY;
    const oz = simState.mountainField.originOffsetZ;

    // Exact JS mirror of the vertex shader CDLOD geomorphing & height-fetch transform
    const evalVertexShader = (
      patchIdx: number,
      gx: number,
      gz: number,
    ): { x: number; y: number; z: number; morph: number; lod: number } => {
      const o4 = patchIdx * 4;
      const patchOriginX = clipmap.patchWorldArray[o4]!;
      const patchOriginY = clipmap.patchWorldArray[o4 + 1]!;
      const patchOriginZ = clipmap.patchWorldArray[o4 + 2]!;
      const spacing = clipmap.patchWorldArray[o4 + 3]!;
      const originModX = Math.round(clipmap.patchTexArray[o4]!);
      const originModZ = Math.round(clipmap.patchTexArray[o4 + 1]!);
      const lod = clamp(Math.round(clipmap.patchTexArray[o4 + 2]!), 0, CLIPMAP_LAYERS - 1);
      const nextLod = Math.min(lod + 1, CLIPMAP_LAYERS - 1);
      const morphStart = clipmap.patchTexArray[o4 + 3]!;
      const morphEnd = mats.clipmapUniforms.uMorphEnds.value[lod]!;

      const oddX = gx & 1;
      const oddZ = gz & 1;
      const coarseGx = gx - oddX;
      const coarseGz = gz - oddZ;

      const fineX = patchOriginX + gx * spacing;
      const fineZ = patchOriginZ + gz * spacing;
      const coarseX = patchOriginX + coarseGx * spacing;
      const coarseZ = patchOriginZ + coarseGz * spacing;

      const focus = mats.clipmapUniforms.uFocusLocalXZ.value;
      const distXZ = Math.hypot(fineX - focus.x, fineZ - focus.y);
      const morph =
        lod < CLIPMAP_LAYERS - 1
          ? clamp((distXZ - morphStart) / Math.max(1e-4, morphEnd - morphStart), 0, 1)
          : 0;

      const morphedX = fineX + (coarseX - fineX) * morph;
      const morphedZ = fineZ + (coarseZ - fineZ) * morph;

      const txFine = (originModX + gx) & 255;
      const tzFine = (originModZ + gz) & 255;
      const h0 = store.heightData[lod * 65536 + tzFine * 256 + txFine]!;
      let h1 = h0;
      if (lod < CLIPMAP_LAYERS - 1 && morph > 0.0001) {
        const modNext = mats.clipmapUniforms.uLayerOriginModXZ.value[nextLod]!;
        const txCoarse = Math.round((coarseX + modNext.x) * (0.5 / spacing)) & 255;
        const tzCoarse = Math.round((coarseZ + modNext.y) * (0.5 / spacing)) & 255;
        h1 = store.heightData[nextLod * 65536 + tzCoarse * 256 + txCoarse]!;
      }
      const height = h0 + (h1 - h0) * morph;
      return { x: morphedX, y: patchOriginY + height, z: morphedZ, morph, lod };
    };

    const assertZeroCracksAcrossAllSharedBorders = (label: string): {
      sameLodChecked: number;
      crossLodChecked: number;
    } => {
      interface PatchMeta {
        idx: number;
        lod: number;
        spacing: number;
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
      }
      const patches: PatchMeta[] = [];
      for (let i = 0; i < clipmap.patchCount; i++) {
        const o4 = i * 4;
        const minX = clipmap.patchWorldArray[o4]!;
        const minZ = clipmap.patchWorldArray[o4 + 2]!;
        const spacing = clipmap.patchWorldArray[o4 + 3]!;
        const lod = Math.round(clipmap.patchTexArray[o4 + 2]!);
        const size = CLIPMAP_PATCH_QUADS * spacing;
        patches.push({ idx: i, lod, spacing, minX, maxX: minX + size, minZ, maxZ: minZ + size });
      }

      let sameLodChecked = 0;
      let crossLodChecked = 0;
      let crackedCount = 0;
      let uncollapsedTJunctions = 0;

      for (let i = 0; i < patches.length; i++) {
        const a = patches[i]!;
        for (let j = i + 1; j < patches.length; j++) {
          const b = patches[j]!;
          const xTouch = Math.abs(a.maxX - b.minX) < 1e-4 || Math.abs(b.maxX - a.minX) < 1e-4;
          const zTouch = Math.abs(a.maxZ - b.minZ) < 1e-4 || Math.abs(b.maxZ - a.minZ) < 1e-4;
          if (!xTouch && !zTouch) continue;

          const overlapMinX = Math.max(a.minX, b.minX);
          const overlapMaxX = Math.min(a.maxX, b.maxX);
          const overlapMinZ = Math.max(a.minZ, b.minZ);
          const overlapMaxZ = Math.min(a.maxZ, b.maxZ);

          const isVerticalEdge = xTouch && overlapMaxZ - overlapMinZ > 1e-4;
          const isHorizontalEdge = zTouch && overlapMaxX - overlapMinX > 1e-4;
          if (!isVerticalEdge && !isHorizontalEdge) continue;

          if (a.lod === b.lod) {
            const steps = isVerticalEdge
              ? Math.round((overlapMaxZ - overlapMinZ) / a.spacing)
              : Math.round((overlapMaxX - overlapMinX) / a.spacing);
            for (let k = 0; k <= steps; k++) {
              const wx = isVerticalEdge ? overlapMinX : overlapMinX + k * a.spacing;
              const wz = isVerticalEdge ? overlapMinZ + k * a.spacing : overlapMinZ;
              const va = evalVertexShader(
                a.idx,
                Math.round((wx - a.minX) / a.spacing),
                Math.round((wz - a.minZ) / a.spacing),
              );
              const vb = evalVertexShader(
                b.idx,
                Math.round((wx - b.minX) / b.spacing),
                Math.round((wz - b.minZ) / b.spacing),
              );
              sameLodChecked++;
              const dXZ = Math.hypot(va.x - vb.x, va.z - vb.z);
              const dY = Math.abs(va.y - vb.y);
              if (dXZ >= 1e-4 || dY >= 1e-4) crackedCount++;
            }
          } else {
            // Cross-LOD border: fine (L) must border coarse (L+1) with diff === 1
            const fine = a.lod < b.lod ? a : b;
            const coarse = a.lod < b.lod ? b : a;
            expect(coarse.lod - fine.lod, `${label}: LOD jump > 1`).toBe(1);

            const fineSteps = isVerticalEdge
              ? Math.round((overlapMaxZ - overlapMinZ) / fine.spacing)
              : Math.round((overlapMaxX - overlapMinX) / fine.spacing);
            for (let k = 0; k <= fineSteps; k++) {
              const wx = isVerticalEdge ? overlapMinX : overlapMinX + k * fine.spacing;
              const wz = isVerticalEdge ? overlapMinZ + k * fine.spacing : overlapMinZ;
              const fgx = Math.round((wx - fine.minX) / fine.spacing);
              const fgz = Math.round((wz - fine.minZ) / fine.spacing);
              const vf = evalVertexShader(fine.idx, fgx, fgz);
              crossLodChecked++;

              // On shared L <-> L+1 edge, fine vertex MUST have morph === 1.0 (zero uncollapsed T-junctions!)
              if (vf.morph < 1 - 1e-5) {
                uncollapsedTJunctions++;
              }

              // Coarse target vertex after fine odd-vertex collapse (coarseGrid = g - (g & 1))
              const targetX = fine.minX + (fgx - (fgx & 1)) * fine.spacing;
              const targetZ = fine.minZ + (fgz - (fgz & 1)) * fine.spacing;
              const cgx = Math.round((targetX - coarse.minX) / coarse.spacing);
              const cgz = Math.round((targetZ - coarse.minZ) / coarse.spacing);
              const vc = evalVertexShader(coarse.idx, cgx, cgz);

              const dXZ = Math.hypot(vf.x - vc.x, vf.z - vc.z);
              const dY = Math.abs(vf.y - vc.y);
              if (dXZ >= 1e-4 || dY >= 1e-4) crackedCount++;
            }
          }
        }
      }

      expect(uncollapsedTJunctions, `${label}: uncollapsed T-junctions`).toBe(0);
      expect(crackedCount, `${label}: cracked border vertices`).toBe(0);
      return { sameLodChecked, crossLodChecked };
    };

    // Scenario A: Steady-state real MountainField (seed 2025, icy-black, full 360-degree quadtree)
    const fx0 = simState.currSkier.posX;
    const fy0 = simState.currSkier.posY;
    const fz0 = simState.currSkier.posZ;
    store.update(simState.mountainField, fx0, fy0, fz0, null, 50);
    clipmap.update(store, fx0, fz0, ox, oy, oz, null);
    const steadyStats = assertZeroCracksAcrossAllSharedBorders('steady-state');
    expect(steadyStats.sameLodChecked).toBeGreaterThan(500);
    expect(steadyStats.crossLodChecked).toBeGreaterThan(500);

    // Scenario B: Forced scroll lag (24 m sudden move under 0.5 ms budget -> L0 lags behind committed center)
    const fxLag = fx0 + 6.0;
    const fzLag = fz0 - 24.0;
    store.update(simState.mountainField, fxLag, fy0, fzLag, null, 0.5);
    clipmap.update(store, fxLag, fzLag, ox, oy, oz, null);
    // effectiveRanges[0] must shrink smoothly below base range while keeping 0 cracks & 0 T-junctions!
    expect(clipmap.effectiveRanges[0]!).toBeLessThanOrEqual(CLIPMAP_LOD_RANGES_M[0]);
    const lagStats = assertZeroCracksAcrossAllSharedBorders('forced-scroll-lag-24m');
    expect(lagStats.sameLodChecked).toBeGreaterThan(200);
    expect(lagStats.crossLodChecked).toBeGreaterThan(200);

    // Scenario C: Extreme scroll lag (44 m move under 0.5 ms budget -> L0 shrinks to 0 cleanly, L1..L4 seamless)
    const fzExtreme = fz0 - 44.0;
    store.update(simState.mountainField, fx0, fy0, fzExtreme, null, 0.5);
    clipmap.update(store, fx0, fzExtreme, ox, oy, oz, null);
    expect(clipmap.effectiveRanges[0]!).toBe(0);
    expect(clipmap.patchCountsByLod[0]!).toBe(0);
    assertZeroCracksAcrossAllSharedBorders('extreme-scroll-lag-44m');

    clipmap.dispose();
    tracker.disposeAll();
    sim.dispose();
  });

  it('uploads via needsUpdate-before-initTexture + raw gl.texSubImage3D with toroidal wrap splits, zero uploads on fractional WORLD_REBASED, global re-anchor, dirtyRects invalidation, and instant context restore', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const store = new ClipmapDataStore(gfx);
    bindClipmapStoreToMaterial(gfx, mats, store);
    const clipmap = new TerrainClipmap(gfx, mats.terrainMaterial, mats.clipmapUniforms);
    const field = createMockMountainField(777);
    const mockGl = createMockWebGL2Renderer();

    // 1. Initial boot MUST set needsUpdate=true (version > 0) BEFORE renderer.initTexture(tex) (#21 S1!)
    store.update(field, 0, 0, 0, mockGl.renderer, 50);
    expect(store.isGpuInitialized).toBe(true);
    expect(mockGl.initCalls).toHaveLength(4);
    for (const call of mockGl.initCalls) {
      expect(call.versionAtInit).toBeGreaterThan(0);
    }

    // Drain initial refinement completely on fast mock field
    for (let f = 0; f < 30 && store.pendingWorkCount > 0; f++) {
      store.update(field, 0, 0, 0, mockGl.renderer, 100);
    }
    expect(store.pendingWorkCount).toBe(0);

    // 2. Verify ZERO texel evaluations and ZERO GPU uploads across fractional WORLD_REBASED!
    const evalsBeforeRebase = store.texelsEvaluatedCount;
    const uploadsBeforeRebase = store.gpuUploadCount;
    const stripsBeforeRebase = store.dirtyStripUploadCount;
    const subLenBeforeRebase = mockGl.subUploads.length;

    const fracDx = 128.37;
    const fracDy = -34.62;
    const fracDz = -128.83;
    field.setOffset(fracDx, fracDy, fracDz);
    // Focus in local render space shifts by -delta so absFocus remains bit-identical!
    store.update(field, -fracDx, -fracDy, -fracDz, mockGl.renderer, 50);
    clipmap.update(store, -fracDx, -fracDz, fracDx, fracDy, fracDz, null);

    expect(store.texelsEvaluatedCount).toBe(evalsBeforeRebase);
    expect(store.gpuUploadCount).toBe(uploadsBeforeRebase);
    expect(store.dirtyStripUploadCount).toBe(stripsBeforeRebase);
    expect(mockGl.subUploads.length).toBe(subLenBeforeRebase);

    // 3. Scroll across toroidal 255 -> 0 wrap boundary and verify raw gl.texSubImage3D zero-copy rows + UNPACK_IMAGE_HEIGHT=0 + continuity
    mockGl.subUploads.length = 0;
    mockGl.pixelStoreCalls.length = 0;
    for (let step = 1; step <= 20; step++) {
      // Advance +8 m per step along -Z so L0 shifts 16 texels/step across wrap boundary 255 -> 0
      const absZ = -step * 8.0;
      const localZ = absZ - field.originOffsetZ;
      for (let s = 0; s < 20 && (s === 0 || store.pendingWorkCount > 0); s++) {
        store.update(field, -fracDx, -fracDy, localZ, mockGl.renderer, 50);
      }
    }
    expect(mockGl.subUploads.length).toBeGreaterThan(0);
    expect(mockGl.pixelStoreCalls.some(([p, v]) => p === 0x0cf5 && v === 1)).toBe(true); // UNPACK_ALIGNMENT = 1
    expect(mockGl.pixelStoreCalls.some(([p, v]) => p === 0x806e && v === 0)).toBe(true); // UNPACK_IMAGE_HEIGHT = 0
    // Full-width row uploads MUST hit the zero-copy fast path (x === 0, w === 256, never split horizontally)
    // and iOS Safari / Metal ANGLE hardening requires srcOffset === 0 via TypedArray.subarray()!
    expect(mockGl.subUploads.every((u) => u.x === 0 && u.w === CLIPMAP_TEX_SIZE)).toBe(true);
    expect(mockGl.subUploads.every((u) => u.srcOffset === 0)).toBe(true);
    // Verify wrap-around height continuity in L0 mirror right after scrolling 160 m (> 128 m full wrap!)
    const testAbsZ = -152.0;
    const testAbsX = 4.0;
    const expectedAbsH = field.evaluateHeight(testAbsX - fracDx, testAbsZ - fracDz) + fracDy;
    const mirrorAbsH = store.sampleMirrorHeightBilinearAbs(0, testAbsX, testAbsZ);
    expect(Math.abs(mirrorAbsH - expectedAbsH)).toBeLessThan(0.01);

    // 4. fieldRevision + dirtyRects invalidation updates only clipped affected region & calls ackDirtyRects()
    const acksBefore = field.ackCount;
    const patchAbsX = 2.0;
    const patchAbsZ = -154.0;
    const heightBeforeBump = store.sampleMirrorHeightAbs(0, Math.round(patchAbsX / 0.5), Math.round(patchAbsZ / 0.5));
    field.addHeightBump(patchAbsX - 2, patchAbsX + 2, patchAbsZ - 2, patchAbsZ + 2, 12.5);
    for (let s = 0; s < 20 && (s === 0 || store.pendingWorkCount > 0); s++) {
      store.update(field, -fracDx, -fracDy, -160 - fracDz, mockGl.renderer, 50);
    }
    expect(field.ackCount).toBe(acksBefore + 1);
    const heightAfterBump = store.sampleMirrorHeightAbs(0, Math.round(patchAbsX / 0.5), Math.round(patchAbsZ / 0.5));
    expect(heightAfterBump - heightBeforeBump).toBeCloseTo(12.5, 2);

    // 4b. Partial teleport (L0 jumps >= 128 texels = 80m, while L1..L4 jump < 128 texels) MUST preserve L1..L4 dirtyRects!
    const l1TestTx = 0;
    const l1TestTz = -170;
    const l1BeforePartial = store.sampleMirrorHeightAbs(1, l1TestTx, l1TestTz);
    field.addHeightBump(-4, 4, -174, -166, 9.0);
    // Jump -80m along Z -> L0 shifts 160 texels (partial teleport!) while L1 shifts 80 texels (< 128, non-booted!)
    const jumpLocalZ = -240 - fracDz;
    store.update(field, -fracDx, -fracDy, jumpLocalZ, mockGl.renderer, 50);
    for (let s = 0; s < 300 && store.pendingWorkCount > 0; s++) {
      store.update(field, -fracDx, -fracDy, jumpLocalZ, mockGl.renderer, 50);
    }
    const l1AfterPartial = store.sampleMirrorHeightAbs(1, l1TestTx, l1TestTz);
    expect(l1AfterPartial - l1BeforePartial).toBeCloseTo(9.0, 2);

    // 4c. Scrolling mid-refinement MUST never skip a coarse-seeded row (256-bit toroidal bitmask drains to 0)
    store.reset();
    let mockClockMs = 0;
    const pacedStore = new ClipmapDataStore(gfx, {
      nowMs: () => {
        mockClockMs += 0.6;
        return mockClockMs;
      },
    });
    pacedStore.update(field, -fracDx, -fracDy, jumpLocalZ, null, 0.5);
    expect(pacedStore.getUnrefinedRowCount(0)).toBe(CLIPMAP_TEX_SIZE);
    // Refine a few rows, then scroll 16 texels on L0, then drain completely with generous budget
    for (let s = 0; s < 5; s++) {
      pacedStore.update(field, -fracDx, -fracDy, jumpLocalZ, null, 0.5);
    }
    const scrolledZ = jumpLocalZ - 8.5;
    for (let s = 0; s < 350 && pacedStore.getUnrefinedRowCount(0) > 0; s++) {
      pacedStore.update(field, -fracDx, -fracDy, scrolledZ, null, 2.0);
    }
    expect(pacedStore.getUnrefinedRowCount(0)).toBe(0);
    const minTz0 = pacedStore.getLoadedMinTexelZ(0);
    for (let r = 0; r < CLIPMAP_TEX_SIZE; r++) {
      expect(pacedStore.isToroidalRowRefined(0, minTz0 + r)).toBe(true);
    }

    // 5. ONE shared global clipmapAnchorAbsY re-anchoring across all 5 layers when |focusAbsY - anchor| > 2048m
    // Re-sync store cleanly at jumpLocalZ before re-anchor test
    store.update(field, -fracDx, -fracDy, jumpLocalZ, mockGl.renderer, 50);
    const anchorBefore = store.clipmapAnchorAbsY;
    const sampleAbsBefore = store.sampleMirrorHeightAbs(0, 0, -480);
    const sampleL4Before = store.sampleMirrorHeightAbs(4, 0, -30);
    store.update(field, -fracDx, -fracDy - 2500, jumpLocalZ, mockGl.renderer, 50);
    expect(store.reanchorCount).toBe(1);
    expect(Math.abs(store.clipmapAnchorAbsY - anchorBefore)).toBeGreaterThan(2048);
    expect(store.sampleMirrorHeightAbs(0, 0, -480)).toBeCloseTo(sampleAbsBefore, 3);
    expect(store.sampleMirrorHeightAbs(4, 0, -30)).toBeCloseTo(sampleL4Before, 3);

    // 6. webglcontextrestored instantaneously restores all 4 DataArrayTextures from CPU mirrors with 0 terrain re-evals
    const evalsBeforeRestore = store.texelsEvaluatedCount;
    const initLenBeforeRestore = mockGl.initCalls.length;
    mockGl.clearProps();
    store.handleContextRestored(mockGl.renderer);
    expect(store.texelsEvaluatedCount).toBe(evalsBeforeRestore);
    expect(mockGl.initCalls.length).toBe(initLenBeforeRestore + 4);
    for (let i = initLenBeforeRestore; i < mockGl.initCalls.length; i++) {
      expect(mockGl.initCalls[i]!.versionAtInit).toBeGreaterThan(0);
    }

    clipmap.dispose();
    tracker.disposeAll();
  });

  it('encodes uAlbedoTex in sRGB (no double-gamma dark snow) and achieves < 1 cm L0 height parity & CPU cavity AO against real MountainField', () => {
    const sim = new SkiSimulation({
      seed: 2025,
      startStageId: 'icy-black',
      debugDrawEnabled: true,
    });
    const intent = createMutablePlayerIntent();
    for (let i = 0; i < 45; i++) {
      const st = sim.getState();
      const targetX = st.trailWindow.curr.sampleSafeX(st.surfaceSample.s + 8);
      intent.steer = clamp((targetX - st.surfaceSample.x) * 0.14, -1, 1);
      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);
    }

    const renderer = new ThreeRenderer(null, sim.eventBus, undefined, { headless: true });
    const simState = sim.getState();

    // Frame 0 cold boot immediately seeds all 5 layers AND exact 32x32 L0 core around skier
    renderer.sync(simState, 0.5, 1 / 60, 50);

    const store = renderer.clipmapStore;
    expect(store.albedoTex.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(store.heightTex.format).toBe(THREE.RedFormat);
    expect(store.heightTex.type).toBe(THREE.FloatType);
    expect(store.heightTex.minFilter).toBe(THREE.NearestFilter);
    expect(store.heightTex.magFilter).toBe(THREE.NearestFilter);

    // 1. Verify < 1 cm height parity between L0 CPU mirror and real MountainField around skier
    const sx = simState.currSkier.posX;
    const sz = simState.currSkier.posZ;
    const ox = simState.mountainField.originOffsetX;
    const oy = simState.mountainField.originOffsetY;
    const oz = simState.mountainField.originOffsetZ;

    let maxErrM = 0;
    for (let dz = -5; dz <= 5; dz += 1) {
      for (let dx = -5; dx <= 5; dx += 1) {
        const wx = sx + dx;
        const wz = sz + dz;
        const trueAbsH = simState.mountainField.evaluateHeight(wx, wz) + oy;
        const mirrorAbsH = store.sampleMirrorHeightBilinearAbs(0, wx + ox, wz + oz);
        const err = Math.abs(mirrorAbsH - trueAbsH);
        if (err > maxErrM) maxErrM = err;
      }
    }
    expect(maxErrM).toBeLessThan(0.01);

    // 2. Verify uAlbedoTex sRGB encoding on sunny-blue snow (#f8fbff -> sRGB bytes ~[248, 251, 255], NOT dark linear!)
    const sunnyField = createMockMountainField(555);
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const sunnyStore = new ClipmapDataStore(gfx);
    sunnyStore.update(sunnyField, 0, 0, 0, null, 50);

    const bytes: [number, number, number, number] = [0, 0, 0, 0];
    sunnyStore.readMirrorAlbedoBytes(0, 0, 0, bytes);
    const expectedLinear = new THREE.Color(STAGE_SUNNY_BLUE.palette.snowColor);
    expect(bytes[0]).toBeGreaterThanOrEqual(246);
    expect(bytes[1]).toBeGreaterThanOrEqual(249);
    expect(bytes[2]).toBeGreaterThanOrEqual(253);
    expect(srgbToLinearChannel(bytes[0] / 255)).toBeCloseTo(expectedLinear.r, 2);
    expect(srgbToLinearChannel(bytes[1] / 255)).toBeCloseTo(expectedLinear.g, 2);
    expect(srgbToLinearChannel(bytes[2] / 255)).toBeCloseTo(expectedLinear.b, 2);
    expect(linearToSRGBChannel(expectedLinear.r) * 255).toBeCloseTo(248, 0);

    // 3. Verify CPU-baked AO channel in flowElevData stays in valid [0.62, 1.06] physical range
    let minAo = Infinity;
    let maxAo = -Infinity;
    for (let i = 0; i < CLIPMAP_TEX_SIZE * CLIPMAP_TEX_SIZE; i++) {
      const aoByte = store.flowElevData[i * 4 + 3]!;
      const ao = 0.5 + (aoByte / 255) * 0.6;
      if (ao < minAo) minAo = ao;
      if (ao > maxAo) maxAo = ao;
    }
    expect(minAo).toBeGreaterThanOrEqual(0.6);
    expect(maxAo).toBeLessThanOrEqual(1.1);

    // 4. Verify SnowVfx forward-centering on a curved camera looking along +X
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
    tracker.disposeAll();
    sim.dispose();
  });

  it('decouples LandmarkStreamer from terrain, handles async assetWaiter, O(1) prune, and reset() badge updates', async () => {
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

    landmarkStreamer.sync(window1);
    expect(landmarkStreamer.activeCount).toBe(2);
    expect(landmarkStreamer.pendingCount).toBe(1);

    resolveHero();
    await heroPromise;
    landmarkStreamer.sync(window1);
    expect(landmarkStreamer.pendingCount).toBe(0);
    expect(landmarkStreamer.activeCount).toBe(3);

    landmarkStreamer.handleWorldRebased(5, -10, -20);
    const archObj = landmarkStreamer.rootGroup.getObjectByName('ForkArchLandmark')!;
    expect(archObj.position.x).toBeCloseTo(-18, 5);
    expect(archObj.position.y).toBeCloseTo(-25, 5);
    expect(archObj.position.z).toBeCloseTo(-120, 5);

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

    landmarkStreamer.sync({ prev: null, curr: seg2, nextLeft: null, nextRight: null });
    expect(landmarkStreamer.activeCount).toBe(0);

    landmarkStreamer.clearAll();
    tracker.disposeAll();
  });

  it('streams decoupled 32m SceneryCellStreamer with deterministic placement, exclusions, LOD-change invariance, cross-fork biomes, and translation-only rebase', () => {
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

    const scenery = new SceneryCellStreamer({ halfExtentCells: 3 });
    const pools = new InstancePools(gfx, mats, outlineMat, bbMat, bbQuad, assets);

    for (let f = 0; f < 30 && (f === 0 || scenery.queuedCellCount > 0); f++) {
      scenery.step(
        simState.trailWindow,
        simState.mountainField,
        simState.currSkier.posX,
        simState.currSkier.posZ,
        0,
        -1,
        50,
      );
    }
    expect(scenery.queuedCellCount).toBe(0);
    expect(scenery.sceneryRevision).toBeGreaterThan(0);

    const activeLandmarks: SegmentLandmarkRequirement[] = [];
    for (const seg of [
      simState.trailWindow.prev,
      simState.trailWindow.curr,
      simState.trailWindow.nextLeft,
      simState.trailWindow.nextRight,
    ]) {
      if (seg) activeLandmarks.push(...seg.landmarks);
    }

    const sampleOut = createMountainSampleOut();
    const snapshotBeforeMove = new Map<string, { x: number; y: number; z: number; frame: string }>();
    let totalItems = 0;

    scenery.forEachActiveScenery((ox, oy, oz, item) => {
      totalItems++;
      const wx = ox + item.localX;
      const wy = oy + item.localY;
      const wz = oz + item.localZ;

      simState.mountainField.evaluate(wx, wz, sampleOut);
      expect(sampleOut.onPiste).toBe(false);
      expect(sampleOut.pisteWeight).toBeLessThanOrEqual(0.15);
      expect(sampleOut.normalY).toBeGreaterThanOrEqual(0.72);
      expect(sampleOut.inChasmZone).toBe(false);
      // Authoritative height parity minus slope sink (zero coarse-LOD floating/sinking drift!)
      expect(wy).toBeLessThanOrEqual(sampleOut.heightY + 1e-4);
      expect(sampleOut.heightY - wy).toBeLessThan(1.5);

      for (let i = 0; i < activeLandmarks.length; i++) {
        const lm = activeLandmarks[i]!;
        const minR = Math.max(2.5, lm.clearanceRadius);
        expect(Math.hypot(wx - lm.worldX, wz - lm.worldZ)).toBeGreaterThanOrEqual(minR - 1e-3);
      }

      const key = `${Math.round(wx * 100)},${Math.round(wz * 100)}`;
      snapshotBeforeMove.set(key, { x: wx, y: wy, z: wz, frame: item.frame });
    });

    expect(totalItems).toBeGreaterThan(20);
    expect(totalItems).toBeLessThanOrEqual(MAX_STATIC_BILLBOARDS);

    pools.sync(simState, 0.5, scenery);
    const staticMesh = pools.rootGroup.getObjectByName(
      'StaticSceneryBillboardPool',
    ) as THREE.InstancedMesh;
    expect(staticMesh.count).toBe(totalItems);

    // Moving skier slightly (crossing CDLOD L0 morph rings!) MUST NOT alter any surviving scenery item's height/position
    scenery.step(
      simState.trailWindow,
      simState.mountainField,
      simState.currSkier.posX + 5,
      simState.currSkier.posZ - 14,
      0,
      -1,
      50,
    );
    let overlapChecked = 0;
    scenery.forEachActiveScenery((ox, oy, oz, item) => {
      const wx = ox + item.localX;
      const wy = oy + item.localY;
      const wz = oz + item.localZ;
      const key = `${Math.round(wx * 100)},${Math.round(wz * 100)}`;
      const prev = snapshotBeforeMove.get(key);
      if (prev) {
        overlapChecked++;
        expect(wy).toBe(prev.y);
        expect(item.frame).toBe(prev.frame);
      }
    });
    expect(overlapChecked).toBeGreaterThan(15);

    // Translation-only WORLD_REBASED shifts all scenery positions by exact (-dx, -dy, -dz)
    const revBeforeRebase = scenery.sceneryRevision;
    const preRebaseFirst: [number, number, number] = [0, 0, 0];
    scenery.forEachActiveScenery((ox, oy, oz, item) => {
      preRebaseFirst[0] = ox + item.localX;
      preRebaseFirst[1] = oy + item.localY;
      preRebaseFirst[2] = oz + item.localZ;
      return false;
    });
    scenery.handleWorldRebased(16, -32, -128);
    expect(scenery.sceneryRevision).toBe(revBeforeRebase + 1);
    const postRebaseFirst: [number, number, number] = [0, 0, 0];
    scenery.forEachActiveScenery((ox, oy, oz, item) => {
      postRebaseFirst[0] = ox + item.localX;
      postRebaseFirst[1] = oy + item.localY;
      postRebaseFirst[2] = oz + item.localZ;
      return false;
    });
    expect(postRebaseFirst[0]).toBeCloseTo(preRebaseFirst[0] - 16, 5);
    expect(postRebaseFirst[1]).toBeCloseTo(preRebaseFirst[1] + 32, 5);
    expect(postRebaseFirst[2]).toBeCloseTo(preRebaseFirst[2] + 128, 5);

    // Deterministic seeding: identical seed -> identical placements; different seed -> distinct placements
    const scenerySame = new SceneryCellStreamer({ halfExtentCells: 3 });
    const sceneryBase = new SceneryCellStreamer({ halfExtentCells: 3 });
    for (let f = 0; f < 30; f++) {
      sceneryBase.step(simState.trailWindow, simState.mountainField, simState.currSkier.posX, simState.currSkier.posZ, 0, -1, 50);
      scenerySame.step(simState.trailWindow, simState.mountainField, simState.currSkier.posX, simState.currSkier.posZ, 0, -1, 50);
      if (sceneryBase.queuedCellCount === 0 && scenerySame.queuedCellCount === 0) break;
    }
    const itemsA: number[] = [];
    const itemsB: number[] = [];
    sceneryBase.forEachActiveScenery((ox, _oy, oz, itItem) => {
      itemsA.push(ox + itItem.localX, oz + itItem.localZ);
    });
    scenerySame.forEachActiveScenery((ox, _oy, oz, itItem) => {
      itemsB.push(ox + itItem.localX, oz + itItem.localZ);
    });
    expect(itemsB).toEqual(itemsA);

    const simDiff = new SkiSimulation({ seed: 888, startStageId: 'icy-black' });
    const sceneryDiff = new SceneryCellStreamer({ halfExtentCells: 3 });
    for (let f = 0; f < 30; f++) {
      sceneryDiff.step(
        simDiff.getState().trailWindow,
        simDiff.getState().mountainField,
        simDiff.getState().currSkier.posX,
        simDiff.getState().currSkier.posZ,
        0,
        -1,
        50,
      );
      if (sceneryDiff.queuedCellCount === 0) break;
    }
    const itemsC: number[] = [];
    sceneryDiff.forEachActiveScenery((ox, _oy, oz, itItem) => {
      itemsC.push(ox + itItem.localX, oz + itItem.localZ);
    });
    expect(itemsC).not.toEqual(itemsA);

    scenery.clearAll();
    pools.sync(simState, 0.5, scenery);
    expect(staticMesh.count).toBe(0);

    sceneryBase.clearAll();
    scenerySame.clearAll();
    sceneryDiff.clearAll();
    tracker.disposeAll();
    simDiff.dispose();
    sim.dispose();
  });

  it('evaluates SceneryTierRule slope gates, canopy suppression, cross-fork biome fidelity, dual-radius tucking, and green circle badge', () => {
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

    const outerSlopeSignal: SceneryEnvSignal = { ...talusSignal, minNormalY: 0.81, lod: 1 };
    expect(evaluateSceneryRuleFitness(pineRule, outerSlopeSignal)).toBe(0);
    expect(evaluateSceneryRuleFitness(rockRule, outerSlopeSignal)).toBeGreaterThan(0);

    const flatForestSignal: SceneryEnvSignal = {
      minNormalY: 0.94,
      distFromTrail: 14,
      relElevation: 2,
      worldNoise01: 0.65,
      lod: 0,
      scenery: STAGE_POWDER_BOWL.layout.scenery,
    };
    for (const roll of [0.05, 0.35, 0.75, 0.95]) {
      const winner = selectWinningSceneryRule(DEFAULT_SCENERY_TIER_RULES, flatForestSignal, true, roll);
      expect(winner).not.toBeNull();
      expect(winner!.layer).toBe('ground');
    }

    // Cross-fork straddling 32m cell (powder-bowl left vs blizzard-ridge right)
    const scenery = new SceneryCellStreamer({ halfExtentCells: 2 });
    const mockSeg = createMockSegment(1, 'curr', 'powder-bowl', 0, 140, 35);
    const mockWindow: TrailWindowView = { prev: null, curr: mockSeg, nextLeft: null, nextRight: null };
    const splitField: TerrainFieldView = {
      worldSeed: 901,
      originOffsetX: 0,
      originOffsetY: 0,
      originOffsetZ: 0,
      fieldRevision: 1,
      dirtyRects: [],
      stageIdTable: ['powder-bowl', 'blizzard-ridge'],
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
        out.onPiste = false;
        out.pisteWeight = 0;
        out.nearestSignedX = wx < 16 ? -24 : 24;
        out.nearestHalfWidth = 10;
        out.nearestStageId = wx < 16 ? 'powder-bowl' : 'blizzard-ridge';
        out.normalX = 0;
        out.normalY = 0.99;
        out.normalZ = -0.1;
        return out;
      },
      evaluateSample(wx, wz, out) {
        return this.evaluate(wx, wz, out);
      },
      sampleColumnGrid() {
        // Unused by SceneryCellStreamer
      },
    };

    for (let f = 0; f < 20 && (f === 0 || scenery.queuedCellCount > 0); f++) {
      scenery.step(mockWindow, splitField, 16, 16, 0, -1, 50);
    }
    expect(scenery.queuedCellCount).toBe(0);

    let leftGreenCount = 0;
    let leftRockOrFrostedCount = 0;
    let rightRockOrFrostedCount = 0;
    let rightCount = 0;
    let leftCount = 0;
    scenery.forEachActiveScenery((ox, _oy, oz, item) => {
      const wx = ox + item.localX;
      const wz = oz + item.localZ;
      if (wx < 0 || wx >= 32 || wz < 0 || wz >= 32) return;
      if (wx < 15.5) {
        leftCount++;
        if (isGreenTreeFrame(item.frame) || item.frame === 'snow_shrub') leftGreenCount++;
        if (item.frame === 'alpine_rock' || item.frame === 'rock_crag' || isFrostedTreeFrame(item.frame)) {
          leftRockOrFrostedCount++;
        }
      } else if (wx > 16.5) {
        rightCount++;
        if (item.frame === 'alpine_rock' || item.frame === 'rock_crag' || isFrostedTreeFrame(item.frame)) {
          rightRockOrFrostedCount++;
        }
      }
    });
    expect(leftCount).toBeGreaterThan(2);
    expect(rightCount).toBeGreaterThan(0);
    expect(leftGreenCount).toBeGreaterThan(leftRockOrFrostedCount);
    expect(rightRockOrFrostedCount).toBeGreaterThanOrEqual(1);

    // Real SkiSimulation powder-bowl: dual-radius spacing + understory tucking
    const simPowder = new SkiSimulation({ seed: 505, startStageId: 'powder-bowl' });
    const powderState = simPowder.getState();
    const powderScenery = new SceneryCellStreamer({ halfExtentCells: 3 });
    for (let f = 0; f < 30 && (f === 0 || powderScenery.queuedCellCount > 0); f++) {
      powderScenery.step(
        powderState.trailWindow,
        powderState.mountainField,
        powderState.currSkier.posX,
        powderState.currSkier.posZ,
        0,
        -1,
        50,
      );
    }
    expect(powderScenery.queuedCellCount).toBe(0);

    const itemsByCell = new Map<string, Array<{ wx: number; wz: number; item: TileSceneryItem }>>();
    powderScenery.forEachActiveScenery((ox, _oy, oz, item) => {
      const key = `${Math.round(ox)},${Math.round(oz)}`;
      let list = itemsByCell.get(key);
      if (!list) {
        list = [];
        itemsByCell.set(key, list);
      }
      list.push({ wx: ox + item.localX, wz: oz + item.localZ, item: { ...item } });
    });

    const isCanopy = (f: string): boolean => isTreeBillboardFrame(f);
    let minTreeDist = Infinity;
    let minItemDist = Infinity;
    let sawUnderstoryTucked = false;
    const observedTreeFrames = new Set<string>();
    for (const cellItems of itemsByCell.values()) {
      for (const entry of cellItems) {
        if (isTreeBillboardFrame(entry.item.frame)) {
          observedTreeFrames.add(entry.item.frame);
          const prop = TREE_FRAME_PROPORTIONS[entry.item.frame];
          if (prop) {
            expect(entry.item.width / entry.item.height).toBeCloseTo(prop.aspect, 4);
          }
        }
      }
      const trees = cellItems.filter((e) => isCanopy(e.item.frame));
      const groundProps = cellItems.filter((e) => !isCanopy(e.item.frame));
      for (let i = 0; i < cellItems.length; i++) {
        for (let j = i + 1; j < cellItems.length; j++) {
          const d = Math.hypot(cellItems[i]!.wx - cellItems[j]!.wx, cellItems[i]!.wz - cellItems[j]!.wz);
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
    expect(sawUnderstoryTucked).toBe(true);

    // Explicitly verify green circle badge on 'powder-bowl' trail gate
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const gateAssets = createTrailGateAssets(gfx, mats);
    const powderArch = createTrailGateObject(gfx, gateAssets, 'powder-bowl');
    expect(powderArch.group.getObjectByName('ForkBadgeCircle')?.visible).toBe(true);
    expect(powderArch.group.getObjectByName('ForkBadgeSquare')?.visible).toBe(false);
    expect(powderArch.group.getObjectByName('ForkBadgeDiamond')?.visible).toBe(false);
    expect(powderArch.group.getObjectByName('TrailGateLeftPost')).toBeDefined();
    expect(powderArch.group.getObjectByName('TrailGateRightPost')).toBeDefined();
    gfx.disposeObject(powderArch.group);
    tracker.disposeAll();

    // Verify blizzard-ridge fog clamp & rocky scenery
    const blizSim = new SkiSimulation({ seed: 101, startStageId: 'blizzard-ridge' });
    const blizRenderer = new ThreeRenderer(null, blizSim.eventBus, undefined, { headless: true });
    for (let f = 0; f < 15; f++) {
      blizRenderer.sync(blizSim.getState(), 0.5, 0.1, 50);
    }
    const fogBliz = blizRenderer.scene.fog as THREE.FogExp2;
    expect(fogBliz.density).toBeCloseTo(1.6 / STAGE_BLIZZARD_RIDGE.weather.fogMinDist, 2);

    let sawRockScenery = false;
    blizRenderer.sceneryStreamer.forEachActiveScenery((_ox, _oy, _oz, item) => {
      if (item.frame === 'alpine_rock' || item.frame === 'rock_crag') {
        sawRockScenery = true;
      }
      if (isTreeBillboardFrame(item.frame)) {
        observedTreeFrames.add(item.frame);
        const prop = TREE_FRAME_PROPORTIONS[item.frame];
        if (prop) {
          expect(item.width / item.height).toBeCloseTo(prop.aspect, 4);
        }
      }
    });
    expect(sawRockScenery).toBe(true);
    for (const expectedTreeFrame of ALL_TREE_FRAMES) {
      expect(
        observedTreeFrames.has(expectedTreeFrame),
        `expected scenery to emit tree variant ${expectedTreeFrame}`,
      ).toBe(true);
    }

    expect(blizRenderer.runLeakCheck(0, true).totalLeaks).toBe(0);
    blizRenderer.dispose();
    tracker.disposeAll();
    scenery.clearAll();
    powderScenery.clearAll();
    blizSim.dispose();
    simPowder.dispose();
  });

  it('stitched CDLOD snow-toon hybrid GLSL expands cleanly against three@0.181.0 ShaderLib.toon with shadow-normal alignment, morph blending, SkyDome, shadows, and CarveSprayVfx', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);

    // 1. Expand all #include chunks against live three@0.181.0 ShaderLib.toon
    const toonShader = THREE.ShaderLib.toon!;
    const mockShader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: toonShader.vertexShader,
      fragmentShader: toonShader.fragmentShader,
    };
    mats.terrainMaterial.onBeforeCompile(
      mockShader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );

    const expandedVert = expandThreeShaderIncludes(mockShader.vertexShader);
    const expandedFrag = expandThreeShaderIncludes(mockShader.fragmentShader);

    // 0 unresolved #include directives
    expect(expandedVert).not.toMatch(/#include\s+</);
    expect(expandedFrag).not.toMatch(/#include\s+</);

    // Balanced braces
    const countChar = (s: string, ch: string): number => s.split(ch).length - 1;
    expect(countChar(expandedVert, '{')).toBe(countChar(expandedVert, '}'));
    expect(countChar(expandedFrag, '{')).toBe(countChar(expandedFrag, '}'));
    expect(countChar(expandedVert, '(')).toBe(countChar(expandedVert, ')'));
    expect(countChar(expandedFrag, '(')).toBe(countChar(expandedFrag, ')'));

    // Vertex CDLOD geomorphing + shadow-normal alignment BEFORE <defaultnormal_vertex> & <shadowmap_vertex>
    expect(expandedVert).toContain('uniform highp sampler2DArray uHeightTex;');
    expect(expandedVert).toContain('texelFetch(uHeightTex, ivec3(cdlodTexFine, cdlodLayer), 0).r');
    expect(expandedVert).toContain('ivec2(round(aPatchTex.xy))');
    expect(expandedVert).toContain('int(round(aPatchTex.z))');
    expect(expandedVert).toContain('float cdlodDistXZ = length(cdlodFineXZ - uFocusLocalXZ);');
    expect(expandedVert).toContain('float cdlodHeight = mix(cdlodH0, cdlodH1, cdlodMorph);');
    const objNormIdx = expandedVert.indexOf('vec3 objectNormal = cdlodWorldNorm;');
    const defNormIdx = expandedVert.indexOf('transformedNormal = normalMatrix * transformedNormal;');
    const shadowNormIdx = expandedVert.indexOf(
      'vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );',
    );
    const shadowBiasUseIdx = expandedVert.lastIndexOf('shadowNormalBias');
    expect(objNormIdx).toBeGreaterThan(0);
    expect(defNormIdx).toBeGreaterThan(objNormIdx);
    expect(shadowNormIdx).toBeGreaterThan(defNormIdx);
    expect(shadowBiasUseIdx).toBeGreaterThan(shadowNormIdx);

    // Fragment morph-band seam blending + M2 snow-toon hybrid shading + zero legacy dFdx faceting
    expect(expandedFrag).toContain('uniform highp sampler2DArray uNormalMaskTex;');
    expect(expandedFrag).toContain('uniform highp sampler2DArray uAlbedoTex;');
    expect(expandedFrag).toContain('uniform highp sampler2DArray uFlowElevTex;');
    expect(expandedFrag).toContain('if (vMorph > 0.001 && fragLod < 4)');
    expect(expandedFrag).toContain('uniform vec3 uShadowSnowTint;');
    expect(expandedFrag).toContain('uniform vec3 uSkyTopColor;');
    expect(expandedFrag).toContain('uniform vec3 uCliffColor;');
    expect(expandedFrag).toContain('uniform vec2 uNoiseOriginModXZ;');
    expect(expandedFrag).toContain('uniform float uNoiseOriginModY;');
    expect(expandedFrag).toContain('float snowSunlit = 0.84 + 0.16 * saturate(ndl);');
    expect(expandedFrag).toContain('float cordK = 11.78097245;');
    expect(expandedFrag).toContain('float sastrugiFade =');
    expect(expandedFrag).toContain('float sparkleGate = smoothstep(0.45, 0.62, ndl)');
    expect(expandedFrag).toContain('vec3 iceSpecColor =');
    expect(expandedFrag).toContain('outgoingLight += reflectedLight.directSpecular;');
    const expandedFragNoComments = expandedFrag.replace(/\/\/[^\n]*/g, '');
    expect(expandedFragNoComments).not.toContain('dFdx(vViewPosition)');
    expect(expandedFragNoComments).not.toMatch(/\bpow\s*\(\s*0/);

    expect(mockShader.uniforms.uHeightTex).toBe(mats.clipmapUniforms.uHeightTex);
    expect(mockShader.uniforms.uNormalMaskTex).toBe(mats.clipmapUniforms.uNormalMaskTex);
    expect(mockShader.uniforms.uAlbedoTex).toBe(mats.clipmapUniforms.uAlbedoTex);
    expect(mockShader.uniforms.uFlowElevTex).toBe(mats.clipmapUniforms.uFlowElevTex);
    expect(mockShader.uniforms.uShadowSnowTint).toBe(mats.sharedUniforms.uShadowSnowTint);
    expect(mockShader.uniforms.uCliffColor).toBe(mats.sharedUniforms.uCliffColor);
    expect(mockShader.uniforms.uNoiseOriginModXZ).toBe(mats.sharedUniforms.uNoiseOriginModXZ);
    expect(mockShader.uniforms.uNoiseOriginModY).toBe(mats.sharedUniforms.uNoiseOriginModY);
    tracker.disposeAll();

    // 2. Verify ThreeRenderer wires SkyDome, texel-snapped directional shadows, CarveSprayVfx, and WORLD_REBASED
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });
    const simState = createMockSimState();
    renderer.sync(simState, 0.5, 1 / 60, 50);

    expect(renderer.dirLight.castShadow).toBe(true);
    expect(renderer.dirLight.shadow.mapSize.x).toBe(1024);
    expect(renderer.dirLight.shadow.mapSize.y).toBe(1024);
    expect(renderer.dirLight.shadow.camera.left).toBe(-48);
    expect(renderer.dirLight.shadow.camera.right).toBe(48);
    expect(renderer.dirLight.shadow.camera.top).toBe(56);
    expect(renderer.dirLight.shadow.camera.bottom).toBe(-56);
    expect(renderer.dirLight.target.parent).toBe(renderer.scene);

    const poolsRoot = renderer.scene.getObjectByName('InstancePoolsRoot')!;
    const staticBbPool = poolsRoot.getObjectByName('StaticSceneryBillboardPool') as THREE.InstancedMesh;
    const dynBbPool = poolsRoot.getObjectByName('DynamicBillboardPool') as THREE.InstancedMesh;
    const boulderSmallPool = poolsRoot.getObjectByName('BoulderSmallPool') as THREE.InstancedMesh;
    expect(staticBbPool.castShadow).toBe(false);
    expect(dynBbPool.castShadow).toBe(false);
    expect(boulderSmallPool.castShadow).toBe(true);

    const skyMesh = renderer.scene.getObjectByName('SkyDomeMesh') as THREE.Mesh;
    expect(skyMesh).toBe(renderer.skyDome.mesh);
    expect(skyMesh.renderOrder).toBe(-1000);
    expect(skyMesh.frustumCulled).toBe(false);
    expect(skyMesh.castShadow).toBe(false);
    expect(skyMesh.receiveShadow).toBe(false);
    expect(skyMesh.position.x).toBeCloseTo(renderer.camera.position.x, 5);
    expect(skyMesh.position.y).toBeCloseTo(renderer.camera.position.y, 5);
    expect(skyMesh.position.z).toBeCloseTo(renderer.camera.position.z, 5);

    const sunnyTopBefore = renderer.skyDome.uniforms.uSkyTop.value.clone();
    const blizState: ReadonlySimState = { ...simState, activeStageId: 'blizzard-ridge' };
    for (let f = 0; f < 25; f++) {
      renderer.sync(blizState, 1, 1 / 60, 50);
    }
    expect(renderer.skyDome.uniforms.uSkyTop.value.b).toBeLessThan(sunnyTopBefore.b);
    expect(renderer.skyDome.uniforms.uBlizzardDim.value).toBeCloseTo(0.35, 3);

    const targetBeforeNudge = renderer.dirLight.target.position.clone();
    const tinyNudgeState: ReadonlySimState = {
      ...blizState,
      prevSkier: { ...blizState.prevSkier, posX: blizState.prevSkier.posX + 0.01 },
      currSkier: { ...blizState.currSkier, posX: blizState.currSkier.posX + 0.01 },
    };
    renderer.sync(tinyNudgeState, 1, 1 / 60, 50);
    expect(renderer.dirLight.target.position.distanceTo(targetBeforeNudge)).toBeLessThan(1e-5);

    const sprayMesh = renderer.scene.getObjectByName('CarveSprayPool') as THREE.InstancedMesh;
    expect(sprayMesh).toBe(renderer.carveSprayVfx.instancedMesh);
    expect(sprayMesh.castShadow).toBe(false);
    expect(sprayMesh.receiveShadow).toBe(false);
    expect(sprayMesh.frustumCulled).toBe(false);

    const carvingState: ReadonlySimState = {
      ...blizState,
      currSkier: {
        ...blizState.currSkier,
        grounded: true,
        speed: 24,
        carveAngleRad: 0.45,
        braking: false,
      },
    };
    for (let f = 0; f < 6; f++) {
      renderer.sync(carvingState, 1, 1 / 30, 50);
    }
    expect(sprayMesh.count).toBeGreaterThan(0);

    const targetBeforeRebase = renderer.dirLight.target.position.clone();
    eventBus.emit('WORLD_REBASED', {
      rebaseCount: 1,
      deltaX: 128,
      deltaY: -64,
      deltaZ: -1152,
      totalOffsetX: 128,
      totalOffsetY: -64,
      totalOffsetZ: -1152,
    });
    const uniforms = renderer.getSharedLightingUniforms();
    expect(uniforms.uNoiseOriginModXZ.value.x).toBeCloseTo(
      positiveMod(128, NOISE_ORIGIN_MOD_PERIOD),
      5,
    );
    expect(uniforms.uNoiseOriginModXZ.value.y).toBeCloseTo(
      positiveMod(-1152, NOISE_ORIGIN_MOD_PERIOD),
      5,
    );
    expect(uniforms.uNoiseOriginModY.value).toBeCloseTo(
      positiveMod(-64, NOISE_ORIGIN_MOD_PERIOD),
      5,
    );
    expect(renderer.dirLight.target.position.x).toBeCloseTo(targetBeforeRebase.x - 128, 4);
    expect(renderer.dirLight.target.position.y).toBeCloseTo(targetBeforeRebase.y + 64, 4);
    expect(renderer.dirLight.target.position.z).toBeCloseTo(targetBeforeRebase.z + 1152, 4);

    // Sim reset (tickCount decreases) clears carve spray pool, resets clipmap & noise offsets
    const resetState: ReadonlySimState = {
      ...simState,
      tickCount: 0,
      currSkier: { ...simState.currSkier, speed: 0, carveAngleRad: 0, braking: false },
      rebase: {
        rebaseCount: 0,
        offsetX: 0,
        offsetY: 0,
        offsetZ: 0,
        lastDeltaX: 0,
        lastDeltaY: 0,
        lastDeltaZ: 0,
      },
    };
    renderer.sync(resetState, 1, 1 / 60, 50);
    expect(sprayMesh.count).toBe(0);
    expect(uniforms.uNoiseOriginModXZ.value.x).toBe(0);
    expect(uniforms.uNoiseOriginModXZ.value.y).toBe(0);
    expect(uniforms.uNoiseOriginModY.value).toBe(0);

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

  it(
    'sustains real-budget (3.25 ms) 1.5 km streaming across 60 FPS & 30 FPS (sunny-blue + icy-black, multiple WORLD_REBASED) with 0 missing frames, >=98% L0 coverage, <=0.15 m skier parity, and srcOffset===0 texSubImage3D uploads',
    { timeout: 60_000 },
    () => {
      const scenarios: ReadonlyArray<{
        label: string;
        seed: number;
        startStageId: string;
        simStepsPerFrame: number;
        budgetMs: number;
        targetDistM: number;
      }> = [
        {
          label: 'sunny-blue-60fps',
          seed: 1337,
          startStageId: 'sunny-blue',
          simStepsPerFrame: 1,
          budgetMs: 3.25,
          targetDistM: 1500,
        },
        {
          label: 'sunny-blue-30fps',
          seed: 1337,
          startStageId: 'sunny-blue',
          simStepsPerFrame: 2,
          budgetMs: 3.25,
          targetDistM: 1500,
        },
        {
          label: 'icy-black-30fps',
          seed: 2025,
          startStageId: 'icy-black',
          simStepsPerFrame: 2,
          budgetMs: 3.25,
          targetDistM: 1500,
        },
      ];

      for (const sc of scenarios) {
        const sim = new SkiSimulation({ seed: sc.seed, startStageId: sc.startStageId });
        const intent = createMutablePlayerIntent();
        const tracker = new GraphicsTracker();
        const gfx = new GraphicsUtils(tracker);
        const mats = createSharedToonMaterials(gfx);
        const store = new ClipmapDataStore(gfx);
        bindClipmapStoreToMaterial(gfx, mats, store);
        const clipmap = new TerrainClipmap(gfx, mats.terrainMaterial, mats.clipmapUniforms);
        const mockGl = createMockWebGL2Renderer();

        // 5 initial frames before downhill start (matching browser boot)
        for (let f = 0; f < 5; f++) {
          const st = sim.getState();
          store.update(
            st.mountainField,
            st.currSkier.posX,
            st.currSkier.posY,
            st.currSkier.posZ,
            mockGl.renderer,
            sc.budgetMs,
          );
          clipmap.update(
            store,
            st.currSkier.posX,
            st.currSkier.posZ,
            st.mountainField.originOffsetX,
            st.mountainField.originOffsetY,
            st.mountainField.originOffsetZ,
            null,
          );
        }

        const evalClipmapAt = (
          wx: number,
          wz: number,
          ox: number,
          oy: number,
          oz: number,
        ): { y: number; lod: number } => {
          let bestLod = 99;
          for (let i = 0; i < clipmap.patchCount; i++) {
            const o4 = i * 4;
            const x0 = clipmap.patchWorldArray[o4]!;
            const z0 = clipmap.patchWorldArray[o4 + 2]!;
            const sz = CLIPMAP_PATCH_QUADS * clipmap.patchWorldArray[o4 + 3]!;
            if (
              wx >= x0 - 1e-4 &&
              wx <= x0 + sz + 1e-4 &&
              wz >= z0 - 1e-4 &&
              wz <= z0 + sz + 1e-4
            ) {
              const lod = Math.round(clipmap.patchTexArray[o4 + 2]!);
              if (lod < bestLod) bestLod = lod;
            }
          }
          if (bestLod >= CLIPMAP_LAYERS) return { y: NaN, lod: -1 };
          return {
            y: store.sampleMirrorHeightBilinearAbs(bestLod, wx + ox, wz + oz) - oy,
            lod: bestLod,
          };
        };

        let frames = 0;
        let missingFrames = 0;
        let l0ActiveFrames = 0;
        let maxSkierErrM = 0;
        let maxPresentErrM = 0;
        let maxLandmarkErrM = 0;
        let nonZeroSrcOffsetCount = 0;
        let totalSubUploads = 0;
        const maxFrames = 8000;

        while (sim.getState().distanceM < sc.targetDistM && frames < maxFrames) {
          for (let s = 0; s < sc.simStepsPerFrame; s++) {
            const st0 = sim.getState();
            if (st0.gameOver) break;
            const targetX = st0.trailWindow.curr.sampleSafeX(st0.surfaceSample.s + 14);
            const downhillYaw = Math.atan2(
              -st0.surfaceSample.tangentX,
              -st0.surfaceSample.tangentZ,
            );
            const latErr = targetX - st0.surfaceSample.x;
            const desiredYaw = downhillYaw - clamp(latErr * 0.065, -0.55, 0.55);
            let headingErr = desiredYaw - st0.currSkier.headingRad;
            while (headingErr > Math.PI) headingErr -= Math.PI * 2;
            while (headingErr < -Math.PI) headingErr += Math.PI * 2;
            intent.steer = clamp(-headingErr * 2.2, -1, 1);
            sim.savePreviousPoses();
            sim.step(FIXED_DT, intent);
          }

          const st = sim.getState();
          if (st.gameOver) break;
          frames++;
          const ox = st.mountainField.originOffsetX;
          const oy = st.mountainField.originOffsetY;
          const oz = st.mountainField.originOffsetZ;

          mockGl.subUploads.length = 0;
          store.update(
            st.mountainField,
            st.currSkier.posX,
            st.currSkier.posY,
            st.currSkier.posZ,
            mockGl.renderer,
            sc.budgetMs,
          );
          for (let u = 0; u < mockGl.subUploads.length; u++) {
            totalSubUploads++;
            if (mockGl.subUploads[u]!.srcOffset !== 0) {
              nonZeroSrcOffsetCount++;
            }
          }

          clipmap.update(store, st.currSkier.posX, st.currSkier.posZ, ox, oy, oz, null);

          const skierSample = evalClipmapAt(st.currSkier.posX, st.currSkier.posZ, ox, oy, oz);
          if (clipmap.mesh.count <= 0 || Number.isNaN(skierSample.y)) {
            missingFrames++;
          } else {
            if (skierSample.lod === 0) l0ActiveFrames++;
            const trueY = st.mountainField.evaluateHeight(st.currSkier.posX, st.currSkier.posZ);
            const err = Math.abs(skierSample.y - trueY);
            if (err > maxSkierErrM) maxSkierErrM = err;
          }

          // Spot-check nearby presents and landmarks within 45 m (L0/L1 playable corridor)
          if (frames % 10 === 0 && st.distanceM >= 20) {
            const presents = st.entities.presents;
            for (let i = 0; i < presents.count; i++) {
              if (presents.collected[i]) continue;
              const px = presents.posX[i]!;
              const pz = presents.posZ[i]!;
              if (Math.hypot(px - st.currSkier.posX, pz - st.currSkier.posZ) > 45) continue;
              const pRes = evalClipmapAt(px, pz, ox, oy, oz);
              if (!Number.isNaN(pRes.y)) {
                const ty = st.mountainField.evaluateHeight(px, pz);
                const e = Math.abs(pRes.y - ty);
                if (e > maxPresentErrM) maxPresentErrM = e;
              }
            }
            for (const seg of [
              st.trailWindow.curr,
              st.trailWindow.nextLeft,
              st.trailWindow.nextRight,
            ]) {
              if (!seg) continue;
              for (let i = 0; i < seg.landmarks.length; i++) {
                const lm = seg.landmarks[i]!;
                if (Math.hypot(lm.worldX - st.currSkier.posX, lm.worldZ - st.currSkier.posZ) > 45) {
                  continue;
                }
                const lRes = evalClipmapAt(lm.worldX, lm.worldZ, ox, oy, oz);
                if (!Number.isNaN(lRes.y)) {
                  const ty = st.mountainField.evaluateHeight(lm.worldX, lm.worldZ);
                  const e = Math.abs(lRes.y - ty);
                  if (e > maxLandmarkErrM) maxLandmarkErrM = e;
                }
              }
            }
          }
        }

        const finalState = sim.getState();
        expect(finalState.distanceM, `${sc.label}: distance`).toBeGreaterThanOrEqual(sc.targetDistM);
        expect(finalState.rebase.rebaseCount, `${sc.label}: multiple rebases`).toBeGreaterThanOrEqual(4);
        expect(missingFrames, `${sc.label}: 0 missing terrain frames`).toBe(0);
        expect(
          l0ActiveFrames / Math.max(1, frames),
          `${sc.label}: >= 98% L0 coverage`,
        ).toBeGreaterThanOrEqual(0.98);
        expect(maxSkierErrM, `${sc.label}: skier parity <= 0.15m`).toBeLessThanOrEqual(0.15);
        expect(maxPresentErrM, `${sc.label}: present parity <= 0.20m`).toBeLessThanOrEqual(0.2);
        expect(maxLandmarkErrM, `${sc.label}: landmark parity <= 0.20m`).toBeLessThanOrEqual(0.2);
        expect(totalSubUploads, `${sc.label}: performed texSubImage3D uploads`).toBeGreaterThan(0);
        expect(nonZeroSrcOffsetCount, `${sc.label}: texSubImage3D srcOffset === 0`).toBe(0);

        clipmap.dispose();
        tracker.disposeAll();
        sim.dispose();
      }
    },
  );

  it('animates SkierRig articulated legs, ski stride/herringbone V, suppresses carve spray while walking, and disposes with 0 GPU leaks', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();
    const shared = createSharedToonMaterials(gfx);
    const outlineMat = createSmoothOutlineMaterial(gfx);
    const rig = new SkierRig(gfx, shared, outlineMat, 'skier_alpine');
    const sprayVfx = new CarveSprayVfx(gfx, scene);
    scene.add(rig.rootGroup);

    const leftLeg = rig.rootGroup.getObjectByName('SkierLeftLegGroup') as THREE.Group;
    const rightLeg = rig.rootGroup.getObjectByName('SkierRightLegGroup') as THREE.Group;
    const leftSki = rig.rootGroup.getObjectByName('SkierLeftSkiGroup') as THREE.Group;
    const rightSki = rig.rootGroup.getObjectByName('SkierRightSkiGroup') as THREE.Group;
    const leftArm = rig.rootGroup.getObjectByName('SkierLeftArmGroup') as THREE.Group;
    const rightArm = rig.rootGroup.getObjectByName('SkierRightArmGroup') as THREE.Group;
    expect(leftLeg).toBeDefined();
    expect(rightLeg).toBeDefined();
    expect(leftSki).toBeDefined();
    expect(rightSki).toBeDefined();
    expect(leftArm).toBeDefined();
    expect(rightArm).toBeDefined();

    const baseSim = createMockSimState();
    const walkState = (phaseRad: number, pitchRad: number): ReadonlySimState => ({
      ...baseSim,
      tickCount: 10,
      skierState: 'skiing',
      currSkier: {
        ...baseSim.currSkier,
        speed: 2.2,
        carveAngleRad: 0,
        pitchRad,
        grounded: true,
        braking: false,
        walking: true,
        walkPhaseRad: phaseRad,
      },
      prevSkier: {
        ...baseSim.prevSkier,
        speed: 2.2,
        carveAngleRad: 0,
        pitchRad,
        grounded: true,
        braking: false,
        walking: true,
        walkPhaseRad: phaseRad,
      },
    });

    // Advance walkBlend up to ~1 on flat ground at peak stride phase (pi/2)
    for (let i = 0; i < 30; i++) {
      rig.sync(walkState(Math.PI * 0.5, 0), 1, 1 / 30);
    }
    expect(leftLeg.rotation.x).toBeGreaterThan(0.35);
    expect(rightLeg.rotation.x).toBeLessThan(-0.35);
    expect(leftLeg.rotation.x).toBeCloseTo(-rightLeg.rotation.x, 4);
    expect(leftSki.position.z).toBeLessThan(-0.15);
    expect(rightSki.position.z).toBeGreaterThan(0.15);
    // Diagonal arm stride opposes leg swing
    expect(leftArm.rotation.x).toBeLessThan(rightArm.rotation.x - 0.5);

    // At phase 0 (cos = +1), left ski lifts while right ski stays planted
    rig.sync(walkState(0, 0), 1, 1 / 30);
    expect(leftSki.position.y).toBeGreaterThan(rightSki.position.y + 0.08);
    expect(leftSki.rotation.x).toBeGreaterThan(0.1);

    // Uphill herringbone V-splay (left ski +yaw outward, right ski -yaw outward)
    rig.sync(walkState(Math.PI * 0.25, 0.3), 1, 1 / 30);
    expect(leftSki.rotation.y).toBeGreaterThan(0.2);
    expect(rightSki.rotation.y).toBeLessThan(-0.2);

    // Wipeout resets walking offsets cleanly
    rig.sync({ ...walkState(Math.PI * 0.5, 0.3), skierState: 'wipeout' }, 1, 1 / 30);
    expect(leftSki.position.z).toBe(0);
    expect(rightSki.position.z).toBe(0);
    expect(leftSki.rotation.x).toBe(0);

    // CarveSprayVfx suppresses continuous spray emission while walking
    const walkingPose = {
      ...baseSim.currSkier,
      grounded: true,
      walking: true,
      speed: 4.0,
      carveAngleRad: 0.4,
      braking: false,
    };
    for (let i = 0; i < 10; i++) {
      sprayVfx.update(1 / 30, walkingPose, 'powder', 0);
    }
    expect(sprayVfx.instancedMesh.count).toBe(0);

    // Skin swap disposes previous leg/body/ski geometries cleanly with zero GPU leaks
    rig.sync({ ...walkState(0, 0), skierId: 'skier_carver' }, 1, 1 / 30);
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    rig.dispose();
    sprayVfx.dispose();
    tracker.disposeAll();
    const stats = tracker.getStats();
    expect(stats.activeObjects).toBe(0);
    expect(stats.activeGeometries).toBe(0);
    expect(stats.activeMaterials).toBe(0);
    expect(stats.activeTextures).toBe(0);
  });
});
