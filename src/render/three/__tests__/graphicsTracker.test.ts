import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ClipmapDataStore } from '../clipmapDataStore';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { SkyDome } from '../skyDome';
import { TerrainClipmap } from '../terrainClipmap';
import { bindClipmapStoreToMaterial, createSharedToonMaterials } from '../toonMaterials';

describe('GraphicsTracker & GraphicsUtils', () => {
  it('reference-counts shared Geometry, Material, and Texture across Mesh, InstancedMesh, Line, and Points', () => {
    let timeSec = 0;
    const tracker = new GraphicsTracker({ nowSec: () => timeSec });
    const gfx = new GraphicsUtils(tracker);

    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
    ]);
    const lineMat = new THREE.LineBasicMaterial();
    const ptsMat = new THREE.PointsMaterial();

    const mesh = gfx.createMesh(geo, mat, 'BoxA');
    const inst = gfx.createInstancedMesh(geo, mat, 4, 'BoxInst');
    const line = gfx.createLine(lineGeo, lineMat, 'LineA', true);
    const pts = gfx.createPoints(lineGeo, ptsMat, 'PtsA');

    expect(inst.frustumCulled).toBe(false);
    expect(tracker.getGeometryRefCount(geo)).toBe(2);
    expect(tracker.getMaterialRefCount(mat)).toBe(2);
    expect(tracker.getTextureRefCount(tex)).toBe(2);
    expect(tracker.getGeometryRefCount(lineGeo)).toBe(2);
    expect(tracker.getStats().activeObjects).toBe(4);

    // Disposing first mesh keeps shared geo/mat/tex alive
    gfx.disposeObject(mesh);
    expect(tracker.getGeometryRefCount(geo)).toBe(1);
    expect(tracker.getMaterialRefCount(mat)).toBe(1);
    expect(tracker.getTextureRefCount(tex)).toBe(1);
    expect(tracker.getStats().disposedGeometries).toBe(0);

    // Disposing second user drops refCount to 0 and disposes uncached geo/mat/tex
    gfx.disposeObject(inst);
    expect(tracker.getGeometryRefCount(geo)).toBe(0);
    expect(tracker.getMaterialRefCount(mat)).toBe(0);
    expect(tracker.getTextureRefCount(tex)).toBe(0);
    expect(tracker.getStats().disposedGeometries).toBe(1);
    expect(tracker.getStats().disposedMaterials).toBe(1);
    expect(tracker.getStats().disposedTextures).toBe(1);

    gfx.disposeObject(line);
    gfx.disposeObject(pts);
    expect(tracker.getStats().activeObjects).toBe(0);
    expect(tracker.getStats().activeGeometries).toBe(0);
    expect(tracker.getStats().activeMaterials).toBe(0);
    expect(tracker.getStats().activeTextures).toBe(0);
  });

  it('supports cloneObject, assignMaterial, assignGeometry, and markAsCache safely', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);

    const sharedTex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    const geoA = new THREE.BoxGeometry(1, 1, 1);
    const geoB = new THREE.SphereGeometry(0.5, 6, 4);
    const matA = new THREE.MeshBasicMaterial({ map: sharedTex });
    const matB = new THREE.MeshBasicMaterial({ map: sharedTex });

    const root = new THREE.Group();
    const child = gfx.createMesh(geoA, matA, 'ChildMesh');
    root.add(child);

    const cloned = gfx.cloneObject(root, 'ClonedRoot');
    const clonedChild = cloned.children[0] as THREE.Mesh;
    expect(clonedChild.geometry).toBe(geoA);
    expect(clonedChild.material).toBe(matA);
    expect(tracker.getGeometryRefCount(geoA)).toBe(2);
    expect(tracker.getMaterialRefCount(matA)).toBe(2);
    expect(tracker.getTextureRefCount(sharedTex)).toBe(2);

    // Assigning matB sharing sharedTex must NOT drop sharedTex refCount to 0 transiently
    gfx.assignMaterial(child, matB);
    expect(tracker.getMaterialRefCount(matA)).toBe(1);
    expect(tracker.getMaterialRefCount(matB)).toBe(1);
    expect(tracker.getTextureRefCount(sharedTex)).toBe(2);
    expect(tracker.getStats().disposedTextures).toBe(0);

    // Assigning geoB updates geometry refCounts
    gfx.assignGeometry(child, geoB);
    expect(tracker.getGeometryRefCount(geoA)).toBe(1);
    expect(tracker.getGeometryRefCount(geoB)).toBe(1);

    // Mark cloned hierarchy as cached: disposing root preserves cached resources
    gfx.markAsCache(cloned);
    gfx.disposeObject(cloned);
    expect(tracker.getStats().disposedGeometries).toBe(0);
    expect(tracker.isCached(geoA)).toBe(true);
    expect(tracker.isCached(matA)).toBe(true);
    expect(tracker.isCached(sharedTex)).toBe(true);

    gfx.disposeObject(root);
    tracker.disposeAll();
    expect(tracker.getStats().activeObjects).toBe(0);
    expect(tracker.getStats().cachedGeometries).toBe(0);
    expect(tracker.getStats().cachedMaterials).toBe(0);
    expect(tracker.getStats().cachedTextures).toBe(0);
  });

  it('detects detached object leaks after minAgeSec and untracked scene objects via checkLeaks', () => {
    let timeSec = 0;
    const tracker = new GraphicsTracker({ nowSec: () => timeSec });
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();

    const validGeo = new THREE.BoxGeometry(1, 1, 1);
    const validMat = new THREE.MeshBasicMaterial();
    const validMesh = gfx.createMesh(validGeo, validMat, 'ValidSceneMesh');
    scene.add(validMesh);

    const leakedGeo = new THREE.BoxGeometry(1, 1, 1);
    const leakedMat = new THREE.MeshBasicMaterial();
    const detachedMesh = gfx.createMesh(leakedGeo, leakedMat, 'DetachedLeak');

    // Too young (< minAgeSec = 20s) -> not flagged as detached leak yet
    timeSec = 10;
    const earlyReport = tracker.checkLeaks(20, true, scene);
    expect(earlyReport.totalLeaks).toBe(0);

    // Advance clock past minAgeSec -> detachedMesh flagged!
    timeSec = 25;
    const firstLeakReport = tracker.checkLeaks(20, false, scene);
    expect(firstLeakReport.detachedObjects).toHaveLength(1);
    expect(firstLeakReport.detachedObjects[0]?.label).toBe('DetachedLeak');
    expect(firstLeakReport.persistingAcrossSnapshots).toBe(0);

    // Two snapshot updates confirm persistence across snapshots
    tracker.checkLeaks(20, true, scene);
    const secondSnapshot = tracker.checkLeaks(20, true, scene);
    expect(secondSnapshot.persistingAcrossSnapshots).toBe(1);

    // Raw untracked mesh added directly to scene graph must be caught
    const rogue = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    rogue.name = 'RogueMesh';
    scene.add(rogue);

    const rogueReport = tracker.checkLeaks(20, false, scene);
    expect(rogueReport.untrackedSceneObjects).toEqual([
      { kind: 'Mesh', name: 'RogueMesh', type: 'Mesh' },
    ]);

    // Clean up
    scene.remove(rogue);
    rogue.geometry.dispose();
    rogue.material.dispose();
    gfx.disposeObject(detachedMesh);
    gfx.disposeObject(validMesh);
    tracker.disposeAll();
  });

  it('enforces that no production file in src/render/three/ bypasses GraphicsUtils', () => {
    const renderDir = path.resolve(__dirname, '..');
    const violations: string[] = [];
    const forbidden = /\bnew\s+THREE\.(Mesh|InstancedMesh|Line|LineSegments|LineLoop|Points)\s*\(/;

    const scanDir = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') {
            scanDir(fullPath);
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        if (fullPath === path.join(renderDir, 'graphicsUtils.ts')) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        if (forbidden.test(content)) {
          violations.push(path.relative(renderDir, fullPath));
        }
      }
    };

    scanDir(renderDir);
    expect(violations).toEqual([]);
  });

  it('tracks SkyDome through GraphicsUtils with cached resources and zero GPU leaks', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();

    const skyDome = new SkyDome(gfx, scene);
    expect(skyDome.mesh.renderOrder).toBe(-1000);
    expect(skyDome.mesh.frustumCulled).toBe(false);
    expect(skyDome.mesh.castShadow).toBe(false);
    expect(skyDome.mesh.receiveShadow).toBe(false);
    expect(skyDome.material.depthWrite).toBe(false);
    expect(tracker.isTracked(skyDome.mesh)).toBe(true);
    expect(tracker.isCached(skyDome.mesh.geometry)).toBe(true);
    expect(tracker.isCached(skyDome.material)).toBe(true);
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    skyDome.dispose();
    tracker.disposeAll();
    const stats = tracker.getStats();
    expect(stats.activeObjects).toBe(0);
    expect(stats.activeGeometries).toBe(0);
    expect(stats.activeMaterials).toBe(0);
    expect(stats.cachedGeometries).toBe(0);
    expect(stats.cachedMaterials).toBe(0);
  });

  it('tracks ClipmapDataStore 4 DataArrayTextures and TerrainClipmap InstancedMesh with zero GPU leaks across reset, restore, and dispose', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const scene = new THREE.Scene();

    const shared = createSharedToonMaterials(gfx);
    const store = new ClipmapDataStore(gfx);
    bindClipmapStoreToMaterial(gfx, shared, store);
    const clipmap = new TerrainClipmap(gfx, shared.terrainMaterial, shared.clipmapUniforms);
    scene.add(clipmap.mesh);

    expect(clipmap.mesh.isInstancedMesh).toBe(true);
    expect(clipmap.mesh.frustumCulled).toBe(false);
    expect(clipmap.mesh.receiveShadow).toBe(true);
    expect(clipmap.mesh.castShadow).toBe(false);

    expect(tracker.isTracked(clipmap.mesh)).toBe(true);
    expect(tracker.isCached(clipmap.geometry)).toBe(true);
    expect(tracker.isCached(shared.terrainMaterial)).toBe(true);
    expect(tracker.isCached(store.heightTex)).toBe(true);
    expect(tracker.isCached(store.normalMaskTex)).toBe(true);
    expect(tracker.isCached(store.albedoTex)).toBe(true);
    expect(tracker.isCached(store.flowElevTex)).toBe(true);

    expect(tracker.getTextureRefCount(store.heightTex)).toBe(1);
    expect(tracker.getTextureRefCount(store.normalMaskTex)).toBe(1);
    expect(tracker.getTextureRefCount(store.albedoTex)).toBe(1);
    expect(tracker.getTextureRefCount(store.flowElevTex)).toBe(1);
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    // Reset + simulated context restore must not leak or duplicate tracked resources
    store.reset();
    store.handleContextRestored(null);
    expect(tracker.checkLeaks(0, true, scene).totalLeaks).toBe(0);

    clipmap.dispose();
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
});
