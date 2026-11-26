import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DELIVERY_VILLAGE_PLAZA } from '../../../content/deliveryZones';
import type {
  SegmentLandmarkRequirement,
  TerrainSegmentView,
  TrailWindowView,
} from '../../../sim/contracts';
import { EntityPools } from '../../../sim/entityPools';
import { LayoutEngine } from '../../../sim/layoutEngine';
import { TrailSegment } from '../../../sim/trailSegment';
import { getStageDef } from '../../../content/stages';
import { CABIN_SMOKE_PUFFS_PER_CABIN } from '../chimneySmoke';
import { FOLK_CABIN_SMOKE_ORIGIN } from '../folkCabinModel';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { createDefaultLandmarkRegistry } from '../landmarkRegistry';
import { LandmarkStreamer } from '../landmarkStreamer';
import { createProceduralMeshAssets } from '../meshFactory';
import {
  buildFolkAFrameGeometries,
  drawFolkAFrameAtlas,
  FOLK_AFRAME_ATLAS_TILES,
  FOLK_AFRAME_SMOKE_ANCHOR,
  type FolkAFrameTileName,
} from '../models/folkAFrameModel';
import { createSmoothOutlineMaterial } from '../outlineShader';
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

function createMockLandmarkSegment(
  id: number,
  seed: number,
  landmarks: readonly SegmentLandmarkRequirement[],
): TerrainSegmentView {
  return {
    id,
    slot: 'curr',
    stageId: 'powder-bowl',
    seed,
    length: 140,
    chunkLength: 35,
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
      seamWorldZ: -140,
      seamYawRad: 0,
    },
    landmarks,
    getChunkBounds() {},
    sampleSpineFrame() {},
    evaluateSurfaceAtX() {},
    sampleSafeX: () => 0,
  };
}

describe('Folk A-Frame Chalet, LandmarkModelRegistry & Deterministic Building Variety', () => {
  it('defines 13 non-overlapping [0, 1] UV tiles in FOLK_AFRAME_ATLAS_TILES', () => {
    const entries = Object.entries(FOLK_AFRAME_ATLAS_TILES) as Array<
      [FolkAFrameTileName, (typeof FOLK_AFRAME_ATLAS_TILES)['aframeRoofSnow']]
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

  it('draws Folk A-Frame Chalet atlas with strictly finite Canvas2D coordinates', () => {
    const ctx = createRecordingCanvas2DContext();
    expect(() => drawFolkAFrameAtlas(ctx)).not.toThrow();
  });

  it('builds finite, smooth-normal, slope-grounded Folk A-Frame Chalet geometries with outward pediment normals', () => {
    const { chaletGeo, chaletGlowGeo } = buildFolkAFrameGeometries();

    for (const geo of [chaletGeo, chaletGlowGeo]) {
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

    const uv = chaletGeo.getAttribute('uv');
    const smooth = chaletGeo.getAttribute('aSmoothNormal');
    const pos = chaletGeo.getAttribute('position');
    expect(uv).toBeDefined();
    expect(smooth).toBeDefined();
    expect(smooth.count).toBe(pos.count);
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
    }

    chaletGeo.computeBoundingBox();
    const box = chaletGeo.boundingBox!;
    expect(box.min.y).toBeLessThanOrEqual(-0.8);
    expect(box.max.y).toBeGreaterThanOrEqual(5.8);
    expect(Math.max(Math.abs(box.min.x), Math.abs(box.max.x))).toBeLessThanOrEqual(4.2);
    expect(Math.max(Math.abs(box.min.z), Math.abs(box.max.z))).toBeLessThanOrEqual(4.4);

    // Verify front (+Z) and back (-Z) upper gable pediment triangles face outward
    const normAttr = chaletGeo.getAttribute('normal');
    let foundFront = false;
    let foundBack = false;
    for (let i = 0; i < pos.count; i += 3) {
      const y0 = pos.getY(i);
      const y1 = pos.getY(i + 1);
      const y2 = pos.getY(i + 2);
      const z0 = pos.getZ(i);
      const z1 = pos.getZ(i + 1);
      const z2 = pos.getZ(i + 2);
      if (Math.max(y0, y1, y2) > 5.4 && Math.min(y0, y1, y2) < 2.4) {
        if (Math.abs(z0 - 2.54) < 0.02 && Math.abs(z1 - 2.54) < 0.02 && Math.abs(z2 - 2.54) < 0.02) {
          expect(normAttr.getZ(i)).toBeGreaterThan(0.95);
          foundFront = true;
        }
        if (Math.abs(z0 + 2.54) < 0.02 && Math.abs(z1 + 2.54) < 0.02 && Math.abs(z2 + 2.54) < 0.02) {
          expect(normAttr.getZ(i)).toBeLessThan(-0.95);
          foundBack = true;
        }
      }
    }
    expect(foundFront).toBe(true);
    expect(foundBack).toBe(true);

    chaletGeo.dispose();
    chaletGlowGeo.dispose();
  });

  it('mounts both Folk Log Cabin and Folk A-Frame Chalet simultaneously via LandmarkModelRegistry with per-model smoke & context restore', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();
    const mats = createSharedToonMaterials(gfx);
    const outlineMat = createSmoothOutlineMaterial(gfx);
    const assets = createProceduralMeshAssets(gfx);

    const registry = createDefaultLandmarkRegistry(gfx, mats, assets, outlineMat);
    expect(registry.resolve('proc:cabin')).toBe(registry.resolve('proc:cabin:folk_log'));
    expect(registry.resolve('proc:cabin:folk_aframe')).toBeDefined();

    const landmarkStreamer = new LandmarkStreamer(gfx, mats, assets, {
      outlineMaterial: outlineMat,
      registry,
    });
    scene.add(landmarkStreamer.rootGroup);

    const landmarks: SegmentLandmarkRequirement[] = [
      {
        id: 'log_1',
        kind: 'deliveryLandmark',
        segmentId: 1,
        s: 40,
        x: -10,
        worldX: -10,
        worldY: -10,
        worldZ: -40,
        yawRad: 0,
        clearanceRadius: 4.5,
        visual: { kind: 'procedural', preset: 'cabin', palette: ['#c48636'], variant: 'folk_log' },
      },
      {
        id: 'aframe_1',
        kind: 'deliveryLandmark',
        segmentId: 1,
        s: 90,
        x: 10,
        worldX: 10,
        worldY: -22,
        worldZ: -90,
        yawRad: 0,
        clearanceRadius: 4.8,
        visual: { kind: 'procedural', preset: 'cabin', palette: ['#cc8a32'], variant: 'folk_aframe' },
      },
    ];

    const seg = createMockLandmarkSegment(1, 29, landmarks);
    const window: TrailWindowView = { prev: null, curr: seg, nextLeft: null, nextRight: null };

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 400);
    camera.position.set(0, -4, -10);
    camera.lookAt(0, -16, -65);
    camera.updateMatrixWorld();

    landmarkStreamer.sync(window, 0.3, camera, 0);
    expect(landmarkStreamer.activeCount).toBe(2);
    expect(landmarkStreamer.cabinSmokeMesh.count).toBe(2 * CABIN_SMOKE_PUFFS_PER_CABIN);

    let cabinMain: THREE.Mesh | undefined;
    let cabinOutline: THREE.Mesh | undefined;
    let cabinGlow: THREE.Mesh | undefined;
    let chaletMain: THREE.Mesh | undefined;
    let chaletOutline: THREE.Mesh | undefined;
    let chaletGlow: THREE.Mesh | undefined;

    landmarkStreamer.rootGroup.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      if (node.name.startsWith('DeliveryCabinOutline_')) cabinOutline = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryCabinGlow_')) cabinGlow = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryCabin_')) cabinMain = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryChaletAFrameOutline_')) chaletOutline = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryChaletAFrameGlow_')) chaletGlow = node as THREE.Mesh;
      else if (node.name.startsWith('DeliveryChaletAFrame_')) chaletMain = node as THREE.Mesh;
    });

    expect(cabinMain?.castShadow).toBe(true);
    expect(cabinOutline?.castShadow).toBe(false);
    expect(cabinGlow?.castShadow).toBe(false);
    expect(chaletMain?.castShadow).toBe(true);
    expect(chaletOutline?.castShadow).toBe(false);
    expect(chaletGlow?.castShadow).toBe(false);

    // Verify puffs rise from their respective rotated chimney anchors
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let minLogY = Infinity;
    let minAframeY = Infinity;
    for (let i = 0; i < landmarkStreamer.cabinSmokeMesh.count; i++) {
      landmarkStreamer.cabinSmokeMesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      if (i < CABIN_SMOKE_PUFFS_PER_CABIN) {
        if (p.y < minLogY) minLogY = p.y;
      } else {
        if (p.y < minAframeY) minAframeY = p.y;
      }
    }
    expect(minLogY).toBeGreaterThanOrEqual(-10 + FOLK_CABIN_SMOKE_ORIGIN.y);
    expect(minAframeY).toBeGreaterThanOrEqual(-22 + FOLK_AFRAME_SMOKE_ANCHOR.y);

    // markAllForContextRestore flags tracked textures/materials automatically
    expect(() => tracker.markAllForContextRestore()).not.toThrow();
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    landmarkStreamer.clearAll();
    expect(landmarkStreamer.cabinSmokeMesh.count).toBe(0);
    tracker.disposeAll();
    const stats = tracker.getStats();
    expect(stats.activeObjects).toBe(0);
    expect(stats.cachedGeometries).toBe(0);
    expect(stats.cachedMaterials).toBe(0);
    expect(stats.cachedTextures).toBe(0);
  });

  it('deterministically picks both folk_log and folk_aframe variants across village_plaza placements', () => {
    expect(DELIVERY_VILLAGE_PLAZA.landmarkVisualPool).toBeDefined();
    expect(DELIVERY_VILLAGE_PLAZA.landmarkVisualPool!.length).toBeGreaterThanOrEqual(2);

    const stage = getStageDef('powder-bowl')!;
    const variantsRun1: string[] = [];
    const variantsRun2: string[] = [];

    const collectVariants = (out: string[]): void => {
      const engine = new LayoutEngine(4242);
      const pools = new EntityPools();
      for (let segId = 1; segId <= 40; segId++) {
        pools.clear();
        const seg = new TrailSegment({
          id: segId,
          slot: 'curr',
          stage,
          seed: segId * 131,
          length: 220,
          startPosX: 0,
          startPosY: 0,
          startPosZ: 0,
          startYawRad: 0,
          startPitchRad: -0.2,
          startHalfWidth: 16,
          endHalfWidth: 16,
          prevSegmentId: null,
          hasFork: false,
          leftStageId: null,
          rightStageId: null,
          isForkChild: false,
          forkSide: 'none',
          seamWorldX: 0,
          seamWorldY: -44,
          seamWorldZ: -220,
          seamYawRad: 0,
        });
        engine.bakeSegment(seg, pools, 0.25);
        for (const lm of seg.landmarks) {
          if (lm.kind === 'deliveryLandmark' && lm.visual.kind === 'procedural' && lm.visual.preset === 'cabin') {
            out.push(lm.visual.variant ?? 'default');
          }
        }
      }
    };

    collectVariants(variantsRun1);
    collectVariants(variantsRun2);

    expect(variantsRun1.length).toBeGreaterThanOrEqual(6);
    expect(variantsRun1).toEqual(variantsRun2);
    expect(variantsRun1).toContain('folk_log');
    expect(variantsRun1).toContain('folk_aframe');
  });
});
