import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_CHILD_SOLO,
  DELIVERY_SLED_DUO,
} from '../../../content/deliveryZones';
import { getStageDef } from '../../../content/stages';
import { EventBus } from '../../../core/eventBus';
import type {
  SegmentLandmarkRequirement,
  SimEvents,
  TerrainSegmentView,
  TrailWindowView,
} from '../../../sim/contracts';
import { EntityPools } from '../../../sim/entityPools';
import { LayoutEngine } from '../../../sim/layoutEngine';
import { TrailSegment } from '../../../sim/trailSegment';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { createDefaultLandmarkRegistry } from '../landmarkRegistry';
import { LandmarkStreamer } from '../landmarkStreamer';
import { createProceduralMeshAssets } from '../meshFactory';
import {
  buildLanternPostGeometries,
  DEFAULT_LANTERN_POST_TUNING,
  drawLanternPostAtlas,
  LANTERN_BODY_CENTER_Y,
  LANTERN_HANG_X,
  LANTERN_POST_ATLAS_SIZE,
  LANTERN_POST_ATLAS_TILES,
  LANTERN_SCALE,
  resolveLanternPostTuning,
  type LanternPostTileName,
} from '../models/lanternPostModel';
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

function createMockLanternSegment(
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
      hasFork: false,
      obstacleFreeStartS: 90,
      leftStageId: 'powder-bowl',
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

function assertFiniteGeometry(geo: THREE.BufferGeometry, requireUvAndSmooth: boolean): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const norm = geo.getAttribute('normal') as THREE.BufferAttribute;
  expect(pos).toBeDefined();
  expect(norm).toBeDefined();
  expect(pos.count).toBeGreaterThan(0);
  expect(norm.count).toBe(pos.count);

  for (let i = 0; i < pos.count; i++) {
    expect(Number.isFinite(pos.getX(i))).toBe(true);
    expect(Number.isFinite(pos.getY(i))).toBe(true);
    expect(Number.isFinite(pos.getZ(i))).toBe(true);
    const nLen = Math.hypot(norm.getX(i), norm.getY(i), norm.getZ(i));
    expect(nLen).toBeCloseTo(1, 3);
  }

  if (requireUvAndSmooth) {
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const smooth = geo.getAttribute('aSmoothNormal') as THREE.BufferAttribute;
    expect(uv).toBeDefined();
    expect(smooth).toBeDefined();
    expect(uv.count).toBe(pos.count);
    expect(smooth.count).toBe(pos.count);
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
      const sLen = Math.hypot(smooth.getX(i), smooth.getY(i), smooth.getZ(i));
      expect(sLen).toBeCloseTo(1, 2);
    }
  } else {
    const color = geo.getAttribute('color') as THREE.BufferAttribute;
    expect(color).toBeDefined();
    expect(color.count).toBe(pos.count);
    for (let i = 0; i < color.count; i++) {
      expect(color.getX(i)).toBeGreaterThanOrEqual(0);
      expect(color.getX(i)).toBeLessThanOrEqual(1);
      expect(color.getY(i)).toBeGreaterThanOrEqual(0);
      expect(color.getY(i)).toBeLessThanOrEqual(1);
      expect(color.getZ(i)).toBeGreaterThanOrEqual(0);
      expect(color.getZ(i)).toBeLessThanOrEqual(1);
    }
  }
}

describe('Single & Double Hanging Wooden Lantern Post 3D Models', () => {
  it('defines 6 non-overlapping tiles within 512x512 and draws finite Canvas2D artwork', () => {
    const keys = Object.keys(LANTERN_POST_ATLAS_TILES) as LanternPostTileName[];
    expect(keys).toHaveLength(6);

    for (let i = 0; i < keys.length; i++) {
      const a = LANTERN_POST_ATLAS_TILES[keys[i]!];
      expect(a.px).toBeGreaterThanOrEqual(0);
      expect(a.py).toBeGreaterThanOrEqual(0);
      expect(a.px + a.pw).toBeLessThanOrEqual(LANTERN_POST_ATLAS_SIZE);
      expect(a.py + a.ph).toBeLessThanOrEqual(LANTERN_POST_ATLAS_SIZE);
      expect(a.u0).toBeGreaterThanOrEqual(0);
      expect(a.u1).toBeLessThanOrEqual(1);
      expect(a.v0).toBeGreaterThanOrEqual(0);
      expect(a.v1).toBeLessThanOrEqual(1);
      expect(a.u1).toBeGreaterThan(a.u0);
      expect(a.v1).toBeGreaterThan(a.v0);

      for (let j = i + 1; j < keys.length; j++) {
        const b = LANTERN_POST_ATLAS_TILES[keys[j]!];
        const overlapX = a.px < b.px + b.pw && a.px + a.pw > b.px;
        const overlapY = a.py < b.py + b.ph && a.py + a.ph > b.py;
        expect(overlapX && overlapY, `tiles ${keys[i]} and ${keys[j]} must not overlap`).toBe(false);
        const overlapU = a.u0 < b.u1 && b.u0 < a.u1;
        const overlapV = a.v0 < b.v1 && b.v0 < a.v1;
        expect(overlapU && overlapV, `UVs ${keys[i]} and ${keys[j]} must not overlap`).toBe(false);
      }
    }

    const ctx = createRecordingCanvas2DContext();
    expect(() => drawLanternPostAtlas(ctx)).not.toThrow();
  });

  it('builds finite, grounded, outward-normal single & double geometries with Z-fighting clearance', () => {
    const single = buildLanternPostGeometries('single');
    const dbl = buildLanternPostGeometries('double');

    assertFiniteGeometry(single.bodyGeo, true);
    assertFiniteGeometry(single.glowGeo, false);
    assertFiniteGeometry(single.glassGeo, false);
    assertFiniteGeometry(dbl.bodyGeo, true);
    assertFiniteGeometry(dbl.glowGeo, false);
    assertFiniteGeometry(dbl.glassGeo, false);

    single.bodyGeo.computeBoundingBox();
    dbl.bodyGeo.computeBoundingBox();
    const sBox = single.bodyGeo.boundingBox!;
    const dBox = dbl.bodyGeo.boundingBox!;

    // Grounded foundation skirt and well-proportioned height above snow
    expect(sBox.min.y).toBeLessThanOrEqual(-1.0);
    expect(sBox.max.y).toBeGreaterThanOrEqual(5.2);
    expect(sBox.max.y).toBeLessThanOrEqual(5.7);
    expect(dBox.min.y).toBeLessThanOrEqual(-1.0);
    expect(dBox.max.y).toBeGreaterThanOrEqual(5.2);
    expect(dBox.max.y).toBeLessThanOrEqual(5.7);

    // Single arm reaches +X asymmetrically; double arms extend symmetrically on both sides
    expect(sBox.max.x).toBeGreaterThan(2.0);
    expect(sBox.min.x).toBeGreaterThan(-0.6);
    expect(dBox.min.x).toBeLessThan(-2.0);
    expect(dBox.max.x).toBeGreaterThan(2.0);
    expect(Math.abs(dBox.min.x + dBox.max.x)).toBeLessThan(1e-4);

    // Double bodyGeo has balanced symmetric X extent around 0
    const dBodyPos = dbl.bodyGeo.getAttribute('position') as THREE.BufferAttribute;
    let negArmVerts = 0;
    let posArmVerts = 0;
    for (let v = 0; v < dBodyPos.count; v++) {
      const px = dBodyPos.getX(v);
      if (px < -0.5) negArmVerts++;
      else if (px > 0.5) posArmVerts++;
    }
    expect(negArmVerts).toBeGreaterThan(100);
    expect(negArmVerts).toBe(posArmVerts);

    // Double variant mirrors the exact lantern chamber, mullions, candle, and glass panes twice
    expect(dbl.glowGeo.getAttribute('position').count).toBe(
      single.glowGeo.getAttribute('position').count * 2,
    );
    expect(dbl.glassGeo.getAttribute('position').count).toBe(
      single.glassGeo.getAttribute('position').count * 2,
    );

    // Tapered post sides (0..23) and top/bottom caps (24..35) have strictly outward normals and slimmer cross-section
    for (const geo of [single.bodyGeo, dbl.bodyGeo]) {
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const norm = geo.getAttribute('normal') as THREE.BufferAttribute;
      for (let v = 0; v < 24; v++) {
        const dot = pos.getX(v) * norm.getX(v) + pos.getZ(v) * norm.getZ(v);
        expect(dot).toBeGreaterThan(0);
        if (pos.getY(v) < 0) {
          expect(Math.abs(pos.getX(v))).toBeLessThanOrEqual(0.22);
          expect(Math.abs(pos.getZ(v))).toBeLessThanOrEqual(0.22);
        } else if (pos.getY(v) > 3) {
          expect(Math.abs(pos.getX(v))).toBeLessThanOrEqual(0.19);
          expect(Math.abs(pos.getZ(v))).toBeLessThanOrEqual(0.19);
        }
      }
      for (let v = 24; v < 30; v++) expect(norm.getY(v)).toBeGreaterThan(0.95);
      for (let v = 30; v < 36; v++) expect(norm.getY(v)).toBeLessThan(-0.95);
    }

    // Glass shell sits strictly inside the mullion plane around x = LANTERN_HANG_X and y = LANTERN_BODY_CENTER_Y (zero Z-fighting)
    const glassPos = single.glassGeo.getAttribute('position') as THREE.BufferAttribute;
    let maxGlassHalfSpan = 0;
    for (let v = 0; v < glassPos.count; v++) {
      const dx = Math.abs(glassPos.getX(v) - LANTERN_HANG_X);
      const dz = Math.abs(glassPos.getZ(v));
      const span = Math.max(dx, dz);
      if (span > maxGlassHalfSpan) maxGlassHalfSpan = span;
    }
    expect(maxGlassHalfSpan).toBeGreaterThan(0.25);
    expect(maxGlassHalfSpan).toBeLessThan(0.28);

    single.glassGeo.computeBoundingBox();
    const glassBox = single.glassGeo.boundingBox!;
    expect((glassBox.min.y + glassBox.max.y) * 0.5).toBeCloseTo(LANTERN_BODY_CENTER_Y, 4);
    expect(glassBox.min.y).toBeGreaterThan(3.0);

    for (const g of [
      single.bodyGeo,
      single.glowGeo,
      single.glassGeo,
      dbl.bodyGeo,
      dbl.glowGeo,
      dbl.glassGeo,
    ]) {
      g.dispose();
    }
  });

  it('supports optional LanternPostTuning overrides while preserving default geometry output', () => {
    const omitted = buildLanternPostGeometries('single');
    const explicitDefault = buildLanternPostGeometries('single', DEFAULT_LANTERN_POST_TUNING);

    omitted.bodyGeo.computeBoundingBox();
    explicitDefault.bodyGeo.computeBoundingBox();
    expect(explicitDefault.bodyGeo.getAttribute('position').count).toBe(
      omitted.bodyGeo.getAttribute('position').count,
    );
    expect(explicitDefault.bodyGeo.boundingBox!.max.x).toBeCloseTo(
      omitted.bodyGeo.boundingBox!.max.x,
      6,
    );
    expect(explicitDefault.bodyGeo.boundingBox!.max.y).toBeCloseTo(
      omitted.bodyGeo.boundingBox!.max.y,
      6,
    );

    const sanitized = resolveLanternPostTuning({
      postHeightM: -1,
      armLengthM: Number.NaN,
      lanternScale: 99,
      woodThicknessScale: 0.05,
    });
    expect(sanitized.postHeightM).toBe(DEFAULT_LANTERN_POST_TUNING.postHeightM);
    expect(sanitized.armLengthM).toBe(DEFAULT_LANTERN_POST_TUNING.armLengthM);
    expect(sanitized.lanternScale).toBe(2.2);
    expect(sanitized.woodThicknessScale).toBe(0.35);
    expect(resolveLanternPostTuning({ lanternScale: -1 }).lanternScale).toBe(LANTERN_SCALE);

    const tallLong = buildLanternPostGeometries('single', {
      postHeightM: 4.8,
      armLengthM: 2.2,
      lanternScale: 0.75,
      woodThicknessScale: 0.8,
    });
    const shortThick = buildLanternPostGeometries('single', {
      postHeightM: 2.8,
      armLengthM: 1.1,
      lanternScale: 1.3,
      woodThicknessScale: 1.3,
    });

    assertFiniteGeometry(tallLong.bodyGeo, true);
    assertFiniteGeometry(tallLong.glowGeo, false);
    assertFiniteGeometry(tallLong.glassGeo, false);
    assertFiniteGeometry(shortThick.bodyGeo, true);
    assertFiniteGeometry(shortThick.glowGeo, false);
    assertFiniteGeometry(shortThick.glassGeo, false);

    tallLong.bodyGeo.computeBoundingBox();
    shortThick.bodyGeo.computeBoundingBox();
    tallLong.glassGeo.computeBoundingBox();
    shortThick.glassGeo.computeBoundingBox();

    const tallBox = tallLong.bodyGeo.boundingBox!;
    const shortBox = shortThick.bodyGeo.boundingBox!;
    expect(tallBox.min.y).toBeLessThanOrEqual(-1.0);
    expect(shortBox.min.y).toBeLessThanOrEqual(-1.0);
    expect(tallBox.max.y).toBeGreaterThan(shortBox.max.y);
    expect(tallBox.max.x).toBeGreaterThan(shortBox.max.x);

    const tallGlassSize = new THREE.Vector3();
    const shortGlassSize = new THREE.Vector3();
    tallLong.glassGeo.boundingBox!.getSize(tallGlassSize);
    shortThick.glassGeo.boundingBox!.getSize(shortGlassSize);
    expect(shortGlassSize.x).toBeGreaterThan(tallGlassSize.x);
    expect(shortGlassSize.y).toBeGreaterThan(tallGlassSize.y);

    // Base post side vertices (pos.y < 0 within indices 0..23) scale proportionally by woodThicknessScale
    const tallPos = tallLong.bodyGeo.getAttribute('position') as THREE.BufferAttribute;
    const shortPos = shortThick.bodyGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < 24; v++) {
      if (tallPos.getY(v) < 0) {
        expect(Math.abs(tallPos.getX(v))).toBeCloseTo(0.215 * 0.8, 4);
        expect(Math.abs(tallPos.getZ(v))).toBeCloseTo(0.215 * 0.8, 4);
      }
      if (shortPos.getY(v) < 0) {
        expect(Math.abs(shortPos.getX(v))).toBeCloseTo(0.215 * 1.3, 4);
        expect(Math.abs(shortPos.getZ(v))).toBeCloseTo(0.215 * 1.3, 4);
      }
    }

    for (const g of [
      omitted.bodyGeo,
      omitted.glowGeo,
      omitted.glassGeo,
      explicitDefault.bodyGeo,
      explicitDefault.glowGeo,
      explicitDefault.glassGeo,
      tallLong.bodyGeo,
      tallLong.glowGeo,
      tallLong.glassGeo,
      shortThick.bodyGeo,
      shortThick.glowGeo,
      shortThick.glassGeo,
    ]) {
      g.dispose();
    }
  });

  it('registers aliases, shares single atlas/materials, flips single arm inward by side, enforces shadow/glass policies, and leaks 0 GPU resources', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();
    const mats = createSharedToonMaterials(gfx);
    const outlineMat = createSmoothOutlineMaterial(gfx);
    const assets = createProceduralMeshAssets(gfx);

    const registry = createDefaultLandmarkRegistry(gfx, mats, assets, outlineMat);
    const singleDef = registry.resolve('proc:lantern:single');
    const doubleDef = registry.resolve('proc:lantern:double');
    expect(singleDef).toBeDefined();
    expect(doubleDef).toBeDefined();
    expect(registry.resolve('proc:lantern')).toBe(singleDef);
    expect(registry.resolve('proc:arch:lantern_arch')).toBe(doubleDef);
    expect(registry.resolve('proc:arch')).toBe(doubleDef);

    const landmarkStreamer = new LandmarkStreamer(gfx, mats, assets, {
      outlineMaterial: outlineMat,
      registry,
    });
    scene.add(landmarkStreamer.rootGroup);

    const reqs: SegmentLandmarkRequirement[] = [
      {
        id: 'solo_left',
        kind: 'deliveryLandmark',
        segmentId: 1,
        s: 40,
        x: -10,
        worldX: -10,
        worldY: -10,
        worldZ: -40,
        yawRad: -0.35,
        clearanceRadius: 3.0,
        visual: DELIVERY_CHILD_SOLO.landmarkVisual,
      },
      {
        id: 'solo_right',
        kind: 'deliveryLandmark',
        segmentId: 1,
        s: 70,
        x: 10,
        worldX: 10,
        worldY: -17,
        worldZ: -70,
        yawRad: 0.35,
        clearanceRadius: 3.0,
        visual: DELIVERY_CHILD_SOLO.landmarkVisual,
      },
      {
        id: 'duo_left',
        kind: 'deliveryLandmark',
        segmentId: 1,
        s: 110,
        x: -11,
        worldX: -11,
        worldY: -27,
        worldZ: -110,
        yawRad: -0.35,
        clearanceRadius: 3.5,
        visual: DELIVERY_SLED_DUO.landmarkVisual,
      },
    ];
    const seg = createMockLanternSegment(1, 51, reqs);
    const window: TrailWindowView = { prev: null, curr: seg, nextLeft: null, nextRight: null };

    landmarkStreamer.sync(window);
    expect(landmarkStreamer.activeCount).toBe(3);

    const singleMaterials = new Set<THREE.Material>();
    const doubleMaterials = new Set<THREE.Material>();
    const glassMaterials = new Set<THREE.Material>();
    const bodyMeshes: THREE.Mesh[] = [];
    const outlineMeshes: THREE.Mesh[] = [];
    const glowMeshes: THREE.Mesh[] = [];
    const glassMeshes: THREE.Mesh[] = [];
    const singlePivots: Array<{ groupX: number; pivotRotY: number }> = [];

    landmarkStreamer.rootGroup.traverse((node) => {
      if (node.name.startsWith('PooledDeliveryLanternSingle_')) {
        const pivot = node.children[0];
        if (pivot) {
          singlePivots.push({ groupX: node.position.x, pivotRotY: pivot.rotation.y });
        }
      }
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      if (mesh.name.startsWith('LanternPostSingleBody_')) {
        bodyMeshes.push(mesh);
        singleMaterials.add(mesh.material as THREE.Material);
      } else if (mesh.name.startsWith('LanternPostDoubleBody_')) {
        bodyMeshes.push(mesh);
        doubleMaterials.add(mesh.material as THREE.Material);
      } else if (mesh.name.startsWith('LanternPost') && mesh.name.includes('Outline_')) {
        outlineMeshes.push(mesh);
      } else if (mesh.name.startsWith('LanternPost') && mesh.name.includes('Glow_')) {
        glowMeshes.push(mesh);
      } else if (mesh.name.startsWith('LanternPost') && mesh.name.includes('Glass_')) {
        glassMeshes.push(mesh);
        glassMaterials.add(mesh.material as THREE.Material);
      }
    });

    expect(bodyMeshes).toHaveLength(3);
    expect(outlineMeshes).toHaveLength(3);
    expect(glowMeshes).toHaveLength(3);
    expect(glassMeshes).toHaveLength(3);

    // Single and double variants share the exact same toon material/atlas and glass material
    expect(singleMaterials.size).toBe(1);
    expect(doubleMaterials.size).toBe(1);
    expect(Array.from(singleMaterials)[0]).toBe(Array.from(doubleMaterials)[0]);
    expect(glassMaterials.size).toBe(1);

    // Left-side single post faces +X (pivot.rotation.y = 0); right-side flips inward (Math.PI)
    const leftPivot = singlePivots.find((p) => p.groupX < 0);
    const rightPivot = singlePivots.find((p) => p.groupX > 0);
    expect(leftPivot?.pivotRotY).toBe(0);
    expect(rightPivot?.pivotRotY).toBeCloseTo(Math.PI, 6);

    // Updating lm.x on an active landmark re-configures side facing dynamically
    const flippedReqs: SegmentLandmarkRequirement[] = [
      { ...reqs[0]!, x: 10, worldX: 10 },
    ];
    landmarkStreamer.sync({
      prev: null,
      curr: createMockLanternSegment(1, 51, flippedReqs),
      nextLeft: null,
      nextRight: null,
    });
    const flippedObj = landmarkStreamer.rootGroup.children.find((c) =>
      c.name.startsWith('PooledDeliveryLanternSingle_'),
    );
    expect(flippedObj?.children[0]?.rotation.y).toBeCloseTo(Math.PI, 6);

    // Pool recycling check: release right-side single lantern to pool, then acquire on left side
    landmarkStreamer.clearAll();
    expect(landmarkStreamer.activeCount).toBe(0);
    landmarkStreamer.sync({
      prev: null,
      curr: createMockLanternSegment(2, 52, [{ ...reqs[0]!, id: 'recycled_left', x: -10, worldX: -10 }]),
      nextLeft: null,
      nextRight: null,
    });
    const recycledObj = landmarkStreamer.rootGroup.children.find((c) =>
      c.name.startsWith('PooledDeliveryLanternSingle_'),
    );
    expect(recycledObj?.name).toBe(flippedObj?.name);
    expect(recycledObj?.children[0]?.rotation.y).toBe(0);

    // Verify all 24 pooled instances (12 single + 12 double) share the exact same atlas texture & materials
    expect(tracker.getStats().cachedTextures).toBeGreaterThanOrEqual(1);
    const sharedToonMat = Array.from(singleMaterials)[0] as THREE.MeshToonMaterial;
    expect(tracker.getMaterialRefCount(sharedToonMat)).toBe(24);
    expect(tracker.getTextureRefCount(sharedToonMat.map!)).toBe(24);
    expect(tracker.getMaterialRefCount(Array.from(glassMaterials)[0]!)).toBe(24);

    // Restore initial window to verify all mesh policies cleanly
    landmarkStreamer.sync(window);
    for (const m of bodyMeshes) expect(m.castShadow).toBe(true);
    for (const m of outlineMeshes) expect(m.castShadow).toBe(false);
    for (const m of glowMeshes) expect(m.castShadow).toBe(false);
    for (const m of glassMeshes) {
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(false);
      expect(m.renderOrder).toBe(1);
      const gm = m.material as THREE.MeshBasicMaterial;
      expect(gm.transparent).toBe(true);
      expect(gm.depthWrite).toBe(false);
      expect(gm.side).toBe(THREE.DoubleSide);
      expect(gm.fog).toBe(false);
    }

    // Verify LayoutEngine produces both single and double lantern variants
    const stage = getStageDef('sunny-blue')!;
    const engine = new LayoutEngine(1337);
    const pools = new EntityPools();
    let sawSingle = false;
    let sawDouble = false;
    for (let segId = 1; segId <= 40 && !(sawSingle && sawDouble); segId++) {
      pools.clear();
      const tSeg = new TrailSegment({
        id: segId,
        slot: 'curr',
        stage,
        seed: segId * 97,
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
      engine.bakeSegment(tSeg, pools, 0.2);
      for (const lm of tSeg.landmarks) {
        if (lm.visual.kind === 'procedural' && lm.visual.preset === 'lantern') {
          if (lm.visual.variant === 'single') sawSingle = true;
          if (lm.visual.variant === 'double') sawDouble = true;
        }
      }
    }
    expect(sawSingle).toBe(true);
    expect(sawDouble).toBe(true);

    // Context restore & leak check
    expect(() => tracker.markAllForContextRestore()).not.toThrow();
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    landmarkStreamer.clearAll();
    tracker.disposeAll();
    const stats = tracker.getStats();
    expect(stats.activeObjects).toBe(0);
    expect(stats.cachedGeometries).toBe(0);
    expect(stats.cachedMaterials).toBe(0);
    expect(stats.cachedTextures).toBe(0);

    // Headless ThreeRenderer full lifecycle check
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
