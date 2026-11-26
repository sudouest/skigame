import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { degToRad, radToDeg } from '../../../core/math';
import type { CameraPose } from '../../../sim/contracts';
import { computeVerticalFovDeg, syncPerspectiveCamera } from '../cameraSync';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import {
  ALL_TREE_FRAMES,
  ATLAS_COLS,
  ATLAS_FRAMES,
  ATLAS_HEIGHT,
  ATLAS_ROWS,
  ATLAS_WIDTH,
  createCartoonSpriteAtlasTexture,
  dilateAtlasEdges,
  FROSTED_TREE_FRAMES,
  GREEN_TREE_FRAMES,
  TREE_FRAME_PROPORTIONS,
  type BillboardFrameName,
} from '../spriteAtlas';
import { createSharedToonMaterials } from '../toonMaterials';

describe('Responsive Camera Sync, Toon Materials, and 2.5D Atlas Dilation', () => {
  it('computes vertical FOV preserving minHorizontalFovDeg + speedFovBoostDeg on 9:16 portrait screens', () => {
    const minHFov = 66;
    const speedBoost = 8;
    const portraitAspect = 9 / 16;

    const vfovDeg = computeVerticalFovDeg(minHFov, speedBoost, portraitAspect);
    const effectiveHFovDeg = radToDeg(
      2 * Math.atan(Math.tan(degToRad(vfovDeg) * 0.5) * portraitAspect),
    );

    expect(effectiveHFovDeg).toBeCloseTo(minHFov + speedBoost, 2);
    expect(vfovDeg).toBeGreaterThan(95);

    const landscapeAspect = 16 / 9;
    const landscapeVfov = computeVerticalFovDeg(minHFov, speedBoost, landscapeAspect);
    const landscapeHFov = radToDeg(
      2 * Math.atan(Math.tan(degToRad(landscapeVfov) * 0.5) * landscapeAspect),
    );
    expect(landscapeHFov).toBeGreaterThanOrEqual(minHFov + speedBoost);
  });

  it('interpolates prevCamera -> currCamera with alpha', () => {
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 400);
    const prev: CameraPose = {
      posX: 0,
      posY: 4,
      posZ: 10,
      lookAtX: 0,
      lookAtY: 1,
      lookAtZ: -10,
      rollRad: 0,
      minHorizontalFovDeg: 64,
      speedFovBoostDeg: 0,
    };
    const curr: CameraPose = {
      posX: 4,
      posY: 6,
      posZ: 6,
      lookAtX: 2,
      lookAtY: 1,
      lookAtZ: -14,
      rollRad: 0.2,
      minHorizontalFovDeg: 64,
      speedFovBoostDeg: 10,
    };

    syncPerspectiveCamera(camera, prev, curr, 0.5, 9 / 16);
    expect(camera.position.x).toBeCloseTo(2, 5);
    expect(camera.position.y).toBeCloseTo(5, 5);
    expect(camera.position.z).toBeCloseTo(8, 5);
    expect(camera.fov).toBeCloseTo(computeVerticalFovDeg(64, 5, 9 / 16), 3);
  });

  it('dilates RGB border colors into transparent pixels while keeping alpha === 0', () => {
    const w = 5;
    const h = 5;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Single opaque bright red-orange pixel at center (2, 2)
    const center = (2 * w + 2) * 4;
    rgba[center] = 240;
    rgba[center + 1] = 80;
    rgba[center + 2] = 40;
    rgba[center + 3] = 255;

    dilateAtlasEdges(rgba, w, h, 2);

    // Adjacent transparent neighbor (1, 2) must inherit RGB without gaining alpha
    const neighbor = (2 * w + 1) * 4;
    expect(rgba[neighbor]).toBe(240);
    expect(rgba[neighbor + 1]).toBe(80);
    expect(rgba[neighbor + 2]).toBe(40);
    expect(rgba[neighbor + 3]).toBe(0);

    // Two-hop neighbor (0, 2) also receives dilated RGB after 2 passes with alpha = 0
    const hop2 = (2 * w + 0) * 4;
    expect(rgba[hop2]).toBe(240);
    expect(rgba[hop2 + 3]).toBe(0);
  });

  it('builds single 3x1 NearestFilter NoColorSpace toon gradientMap and headless atlas safely', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);

    const shared = createSharedToonMaterials(gfx);
    expect(shared.gradientMap.image.width).toBe(3);
    expect(shared.gradientMap.image.height).toBe(1);
    expect(shared.gradientMap.minFilter).toBe(THREE.NearestFilter);
    expect(shared.gradientMap.magFilter).toBe(THREE.NearestFilter);
    expect(shared.gradientMap.generateMipmaps).toBe(false);
    expect(shared.gradientMap.colorSpace).toBe(THREE.NoColorSpace);

    const atlas = createCartoonSpriteAtlasTexture(gfx);
    expect(atlas.isTexture).toBe(true);
    expect(atlas.colorSpace).toBe(THREE.SRGBColorSpace);

    expect(ATLAS_WIDTH).toBe(2048);
    expect(ATLAS_HEIGHT).toBe(1024);
    expect(ATLAS_COLS).toBe(8);
    expect(ATLAS_ROWS).toBe(4);
    const frames = Object.entries(ATLAS_FRAMES) as [BillboardFrameName, (typeof ATLAS_FRAMES)['pine_green']][];
    expect(frames.length).toBe(18);
    const seenCells = new Set<string>();
    for (const [name, rect] of frames) {
      expect(rect.uOffset).toBeGreaterThanOrEqual(0);
      expect(rect.vOffset).toBeGreaterThanOrEqual(0);
      expect(rect.uScale).toBeGreaterThan(0);
      expect(rect.vScale).toBeGreaterThan(0);
      expect(rect.uOffset + rect.uScale).toBeLessThanOrEqual(1);
      expect(rect.vOffset + rect.vScale).toBeLessThanOrEqual(1);
      const cellKey = `${rect.col},${rect.row}`;
      expect(seenCells.has(cellKey), `duplicate atlas cell on ${name}`).toBe(false);
      seenCells.add(cellKey);
    }
    for (let i = 0; i < frames.length; i++) {
      const [nameA, a] = frames[i]!;
      for (let j = i + 1; j < frames.length; j++) {
        const [nameB, b] = frames[j]!;
        const overlapU = a.uOffset < b.uOffset + b.uScale && b.uOffset < a.uOffset + a.uScale;
        const overlapV = a.vOffset < b.vOffset + b.vScale && b.vOffset < a.vOffset + a.vScale;
        expect(overlapU && overlapV, `UV overlap between ${nameA} and ${nameB}`).toBe(false);
      }
    }
    expect(ATLAS_FRAMES.alpine_rock.row).toBe(0);
    expect(ATLAS_FRAMES.rock_crag.row).toBe(0);

    expect(GREEN_TREE_FRAMES).toHaveLength(5);
    expect(FROSTED_TREE_FRAMES).toHaveLength(5);
    expect(ALL_TREE_FRAMES).toHaveLength(10);
    expect(new Set(ALL_TREE_FRAMES).size).toBe(10);

    for (const frame of ALL_TREE_FRAMES) {
      if (frame === 'pine_green' || frame === 'pine_frosted') continue;
      const prop = TREE_FRAME_PROPORTIONS[frame];
      expect(prop, `missing proportions for ${frame}`).toBeDefined();
      const rect = ATLAS_FRAMES[frame];
      const pixelAspect = (rect.uScale * ATLAS_WIDTH) / (rect.vScale * ATLAS_HEIGHT);
      expect(prop!.aspect).toBeCloseTo(pixelAspect, 5);
    }

    const pngPath = path.resolve(__dirname, '..', 'assets', 'treeSprites.png');
    expect(fs.existsSync(pngPath)).toBe(true);
    const pngBytes = fs.readFileSync(pngPath);
    expect(pngBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(pngBytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(pngBytes.readUInt32BE(16)).toBe(2048);
    expect(pngBytes.readUInt32BE(20)).toBe(512);
    expect(pngBytes[24]).toBe(8);
    expect(pngBytes[25]).toBe(6);

    tracker.disposeAll();
  });
});
