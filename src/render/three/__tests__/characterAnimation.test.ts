import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getDeliveryZoneDef } from '../../../content/deliveryZones';
import { CHARACTER_SCALE_TUNING } from '../../../content/visibilityTuning';
import { hashCoords2DU32 } from '../../../core/rng';
import {
  CREATURE_PHASE_IDLE,
  CREATURE_PHASE_TELEGRAPH,
  createSurfaceSample,
  type ChunkRangeOut,
  type ReadonlySimState,
  type RibbonPointOut,
  type SpineFrameOut,
  type TerrainFieldView,
  type TerrainSegmentView,
} from '../../../sim/contracts';
import { createBillboardQuadGeometry, createCylindricalBillboardMaterial } from '../billboardMaterial';
import {
  CHARACTER_ATLAS_COLS,
  CHARACTER_ATLAS_FRAMES,
  CHARACTER_ATLAS_HEIGHT,
  CHARACTER_ATLAS_ROWS,
  CHARACTER_ATLAS_WIDTH,
  CHARACTER_CELL_PAD_PX,
  CHARACTER_CELL_SIZE,
  CHARACTER_SPRITE_STRIPS,
  CHILD_SHADOW_RADIUS_M,
  CHILD_SPRITE_BASE_HEIGHT_M,
  CHILD_SPRITE_BASE_WIDTH_M,
  CHILD_VARIANT_IDS,
  copyCanvasRegionToFlippedRgba,
  createCharacterSpriteAtlasTexture,
  type CharacterFrameName,
  type ChildVariantId,
} from '../characterSpriteAtlas';
import { ContactShadows } from '../contactShadows';
import { GraphicsTracker } from '../graphicsTracker';
import { GraphicsUtils } from '../graphicsUtils';
import { InstancePools } from '../instancePools';
import { createProceduralMeshAssets } from '../meshFactory';
import type { SceneryProvider } from '../sceneryCellStreamer';
import {
  applyVolumePreservingSquash,
  CHILD_CELEBRATION_DURATION_SEC,
  CHILD_CELEBRATION_HOP_COUNT,
  CHILD_CELEBRATION_STAGGER_SEC,
  CHILD_HOP_CONFIG,
  CHILD_SLOT_SPREAD_M,
  CHILD_VARIANT_ANIM_SETS,
  computeCameraRelativeFlipX,
  computeDeliveryChildPosition,
  computeDeliveryZoneHash,
  createBillboardAnimPose,
  evaluateBallisticHopPose,
  evaluateBearAnimPose,
  evaluateChildAnimPose,
  evaluateThreePhaseHop,
  resolveChildVariant,
  sampleSpriteAnimFrame,
  type BallisticHopConfig,
  type SpriteAnimClip,
  type ThreePhaseHopConfig,
} from '../spriteAnimation';
import { createSharedToonMaterials } from '../toonMaterials';

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

function decodeRgbaPng(pngBytes: Buffer): { width: number; height: number; rgba: Uint8Array } {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idatParts: Buffer[] = [];
  while (offset + 8 <= pngBytes.length) {
    const len = pngBytes.readUInt32BE(offset);
    const tag = pngBytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = pngBytes.subarray(offset + 8, offset + 8 + len);
    if (tag === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (tag === 'IDAT') {
      idatParts.push(data);
    } else if (tag === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const rgba = new Uint8Array(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    expect(filter).toBe(0);
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, rgba };
}

function createMinimalSimState(
  elapsedSec: number,
  celebratingTimerSec: number,
  withBear = false,
): ReadonlySimState {
  const seg: TerrainSegmentView = {
    id: 1,
    slot: 'curr',
    stageId: 'sunny-blue',
    seed: 1,
    length: 100,
    chunkLength: 50,
    chunkCount: 2,
    prevSegmentId: null,
    nextLeftId: null,
    nextRightId: null,
    fork: {
      hasFork: false,
      obstacleFreeStartS: 50,
      leftStageId: null,
      rightStageId: null,
      isForkChild: false,
      forkSide: 'none',
      innerWallRampLength: 25,
      seamNoseRadius: 1.5,
      seamWorldX: 0,
      seamWorldY: 0,
      seamWorldZ: -100,
      seamYawRad: 0,
    },
    landmarks: [],
    getChunkBounds(_i: number, out: ChunkRangeOut): void {
      out.startS = 0;
      out.endS = 50;
    },
    sampleSpineFrame(s: number, out: SpineFrameOut): void {
      out.posX = 0;
      out.posY = 0;
      out.posZ = -s;
      out.forwardX = 0;
      out.forwardY = 0;
      out.forwardZ = -1;
      out.rightX = 1;
      out.rightY = 0;
      out.rightZ = 0;
      out.yawRad = 0;
      out.pitchRad = 0;
      out.bankRad = 0;
      out.curvature = 0;
      out.halfWidth = 14;
      out.skirtWidth = 12;
      out.dividerHalfWidth = 0;
    },
    evaluateSurfaceAtX(s: number, x: number, out: RibbonPointOut): void {
      out.posX = x;
      out.posY = 0;
      out.posZ = -s;
      out.normalX = 0;
      out.normalY = 1;
      out.normalZ = 0;
      out.lateralX = x;
      out.halfWidth = 14;
      out.skirtWidth = 12;
      out.slopeDeg = 0;
      out.localHeight = 0;
      out.surfaceType = 'packed';
      out.inPlayableCorridor = true;
      out.inDivider = false;
      out.isInnerForkSlope = false;
    },
    sampleSafeX(): number {
      return 0;
    },
  };

  const emptyField: TerrainFieldView = {
    worldSeed: 1,
    originOffsetX: 0,
    originOffsetY: 0,
    originOffsetZ: 0,
    fieldRevision: 1,
    dirtyRects: [],
    stageIdTable: ['sunny-blue'],
    collectSpinesInBounds(_minX, _maxX, _minZ, _maxZ, _padM, out) {
      out.length = 0;
    },
    evaluateHeight() {
      return 0;
    },
    evaluateColumn(_wx, _wz, out) {
      return out;
    },
    evaluate(_wx, _wz, out) {
      out.normalX = 0;
      out.normalY = 1;
      out.normalZ = 0;
      return out;
    },
    evaluateSample(_wx, _wz, out) {
      return out;
    },
    sampleColumnGrid() {
      // Unused
    },
  };

  return {
    tickCount: 10,
    elapsedSec,
    distanceM: 10,
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
      velY: 0,
      velZ: -10,
      headingRad: 0,
      carveAngleRad: 0,
      pitchRad: 0,
      speed: 10,
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
      velY: 0,
      velZ: -10,
      headingRad: 0,
      carveAngleRad: 0,
      pitchRad: 0,
      speed: 10,
      groundY: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      grounded: true,
      braking: false,
      walking: false,
      walkPhaseRad: 0,
    },
    surfaceSample: { ...createSurfaceSample(), valid: true },
    wipeoutTimerSec: 0,
    wipeoutDurationSec: 1.2,
    invulnerableTimerSec: 0,
    invulnerableDurationSec: 1.5,
    prevCamera: {
      posX: 0,
      posY: 4,
      posZ: 10,
      lookAtX: 0,
      lookAtY: 0,
      lookAtZ: -10,
      rollRad: 0,
      minHorizontalFovDeg: 66,
      speedFovBoostDeg: 0,
    },
    currCamera: {
      posX: 0,
      posY: 4,
      posZ: 10,
      lookAtX: 0,
      lookAtY: 0,
      lookAtZ: -10,
      rollRad: 0,
      minHorizontalFovDeg: 66,
      speedFovBoostDeg: 0,
    },
    score: 0,
    highCombo: 0,
    comboCount: 0,
    comboMultiplier: 1,
    comboTimerSec: 0,
    comboDurationSec: 5,
    carriedCount: 0,
    maxCarryCapacity: 12,
    carriedPresentDefIds: [],
    deliveredTotal: 1,
    activeStageId: 'sunny-blue',
    activeWeather: {
      profileId: 'clear',
      blizzardEnabled: false,
      blizzardIntensity: 0,
      snowParticleCount: 0,
      windLateral: 0,
      fogDistanceM: 180,
      blizzardDim: 0,
    },
    trailWindow: { prev: null, curr: seg, nextLeft: null, nextRight: null },
    mountainField: emptyField,
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
        capacity: 1,
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
        capacity: 1,
        defIds: [],
        segmentIds: new Int32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        bobPhase: new Float32Array(0),
        collected: new Uint8Array(0),
      },
      tossedPresents: {
        count: 0,
        capacity: 1,
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
        count: 1,
        capacity: 1,
        defIds: ['sled_duo'],
        segmentIds: new Int32Array([1]),
        posX: new Float32Array([-5]),
        posY: new Float32Array([0]),
        posZ: new Float32Array([-20]),
        yawRad: new Float32Array([0]),
        radius: new Float32Array([8]),
        deliveredCount: new Uint8Array([celebratingTimerSec > 0 ? 2 : 0]),
        active: new Uint8Array([celebratingTimerSec > 0 ? 0 : 1]),
        celebratingTimer: new Float32Array([celebratingTimerSec]),
      },
      creatures: withBear
        ? {
            count: 2,
            capacity: 2,
            defIds: ['bear_patrol', 'bear_patrol'],
            segmentIds: new Int32Array([1, 1]),
            prevPosX: new Float32Array([2, -2]),
            prevPosY: new Float32Array([0, 0]),
            prevPosZ: new Float32Array([-30, -35]),
            posX: new Float32Array([4, -4]),
            posY: new Float32Array([0, 0]),
            posZ: new Float32Array([-30, -35]),
            normalX: new Float32Array([0, 0]),
            normalY: new Float32Array([1, 1]),
            normalZ: new Float32Array([0, 0]),
            prevHeadingRad: new Float32Array([-Math.PI * 0.5, Math.PI * 0.5]),
            headingRad: new Float32Array([-Math.PI * 0.5, Math.PI * 0.5]),
            groundY: new Float32Array([0, 0]),
            stateCode: new Uint8Array([CREATURE_PHASE_TELEGRAPH, CREATURE_PHASE_IDLE]),
            stateTimer: new Float32Array([0.5, 1.0]),
            telegraphProgress: new Float32Array([0.75, 0]),
            radius: new Float32Array([1.2, 1.2]),
          }
        : {
            count: 0,
            capacity: 1,
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
            stateCode: new Uint8Array(0),
            stateTimer: new Float32Array(0),
            telegraphProgress: new Float32Array(0),
            radius: new Float32Array(0),
          },
      skiTracks: {
        count: 0,
        capacity: 1,
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
        count: 0,
        capacity: 1,
        defIds: [],
        segmentIds: new Int32Array(0),
        posX: new Float32Array(0),
        posY: new Float32Array(0),
        posZ: new Float32Array(0),
        yawRad: new Float32Array(0),
        pitchRad: new Float32Array(0),
        width: new Float32Array(0),
        length: new Float32Array(0),
        height: new Float32Array(0),
      },
      structures: {
        count: 0,
        capacity: 1,
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
      skierPos: new Float32Array(3),
      skierNormal: new Float32Array([0, 1, 0]),
      skierDownhill: new Float32Array([0, 0, -1]),
      skierVelocity: new Float32Array(3),
    },
  };
}

describe('2.5D Character Sprite Atlas, Procedural Animation & Contact Shadows', () => {
  it('validates CHARACTER_ATLAS_FRAMES UV layout, CHARACTER_SPRITE_STRIPS, and all 4 padded/dilated 1024x256 RGBA child PNGs', () => {
    expect(CHARACTER_ATLAS_WIDTH).toBe(2048);
    expect(CHARACTER_ATLAS_HEIGHT).toBe(1024);
    expect(CHARACTER_ATLAS_COLS).toBe(8);
    expect(CHARACTER_ATLAS_ROWS).toBe(4);
    expect(CHARACTER_CELL_SIZE).toBe(256);
    expect(CHARACTER_CELL_PAD_PX).toBe(4);

    const entries = Object.entries(CHARACTER_ATLAS_FRAMES) as [
      CharacterFrameName,
      (typeof CHARACTER_ATLAS_FRAMES)[CharacterFrameName],
    ][];
    expect(entries).toHaveLength(18);

    const seenCells = new Set<string>();
    for (const [name, rect] of entries) {
      expect(rect.uOffset).toBeGreaterThanOrEqual(0);
      expect(rect.vOffset).toBeGreaterThanOrEqual(0);
      expect(rect.uScale).toBeGreaterThan(0);
      expect(rect.vScale).toBeGreaterThan(0);
      expect(rect.uOffset + rect.uScale).toBeLessThanOrEqual(1);
      expect(rect.vOffset + rect.vScale).toBeLessThanOrEqual(1);
      const key = `${rect.col},${rect.row}`;
      expect(seenCells.has(key), `duplicate cell for ${name}`).toBe(false);
      seenCells.add(key);
    }

    for (let i = 0; i < entries.length; i++) {
      const [nameA, a] = entries[i]!;
      for (let j = i + 1; j < entries.length; j++) {
        const [nameB, b] = entries[j]!;
        const overlapU = a.uOffset < b.uOffset + b.uScale && b.uOffset < a.uOffset + a.uScale;
        const overlapV = a.vOffset < b.vOffset + b.vScale && b.vOffset < a.vOffset + a.vScale;
        expect(overlapU && overlapV, `UV overlap between ${nameA} and ${nameB}`).toBe(false);
      }
    }

    expect(CHARACTER_SPRITE_STRIPS).toHaveLength(4);
    for (const strip of CHARACTER_SPRITE_STRIPS) {
      expect(strip.frameCount).toBe(4);
      expect(strip.col + strip.frameCount).toBeLessThanOrEqual(CHARACTER_ATLAS_COLS);
      expect(strip.row).toBeLessThan(CHARACTER_ATLAS_ROWS);
    }

    // Verify top-down -> WebGL bottom-up copy preserves dilated alpha===0 RGBs and aligns with vOffset
    const srcStrip = new Uint8ClampedArray(4 * 2 * 4);
    srcStrip[0] = 200;
    srcStrip[1] = 100;
    srcStrip[2] = 50;
    srcStrip[3] = 0;
    const dstAtlas = new Uint8Array(8 * 4 * 4);
    copyCanvasRegionToFlippedRgba(srcStrip, 4, 2, dstAtlas, 8, 4, 0, 0);
    const glIdx = (3 * 8 + 0) * 4;
    expect(dstAtlas[glIdx]).toBe(200);
    expect(dstAtlas[glIdx + 1]).toBe(100);
    expect(dstAtlas[glIdx + 2]).toBe(50);
    expect(dstAtlas[glIdx + 3]).toBe(0);

    // Non-zero strip offset (col=4, row=1 -> child_ochre) aligns with CHARACTER_ATLAS_FRAMES.child_ochre_idle_0
    const stripW = 1024;
    const stripH = 256;
    const ochreStrip = new Uint8ClampedArray(stripW * stripH * 4);
    // Bottom-left pixel inside padded inner cell (x=4, y=251)
    const ochrePx = (251 * stripW + 4) * 4;
    ochreStrip[ochrePx] = 212;
    ochreStrip[ochrePx + 1] = 155;
    ochreStrip[ochrePx + 2] = 44;
    ochreStrip[ochrePx + 3] = 255;
    const fullAtlas = new Uint8Array(CHARACTER_ATLAS_WIDTH * CHARACTER_ATLAS_HEIGHT * 4);
    copyCanvasRegionToFlippedRgba(
      ochreStrip,
      stripW,
      stripH,
      fullAtlas,
      CHARACTER_ATLAS_WIDTH,
      CHARACTER_ATLAS_HEIGHT,
      4 * CHARACTER_CELL_SIZE,
      1 * CHARACTER_CELL_SIZE,
    );
    const ochreRect = CHARACTER_ATLAS_FRAMES.child_ochre_idle_0;
    const texX = Math.round(ochreRect.uOffset * CHARACTER_ATLAS_WIDTH);
    const texY = Math.round(ochreRect.vOffset * CHARACTER_ATLAS_HEIGHT);
    const outOchreIdx = (texY * CHARACTER_ATLAS_WIDTH + texX) * 4;
    expect(fullAtlas[outOchreIdx]).toBe(212);
    expect(fullAtlas[outOchreIdx + 1]).toBe(155);
    expect(fullAtlas[outOchreIdx + 2]).toBe(44);
    expect(fullAtlas[outOchreIdx + 3]).toBe(255);

    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const atlas = createCharacterSpriteAtlasTexture(gfx);
    expect(atlas.isTexture).toBe(true);
    expect(atlas.colorSpace).toBe(THREE.SRGBColorSpace);
    tracker.disposeAll();
    expect(tracker.getStats().activeTextures).toBe(0);
    expect(tracker.getStats().cachedTextures).toBe(0);

    // Mocked-DOM async Image.onload upgrade & dispose cancellation verification
    const createdImgs: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
      naturalWidth: number;
      naturalHeight: number;
      src: string;
    }> = [];
    const origDoc = (globalThis as { document?: unknown }).document;
    const origImg = (globalThis as { Image?: unknown }).Image;
    try {
      (globalThis as { document: unknown }).document = {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({
            clearRect() {},
            drawImage() {},
            save() {},
            restore() {},
            beginPath() {},
            roundRect() {},
            arc() {},
            ellipse() {},
            moveTo() {},
            lineTo() {},
            closePath() {},
            fill() {},
            stroke() {},
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
            }),
          }),
        }),
      };
      (globalThis as { Image: unknown }).Image = class MockImage {
        decoding = 'async';
        naturalWidth = 1024;
        naturalHeight = 256;
        width = 1024;
        height = 256;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        private _src = '';
        get src(): string {
          return this._src;
        }
        set src(v: string) {
          this._src = v;
          createdImgs.push(this);
        }
      };

      const domTracker = new GraphicsTracker();
      const domGfx = new GraphicsUtils(domTracker);
      const domAtlas = createCharacterSpriteAtlasTexture(domGfx) as THREE.DataTexture;
      expect(createdImgs).toHaveLength(4);
      const verBefore = domAtlas.version;
      createdImgs[0]!.onload?.();
      expect(domAtlas.version).toBe(verBefore + 1);
      // Disposing cancels subsequent strip upgrades
      domTracker.disposeAll();
      const verAfterDispose = domAtlas.version;
      createdImgs[1]!.onload?.();
      expect(domAtlas.version).toBe(verAfterDispose);
    } finally {
      if (origDoc === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = origDoc;
      if (origImg === undefined) delete (globalThis as { Image?: unknown }).Image;
      else (globalThis as { Image?: unknown }).Image = origImg;
    }

    const assetChecks: ReadonlyArray<{ file: string; minBrightWhites: number; minWarmHighlights: number }> = [
      { file: 'childSprites.png', minBrightWhites: 4, minWarmHighlights: 35 },
      { file: 'childTealSprites.png', minBrightWhites: 2, minWarmHighlights: 70 },
      { file: 'childBlueSprites.png', minBrightWhites: 25, minWarmHighlights: 90 },
      { file: 'childOchreSprites.png', minBrightWhites: 20, minWarmHighlights: 40 },
    ];

    for (const asset of assetChecks) {
      const pngPath = path.resolve(__dirname, '..', 'assets', asset.file);
      expect(fs.existsSync(pngPath), `missing ${asset.file}`).toBe(true);
      const bytes = fs.readFileSync(pngPath);
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
      expect(bytes.readUInt32BE(16)).toBe(1024);
      expect(bytes.readUInt32BE(20)).toBe(256);
      expect(bytes[24]).toBe(8);
      expect(bytes[25]).toBe(6);

      const decoded = decodeRgbaPng(bytes);
      expect(decoded.width).toBe(1024);
      expect(decoded.height).toBe(256);

      let brightInteriorWhites = 0;
      let brightWarmHighlights = 0;
      for (let col = 0; col < 4; col++) {
        let opaqueCount = 0;
        let dilatedTransparentRgbCount = 0;
        const cellX0 = col * CHARACTER_CELL_SIZE;
        for (let ly = 0; ly < CHARACTER_CELL_SIZE; ly++) {
          for (let lx = 0; lx < CHARACTER_CELL_SIZE; lx++) {
            const i = (ly * decoded.width + (cellX0 + lx)) * 4;
            const r = decoded.rgba[i]!;
            const g = decoded.rgba[i + 1]!;
            const b = decoded.rgba[i + 2]!;
            const a = decoded.rgba[i + 3]!;
            const inPad =
              lx < CHARACTER_CELL_PAD_PX ||
              lx >= CHARACTER_CELL_SIZE - CHARACTER_CELL_PAD_PX ||
              ly < CHARACTER_CELL_PAD_PX ||
              ly >= CHARACTER_CELL_SIZE - CHARACTER_CELL_PAD_PX;
            if (inPad) {
              expect(a, `${asset.file} cell ${col} border (${lx},${ly}) must be transparent`).toBe(0);
            }
            if (a >= 128) opaqueCount++;
            if (a === 255 && r > 225 && g > 225 && b > 225) brightInteriorWhites++;
            if (a === 255 && r > 210 && g > 200 && b > 185) brightWarmHighlights++;
            if (a === 0 && (r > 0 || g > 0 || b > 0)) dilatedTransparentRgbCount++;
          }
        }
        expect(opaqueCount, `${asset.file} cell ${col} opaque count`).toBeGreaterThan(8000);
        expect(dilatedTransparentRgbCount, `${asset.file} cell ${col} dilation`).toBeGreaterThan(500);
      }
      expect(brightInteriorWhites, `${asset.file} white teeth/snowflakes/highlights preserved`).toBeGreaterThanOrEqual(
        asset.minBrightWhites,
      );
      expect(brightWarmHighlights, `${asset.file} interior light details preserved`).toBeGreaterThanOrEqual(
        asset.minWarmHighlights,
      );
    }
  });

  it('expands CylindricalBillboardMaterial GLSL cleanly with aUvRect and aTilt rotation', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const atlas = createCharacterSpriteAtlasTexture(gfx);
    const mat = createCylindricalBillboardMaterial(
      gfx,
      atlas,
      mats.sharedUniforms,
      false,
      'CharacterBillboardMaterial',
    );
    const msaaMat = createCylindricalBillboardMaterial(
      gfx,
      atlas,
      mats.sharedUniforms,
      true,
      'CharacterBillboardMaterialMsaa',
    );
    expect(mat.customProgramCacheKey()).toBe('cylindrical-billboard-v2');
    expect(msaaMat.customProgramCacheKey()).toBe('cylindrical-billboard-msaa-v2');

    const basicShader = THREE.ShaderLib.basic!;
    const mockShader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: basicShader.vertexShader,
      fragmentShader: basicShader.fragmentShader,
    };
    mat.onBeforeCompile(
      mockShader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );

    const expandedVert = expandThreeShaderIncludes(mockShader.vertexShader);
    const expandedFrag = expandThreeShaderIncludes(mockShader.fragmentShader);

    expect(expandedVert).not.toMatch(/#include\s+</);
    expect(expandedFrag).not.toMatch(/#include\s+</);
    const countChar = (s: string, ch: string): number => s.split(ch).length - 1;
    expect(countChar(expandedVert, '{')).toBe(countChar(expandedVert, '}'));
    expect(countChar(expandedFrag, '{')).toBe(countChar(expandedFrag, '}'));
    expect(countChar(expandedVert, '(')).toBe(countChar(expandedVert, ')'));
    expect(countChar(expandedFrag, '(')).toBe(countChar(expandedFrag, ')'));

    expect(expandedVert).toContain('attribute vec4 aUvRect;');
    expect(expandedVert).toContain('attribute float aTilt;');
    expect(expandedVert).toContain('bbRotX');
    expect(expandedVert).toContain('bbRotY');
    expect(expandedFrag).toContain('uniform vec3 uBiomeTint;');
    expect(expandedFrag).toContain('uniform float uBlizzardDim;');

    tracker.disposeAll();
  });

  it('samples flipbook frames deterministically across loop, once, pingpong, and NaN/overflow cases', () => {
    const loopClip: SpriteAnimClip<'a' | 'b' | 'c'> = { frames: ['a', 'b', 'c'], fps: 2, mode: 'loop' };
    expect(sampleSpriteAnimFrame(loopClip, -1)).toBe('a');
    expect(sampleSpriteAnimFrame(loopClip, Number.NaN)).toBe('a');
    expect(sampleSpriteAnimFrame(loopClip, 0)).toBe('a');
    expect(sampleSpriteAnimFrame(loopClip, 0.5)).toBe('b');
    expect(sampleSpriteAnimFrame(loopClip, 1.0)).toBe('c');
    expect(sampleSpriteAnimFrame(loopClip, 1.5)).toBe('a');
    expect(sampleSpriteAnimFrame(loopClip, Number.MAX_VALUE)).toBe('a');

    const onceClip: SpriteAnimClip<'a' | 'b' | 'c'> = { frames: ['a', 'b', 'c'], fps: 2, mode: 'once' };
    expect(sampleSpriteAnimFrame(onceClip, 0.1)).toBe('a');
    expect(sampleSpriteAnimFrame(onceClip, 0.6)).toBe('b');
    expect(sampleSpriteAnimFrame(onceClip, 10)).toBe('c');
    expect(sampleSpriteAnimFrame(onceClip, Number.MAX_VALUE)).toBe('c');

    const ping2: SpriteAnimClip<'a' | 'b'> = { frames: ['a', 'b'], fps: 1, mode: 'pingpong' };
    expect(
      [0, 1, 2, 3].map((t) => sampleSpriteAnimFrame(ping2, t)),
    ).toEqual(['a', 'b', 'a', 'b']);

    const ping3: SpriteAnimClip<'a' | 'b' | 'c'> = {
      frames: ['a', 'b', 'c'],
      fps: 1,
      mode: 'pingpong',
    };
    expect(
      [0, 1, 2, 3, 4, 5].map((t) => sampleSpriteAnimFrame(ping3, t)),
    ).toEqual(['a', 'b', 'c', 'b', 'a', 'b']);

    const single: SpriteAnimClip<'solo'> = { frames: ['solo'], fps: 4, mode: 'loop' };
    expect(sampleSpriteAnimFrame(single, 42)).toBe('solo');
  });

  it('evaluates C0-continuous 3-phase hops with volume preservation and alternating tilt', () => {
    const config: ThreePhaseHopConfig<'crouch' | 'up' | 'down' | 'land'> = {
      cycleDurationSec: 1.0,
      crouchEndRatio: 0.2,
      landStartRatio: 0.8,
      maxHopHeightM: 0.8,
      crouchSquashY: 0.85,
      takeoffStretchY: 1.15,
      landSquashY: 0.82,
      maxTiltRad: 0.1,
      crouchFrame: 'crouch',
      airUpFrame: 'up',
      airDownFrame: 'down',
      landFrame: 'land',
    };

    const pose = createBillboardAnimPose<'crouch' | 'up' | 'down' | 'land'>('crouch');

    evaluateThreePhaseHop(0.1, config, pose);
    expect(pose.frame).toBe('crouch');
    expect(pose.offsetY).toBe(0);
    expect(pose.scaleY).toBeCloseTo(0.85, 5);
    expect(pose.scaleX * pose.scaleX * pose.scaleY).toBeCloseTo(1, 5);

    const beforeTakeoff = createBillboardAnimPose<'crouch' | 'up' | 'down' | 'land'>('crouch');
    const atTakeoff = createBillboardAnimPose<'crouch' | 'up' | 'down' | 'land'>('crouch');
    evaluateThreePhaseHop(0.2 - 1e-5, config, beforeTakeoff);
    evaluateThreePhaseHop(0.2 + 1e-5, config, atTakeoff);
    expect(Math.abs(beforeTakeoff.offsetY - atTakeoff.offsetY)).toBeLessThan(1e-3);
    expect(Math.abs(beforeTakeoff.scaleY - atTakeoff.scaleY)).toBeLessThan(1e-3);
    expect(Math.abs(beforeTakeoff.tiltRad - atTakeoff.tiltRad)).toBeLessThan(1e-3);

    evaluateThreePhaseHop(0.5, config, pose);
    expect(pose.offsetY).toBeCloseTo(0.8, 5);
    expect(pose.frame).toBe('up');
    expect(pose.tiltRad).toBeGreaterThan(0.05);
    expect(pose.scaleX * pose.scaleX * pose.scaleY).toBeCloseTo(1, 5);

    evaluateThreePhaseHop(0.65, config, pose);
    expect(pose.frame).toBe('down');
    expect(pose.scaleX * pose.scaleX * pose.scaleY).toBeCloseTo(1, 5);

    const beforeLand = createBillboardAnimPose<'crouch' | 'up' | 'down' | 'land'>('crouch');
    const atLand = createBillboardAnimPose<'crouch' | 'up' | 'down' | 'land'>('crouch');
    evaluateThreePhaseHop(0.8 - 1e-5, config, beforeLand);
    evaluateThreePhaseHop(0.8 + 1e-5, config, atLand);
    expect(Math.abs(beforeLand.offsetY - atLand.offsetY)).toBeLessThan(1e-3);
    expect(Math.abs(beforeLand.scaleY - atLand.scaleY)).toBeLessThan(1e-3);

    evaluateThreePhaseHop(0.9, config, pose);
    expect(pose.frame).toBe('land');
    expect(pose.offsetY).toBe(0);
    expect(pose.scaleY).toBeCloseTo(0.82, 5);

    const poseCycle1 = createBillboardAnimPose<'crouch' | 'up' | 'down' | 'land'>('crouch');
    evaluateThreePhaseHop(1.5, config, poseCycle1);
    expect(poseCycle1.tiltRad).toBeLessThan(-0.05);

    const sqOut = { scaleX: 1, scaleY: 1 };
    applyVolumePreservingSquash(1.25, sqOut);
    expect(sqOut.scaleX * sqOut.scaleX * sqOut.scaleY).toBeCloseTo(1, 5);
  });

  it('animates all 4 child variants cleanly across idle and staggered 3-hop celebrations and resolves distinct zone siblings', () => {
    const pose = createBillboardAnimPose('child_idle_0');

    for (const variant of CHILD_VARIANT_IDS) {
      const animSet = CHILD_VARIANT_ANIM_SETS[variant];
      evaluateChildAnimPose(0.0, 0, 0, pose, false, variant);
      expect(pose.frame).toBe(animSet.idleClip.frames[0]);
      expect(pose.offsetY).toBe(0);

      evaluateChildAnimPose(0.45, 0, 0, pose, false, variant);
      expect(pose.frame).toBe(animSet.idleClip.frames[1]);
      expect(pose.offsetY).toBe(0);

      const apexElapsed = CHILD_HOP_CONFIG.cycleDurationSec * 0.52;
      evaluateChildAnimPose(2.0, CHILD_CELEBRATION_DURATION_SEC - apexElapsed, 0, pose, false, variant);
      expect(pose.frame).toBe(animSet.hopConfig.airUpFrame);
      expect(pose.offsetY).toBeGreaterThan(0.55);

      evaluateChildAnimPose(2.0, CHILD_CELEBRATION_DURATION_SEC - 0.05, 1, pose, false, variant);
      expect(pose.frame).toBe(animSet.hopConfig.crouchFrame);
      expect(pose.offsetY).toBe(0);
    }

    const apexElapsed = CHILD_HOP_CONFIG.cycleDurationSec * 0.52;
    evaluateChildAnimPose(2.0, CHILD_CELEBRATION_DURATION_SEC - apexElapsed, 0, pose, false);
    const unflippedTilt = pose.tiltRad;
    evaluateChildAnimPose(2.0, CHILD_CELEBRATION_DURATION_SEC - apexElapsed, 0, pose, true);
    expect(pose.tiltRad).toBeCloseTo(-unflippedTilt, 6);

    const totalWindow0 = CHILD_CELEBRATION_HOP_COUNT * CHILD_HOP_CONFIG.cycleDurationSec;
    const endElapsed2 = totalWindow0 + 2 * CHILD_CELEBRATION_STAGGER_SEC;
    expect(endElapsed2).toBeLessThan(CHILD_CELEBRATION_DURATION_SEC);

    for (let c = 0; c < 3; c++) {
      evaluateChildAnimPose(
        5.0,
        CHILD_CELEBRATION_DURATION_SEC - (endElapsed2 + 0.02),
        c,
        pose,
      );
      expect(pose.offsetY).toBe(0);
    }

    evaluateChildAnimPose(Number.NaN, Number.NaN, Number.NaN, pose);
    expect(Number.isFinite(pose.offsetY)).toBe(true);
    expect(Number.isFinite(pose.scaleX)).toBe(true);
    expect(Number.isFinite(pose.scaleY)).toBe(true);
    expect(Number.isFinite(pose.tiltRad)).toBe(true);

    // resolveChildVariant guarantees distinct siblings for c=0..3 across arbitrary hashes and honors explicit pins
    const observedSolo = new Set<ChildVariantId>();
    for (let h = 0; h < 64; h++) {
      const hash = hashCoords2DU32(h * 17, -h * 31, 0x517cc1b7);
      observedSolo.add(resolveChildVariant(undefined, 0, hash));
      const row = [
        resolveChildVariant(undefined, 0, hash),
        resolveChildVariant(undefined, 1, hash),
        resolveChildVariant(undefined, 2, hash),
        resolveChildVariant(undefined, 3, hash),
      ];
      expect(new Set(row).size).toBe(4);
    }
    expect(observedSolo.size).toBe(4);

    const pinnedZone = {
      ...getDeliveryZoneDef('village_plaza')!,
      childVisuals: [
        {
          kind: 'procedural' as const,
          preset: 'child' as const,
          palette: ['#000000'],
          variant: 'child_teal',
        },
        {
          kind: 'procedural' as const,
          preset: 'child' as const,
          palette: ['#000000'],
          variant: 'plaza_2',
        },
        {
          kind: 'procedural' as const,
          preset: 'child' as const,
          palette: ['#000000'],
          variant: 'plaza_3',
        },
      ],
    };
    for (let h = 0; h < 32; h++) {
      const pHash = hashCoords2DU32(h * 13, h * 7, 0x517cc1b7);
      const pv0 = resolveChildVariant(pinnedZone, 0, pHash);
      const pv1 = resolveChildVariant(pinnedZone, 1, pHash);
      const pv2 = resolveChildVariant(pinnedZone, 2, pHash);
      expect(pv0).toBe('teal');
      expect(new Set([pv0, pv1, pv2]).size).toBe(3);
    }
  });

  it('supports sim-driven ballistic hops, NaN-safe guards, sloped child placement, and camera-relative flipping', () => {
    const rabbitCfg: BallisticHopConfig<'idle_0' | 'idle_1' | 'crouch' | 'up' | 'down'> = {
      idleClip: { frames: ['idle_0', 'idle_1'], fps: 2, mode: 'loop' },
      crouchFrame: 'crouch',
      airUpFrame: 'up',
      airDownFrame: 'down',
      takeoffStretchY: 1.18,
      landSquashY: 0.84,
      maxTiltRad: 0.22,
      airborneThresholdM: 0.03,
    };
    const pose = createBillboardAnimPose<'idle_0' | 'idle_1' | 'crouch' | 'up' | 'down'>('idle_0');

    evaluateBallisticHopPose(0.1, 0, 0, 1, rabbitCfg, pose);
    expect(pose.frame).toBe('idle_0');
    expect(pose.tiltRad).toBe(0);

    evaluateBallisticHopPose(0.1, 0, 0, 1, rabbitCfg, pose, true, 0);
    expect(pose.frame).toBe('crouch');
    expect(pose.scaleY).toBeCloseTo(0.84, 5);
    expect(pose.scaleX * pose.scaleX * pose.scaleY).toBeCloseTo(1, 5);

    evaluateBallisticHopPose(0.1, 0, 0, 1, rabbitCfg, pose, false, 0.5);
    expect(pose.frame).toBe('crouch');
    expect(pose.scaleY).toBeCloseTo(0.92, 5);

    evaluateBallisticHopPose(0.2, 0.35, 4.5, 1, rabbitCfg, pose);
    expect(pose.frame).toBe('up');
    expect(pose.scaleY).toBeGreaterThan(1.05);
    expect(pose.scaleX * pose.scaleX * pose.scaleY).toBeCloseTo(1, 5);
    expect(pose.tiltRad).toBeGreaterThan(0);

    evaluateBallisticHopPose(0.4, 0.25, -4.5, 1, rabbitCfg, pose);
    expect(pose.frame).toBe('down');
    expect(pose.tiltRad).toBeLessThan(0);

    evaluateBallisticHopPose(0.2, 0.35, 4.5, -1, rabbitCfg, pose);
    expect(pose.tiltRad).toBeLessThan(0);

    evaluateBallisticHopPose(Number.NaN, 0.2, Number.NaN, Number.NaN, rabbitCfg, pose);
    expect(Number.isFinite(pose.tiltRad)).toBe(true);
    expect(Number.isFinite(pose.scaleY)).toBe(true);

    const bearPose = createBillboardAnimPose('bear_walk');
    evaluateBearAnimPose(Number.NaN, CREATURE_PHASE_TELEGRAPH, Number.NaN, 0, bearPose);
    expect(Number.isFinite(bearPose.offsetY)).toBe(true);
    expect(Number.isFinite(bearPose.scaleX)).toBe(true);
    expect(Number.isFinite(bearPose.tiltRad)).toBe(true);

    expect(computeCameraRelativeFlipX(-Math.PI * 0.5, 1, 0, false)).toBe(true);
    expect(computeCameraRelativeFlipX(Math.PI * 0.5, 1, 0, false)).toBe(false);
    expect(computeCameraRelativeFlipX(Math.PI, 0, 1, false)).toBe(true);
    expect(computeCameraRelativeFlipX(0, 0, 1, false)).toBe(false);
    expect(computeCameraRelativeFlipX(Math.PI, 0, 1, true)).toBe(false);

    const slopedField = {
      ...createMinimalSimState(0, 0).mountainField,
      evaluateHeight(wx: number, wz: number) {
        return wx * 0.5 - wz * 0.25;
      },
    };
    const outPos = { x: 0, y: 0, z: 0 };
    const yaw = Math.PI * 0.25;
    computeDeliveryChildPosition(10, 4, -20, yaw, 0, 2, slopedField, outPos);
    const spread0 = -0.5 * CHILD_SLOT_SPREAD_M;
    const expectedDx = Math.cos(yaw) * spread0;
    const expectedDz = -Math.sin(yaw) * spread0;
    expect(outPos.x).toBeCloseTo(10 + expectedDx, 5);
    expect(outPos.z).toBeCloseTo(-20 + expectedDz, 5);
    expect(outPos.y).toBeCloseTo(
      4 + (slopedField.evaluateHeight(10 + expectedDx, -20 + expectedDz) - slopedField.evaluateHeight(10, -20)),
      5,
    );
  });

  it('packs distinct child variants (rebase-invariant) and creatures into CharacterBillboardPool with reactive ContactShadows', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const outlineMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(outlineMat, 'TestOutline');
    const bbMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(bbMat, 'TestSceneryBb');
    const charMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(charMat, 'TestCharBb');
    const bbQuad = createBillboardQuadGeometry(gfx);
    const assets = createProceduralMeshAssets(gfx);

    const pools = new InstancePools(gfx, mats, outlineMat, bbMat, bbQuad, assets, charMat);
    const shadows = new ContactShadows(gfx);
    const emptyScenery: SceneryProvider = {
      sceneryRevision: 1,
      forEachActiveScenery() {
        // Empty
      },
    };

    const idleState = createMinimalSimState(2.0, 0, true);
    pools.sync(idleState, 0.5, emptyScenery);
    shadows.sync(idleState, 0.5);

    const dynPool = pools.rootGroup.getObjectByName('DynamicBillboardPool') as THREE.InstancedMesh;
    const charPool = pools.rootGroup.getObjectByName('CharacterBillboardPool') as THREE.InstancedMesh;
    expect(dynPool.count).toBe(0);
    expect(charPool.count).toBe(4); // 2 sled_duo children + 2 bears
    expect(shadows.instancedMesh.count).toBe(5); // 1 skier + 2 bears + 2 children

    const idleChild0Mat = new THREE.Matrix4();
    charPool.getMatrixAt(0, idleChild0Mat);
    const idleChild0Pos = new THREE.Vector3().setFromMatrixPosition(idleChild0Mat);
    expect(idleChild0Pos.y).toBeCloseTo(0, 5);

    const idleShadowMat = new THREE.Matrix4();
    const idleShadowScale = new THREE.Vector3();
    shadows.instancedMesh.getMatrixAt(3, idleShadowMat);
    idleShadowScale.setFromMatrixScale(idleShadowMat);
    const idleShadowAlpha = (
      shadows.instancedMesh.geometry.getAttribute('aShadowAlpha') as THREE.InstancedBufferAttribute
    ).getX(3);

    const bear0Mat = new THREE.Matrix4();
    charPool.getMatrixAt(2, bear0Mat);
    const bear0Pos = new THREE.Vector3().setFromMatrixPosition(bear0Mat);
    expect(bear0Pos.x).toBeCloseTo(3.0, 4);

    const uvAttr = charPool.geometry.getAttribute('aUvRect') as THREE.InstancedBufferAttribute;
    const tiltAttr = charPool.geometry.getAttribute('aTilt') as THREE.InstancedBufferAttribute;

    const bearTeleRect = CHARACTER_ATLAS_FRAMES.bear_telegraph;
    expect(uvAttr.getX(2)).toBeCloseTo(bearTeleRect.uOffset + bearTeleRect.uScale, 5);
    expect(uvAttr.getZ(2)).toBeCloseTo(-bearTeleRect.uScale, 5);

    const bearWalkRect = CHARACTER_ATLAS_FRAMES.bear_walk;
    expect(uvAttr.getX(3)).toBeCloseTo(bearWalkRect.uOffset, 5);
    expect(uvAttr.getZ(3)).toBeCloseTo(bearWalkRect.uScale, 5);
    expect(Math.abs(tiltAttr.getX(2))).toBeGreaterThan(0);

    const expectedBear0 = createBillboardAnimPose('bear_walk');
    const expectedBear1 = createBillboardAnimPose('bear_walk');
    evaluateBearAnimPose(2.0, CREATURE_PHASE_TELEGRAPH, 0.75, 0, expectedBear0, true);
    evaluateBearAnimPose(2.0, CREATURE_PHASE_IDLE, 0, 1, expectedBear1, false);
    expect(tiltAttr.getX(2)).toBeCloseTo(expectedBear0.tiltRad, 5);
    expect(tiltAttr.getX(3)).toBeCloseTo(expectedBear1.tiltRad, 5);

    // Celebrating state at celebElapsed = 0.42s (both child 0 and child 1 are airborne in hop 1)
    const celebTimer = CHILD_CELEBRATION_DURATION_SEC - 0.42;
    const celebState = createMinimalSimState(2.0, celebTimer, true);
    pools.sync(celebState, 1, emptyScenery);
    shadows.sync(celebState, 1);

    const celebChild0Mat = new THREE.Matrix4();
    charPool.getMatrixAt(0, celebChild0Mat);
    const celebChild0Pos = new THREE.Vector3().setFromMatrixPosition(celebChild0Mat);
    expect(celebChild0Pos.y).toBeGreaterThan(0.5);

    const zoneDef = getDeliveryZoneDef('sled_duo');
    const zHash = computeDeliveryZoneHash(-5, -20, 0, 0, 1);
    const v0 = resolveChildVariant(zoneDef, 0, zHash);
    const v1 = resolveChildVariant(zoneDef, 1, zHash);
    expect(v0).not.toBe(v1);

    const jumpRect0 = CHARACTER_ATLAS_FRAMES[CHILD_VARIANT_ANIM_SETS[v0].hopConfig.airUpFrame];
    const jumpRect1 = CHARACTER_ATLAS_FRAMES[CHILD_VARIANT_ANIM_SETS[v1].hopConfig.airUpFrame];

    expect(uvAttr.getX(0)).toBeCloseTo(jumpRect0.uOffset, 5);
    expect(uvAttr.getY(0)).toBeCloseTo(jumpRect0.vOffset, 5);
    expect(uvAttr.getZ(0)).toBeCloseTo(jumpRect0.uScale, 5);
    expect(uvAttr.getW(0)).toBeCloseTo(jumpRect0.vScale, 5);

    // Child 1 is distinct variant, horizontally mirrored (flipX = true), and tilts opposite to child 0
    expect(uvAttr.getX(1)).toBeCloseTo(jumpRect1.uOffset + jumpRect1.uScale, 5);
    expect(uvAttr.getY(1)).toBeCloseTo(jumpRect1.vOffset, 5);
    expect(uvAttr.getZ(1)).toBeCloseTo(-jumpRect1.uScale, 5);
    expect(uvAttr.getW(1)).toBeCloseTo(jumpRect1.vScale, 5);
    expect(tiltAttr.getX(0)).toBeGreaterThan(0.03);
    expect(tiltAttr.getX(1)).toBeLessThan(-0.03);

    // Verify floating-origin WORLD_REBASED with fractional non-power-of-two offsets preserves variant assignment
    const rebasedState: ReadonlySimState = {
      ...celebState,
      rebase: {
        ...celebState.rebase,
        rebaseCount: 1,
        offsetX: 37.4,
        offsetZ: -91.25,
      },
      entities: {
        ...celebState.entities,
        deliveryZones: {
          ...celebState.entities.deliveryZones,
          posX: new Float32Array([-5 - 37.4]),
          posZ: new Float32Array([-20 - -91.25]),
        },
      },
    };
    pools.sync(rebasedState, 1, emptyScenery);
    expect(uvAttr.getX(0)).toBeCloseTo(jumpRect0.uOffset, 5);
    expect(uvAttr.getY(0)).toBeCloseTo(jumpRect0.vOffset, 5);
    expect(uvAttr.getX(1)).toBeCloseTo(jumpRect1.uOffset + jumpRect1.uScale, 5);
    expect(uvAttr.getY(1)).toBeCloseTo(jumpRect1.vOffset, 5);

    // Verify 3-child village_plaza packs 3 distinct variants
    const plazaState: ReadonlySimState = {
      ...celebState,
      entities: {
        ...celebState.entities,
        creatures: { ...celebState.entities.creatures, count: 0 },
        deliveryZones: {
          ...celebState.entities.deliveryZones,
          defIds: ['village_plaza'],
        },
      },
    };
    pools.sync(plazaState, 1, emptyScenery);
    expect(charPool.count).toBe(3);
    const plazaUvOffsets = new Set([uvAttr.getY(0), uvAttr.getY(1), uvAttr.getY(2)]);
    const plazaUOffsets = new Set([
      Math.round((uvAttr.getZ(0) < 0 ? uvAttr.getX(0) + uvAttr.getZ(0) : uvAttr.getX(0)) * 2048),
      Math.round((uvAttr.getZ(1) < 0 ? uvAttr.getX(1) + uvAttr.getZ(1) : uvAttr.getX(1)) * 2048),
      Math.round((uvAttr.getZ(2) < 0 ? uvAttr.getX(2) + uvAttr.getZ(2) : uvAttr.getX(2)) * 2048),
    ]);
    expect(plazaUvOffsets.size + plazaUOffsets.size).toBeGreaterThanOrEqual(4);
    const pHash = computeDeliveryZoneHash(-5, -20, 0, 0, 1);
    const plazaDef = getDeliveryZoneDef('village_plaza');
    expect(
      new Set([
        resolveChildVariant(plazaDef, 0, pHash),
        resolveChildVariant(plazaDef, 1, pHash),
        resolveChildVariant(plazaDef, 2, pHash),
      ]).size,
    ).toBe(3);

    pools.sync(celebState, 1, emptyScenery);
    shadows.sync(celebState, 1);

    const celebShadowMat = new THREE.Matrix4();
    const celebShadowScale = new THREE.Vector3();
    shadows.instancedMesh.getMatrixAt(3, celebShadowMat);
    celebShadowScale.setFromMatrixScale(celebShadowMat);
    const celebShadowAlpha = (
      shadows.instancedMesh.geometry.getAttribute('aShadowAlpha') as THREE.InstancedBufferAttribute
    ).getX(3);

    expect(celebShadowScale.x).toBeLessThan(idleShadowScale.x);
    expect(celebShadowAlpha).toBeLessThan(idleShadowAlpha);

    tracker.disposeAll();
    expect(tracker.getStats().activeObjects).toBe(0);
    expect(tracker.getStats().activeGeometries).toBe(0);
    expect(tracker.getStats().activeMaterials).toBe(0);
  });

  it('applies parametric CharacterScaleTuning consistently across InstancePools and ContactShadows', () => {
    const tracker = new GraphicsTracker();
    const gfx = new GraphicsUtils(tracker);
    const mats = createSharedToonMaterials(gfx);
    const outlineMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(outlineMat, 'TestScaleOutline');
    const bbMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(bbMat, 'TestScaleSceneryBb');
    const charMat = new THREE.MeshBasicMaterial();
    gfx.markAsCache(charMat, 'TestScaleCharBb');
    const bbQuad = createBillboardQuadGeometry(gfx);
    const assets = createProceduralMeshAssets(gfx);

    const disabledScale = { ...CHARACTER_SCALE_TUNING, enabled: false };

    const scaledPools = new InstancePools(
      gfx,
      mats,
      outlineMat,
      bbMat,
      bbQuad,
      assets,
      charMat,
      CHARACTER_SCALE_TUNING,
    );
    const scaledShadows = new ContactShadows(gfx, CHARACTER_SCALE_TUNING);

    const legacyPools = new InstancePools(
      gfx,
      mats,
      outlineMat,
      bbMat,
      bbQuad,
      assets,
      charMat,
      disabledScale,
    );
    const legacyShadows = new ContactShadows(gfx, disabledScale);

    const emptyScenery: SceneryProvider = {
      sceneryRevision: 1,
      forEachActiveScenery() {
        // Empty
      },
    };

    const base = createMinimalSimState(0, 0, true);
    const farState: ReadonlySimState = {
      ...base,
      entities: {
        ...base.entities,
        deliveryZones: {
          ...base.entities.deliveryZones,
          posZ: new Float32Array([-45]),
        },
      },
    };

    scaledPools.sync(farState, 1, emptyScenery);
    scaledShadows.sync(farState, 1);
    legacyPools.sync(farState, 1, emptyScenery);
    legacyShadows.sync(farState, 1);

    const scaledCharPool = scaledPools.rootGroup.getObjectByName(
      'CharacterBillboardPool',
    ) as THREE.InstancedMesh;
    const legacyCharPool = legacyPools.rootGroup.getObjectByName(
      'CharacterBillboardPool',
    ) as THREE.InstancedMesh;

    const mScaled = new THREE.Matrix4();
    const sScaled = new THREE.Vector3();
    const pScaled = new THREE.Vector3();
    scaledCharPool.getMatrixAt(0, mScaled);
    mScaled.decompose(pScaled, new THREE.Quaternion(), sScaled);

    const mLegacy = new THREE.Matrix4();
    const sLegacy = new THREE.Vector3();
    const pLegacy = new THREE.Vector3();
    legacyCharPool.getMatrixAt(0, mLegacy);
    mLegacy.decompose(pLegacy, new THREE.Quaternion(), sLegacy);

    expect(sLegacy.x).toBeCloseTo(CHILD_SPRITE_BASE_WIDTH_M, 2);
    expect(sLegacy.y).toBeCloseTo(CHILD_SPRITE_BASE_HEIGHT_M, 2);
    expect(sScaled.x).toBeCloseTo(sLegacy.x * CHARACTER_SCALE_TUNING.childScale, 4);
    expect(sScaled.y).toBeCloseTo(sLegacy.y * CHARACTER_SCALE_TUNING.childScale, 4);

    // Child spread scales by childSlotSpreadScale and matches ContactShadows XZ position identically
    const mScaled1 = new THREE.Matrix4();
    const pScaled1 = new THREE.Vector3();
    scaledCharPool.getMatrixAt(1, mScaled1);
    pScaled1.setFromMatrixPosition(mScaled1);
    expect(pScaled1.x - pScaled.x).toBeCloseTo(
      CHILD_SLOT_SPREAD_M * CHARACTER_SCALE_TUNING.childSlotSpreadScale,
      4,
    );

    const shadowMat0 = new THREE.Matrix4();
    const shadowScale0 = new THREE.Vector3();
    const shadowPos0 = new THREE.Vector3();
    // Index 3 = child 0 shadow (0: skier, 1: bear0, 2: bear1, 3: child0)
    scaledShadows.instancedMesh.getMatrixAt(3, shadowMat0);
    shadowMat0.decompose(shadowPos0, new THREE.Quaternion(), shadowScale0);

    const legacyShadowMat0 = new THREE.Matrix4();
    const legacyShadowScale0 = new THREE.Vector3();
    legacyShadows.instancedMesh.getMatrixAt(3, legacyShadowMat0);
    legacyShadowScale0.setFromMatrixScale(legacyShadowMat0);

    expect(shadowPos0.x).toBeCloseTo(pScaled.x, 4);
    expect(shadowPos0.z).toBeCloseTo(pScaled.z, 4);
    expect(legacyShadowScale0.x).toBeCloseTo(CHILD_SHADOW_RADIUS_M, 4);
    expect(shadowScale0.x).toBeCloseTo(
      legacyShadowScale0.x * CHARACTER_SCALE_TUNING.childScale,
      4,
    );

    // Skier shadow scales by skierScale vs 0.95 when disabled
    const skierShadowScaledMat = new THREE.Matrix4();
    const skierShadowScaledScale = new THREE.Vector3();
    scaledShadows.instancedMesh.getMatrixAt(0, skierShadowScaledMat);
    skierShadowScaledScale.setFromMatrixScale(skierShadowScaledMat);

    const skierShadowLegacyMat = new THREE.Matrix4();
    const skierShadowLegacyScale = new THREE.Vector3();
    legacyShadows.instancedMesh.getMatrixAt(0, skierShadowLegacyMat);
    skierShadowLegacyScale.setFromMatrixScale(skierShadowLegacyMat);

    expect(skierShadowLegacyScale.x).toBeCloseTo(0.95, 4);
    expect(skierShadowScaledScale.x).toBeCloseTo(0.95 * CHARACTER_SCALE_TUNING.skierScale, 4);

    // Bear billboard & contact shadow both apply creatureScale consistently
    const bearScaledMat = new THREE.Matrix4();
    const bearScaledScale = new THREE.Vector3();
    scaledCharPool.getMatrixAt(2, bearScaledMat);
    bearScaledScale.setFromMatrixScale(bearScaledMat);

    const bearLegacyMat = new THREE.Matrix4();
    const bearLegacyScale = new THREE.Vector3();
    legacyCharPool.getMatrixAt(2, bearLegacyMat);
    bearLegacyScale.setFromMatrixScale(bearLegacyMat);

    const bearShadowScaledMat = new THREE.Matrix4();
    const bearShadowScaledScale = new THREE.Vector3();
    scaledShadows.instancedMesh.getMatrixAt(1, bearShadowScaledMat);
    bearShadowScaledScale.setFromMatrixScale(bearShadowScaledMat);

    const bearShadowLegacyMat = new THREE.Matrix4();
    const bearShadowLegacyScale = new THREE.Vector3();
    legacyShadows.instancedMesh.getMatrixAt(1, bearShadowLegacyMat);
    bearShadowLegacyScale.setFromMatrixScale(bearShadowLegacyMat);

    expect(bearScaledScale.x).toBeCloseTo(
      bearLegacyScale.x * CHARACTER_SCALE_TUNING.creatureScale,
      4,
    );
    expect(bearShadowScaledScale.x / bearShadowLegacyScale.x).toBeCloseTo(
      CHARACTER_SCALE_TUNING.creatureScale,
      4,
    );

    tracker.disposeAll();
  });
});
