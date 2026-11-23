import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { degToRad, radToDeg } from '../../../core/math';
import type { CameraPose } from '../../../sim/contracts';
import { computeVerticalFovDeg, syncPerspectiveCamera } from '../cameraSync';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { createCartoonSpriteAtlasTexture, dilateAtlasEdges } from '../spriteAtlas';
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

    tracker.disposeAll();
  });
});
