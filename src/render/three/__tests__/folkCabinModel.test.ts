import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../core/eventBus';
import {
  createChunkRangeOut,
  createRibbonPointOut,
  createSpineFrameOut,
  type SegmentLandmarkRequirement,
  type SimEvents,
  type TerrainSegmentView,
  type TrailWindowView,
} from '../../../sim/contracts';
import {
  buildFolkCabinGeometries,
  drawFolkCabinAtlas,
  drawFolkSmokeSprite,
  FOLK_CABIN_ATLAS_TILES,
  FOLK_CABIN_SMOKE_ORIGIN,
  type FolkCabinTileName,
} from '../folkCabinModel';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { LandmarkStreamer } from '../landmarkStreamer';
import { createProceduralMeshAssets } from '../meshFactory';
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

function createMockCabinSegment(
  id: number,
  seed: number,
  landmarks: readonly SegmentLandmarkRequirement[],
): TerrainSegmentView {
  const length = 140;
  const chunkLength = 35;
  return {
    id,
    slot: 'curr',
    stageId: 'sunny-blue',
    seed,
    length,
    chunkLength,
    chunkCount: 4,
    prevSegmentId: null,
    nextLeftId: null,
    nextRightId: null,
    fork: {
      hasFork: false,
      obstacleFreeStartS: 90,
      leftStageId: 'sunny-blue',
      rightStageId: 'icy-black',
      isForkChild: false,
      forkSide: 'none',
      innerWallRampLength: 25,
      seamNoseRadius: 1.5,
      seamWorldX: 0,
      seamWorldY: -35,
      seamWorldZ: -length,
      seamYawRad: 0,
    },
    landmarks,
    getChunkBounds(chunkIndex, out = createChunkRangeOut()) {
      out.startS = chunkIndex * chunkLength;
      out.endS = Math.min(length, (chunkIndex + 1) * chunkLength);
    },
    sampleSpineFrame(s, out = createSpineFrameOut()) {
      out.posX = 0;
      out.posY = -s * 0.25;
      out.posZ = -s;
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
    evaluateSurfaceAtX(s, x, out = createRibbonPointOut()) {
      out.posX = x;
      out.posY = -s * 0.25;
      out.posZ = -s;
      out.normalX = 0;
      out.normalY = 0.97;
      out.normalZ = -0.24;
      out.lateralX = x;
      out.halfWidth = 14;
      out.skirtWidth = 12;
      out.slopeDeg = 14;
      out.localHeight = 0;
      out.surfaceType = 'packed';
      out.inPlayableCorridor = Math.abs(x) <= 14;
      out.inDivider = false;
      out.isInnerForkSlope = false;
    },
    sampleSafeX(): number {
      return 0;
    },
  };
}

describe('Folk Log Cabin Model & LandmarkStreamer Integration', () => {
  it('defines non-overlapping [0, 1] UV tiles in FOLK_CABIN_ATLAS_TILES', () => {
    const entries = Object.entries(FOLK_CABIN_ATLAS_TILES) as Array<
      [FolkCabinTileName, (typeof FOLK_CABIN_ATLAS_TILES)['logBark']]
    >;
    expect(entries).toHaveLength(13);

    for (const [name, tile] of entries) {
      expect(tile.u0, `${name} u0 >= 0`).toBeGreaterThanOrEqual(0);
      expect(tile.v0, `${name} v0 >= 0`).toBeGreaterThanOrEqual(0);
      expect(tile.u1, `${name} u1 <= 1`).toBeLessThanOrEqual(1);
      expect(tile.v1, `${name} v1 <= 1`).toBeLessThanOrEqual(1);
      expect(tile.u1, `${name} u1 > u0`).toBeGreaterThan(tile.u0);
      expect(tile.v1, `${name} v1 > v0`).toBeGreaterThan(tile.v0);
    }

    for (let i = 0; i < entries.length; i++) {
      const [nameA, a] = entries[i]!;
      for (let j = i + 1; j < entries.length; j++) {
        const [nameB, b] = entries[j]!;
        const overlapU = a.u0 < b.u1 && b.u0 < a.u1;
        const overlapV = a.v0 < b.v1 && b.v0 < a.v1;
        expect(overlapU && overlapV, `UV overlap between ${nameA} and ${nameB}`).toBe(false);
      }
    }
  });

  it('draws folk cabin atlas and swirling smoke sprite with strictly finite Canvas2D coordinates', () => {
    const ctx = createRecordingCanvas2DContext();
    expect(() => drawFolkCabinAtlas(ctx)).not.toThrow();
    expect(() => drawFolkSmokeSprite(ctx)).not.toThrow();
  });

  it('builds finite, smooth-normal, sloped-grounded Folk Log Cabin geometries with outward gable normals', () => {
    const { cabinGeo, cabinGlowGeo, cabinSmokeGeo } = buildFolkCabinGeometries();

    for (const geo of [cabinGeo, cabinGlowGeo, cabinSmokeGeo]) {
      const pos = geo.getAttribute('position');
      const norm = geo.getAttribute('normal');
      expect(pos).toBeDefined();
      expect(norm).toBeDefined();
      expect(pos.count).toBeGreaterThan(0);
      expect(norm.count).toBe(pos.count);

      for (let i = 0; i < pos.count; i++) {
        expect(Number.isFinite(pos.getX(i))).toBe(true);
        expect(Number.isFinite(pos.getY(i))).toBe(true);
        expect(Number.isFinite(pos.getZ(i))).toBe(true);
        expect(Number.isFinite(norm.getX(i))).toBe(true);
        expect(Number.isFinite(norm.getY(i))).toBe(true);
        expect(Number.isFinite(norm.getZ(i))).toBe(true);
      }
    }

    const cabinUv = cabinGeo.getAttribute('uv');
    const cabinSmooth = cabinGeo.getAttribute('aSmoothNormal');
    const cabinPos = cabinGeo.getAttribute('position');
    expect(cabinUv).toBeDefined();
    expect(cabinSmooth).toBeDefined();
    expect(cabinSmooth.count).toBe(cabinPos.count);
    for (let i = 0; i < cabinUv.count; i++) {
      const u = cabinUv.getX(i);
      const v = cabinUv.getY(i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // Verify bounding boxes & slope grounding
    cabinGeo.computeBoundingBox();
    const box = cabinGeo.boundingBox!;
    expect(box.min.y).toBeLessThanOrEqual(-0.8);
    expect(box.max.y).toBeGreaterThanOrEqual(5.4);
    expect(Math.max(Math.abs(box.min.x), Math.abs(box.max.x))).toBeLessThanOrEqual(4.0);
    expect(Math.max(Math.abs(box.min.z), Math.abs(box.max.z))).toBeLessThanOrEqual(4.6);

    cabinSmokeGeo.computeBoundingBox();
    const smokeBox = cabinSmokeGeo.boundingBox!;
    expect(smokeBox.min.y).toBeGreaterThanOrEqual(-0.1);
    expect(smokeBox.max.y).toBeGreaterThanOrEqual(2.8);

    // Verify front (+Z) and back (-Z) gable pediment triangles point strictly outward
    const normAttr = cabinGeo.getAttribute('normal');
    let foundFrontPediment = false;
    let foundBackPediment = false;
    for (let i = 0; i < cabinPos.count; i += 3) {
      const z0 = cabinPos.getZ(i);
      const z1 = cabinPos.getZ(i + 1);
      const z2 = cabinPos.getZ(i + 2);
      const y0 = cabinPos.getY(i);
      const y1 = cabinPos.getY(i + 1);
      const y2 = cabinPos.getY(i + 2);
      const maxY = Math.max(y0, y1, y2);
      const minY = Math.min(y0, y1, y2);
      if (maxY > 4.9 && minY < 2.9) {
        if (Math.abs(z0 - 2.78) < 0.02 && Math.abs(z1 - 2.78) < 0.02 && Math.abs(z2 - 2.78) < 0.02) {
          expect(normAttr.getZ(i)).toBeGreaterThan(0.95);
          foundFrontPediment = true;
        }
        if (Math.abs(z0 + 2.78) < 0.02 && Math.abs(z1 + 2.78) < 0.02 && Math.abs(z2 + 2.78) < 0.02) {
          expect(normAttr.getZ(i)).toBeLessThan(-0.95);
          foundBackPediment = true;
        }
      }
    }
    expect(foundFrontPediment).toBe(true);
    expect(foundBackPediment).toBe(true);

    cabinGeo.dispose();
    cabinGlowGeo.dispose();
    cabinSmokeGeo.dispose();
  });

  it('mounts pooled Folk Log Cabin with outlines, glow windows, animated smoke, and zero GPU leaks', () => {
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

    const cabinReq: SegmentLandmarkRequirement = {
      id: 'folk_cabin_1',
      kind: 'deliveryLandmark',
      segmentId: 1,
      s: 40,
      x: -10,
      worldX: -10,
      worldY: -12,
      worldZ: -40,
      yawRad: 0,
      clearanceRadius: 4.5,
      visual: { kind: 'procedural', preset: 'cabin', palette: ['#c48636'] },
    };
    const seg = createMockCabinSegment(1, 17, [cabinReq]);
    const window: TrailWindowView = { prev: null, curr: seg, nextLeft: null, nextRight: null };

    landmarkStreamer.sync(window, 0.25);
    expect(landmarkStreamer.activeCount).toBe(1);

    let cabinMesh: THREE.Mesh | undefined;
    let outlineMesh: THREE.Mesh | undefined;
    let glowMesh: THREE.Mesh | undefined;
    let smokeMesh: THREE.Mesh | undefined;

    landmarkStreamer.rootGroup.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      if (node.name.startsWith('DeliveryCabinOutline_')) outlineMesh = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryCabinGlow_')) glowMesh = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryCabinSmoke_')) smokeMesh = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryCabin_')) cabinMesh = node as THREE.Mesh;
    });

    expect(cabinMesh).toBeDefined();
    expect(outlineMesh).toBeDefined();
    expect(glowMesh).toBeDefined();
    expect(smokeMesh).toBeDefined();

    expect(cabinMesh!.castShadow).toBe(true);
    expect(outlineMesh!.castShadow).toBe(false);
    expect(glowMesh!.castShadow).toBe(false);
    expect(smokeMesh!.castShadow).toBe(false);

    expect(smokeMesh!.position.x).toBeCloseTo(FOLK_CABIN_SMOKE_ORIGIN.x, 5);
    expect(smokeMesh!.position.y).toBeCloseTo(FOLK_CABIN_SMOKE_ORIGIN.y, 5);
    expect(smokeMesh!.position.z).toBeCloseTo(FOLK_CABIN_SMOKE_ORIGIN.z, 5);

    const rotY0 = smokeMesh!.rotation.y;
    const scaleY0 = smokeMesh!.scale.y;
    landmarkStreamer.sync(window, 1.35);
    expect(smokeMesh!.rotation.y).not.toBeCloseTo(rotY0, 4);
    expect(smokeMesh!.scale.y).not.toBeCloseTo(scaleY0, 4);

    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    landmarkStreamer.clearAll();
    tracker.disposeAll();
    const stats = tracker.getStats();
    expect(stats.activeObjects).toBe(0);
    expect(stats.activeGeometries).toBe(0);
    expect(stats.activeMaterials).toBe(0);
    expect(stats.activeTextures).toBe(0);
    expect(stats.cachedGeometries).toBe(0);
    expect(stats.cachedMaterials).toBe(0);
    expect(stats.cachedTextures).toBe(0);
  });

  it('integrates folk cabin materials & cleanup cleanly inside headless ThreeRenderer', () => {
    const eventBus = new EventBus<SimEvents>();
    const renderer = new ThreeRenderer(null, eventBus, undefined, { headless: true });
    expect(renderer.runLeakCheck(0, true).totalLeaks).toBe(0);

    renderer.dispose();
    const stats = renderer.getStats().graphics;
    expect(stats.activeObjects).toBe(0);
    expect(stats.cachedGeometries).toBe(0);
    expect(stats.cachedMaterials).toBe(0);
    expect(stats.cachedTextures).toBe(0);
  });
});
