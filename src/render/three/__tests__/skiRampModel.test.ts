import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RAMP, RAMP_GENTLE, RAMP_STEEP } from '../../../content/hazards';
import { EventBus } from '../../../core/eventBus';
import { MAX_RAMPS } from '../../../sim/entityPools';
import {
  CREATURE_PHASE_IDLE,
  createMountainColumnOut,
  createMountainSampleOut,
  createSurfaceSample,
  TERRAIN_FLAG_ON_PISTE,
  type MountainColumnOut,
  type MountainSampleOut,
  type ReadonlySimState,
  type SimEvents,
  type SpineView,
  type TerrainFieldView,
  type TerrainGridSampleOut,
} from '../../../sim/contracts';
import { createBillboardQuadGeometry, createCylindricalBillboardMaterial } from '../billboardMaterial';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { InstancePools } from '../instancePools';
import { createProceduralMeshAssets } from '../meshFactory';
import {
  buildSkiRampGeometries,
  createSkiRampAssets,
  drawSkiRampAtlas,
  evaluateSkiRampDeckY,
  resolveSkiRampVariant,
  SKI_RAMP_ATLAS_SIZE,
  SKI_RAMP_ATLAS_TILES,
  SKI_RAMP_DEFAULT_HEIGHT,
  SKI_RAMP_DEFAULT_LENGTH,
  SKI_RAMP_DEFAULT_WIDTH,
  SKI_RAMP_LEFT_SHRUB_MOUNDS,
  SKI_RAMP_LIP_LENGTH_M,
  SKI_RAMP_POST_BASE_Y,
  SKI_RAMP_RIGHT_SHRUB_MOUNDS,
  SKI_RAMP_VARIANT_DIMS,
  type SkiRampShrubMoundSpec,
  type SkiRampTileName,
  type SkiRampVariant,
} from '../models/skiRampModel';
import { createSmoothOutlineMaterial } from '../outlineShader';
import { ThreeRenderer } from '../renderer';
import type { SceneryProvider } from '../sceneryCellStreamer';
import { createCartoonSpriteAtlasTexture } from '../spriteAtlas';
import { createSharedToonMaterials } from '../toonMaterials';

function createRecordingCanvas2DContext(): CanvasRenderingContext2D {
  const noopGradient = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineJoin: 'round',
    lineCap: 'round',
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
      for (const n of [x0, y0, x1, y1]) {
        expect(Number.isFinite(n)).toBe(true);
      }
      return noopGradient;
    },
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop as string];
      return (...args: unknown[]) => {
        for (const arg of args) {
          if (typeof arg === 'number') {
            expect(Number.isFinite(arg)).toBe(true);
          }
        }
        return undefined;
      };
    },
  }) as unknown as CanvasRenderingContext2D;
}

function assertFiniteTexturedGeo(geo: THREE.BufferGeometry, requireSmoothNormals: boolean): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const norm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  expect(pos).toBeDefined();
  expect(norm).toBeDefined();
  expect(uv).toBeDefined();
  expect(pos.count).toBeGreaterThan(0);
  expect(norm.count).toBe(pos.count);
  expect(uv.count).toBe(pos.count);

  for (let i = 0; i < pos.count; i++) {
    expect(Number.isFinite(pos.getX(i))).toBe(true);
    expect(Number.isFinite(pos.getY(i))).toBe(true);
    expect(Number.isFinite(pos.getZ(i))).toBe(true);
    const nLen = Math.hypot(norm.getX(i), norm.getY(i), norm.getZ(i));
    expect(nLen).toBeCloseTo(1, 3);
    expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
    expect(uv.getX(i)).toBeLessThanOrEqual(1);
    expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
    expect(uv.getY(i)).toBeLessThanOrEqual(1);
  }

  if (requireSmoothNormals) {
    const smooth = geo.getAttribute('aSmoothNormal') as THREE.BufferAttribute;
    expect(smooth).toBeDefined();
    expect(smooth.count).toBe(pos.count);
    for (let i = 0; i < smooth.count; i++) {
      const sLen = Math.hypot(smooth.getX(i), smooth.getY(i), smooth.getZ(i));
      expect(sLen).toBeCloseTo(1, 2);
    }
  }

  // Verify every triangle in non-indexed mesh has non-zero area and outward CCW winding matching normal
  expect(geo.getIndex()).toBeNull();
  expect(pos.count % 3).toBe(0);
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i);
    const ay = pos.getY(i);
    const az = pos.getZ(i);
    const e1x = pos.getX(i + 1) - ax;
    const e1y = pos.getY(i + 1) - ay;
    const e1z = pos.getZ(i + 1) - az;
    const e2x = pos.getX(i + 2) - ax;
    const e2y = pos.getY(i + 2) - ay;
    const e2z = pos.getZ(i + 2) - az;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area2 = Math.hypot(cx, cy, cz);
    expect(area2).toBeGreaterThan(1e-7);
    const dot =
      (cx * norm.getX(i) + cy * norm.getY(i) + cz * norm.getZ(i)) / area2;
    expect(dot).toBeGreaterThan(0.99);
  }
}

function createRampSimState(): ReadonlySimState {
  const dummySegment = {
    id: 1,
    slot: 'curr' as const,
    stageId: 'sunny-blue',
    seed: 1,
    length: 120,
    chunkLength: 30,
    chunkCount: 4,
    prevSegmentId: null,
    nextLeftId: null,
    nextRightId: null,
    fork: {
      hasFork: false,
      leftStageId: null,
      rightStageId: null,
      obstacleFreeStartS: 120,
      innerWallRampLength: 25,
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: -120,
      seamYawRad: 0,
      seamNoseRadius: 1.5,
      isForkChild: false,
      forkSide: 'none' as const,
    },
    landmarks: [],
    getChunkBounds() {},
    sampleSpineFrame() {},
    evaluateSurfaceAtX() {},
    sampleSafeX: () => 0,
  };

  const evalSample = (wx: number, _wz: number, out: MountainSampleOut): MountainSampleOut => {
    Object.assign(out, createMountainSampleOut());
    out.onPiste = Math.abs(wx) <= 16;
    out.pisteWeight = out.onPiste ? 1 : 0;
    out.nearestSignedX = wx;
    out.nearestHalfWidth = 16;
    out.nearestStageId = 'sunny-blue';
    return out;
  };

  const mountainField: TerrainFieldView = {
    worldSeed: 1,
    fieldRevision: 1,
    dirtyRects: [],
    originOffsetX: 0,
    originOffsetY: 0,
    originOffsetZ: 0,
    stageIdTable: ['powder-bowl', 'sunny-blue', 'granite-gorge', 'icy-black', 'blizzard-ridge'],
    ackDirtyRects() {},
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
    evaluateHeight: () => 0,
    evaluateColumn(_wx: number, _wz: number, out: MountainColumnOut): MountainColumnOut {
      Object.assign(out, createMountainColumnOut());
      out.onPiste = true;
      out.pisteWeight = 1;
      out.nearestStageId = 'sunny-blue';
      return out;
    },
    evaluate: evalSample,
    evaluateSample: evalSample,
    sampleColumnGrid(
      originAbsX: number,
      _originAbsZ: number,
      cols: number,
      rows: number,
      stepM: number,
      _blockOriginY: number,
      out: TerrainGridSampleOut,
    ): void {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const absX = originAbsX + c * stepM;
          const idx = r * cols + c;
          out.heights[idx] = 0;
          out.macroY[idx] = 0;
          out.normals[idx * 3] = 0;
          out.normals[idx * 3 + 1] = 1;
          out.normals[idx * 3 + 2] = 0;
          const onPiste = Math.abs(absX) <= 16;
          out.pisteWeight[idx] = onPiste ? 1 : 0;
          out.iceWeight[idx] = 0;
          out.powderWeight[idx] = onPiste ? 0 : 1;
          out.dividerMask[idx] = 0;
          out.flowXZ[idx * 2] = 0;
          out.flowXZ[idx * 2 + 1] = -1;
          out.offPisteDist[idx] = Math.max(0, Math.abs(absX) - 16);
          out.primaryStageIdx[idx] = 1;
          out.secondaryStageIdx[idx] = 1;
          out.secondaryStageWeightU8[idx] = 0;
          out.flags[idx] = onPiste ? TERRAIN_FLAG_ON_PISTE : 0;
        }
      }
    },
  };

  return {
    tickCount: 150,
    elapsedSec: 2.5,
    distanceM: 40,
    paused: false,
    gameMode: 'endless',
    livesRemaining: 3,
    gameOver: false,
    skierId: 'skier_alpine',
    skierState: 'skiing',
    prevSkier: {
      posX: 0,
      posY: 0,
      posZ: 0,
      velX: 0,
      velY: -2,
      velZ: -15,
      headingRad: 0,
      carveAngleRad: 0,
      pitchRad: -0.2,
      speed: 15,
      groundY: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      grounded: true,
      braking: false,
      walking: false,
      walkPhaseRad: 0,
    },
    currSkier: {
      posX: 0,
      posY: 0,
      posZ: 0,
      velX: 0,
      velY: -2,
      velZ: -15,
      headingRad: 0,
      carveAngleRad: 0,
      pitchRad: -0.2,
      speed: 15,
      groundY: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      grounded: true,
      braking: false,
      walking: false,
      walkPhaseRad: 0,
    },
    surfaceSample: {
      ...createSurfaceSample(),
      valid: true,
      segmentId: 1,
      s: 10,
      x: 0,
      groundY: 0,
      macroY: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      tangentX: 0,
      tangentY: -0.2,
      tangentZ: -0.98,
      fallLineX: 0,
      fallLineY: -0.2,
      fallLineZ: -0.98,
      halfWidth: 16,
      pisteWeight: 1,
      onPiste: true,
      inChasmZone: false,
      chasmWipeoutDepth: 0,
      surfaceType: 'packed',
    },
    wipeoutTimerSec: 0,
    wipeoutDurationSec: 1.2,
    invulnerableTimerSec: 0,
    invulnerableDurationSec: 1.5,
    prevCamera: {
      posX: 0,
      posY: 4,
      posZ: 10,
      lookAtX: 0,
      lookAtY: 1,
      lookAtZ: -18,
      rollRad: 0,
      minHorizontalFovDeg: 66,
      speedFovBoostDeg: 2,
    },
    currCamera: {
      posX: 0,
      posY: 4,
      posZ: 10,
      lookAtX: 0,
      lookAtY: 1,
      lookAtZ: -18,
      rollRad: 0,
      minHorizontalFovDeg: 66,
      speedFovBoostDeg: 2,
    },
    score: 0,
    highCombo: 1,
    comboCount: 0,
    comboMultiplier: 1,
    comboTimerSec: 0,
    comboDurationSec: 5,
    carriedCount: 0,
    maxCarryCapacity: 12,
    carriedPresentDefIds: [],
    deliveredTotal: 0,
    activeStageId: 'sunny-blue',
    activeWeather: {
      profileId: 'weather_sunny',
      blizzardEnabled: false,
      blizzardIntensity: 0,
      snowParticleCount: 0,
      windLateral: 0,
      fogDistanceM: 220,
      blizzardDim: 0,
    },
    trailWindow: {
      prev: null,
      curr: dummySegment,
      nextLeft: null,
      nextRight: null,
    },
    mountainField,
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
        count: 0,
        capacity: 16,
        defIds: [],
        segmentIds: new Int32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        normalX: new Float32Array(0),
        normalY: new Float32Array(0),
        normalZ: new Float32Array(0),
        yawRad: new Float32Array(0),
        scale: new Float32Array(0),
        radius: new Float32Array(0),
        height: new Float32Array(0),
        triggered: new Uint8Array(0),
      },
      presents: {
        count: 0,
        capacity: 16,
        defIds: [],
        segmentIds: new Int32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        collected: new Uint8Array(0),
        bobPhase: new Float32Array(0),
      },
      tossedPresents: {
        count: 0,
        capacity: 16,
        defIds: [],
        prevPosX: new Float32Array(0),
        prevPosY: new Float32Array(0),
        prevPosZ: new Float32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        prevSpinRad: new Float32Array(0),
        spinRad: new Float32Array(0),
        progress: new Float32Array(0),
        kind: new Uint8Array(0),
      },
      deliveryZones: {
        count: 0,
        capacity: 8,
        defIds: [],
        segmentIds: new Int32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        yawRad: new Float32Array(0),
        radius: new Float32Array(0),
        deliveredCount: new Uint8Array(0),
        active: new Uint8Array(0),
        celebratingTimer: new Float32Array(0),
      },
      creatures: {
        count: 0,
        capacity: 8,
        defIds: [],
        segmentIds: new Int32Array(0),
        prevPosX: new Float32Array(0),
        prevPosY: new Float32Array(0),
        prevPosZ: new Float32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        normalX: new Float32Array(0),
        normalY: new Float32Array(0),
        normalZ: new Float32Array(0),
        prevHeadingRad: new Float32Array(0),
        headingRad: new Float32Array(0),
        groundY: new Float32Array(0),
        stateCode: new Uint8Array([CREATURE_PHASE_IDLE]),
        stateTimer: new Float32Array(0),
        telegraphProgress: new Float32Array(0),
        radius: new Float32Array(0),
      },
      skiTracks: {
        count: 0,
        capacity: 16,
        head: 0,
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        normalX: new Float32Array(0),
        normalY: new Float32Array(0),
        normalZ: new Float32Array(0),
        rightX: new Float32Array(0),
        rightY: new Float32Array(0),
        rightZ: new Float32Array(0),
        ageSec: new Float32Array(0),
        grounded: new Uint8Array(0),
      },
      ramps: {
        count: 2,
        capacity: 8,
        defIds: ['ski_ramp_standard', 'ski_ramp_standard'],
        segmentIds: new Int32Array([1, 1]),
        posX: new Float32Array([0, 4]),
        posY: new Float32Array([-5, -10]),
        posZ: new Float32Array([-25, -50]),
        yawRad: new Float32Array([0, 0.25]),
        pitchRad: new Float32Array([-0.22, -0.3]),
        width: new Float32Array([4.2, 5.25]),
        length: new Float32Array([6.5, 7.8]),
        height: new Float32Array([1.35, 1.6875]),
      },
      structures: {
        count: 0,
        capacity: 16,
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
      enabled: false,
      safePathPointCount: 0,
      safePathPoints: new Float32Array(0),
      safePathSegmentIds: new Int32Array(0),
      colliderCount: 0,
      colliderPositions: new Float32Array(0),
      colliderRadii: new Float32Array(0),
      colliderHeights: new Float32Array(0),
      colliderKinds: new Uint8Array(0),
      deliveryZoneCount: 0,
      deliveryPositions: new Float32Array(0),
      deliveryRadii: new Float32Array(0),
      forkCount: 0,
      forkApexPositions: new Float32Array(0),
      forkLeftTargets: new Float32Array(0),
      forkRightTargets: new Float32Array(0),
      forkNoseRadii: new Float32Array(0),
      chunkBoundaryCount: 0,
      chunkBoundaryLines: new Float32Array(0),
      skierPos: new Float32Array([0, 0, 0]),
      skierNormal: new Float32Array([0, 1, 0]),
      skierDownhill: new Float32Array([0, 0, -1]),
      skierVelocity: new Float32Array([0, 0, -15]),
    },
  };
}

describe('Procedural Ski Ramp 3D Model', () => {
  it('defines 9 non-overlapping tiles within 1024x1024 and draws finite Canvas2D artwork', () => {
    const keys = Object.keys(SKI_RAMP_ATLAS_TILES) as SkiRampTileName[];
    expect(keys).toHaveLength(9);

    for (let i = 0; i < keys.length; i++) {
      const a = SKI_RAMP_ATLAS_TILES[keys[i]!];
      expect(a.px).toBeGreaterThanOrEqual(0);
      expect(a.py).toBeGreaterThanOrEqual(0);
      expect(a.px + a.pw).toBeLessThanOrEqual(SKI_RAMP_ATLAS_SIZE);
      expect(a.py + a.ph).toBeLessThanOrEqual(SKI_RAMP_ATLAS_SIZE);
      expect(a.u0).toBeGreaterThanOrEqual(0);
      expect(a.u1).toBeLessThanOrEqual(1);
      expect(a.v0).toBeGreaterThanOrEqual(0);
      expect(a.v1).toBeLessThanOrEqual(1);
      expect(a.u1).toBeGreaterThan(a.u0);
      expect(a.v1).toBeGreaterThan(a.v0);

      for (let j = i + 1; j < keys.length; j++) {
        const b = SKI_RAMP_ATLAS_TILES[keys[j]!];
        const overlapX = a.px < b.px + b.pw && a.px + a.pw > b.px;
        const overlapY = a.py < b.py + b.ph && a.py + a.ph > b.py;
        expect(overlapX && overlapY, `tiles ${keys[i]} and ${keys[j]} must not overlap`).toBe(false);
        const overlapU = a.u0 < b.u1 && b.u0 < a.u1;
        const overlapV = a.v0 < b.v1 && b.v0 < a.v1;
        expect(overlapU && overlapV, `UVs ${keys[i]} and ${keys[j]} must not overlap`).toBe(false);
      }
    }

    const ctx = createRecordingCanvas2DContext();
    expect(() => drawSkiRampAtlas(ctx)).not.toThrow();
  });

  it('matches DEFAULT_RAMP physics dimensions, outward CCW normals, linear deck parity, and concept-art features', () => {
    expect(SKI_RAMP_DEFAULT_WIDTH).toBe(DEFAULT_RAMP.width);
    expect(SKI_RAMP_DEFAULT_HEIGHT).toBe(DEFAULT_RAMP.height);
    expect(SKI_RAMP_DEFAULT_LENGTH).toBe(DEFAULT_RAMP.length);

    const { bodyGeo, glowGeo } = buildSkiRampGeometries();
    assertFiniteTexturedGeo(bodyGeo, true);
    assertFiniteTexturedGeo(glowGeo, false);

    bodyGeo.computeBoundingBox();
    glowGeo.computeBoundingBox();
    const bBox = bodyGeo.boundingBox!;
    const gBox = glowGeo.boundingBox!;

    // Grounded trestle posts + full lateral/longitudinal extent
    expect(bBox.min.y).toBeCloseTo(SKI_RAMP_POST_BASE_Y, 3);
    expect(bBox.max.y).toBeGreaterThanOrEqual(SKI_RAMP_DEFAULT_HEIGHT);
    expect(bBox.max.y).toBeLessThanOrEqual(SKI_RAMP_DEFAULT_HEIGHT + 0.25);
    expect(bBox.min.x).toBeLessThanOrEqual(-2.6);
    expect(bBox.max.x).toBeGreaterThanOrEqual(2.6);
    expect(bBox.min.z).toBeLessThanOrEqual(-3.25);
    expect(bBox.max.z).toBeGreaterThanOrEqual(3.6);

    // 1. Snow deck top surface (first 6 vertices of bodyGeo) matches linear physics slope & outward +Y/+Z normal
    const bPos = bodyGeo.getAttribute('position') as THREE.BufferAttribute;
    const bNorm = bodyGeo.getAttribute('normal') as THREE.BufferAttribute;
    const bUv = bodyGeo.getAttribute('uv') as THREE.BufferAttribute;
    const lipJoinZ = -SKI_RAMP_DEFAULT_LENGTH * 0.5 + SKI_RAMP_LIP_LENGTH_M;

    for (let v = 0; v < 6; v++) {
      const z = bPos.getZ(v);
      const y = bPos.getY(v);
      expect(z).toBeGreaterThanOrEqual(lipJoinZ - 1e-4);
      expect(z).toBeLessThanOrEqual(SKI_RAMP_DEFAULT_LENGTH * 0.5 + 1e-4);
      expect(y).toBeCloseTo(evaluateSkiRampDeckY(z), 4);
      expect(bNorm.getY(v)).toBeGreaterThan(0.95);
      expect(bNorm.getZ(v)).toBeGreaterThan(0.15);
    }

    // 2. Open trestle posts/bracing exist beneath deck on both flanks
    let leftUnderTrestleVerts = 0;
    let rightUnderTrestleVerts = 0;
    let leftShrubVerts = 0;
    let rightShrubVerts = 0;
    for (let v = 0; v < bPos.count; v++) {
      const x = bPos.getX(v);
      const y = bPos.getY(v);
      const z = bPos.getZ(v);
      const deckY = evaluateSkiRampDeckY(z);
      if (y < deckY - 0.25 && Math.abs(x) < 2.25) {
        if (x < -1.8) leftUnderTrestleVerts++;
        if (x > 1.8) rightUnderTrestleVerts++;
      }
      if (y < 0.7 && Math.abs(x) > 2.3) {
        if (x < 0) leftShrubVerts++;
        if (x > 0) rightShrubVerts++;
      }
    }
    expect(leftUnderTrestleVerts).toBeGreaterThan(60);
    expect(rightUnderTrestleVerts).toBeGreaterThan(60);
    expect(leftShrubVerts).toBeGreaterThan(80);
    expect(rightShrubVerts).toBeGreaterThan(80);

    // 3. Glow geometry contains orange takeoff lip pad, cyan entry threshold bar, and flanking shrub lights
    const gPos = glowGeo.getAttribute('position') as THREE.BufferAttribute;
    const gNorm = glowGeo.getAttribute('normal') as THREE.BufferAttribute;
    const gUv = glowGeo.getAttribute('uv') as THREE.BufferAttribute;
    const orangeTile = SKI_RAMP_ATLAS_TILES.orangeGrate;
    const cyanTile = SKI_RAMP_ATLAS_TILES.cyanGlow;

    // First 6 vertices of glowGeo are the top face of the orange takeoff lip pad
    for (let v = 0; v < 6; v++) {
      const z = gPos.getZ(v);
      const y = gPos.getY(v);
      const u = gUv.getX(v);
      const vv = gUv.getY(v);
      expect(z).toBeLessThanOrEqual(lipJoinZ);
      expect(y).toBeCloseTo(evaluateSkiRampDeckY(z) + 0.014, 4);
      expect(gNorm.getY(v)).toBeGreaterThan(0.95);
      expect(u).toBeGreaterThanOrEqual(orangeTile.u0 - 1e-5);
      expect(u).toBeLessThanOrEqual(orangeTile.u1 + 1e-5);
      expect(vv).toBeGreaterThanOrEqual(orangeTile.v0 - 1e-5);
      expect(vv).toBeLessThanOrEqual(orangeTile.v1 + 1e-5);
    }

    // Orange pad bottom strictly clears the recessed lip sub-deck top (zero Z-fighting)
    const subDeckTopMaxY = SKI_RAMP_DEFAULT_HEIGHT - 0.028;
    let orangeFarBottomY = Infinity;
    for (let v = 0; v < 36; v++) {
      if (gPos.getZ(v) < -3.25) {
        orangeFarBottomY = Math.min(orangeFarBottomY, gPos.getY(v));
      }
    }
    expect(orangeFarBottomY).toBeGreaterThan(subDeckTopMaxY + 0.002);

    // Entry threshold cyan bar sits at +Z > 3.25, proudly visible above y = 0, and maps into cyanGlow tile
    expect(gBox.max.z).toBeGreaterThan(3.25);
    let leftCyanLights = 0;
    let rightCyanLights = 0;
    let entryCyanVerts = 0;
    let entryCyanMaxY = -Infinity;
    for (let v = 36; v < gPos.count; v++) {
      const x = gPos.getX(v);
      const y = gPos.getY(v);
      const z = gPos.getZ(v);
      const u = gUv.getX(v);
      const vv = gUv.getY(v);
      expect(u).toBeGreaterThanOrEqual(cyanTile.u0 - 1e-5);
      expect(u).toBeLessThanOrEqual(cyanTile.u1 + 1e-5);
      expect(vv).toBeGreaterThanOrEqual(cyanTile.v0 - 1e-5);
      expect(vv).toBeLessThanOrEqual(cyanTile.v1 + 1e-5);
      if (z > 3.25 && Math.abs(x) < 2.05) {
        entryCyanVerts++;
        if (y > entryCyanMaxY) entryCyanMaxY = y;
      }
      if (x < -2.2) leftCyanLights++;
      if (x > 2.2) rightCyanLights++;
    }
    expect(entryCyanVerts).toBe(36);
    expect(entryCyanMaxY).toBeGreaterThan(0.015);
    expect(leftCyanLights).toBeGreaterThan(20);
    expect(rightCyanLights).toBeGreaterThan(20);

    const buildExpectedMoundCenters = (
      halfW: number,
      zScale: number,
    ): Array<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }> => {
      const anchorX = halfW + 0.16;
      const pushSide = (
        side: -1 | 1,
        specs: readonly SkiRampShrubMoundSpec[],
        out: Array<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }>,
      ): void => {
        for (const m of specs) {
          out.push({
            x: side * (anchorX + m.xOff),
            y: m.y,
            z: m.z * zScale,
            rx: m.r * m.sx,
            ry: m.r * m.sy,
            rz: m.r * m.sz,
          });
        }
      };
      const centers: Array<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }> = [];
      pushSide(-1, SKI_RAMP_LEFT_SHRUB_MOUNDS, centers);
      pushSide(1, SKI_RAMP_RIGHT_SHRUB_MOUNDS, centers);
      return centers;
    };

    // Every cyan accent crystal cluster has vertices strictly exposed outside shrub mound bounds
    const crystalStartVert = 72;
    const vertsPerOctahedron = 24;
    const crystalCount = (gPos.count - crystalStartVert) / vertsPerOctahedron;
    expect(crystalCount).toBe(10);
    const moundCenters = buildExpectedMoundCenters(SKI_RAMP_DEFAULT_WIDTH * 0.5, 1);
    for (let c = 0; c < crystalCount; c++) {
      let hasExposedVert = false;
      const start = crystalStartVert + c * vertsPerOctahedron;
      for (let v = start; v < start + vertsPerOctahedron; v++) {
        const vx = gPos.getX(v);
        const vy = gPos.getY(v);
        const vz = gPos.getZ(v);
        const buried = moundCenters.some((m) => {
          const nx = (vx - m.x) / m.rx;
          const ny = (vy - m.y) / m.ry;
          const nz = (vz - m.z) / m.rz;
          return nx * nx + ny * ny + nz * nz < 0.78;
        });
        if (!buried) {
          hasExposedVert = true;
          break;
        }
      }
      expect(hasExposedVert, `cyan shrub crystal #${c} must not be swallowed by shrub mounds`).toBe(true);
    }

    // Snow deck vertices map cleanly to snowDeck tile
    const snowTile = SKI_RAMP_ATLAS_TILES.snowDeck;
    for (let v = 0; v < 6; v++) {
      expect(bUv.getX(v)).toBeGreaterThanOrEqual(snowTile.u0 - 1e-5);
      expect(bUv.getX(v)).toBeLessThanOrEqual(snowTile.u1 + 1e-5);
      expect(bUv.getY(v)).toBeGreaterThanOrEqual(snowTile.v0 - 1e-5);
      expect(bUv.getY(v)).toBeLessThanOrEqual(snowTile.v1 + 1e-5);
    }

    bodyGeo.dispose();
    glowGeo.dispose();

    // Validate all 3 incline presets (gentle, standard, steep) for CCW winding, linear deck parity,
    // strictly increasing incline angles, grounded posts, Z-fighting clearance, and crystal exposure
    expect(resolveSkiRampVariant(RAMP_GENTLE.id)).toBe('gentle');
    expect(resolveSkiRampVariant(DEFAULT_RAMP.id)).toBe('standard');
    expect(resolveSkiRampVariant(RAMP_STEEP.id)).toBe('steep');
    expect(resolveSkiRampVariant('unknown_id')).toBe('standard');

    const variantOrder: readonly SkiRampVariant[] = ['gentle', 'standard', 'steep'];
    let prevDeckSlope = 0;
    for (const variant of variantOrder) {
      const dims = SKI_RAMP_VARIANT_DIMS[variant];
      const { bodyGeo: vBody, glowGeo: vGlow } = buildSkiRampGeometries(dims, `Test_${variant}`);
      assertFiniteTexturedGeo(vBody, true);
      assertFiniteTexturedGeo(vGlow, false);

      vBody.computeBoundingBox();
      vGlow.computeBoundingBox();
      const vBox = vBody.boundingBox!;
      const vgBox = vGlow.boundingBox!;
      expect(vBox.min.y).toBeCloseTo(SKI_RAMP_POST_BASE_Y, 3);
      expect(vBox.max.y).toBeGreaterThanOrEqual(dims.height);
      expect(vBox.max.y).toBeLessThanOrEqual(dims.height + 0.25);

      const vp = vBody.getAttribute('position') as THREE.BufferAttribute;
      const vn = vBody.getAttribute('normal') as THREE.BufferAttribute;
      const vhl = dims.length * 0.5;
      const vLipJoinZ = -vhl + Math.min(SKI_RAMP_LIP_LENGTH_M, dims.length * 0.2);
      for (let v = 0; v < 6; v++) {
        const z = vp.getZ(v);
        expect(z).toBeGreaterThanOrEqual(vLipJoinZ - 1e-4);
        expect(vp.getY(v)).toBeCloseTo(evaluateSkiRampDeckY(z, dims.height, dims.length), 4);
        expect(vn.getY(v)).toBeGreaterThan(0.85);
      }

      // Check orange lip top slope & cyan crystal exposure across preset length scaling
      const gp = vGlow.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < 6; v++) {
        const z = gp.getZ(v);
        expect(gp.getY(v)).toBeCloseTo(evaluateSkiRampDeckY(z, dims.height, dims.length) + 0.014, 4);
      }
      expect(vgBox.max.z).toBeGreaterThan(vhl);

      const hw = dims.width * 0.5;
      const zScale = dims.length / SKI_RAMP_DEFAULT_LENGTH;
      const variantMounds = buildExpectedMoundCenters(hw, zScale);
      for (let c = 0; c < 10; c++) {
        let hasExposedVert = false;
        const start = 72 + c * 24;
        for (let v = start; v < start + 24; v++) {
          const vx = gp.getX(v);
          const vy = gp.getY(v);
          const vz = gp.getZ(v);
          const buried = variantMounds.some((m) => {
            const nx = (vx - m.x) / m.rx;
            const ny = (vy - m.y) / m.ry;
            const nz = (vz - m.z) / m.rz;
            return nx * nx + ny * ny + nz * nz < 0.78;
          });
          if (!buried) {
            hasExposedVert = true;
            break;
          }
        }
        expect(hasExposedVert, `${variant} crystal #${c} must stay exposed`).toBe(true);
      }

      const slope = dims.height / dims.length;
      expect(slope).toBeGreaterThan(prevDeckSlope);
      prevDeckSlope = slope;

      vBody.dispose();
      vGlow.dispose();
    }
  });

  it('integrates all 3 presets with InstancePools (unit scale per preset, shared atlas, shadow policy) and leaks 0 GPU resources', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();
    const mats = createSharedToonMaterials(gfx);
    const outlineMat = createSmoothOutlineMaterial(gfx);
    const bbAtlas = createCartoonSpriteAtlasTexture(gfx);
    const bbMat = createCylindricalBillboardMaterial(gfx, bbAtlas, mats.sharedUniforms, false);
    const bbQuad = createBillboardQuadGeometry(gfx);
    const meshAssets = createProceduralMeshAssets(gfx);
    const rampAssets = createSkiRampAssets(gfx, mats);

    const pools = new InstancePools(
      gfx,
      mats,
      outlineMat,
      bbMat,
      bbQuad,
      meshAssets,
      undefined,
      undefined,
      rampAssets,
    );
    scene.add(pools.rootGroup);

    const rampMesh = pools.rootGroup.getObjectByName('RampPool') as THREE.InstancedMesh;
    const rampOutline = pools.rootGroup.getObjectByName('RampPool_Outline') as THREE.InstancedMesh;
    const rampGlow = pools.rootGroup.getObjectByName('RampPool_Glow') as THREE.InstancedMesh;
    const gentleMesh = pools.rootGroup.getObjectByName('RampGentlePool') as THREE.InstancedMesh;
    const gentleOutline = pools.rootGroup.getObjectByName('RampGentlePool_Outline') as THREE.InstancedMesh;
    const gentleGlow = pools.rootGroup.getObjectByName('RampGentlePool_Glow') as THREE.InstancedMesh;
    const steepMesh = pools.rootGroup.getObjectByName('RampSteepPool') as THREE.InstancedMesh;
    const steepOutline = pools.rootGroup.getObjectByName('RampSteepPool_Outline') as THREE.InstancedMesh;
    const steepGlow = pools.rootGroup.getObjectByName('RampSteepPool_Glow') as THREE.InstancedMesh;

    for (const bodyM of [gentleMesh, rampMesh, steepMesh]) {
      expect(bodyM).toBeDefined();
      expect(bodyM.frustumCulled).toBe(false);
      expect(bodyM.castShadow).toBe(true);
    }
    for (const outM of [gentleOutline, rampOutline, steepOutline]) {
      expect(outM).toBeDefined();
      expect(outM.frustumCulled).toBe(false);
      expect(outM.castShadow).toBe(false);
    }
    for (const glowM of [gentleGlow, rampGlow, steepGlow]) {
      expect(glowM).toBeDefined();
      expect(glowM.frustumCulled).toBe(false);
      expect(glowM.castShadow).toBe(false);
      expect(glowM.receiveShadow).toBe(false);
      expect((glowM.material as THREE.MeshBasicMaterial).fog).toBe(true);
    }

    // All 3 toon body pools + 3 glow pools share the single atlas texture (refCount === 6)
    // and share the single toonMaterial (refCount === 3) and glowMaterial (refCount === 3)
    expect(tracker.getTextureRefCount(rampAssets.atlasTexture)).toBe(6);
    expect(tracker.getMaterialRefCount(rampAssets.toonMaterial)).toBe(3);
    expect(tracker.getMaterialRefCount(rampAssets.glowMaterial)).toBe(3);

    const simState = createRampSimState();
    const emptyScenery: SceneryProvider = {
      sceneryRevision: 0,
      forEachActiveScenery() {},
    };

    // Route gentle, standard, steep, and custom-scaled standard simultaneously
    const multiState: ReadonlySimState = {
      ...simState,
      entities: {
        ...simState.entities,
        ramps: {
          count: 4,
          capacity: 8,
          defIds: ['ski_ramp_gentle', 'ski_ramp_standard', 'ski_ramp_steep', 'ski_ramp_standard'],
          segmentIds: new Int32Array([1, 1, 1, 1]),
          posX: new Float32Array([-3, 0, 3, 6]),
          posY: new Float32Array([-2, -5, -8, -10]),
          posZ: new Float32Array([-15, -25, -35, -50]),
          yawRad: new Float32Array([0, 0, 0.15, 0.25]),
          pitchRad: new Float32Array([-0.18, -0.22, -0.28, -0.3]),
          width: new Float32Array([RAMP_GENTLE.width, DEFAULT_RAMP.width, RAMP_STEEP.width, 5.25]),
          length: new Float32Array([RAMP_GENTLE.length, DEFAULT_RAMP.length, RAMP_STEEP.length, 7.8]),
          height: new Float32Array([RAMP_GENTLE.height, DEFAULT_RAMP.height, RAMP_STEEP.height, 1.6875]),
        },
      },
    };
    pools.sync(multiState, 0.5, emptyScenery);

    expect(gentleMesh.count).toBe(1);
    expect(gentleOutline.count).toBe(1);
    expect(gentleGlow.count).toBe(1);
    expect(rampMesh.count).toBe(2);
    expect(rampOutline.count).toBe(2);
    expect(rampGlow.count).toBe(2);
    expect(steepMesh.count).toBe(1);
    expect(steepOutline.count).toBe(1);
    expect(steepGlow.count).toBe(1);

    const mBody0 = new THREE.Matrix4();
    const mOut0 = new THREE.Matrix4();
    const mGlow0 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();

    // Every canonical preset renders with exact unit scale (1, 1, 1) so outline normals stay undistorted
    for (const [m, o, g, px, py, pz] of [
      [gentleMesh, gentleOutline, gentleGlow, -3, -2, -15],
      [rampMesh, rampOutline, rampGlow, 0, -5, -25],
      [steepMesh, steepOutline, steepGlow, 3, -8, -35],
    ] as const) {
      m.getMatrixAt(0, mBody0);
      o.getMatrixAt(0, mOut0);
      g.getMatrixAt(0, mGlow0);
      expect(mOut0.elements).toEqual(mBody0.elements);
      expect(mGlow0.elements).toEqual(mBody0.elements);
      mBody0.decompose(pos, quat, scl);
      expect(pos.x).toBeCloseTo(px, 5);
      expect(pos.y).toBeCloseTo(py, 5);
      expect(pos.z).toBeCloseTo(pz, 5);
      expect(scl.x).toBeCloseTo(1, 5);
      expect(scl.y).toBeCloseTo(1, 5);
      expect(scl.z).toBeCloseTo(1, 5);
    }

    // Custom-sized standard ramp (slot 1 of RampPool) scales proportionally
    const mBody1 = new THREE.Matrix4();
    rampMesh.getMatrixAt(1, mBody1);
    mBody1.decompose(pos, quat, scl);
    expect(scl.x).toBeCloseTo(5.25 / 4.2, 5);
    expect(scl.y).toBeCloseTo(1.6875 / 1.35, 5);
    expect(scl.z).toBeCloseTo(7.8 / 6.5, 5);

    // Unknown defId + zero dimensions fall back cleanly to canonical 1:1 scale
    const fallbackState: ReadonlySimState = {
      ...simState,
      entities: {
        ...simState.entities,
        ramps: {
          ...simState.entities.ramps,
          count: 1,
          defIds: ['unknown_ramp'],
          width: new Float32Array([0]),
          height: new Float32Array([0]),
          length: new Float32Array([0]),
        },
      },
    };
    pools.sync(fallbackState, 0.5, emptyScenery);
    expect(rampMesh.count).toBe(1);
    expect(rampOutline.count).toBe(1);
    expect(rampGlow.count).toBe(1);
    rampMesh.getMatrixAt(0, mBody0);
    mBody0.decompose(pos, quat, scl);
    expect(scl.x).toBeCloseTo(1, 5);
    expect(scl.y).toBeCloseTo(1, 5);
    expect(scl.z).toBeCloseTo(1, 5);

    // Overflow beyond MAX_RAMPS clamps safely without exceeding pool capacity
    const overflowCount = MAX_RAMPS + 5;
    const overflowState: ReadonlySimState = {
      ...simState,
      entities: {
        ...simState.entities,
        ramps: {
          count: overflowCount,
          capacity: overflowCount,
          defIds: Array.from({ length: overflowCount }, () => 'ski_ramp_standard'),
          segmentIds: new Int32Array(overflowCount).fill(1),
          posX: new Float32Array(overflowCount),
          posY: new Float32Array(overflowCount),
          posZ: new Float32Array(overflowCount),
          yawRad: new Float32Array(overflowCount),
          pitchRad: new Float32Array(overflowCount),
          width: new Float32Array(overflowCount).fill(4.2),
          length: new Float32Array(overflowCount).fill(6.5),
          height: new Float32Array(overflowCount).fill(1.35),
        },
      },
    };
    pools.sync(overflowState, 0.5, emptyScenery);
    expect(rampMesh.count).toBe(MAX_RAMPS);
    expect(rampOutline.count).toBe(MAX_RAMPS);
    expect(rampGlow.count).toBe(MAX_RAMPS);

    // Zero ramps clears all ramp pools cleanly
    const emptyRampState: ReadonlySimState = {
      ...simState,
      entities: {
        ...simState.entities,
        ramps: { ...simState.entities.ramps, count: 0 },
      },
    };
    pools.sync(emptyRampState, 0.5, emptyScenery);
    expect(gentleMesh.count).toBe(0);
    expect(rampMesh.count).toBe(0);
    expect(rampOutline.count).toBe(0);
    expect(rampGlow.count).toBe(0);
    expect(steepMesh.count).toBe(0);

    expect(() => tracker.markAllForContextRestore()).not.toThrow();
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    gfx.disposeObject(pools.rootGroup);
    tracker.disposeAll();
    const stats = tracker.getStats();
    expect(stats.activeObjects).toBe(0);
    expect(stats.cachedGeometries).toBe(0);
    expect(stats.cachedMaterials).toBe(0);
    expect(stats.cachedTextures).toBe(0);

    // Full headless ThreeRenderer lifecycle verification
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });
    renderer.sync(simState, 0.5, 1 / 60, 50);
    const rRampPool = renderer.scene.getObjectByName('RampPool') as THREE.InstancedMesh;
    const rGlowPool = renderer.scene.getObjectByName('RampPool_Glow') as THREE.InstancedMesh;
    expect(rRampPool.count).toBe(2);
    expect(rGlowPool.count).toBe(2);
    expect(renderer.runLeakCheck(0, true).totalLeaks).toBe(0);
    renderer.dispose();
    const rStats = renderer.getStats().graphics;
    expect(rStats.activeObjects).toBe(0);
    expect(rStats.cachedGeometries).toBe(0);
    expect(rStats.cachedMaterials).toBe(0);
    expect(rStats.cachedTextures).toBe(0);
  });
});
