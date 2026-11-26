import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../core/eventBus';
import type {
  SegmentLandmarkRequirement,
  SimEvents,
  TerrainSegmentView,
  TrailWindowView,
} from '../../../sim/contracts';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { LandmarkStreamer } from '../landmarkStreamer';
import { createProceduralMeshAssets } from '../meshFactory';
import {
  buildTrailGateGeometries,
  createTrailGateAssets,
  createTrailGateObject,
  drawTrailGateAtlas,
  TRAIL_GATE_ATLAS_SIZE,
  TRAIL_GATE_ATLAS_TILES,
  TRAIL_GATE_BEAM_Y,
  TRAIL_GATE_DEFAULT_HALF_SPAN,
  TRAIL_GATE_LOG_RADIUS,
  TRAIL_GATE_MAX_HALF_SPAN,
  TRAIL_GATE_MIN_HALF_SPAN,
  type TrailGateTileName,
} from '../models/trailGateModel';
import { createSmoothOutlineMaterial } from '../outlineShader';
import { ThreeRenderer } from '../renderer';
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
    createRadialGradient: (
      x0: number,
      y0: number,
      r0: number,
      x1: number,
      y1: number,
      r1: number,
    ) => {
      for (const n of [x0, y0, r0, x1, y1, r1]) {
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

function createMockGateSegment(
  id: number,
  seed: number,
  landmarks: readonly SegmentLandmarkRequirement[],
): TerrainSegmentView {
  return {
    id,
    slot: 'curr',
    stageId: 'sunny-blue',
    seed,
    length: 140,
    chunkLength: 35,
    chunkCount: 4,
    prevSegmentId: null,
    nextLeftId: null,
    nextRightId: null,
    fork: {
      hasFork: true,
      leftStageId: 'powder-bowl',
      rightStageId: 'icy-black',
      obstacleFreeStartS: 90,
      innerWallRampLength: 25,
      seamWorldX: 0,
      seamWorldY: -35,
      seamWorldZ: -140,
      seamYawRad: 0,
      seamNoseRadius: 1.5,
      isForkChild: false,
      forkSide: 'none',
    },
    landmarks,
    getChunkBounds() {},
    sampleSpineFrame() {},
    evaluateSurfaceAtX() {},
    sampleSafeX: () => 0,
  };
}

function assertFiniteTexturedGeo(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const norm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const smooth = geo.getAttribute('aSmoothNormal') as THREE.BufferAttribute;
  expect(pos).toBeDefined();
  expect(norm).toBeDefined();
  expect(uv).toBeDefined();
  expect(smooth).toBeDefined();
  expect(pos.count).toBeGreaterThan(0);

  for (let i = 0; i < pos.count; i++) {
    expect(Number.isFinite(pos.getX(i))).toBe(true);
    expect(Number.isFinite(pos.getY(i))).toBe(true);
    expect(Number.isFinite(pos.getZ(i))).toBe(true);
    const nLen = Math.hypot(norm.getX(i), norm.getY(i), norm.getZ(i));
    expect(nLen).toBeCloseTo(1, 3);
    const sLen = Math.hypot(smooth.getX(i), smooth.getY(i), smooth.getZ(i));
    expect(sLen).toBeCloseTo(1, 2);
    expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
    expect(uv.getX(i)).toBeLessThanOrEqual(1);
    expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
    expect(uv.getY(i)).toBeLessThanOrEqual(1);
  }
}

describe('Simplified Folk Trail Gate Model & Modular Asset Pipeline', () => {
  it('defines 11 non-overlapping atlas tiles within 1024x1024 and paints finite Canvas2D folk artwork', () => {
    const keys = Object.keys(TRAIL_GATE_ATLAS_TILES) as TrailGateTileName[];
    expect(keys).toHaveLength(11);

    for (let i = 0; i < keys.length; i++) {
      const a = TRAIL_GATE_ATLAS_TILES[keys[i]!];
      expect(a.px).toBeGreaterThanOrEqual(0);
      expect(a.py).toBeGreaterThanOrEqual(0);
      expect(a.px + a.pw).toBeLessThanOrEqual(TRAIL_GATE_ATLAS_SIZE);
      expect(a.py + a.ph).toBeLessThanOrEqual(TRAIL_GATE_ATLAS_SIZE);
      expect(a.u0).toBeGreaterThanOrEqual(0);
      expect(a.u1).toBeLessThanOrEqual(1);
      expect(a.v0).toBeGreaterThanOrEqual(0);
      expect(a.v1).toBeLessThanOrEqual(1);
      expect(a.u1).toBeGreaterThan(a.u0);
      expect(a.v1).toBeGreaterThan(a.v0);

      for (let j = i + 1; j < keys.length; j++) {
        const b = TRAIL_GATE_ATLAS_TILES[keys[j]!];
        const overlapX = a.px < b.px + b.pw && a.px + a.pw > b.px;
        const overlapY = a.py < b.py + b.ph && a.py + a.ph > b.py;
        expect(overlapX && overlapY, `tiles ${keys[i]} and ${keys[j]} must not overlap`).toBe(false);
      }
    }

    const ctx = createRecordingCanvas2DContext();
    expect(() => drawTrailGateAtlas(ctx)).not.toThrow();
  });

  it('builds finite smooth-normal gate geometries with grounded posts and outward normals on left & right assemblies', () => {
    const geos = buildTrailGateGeometries();
    const all = [
      geos.beamCenterGeo,
      geos.leftPostGeo,
      geos.rightPostGeo,
      geos.badgeCircleGeo,
      geos.badgeSquareGeo,
      geos.badgeDiamondGeo,
      geos.badgeSnowCapGeo,
    ];
    for (const g of all) {
      assertFiniteTexturedGeo(g);
    }

    // Tall gate proportions & grounded post bases (y <= -1.4m)
    expect(TRAIL_GATE_BEAM_Y).toBeGreaterThanOrEqual(10.5);
    expect(TRAIL_GATE_LOG_RADIUS).toBeGreaterThanOrEqual(0.9);
    geos.leftPostGeo.computeBoundingBox();
    geos.rightPostGeo.computeBoundingBox();
    geos.beamCenterGeo.computeBoundingBox();
    geos.badgeSquareGeo.computeBoundingBox();
    geos.badgeSnowCapGeo.computeBoundingBox();
    expect(geos.leftPostGeo.boundingBox!.min.y).toBeLessThanOrEqual(-1.4);
    expect(geos.rightPostGeo.boundingBox!.min.y).toBeLessThanOrEqual(-1.4);

    // Zero beam-snow clipping through central signboard front face
    const signWorldFrontZ = 1.18 + geos.badgeSquareGeo.boundingBox!.max.z;
    expect(geos.beamCenterGeo.boundingBox!.max.z).toBeLessThanOrEqual(signWorldFrontZ - 0.25);
    expect(geos.badgeSnowCapGeo.boundingBox!.max.z).toBeLessThanOrEqual(
      geos.badgeSquareGeo.boundingBox!.max.z,
    );

    // Swept wavy beam snow crest catches upward sunlight brightly (ny > 0.25 along upper ridge skin; skip +/-X end caps)
    const beamPos = geos.beamCenterGeo.getAttribute('position') as THREE.BufferAttribute;
    const beamNorm = geos.beamCenterGeo.getAttribute('normal') as THREE.BufferAttribute;
    let upperSnowCount = 0;
    for (let v = 0; v < beamPos.count; v++) {
      if (beamPos.getY(v) > TRAIL_GATE_BEAM_Y + 1.12 && Math.abs(beamNorm.getX(v)) < 0.95) {
        expect(beamNorm.getY(v)).toBeGreaterThan(0.25);
        upperSnowCount++;
      }
    }
    expect(upperSnowCount).toBeGreaterThan(140);

    // Tapered timber post vertical side faces (first 24 vertices / 8 triangles) must point strictly outward
    // and continuous S-scrollwork corner braces must sweep inward (+X on left, -X on right)
    for (const [idx, postGeo] of [geos.leftPostGeo, geos.rightPostGeo].entries()) {
      const inwardSign = idx === 0 ? 1 : -1;
      const pos = postGeo.getAttribute('position') as THREE.BufferAttribute;
      const norm = postGeo.getAttribute('normal') as THREE.BufferAttribute;
      for (let v = 0; v < 24; v++) {
        const dot = pos.getX(v) * norm.getX(v) + pos.getZ(v) * norm.getZ(v);
        expect(dot).toBeGreaterThan(0);
      }
      // Top cap vertices (24..29) face upward (+Y); bottom cap (30..35) face downward (-Y)
      for (let v = 24; v < 30; v++) expect(norm.getY(v)).toBeGreaterThan(0.95);
      for (let v = 30; v < 36; v++) expect(norm.getY(v)).toBeLessThan(-0.95);

      let inwardBraceCount = 0;
      let maxInwardReach = 0;
      for (let v = 0; v < pos.count; v++) {
        const py = pos.getY(v);
        if (py >= TRAIL_GATE_BEAM_Y - 3.9 && py <= TRAIL_GATE_BEAM_Y - 0.8) {
          const inward = pos.getX(v) * inwardSign;
          if (inward > 1.2) {
            inwardBraceCount++;
            if (inward > maxInwardReach) maxInwardReach = inward;
          }
        }
      }
      expect(inwardBraceCount).toBeGreaterThan(60);
      expect(maxInwardReach).toBeGreaterThan(2.5);
    }

    for (const g of all) {
      g.dispose();
    }
  });

  it('swaps stage badges cleanly and scales beam width without distorting posts or badge', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const outlineMat = createSmoothOutlineMaterial(gfx);
    const gateAssets = createTrailGateAssets(gfx, mats, outlineMat);

    const gate = createTrailGateObject(gfx, gateAssets);
    const beamHolder = gate.group.getObjectByName('TrailGateBeamHolder')!;
    const leftPost = gate.group.getObjectByName('TrailGateLeftPost')!;
    const rightPost = gate.group.getObjectByName('TrailGateRightPost')!;
    const badgeHolder = gate.group.getObjectByName('ForkArchBadgeHolder')!;
    const circle = gate.group.getObjectByName('ForkBadgeCircle')!;
    const square = gate.group.getObjectByName('ForkBadgeSquare')!;
    const diamond = gate.group.getObjectByName('ForkBadgeDiamond')!;

    expect(badgeHolder.position.y).toBeGreaterThanOrEqual(TRAIL_GATE_BEAM_Y - 0.25);
    expect(badgeHolder.position.z).toBeGreaterThanOrEqual(1.1);

    // Narrow gate: gateHalfWidth = 8.5 -> halfSpan clamped to min (6.2)
    gate.setBadge('powder-bowl', 8.5);
    expect(circle.visible).toBe(true);
    expect(square.visible).toBe(false);
    expect(diamond.visible).toBe(false);
    expect(leftPost.position.x).toBeCloseTo(-TRAIL_GATE_MIN_HALF_SPAN, 5);
    expect(rightPost.position.x).toBeCloseTo(TRAIL_GATE_MIN_HALF_SPAN, 5);
    expect(beamHolder.scale.x).toBeCloseTo(TRAIL_GATE_MIN_HALF_SPAN / TRAIL_GATE_DEFAULT_HALF_SPAN, 5);
    expect(leftPost.scale.x).toBe(1);
    expect(rightPost.scale.x).toBe(1);
    expect(badgeHolder.scale.x).toBe(1);

    // Standard gate: gateHalfWidth = 12.8 -> halfSpan = 10.0
    gate.setBadge('sunny-blue', 12.8);
    expect(circle.visible).toBe(false);
    expect(square.visible).toBe(true);
    expect(diamond.visible).toBe(false);
    expect(leftPost.position.x).toBeCloseTo(-TRAIL_GATE_DEFAULT_HALF_SPAN, 5);
    expect(rightPost.position.x).toBeCloseTo(TRAIL_GATE_DEFAULT_HALF_SPAN, 5);
    expect(beamHolder.scale.x).toBeCloseTo(1, 5);

    // Wide gate: gateHalfWidth = 17.0 -> halfSpan clamped to max (13.2)
    gate.setBadge('icy-black', 17.0);
    expect(circle.visible).toBe(false);
    expect(square.visible).toBe(false);
    expect(diamond.visible).toBe(true);
    expect(leftPost.position.x).toBeCloseTo(-TRAIL_GATE_MAX_HALF_SPAN, 5);
    expect(rightPost.position.x).toBeCloseTo(TRAIL_GATE_MAX_HALF_SPAN, 5);
    expect(beamHolder.scale.x).toBeCloseTo(TRAIL_GATE_MAX_HALF_SPAN / TRAIL_GATE_DEFAULT_HALF_SPAN, 5);
    expect(leftPost.scale.x).toBe(1);
    expect(rightPost.scale.x).toBe(1);
    expect(badgeHolder.scale.x).toBe(1);

    gfx.disposeObject(gate.group);
    tracker.disposeAll();
    const stats = tracker.getStats();
    expect(stats.activeObjects).toBe(0);
    expect(stats.cachedGeometries).toBe(0);
    expect(stats.cachedMaterials).toBe(0);
    expect(stats.cachedTextures).toBe(0);
  });

  it('mounts pooled Trail Gates with outlines, context restore support, and 0 GPU leaks inside LandmarkStreamer & ThreeRenderer', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();
    const mats = createSharedToonMaterials(gfx);
    const outlineMat = createSmoothOutlineMaterial(gfx);
    const assets = createProceduralMeshAssets(gfx);

    const landmarkStreamer = new LandmarkStreamer(gfx, mats, assets, {
      outlineMaterial: outlineMat,
    });
    scene.add(landmarkStreamer.rootGroup);

    const reqs: SegmentLandmarkRequirement[] = [
      {
        id: 'fork_arch_1_left',
        kind: 'forkArch',
        segmentId: 1,
        s: 140,
        x: -11,
        worldX: -11,
        worldY: -35,
        worldZ: -140,
        yawRad: 0,
        clearanceRadius: 4.5,
        visual: { kind: 'procedural', preset: 'arch', palette: ['#78350f'] },
        badgeStageId: 'powder-bowl',
        forkSide: 'left',
        gateHalfWidth: 11,
      },
      {
        id: 'fork_arch_1_right',
        kind: 'forkArch',
        segmentId: 1,
        s: 140,
        x: 11,
        worldX: 11,
        worldY: -35,
        worldZ: -140,
        yawRad: 0,
        clearanceRadius: 4.5,
        visual: { kind: 'procedural', preset: 'arch', palette: ['#78350f'] },
        badgeStageId: 'icy-black',
        forkSide: 'right',
        gateHalfWidth: 13.5,
      },
    ];
    const seg = createMockGateSegment(1, 77, reqs);
    const window: TrailWindowView = { prev: null, curr: seg, nextLeft: null, nextRight: null };

    landmarkStreamer.sync(window);
    expect(landmarkStreamer.activeCount).toBe(2);

    const gates: THREE.Object3D[] = [];
    landmarkStreamer.rootGroup.traverse((n) => {
      if (n.name === 'ForkArchLandmark') gates.push(n);
    });
    expect(gates).toHaveLength(2);
    expect(gates.some((g) => g.getObjectByName('ForkBadgeCircle')?.visible === true)).toBe(true);
    expect(gates.some((g) => g.getObjectByName('ForkBadgeDiamond')?.visible === true)).toBe(true);

    expect(() => tracker.markAllForContextRestore()).not.toThrow();
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    landmarkStreamer.clearAll();
    tracker.disposeAll();
    expect(tracker.getStats().activeObjects).toBe(0);
    expect(tracker.getStats().cachedGeometries).toBe(0);
    expect(tracker.getStats().cachedMaterials).toBe(0);
    expect(tracker.getStats().cachedTextures).toBe(0);

    // Full headless ThreeRenderer lifecycle verification
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });
    expect(renderer.runLeakCheck(0, true).totalLeaks).toBe(0);
    renderer.dispose();
    const rStats = renderer.getStats().graphics;
    expect(rStats.activeObjects).toBe(0);
    expect(rStats.cachedGeometries).toBe(0);
    expect(rStats.cachedMaterials).toBe(0);
    expect(rStats.cachedTextures).toBe(0);
  });
});
