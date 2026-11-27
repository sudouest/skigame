import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  OUTLINE_VISIBILITY_TUNING,
  PORTRAIT_FOV_TUNING,
} from '../../../content/visibilityTuning';
import { degToRad, radToDeg } from '../../../core/math';
import type { CameraPose } from '../../../sim/contracts';
import { computeVerticalFovDeg, syncPerspectiveCamera } from '../cameraSync';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { createSmoothOutlineMaterial, syncOutlineMaterialForAspect } from '../outlineShader';
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
  it('caps portrait VFOV smoothly by default while preserving Hor+ framing on landscape and legacy mode when disabled', () => {
    const minHFov = 72;
    const speedBoost = 10;
    const portraitAspect = 9 / 16;
    const tallPhoneAspect = 9 / 19.5;

    // 1. Default aspect-aware portrait mode caps wide-angle miniaturization & responds to speed boost
    const vfovIdle = computeVerticalFovDeg(minHFov, 0, portraitAspect);
    const vfovFast = computeVerticalFovDeg(minHFov, speedBoost, portraitAspect);
    const vfovTallPhone = computeVerticalFovDeg(minHFov, 0, tallPhoneAspect);
    expect(vfovIdle).toBeCloseTo(PORTRAIT_FOV_TUNING.maxBaseVerticalFovDeg, 2);
    expect(vfovFast).toBeGreaterThan(vfovIdle);
    expect(vfovFast).toBeLessThanOrEqual(PORTRAIT_FOV_TUNING.hardMaxVerticalFovDeg);
    expect(vfovTallPhone).toBeCloseTo(PORTRAIT_FOV_TUNING.maxBaseVerticalFovDeg, 2);

    // 2. Landscape 16:9 stays Hor+ and obeys base minimum vertical FOV
    const landscapeAspect = 16 / 9;
    const landscapeVfov = computeVerticalFovDeg(minHFov, speedBoost, landscapeAspect);
    const landscapeHFov = radToDeg(
      2 * Math.atan(Math.tan(degToRad(landscapeVfov) * 0.5) * landscapeAspect),
    );
    expect(landscapeHFov).toBeGreaterThanOrEqual(minHFov + speedBoost);
    expect(landscapeVfov).toBeGreaterThanOrEqual(PORTRAIT_FOV_TUNING.baseMinVerticalFovDeg);

    // 3. Disabling portrait FOV cap restores exact legacy Hor+ math
    const legacyTuning = { ...PORTRAIT_FOV_TUNING, enabled: false };
    const legacyVfov = computeVerticalFovDeg(66, 8, portraitAspect, legacyTuning);
    const legacyEffectiveHFov = radToDeg(
      2 * Math.atan(Math.tan(degToRad(legacyVfov) * 0.5) * portraitAspect),
    );
    expect(legacyEffectiveHFov).toBeCloseTo(66 + 8, 2);
    expect(legacyVfov).toBeGreaterThan(95);

    // 4. Edge-case sanitization: NaN / <= 0 aspect, negative speedBoost, out-of-range clamp bounds
    expect(computeVerticalFovDeg(72, -10, portraitAspect)).toBeCloseTo(
      computeVerticalFovDeg(72, 0, portraitAspect),
      5,
    );
    expect(computeVerticalFovDeg(72, -10, 16 / 9)).toBeGreaterThanOrEqual(
      PORTRAIT_FOV_TUNING.baseMinVerticalFovDeg,
    );
    expect(Number.isFinite(computeVerticalFovDeg(72, 0, 0))).toBe(true);
    expect(Number.isFinite(computeVerticalFovDeg(72, 0, Number.NaN))).toBe(true);
    const extremeBounds = computeVerticalFovDeg(72, 20, portraitAspect, {
      ...PORTRAIT_FOV_TUNING,
      minVerticalFovDeg: -10,
      hardMaxVerticalFovDeg: 220,
    });
    expect(extremeBounds).toBeGreaterThanOrEqual(1);
    expect(extremeBounds).toBeLessThanOrEqual(175);

    const safeCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 400);
    const poseZero: CameraPose = {
      posX: 0,
      posY: 4,
      posZ: 10,
      lookAtX: 0,
      lookAtY: 1,
      lookAtZ: -10,
      rollRad: 0,
      minHorizontalFovDeg: 72,
      speedFovBoostDeg: 0,
    };
    syncPerspectiveCamera(safeCam, poseZero, poseZero, 1, Number.NaN);
    expect(Number.isFinite(safeCam.aspect) && safeCam.aspect > 0).toBe(true);
    expect(Number.isFinite(safeCam.fov)).toBe(true);
    syncPerspectiveCamera(safeCam, poseZero, poseZero, 1, 0);
    expect(safeCam.aspect).toBeCloseTo(16 / 9, 5);
  });

  it('scales smooth-normal outline uniforms idempotently for portrait aspects and resets cleanly when disabled', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mat = createSmoothOutlineMaterial(gfx, {
      outlineWidth: 0.045,
      minClipOffset: 0.0025,
      maxClipOffset: 0.016,
    });

    const landscapeScale = syncOutlineMaterialForAspect(mat, 16 / 9);
    expect(landscapeScale).toBeCloseTo(1.0, 5);
    expect(mat.uniforms.uOutlineWidth!.value).toBeCloseTo(0.045, 6);
    expect(mat.uniforms.uMinClipOffset!.value).toBeCloseTo(0.0025, 6);
    expect(mat.uniforms.uMaxClipOffset!.value).toBeCloseTo(0.016, 6);

    const portraitScale = syncOutlineMaterialForAspect(mat, 9 / 19.5);
    expect(portraitScale).toBeGreaterThan(1.3);
    const widthAfterFirst = mat.uniforms.uOutlineWidth!.value as number;
    expect(widthAfterFirst).toBeCloseTo(0.045 * portraitScale, 6);
    expect(mat.uniforms.uMaxClipOffset!.value).toBeLessThanOrEqual(
      OUTLINE_VISIBILITY_TUNING.maxClipOffsetCeiling,
    );

    // Repeated resize calls must remain strictly idempotent (never compound)
    syncOutlineMaterialForAspect(mat, 9 / 19.5);
    expect(mat.uniforms.uOutlineWidth!.value).toBeCloseTo(widthAfterFirst, 6);

    // Invalid aspect values stay finite at 1.0x base outline scale
    expect(syncOutlineMaterialForAspect(mat, Number.NaN)).toBe(1.0);
    expect(syncOutlineMaterialForAspect(mat, -1)).toBe(1.0);

    // Disabling outline portrait scaling restores base uniform values cleanly
    const disabledScale = syncOutlineMaterialForAspect(mat, 9 / 19.5, {
      ...OUTLINE_VISIBILITY_TUNING,
      enabled: false,
    });
    expect(disabledScale).toBe(1.0);
    expect(mat.uniforms.uOutlineWidth!.value).toBeCloseTo(0.045, 6);
    expect(mat.uniforms.uMinClipOffset!.value).toBeCloseTo(0.0025, 6);
    expect(mat.uniforms.uMaxClipOffset!.value).toBeCloseTo(0.016, 6);

    tracker.disposeAll();
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
