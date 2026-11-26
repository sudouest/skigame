import * as THREE from 'three';
import type { EventBus, Unsubscribe } from '../../core/eventBus';
import type { Profiler } from '../../core/profiler';
import type { ReadonlySimState, SimEvents } from '../../sim/contracts';
import { BackpackStack } from './backpackStack';
import { createBillboardQuadGeometry, createCylindricalBillboardMaterial } from './billboardMaterial';
import { computeVerticalFovDeg, syncPerspectiveCamera } from './cameraSync';
import { CarveSprayVfx } from './carveSprayVfx';
import {
  ClipmapDataStore,
  DEFAULT_CLIPMAP_STREAM_BUDGET_MS,
} from './clipmapDataStore';
import { ContactShadows } from './contactShadows';
import { DebugOverlay3D } from './debugOverlay';
import {
  GraphicsTracker,
  type GraphicsTrackerStats,
  type LeakReport,
} from './graphicsTracker';
import { GraphicsUtils } from './graphicsUtils';
import { InstancePools } from './instancePools';
import { LandmarkStreamer } from './landmarkStreamer';
import { createProceduralMeshAssets } from './meshFactory';
import { createSmoothOutlineMaterial } from './outlineShader';
import { SceneryCellStreamer } from './sceneryCellStreamer';
import { SkierRig } from './skierRig';
import { SkiTracks } from './skiTracks';
import { SkyDome } from './skyDome';
import { SnowVfx } from './snowVfx';
import { createCartoonSpriteAtlasTexture } from './spriteAtlas';
import { TerrainClipmap } from './terrainClipmap';
import {
  bindClipmapStoreToMaterial,
  createSharedToonMaterials,
  NOISE_ORIGIN_MOD_PERIOD,
  positiveMod,
  type SharedLightingUniforms,
  type SharedToonMaterials,
} from './toonMaterials';
import { TossedPresents } from './tossedPresents';

export const CAMERA_NEAR_M = 0.25;
export const CAMERA_FAR_M = 750;
export const DEFAULT_TERRAIN_STREAM_BUDGET_MS = 5;

const SHADOW_MAP_SIZE = 1024;
const SHADOW_HALF_WIDTH_M = 48;
const SHADOW_HALF_HEIGHT_M = 56;
const SHADOW_FORWARD_BIAS_M = 28;
const SHADOW_VERTICAL_BIAS_M = -6;
const SHADOW_LIGHT_DISTANCE_M = 110;
const SHADOW_CAMERA_NEAR_M = 10;
const SHADOW_CAMERA_FAR_M = 260;
const SHADOW_TEXEL_WORLD_X = (SHADOW_HALF_WIDTH_M * 2) / SHADOW_MAP_SIZE;
const SHADOW_TEXEL_WORLD_Y = (SHADOW_HALF_HEIGHT_M * 2) / SHADOW_MAP_SIZE;

// Fixed orthonormal light-camera basis matching THREE.Object3D.lookAt with up = (0, 1, 0)
const _sunLen = Math.hypot(35, 65, 40);
const LIGHT_BACK_X = 35 / _sunLen;
const LIGHT_BACK_Y = 65 / _sunLen;
const LIGHT_BACK_Z = 40 / _sunLen;
// lightRight = normalize(cross((0, 1, 0), lightBack)) = normalize(lightBack.z, 0, -lightBack.x)
const _rightLen = Math.hypot(LIGHT_BACK_Z, LIGHT_BACK_X);
const LIGHT_RIGHT_X = LIGHT_BACK_Z / _rightLen;
const LIGHT_RIGHT_Y = 0;
const LIGHT_RIGHT_Z = -LIGHT_BACK_X / _rightLen;
// lightUp = cross(lightBack, lightRight)
const LIGHT_UP_X = LIGHT_BACK_Y * LIGHT_RIGHT_Z - LIGHT_BACK_Z * LIGHT_RIGHT_Y;
const LIGHT_UP_Y = LIGHT_BACK_Z * LIGHT_RIGHT_X - LIGHT_BACK_X * LIGHT_RIGHT_Z;
const LIGHT_UP_Z = LIGHT_BACK_X * LIGHT_RIGHT_Y - LIGHT_BACK_Y * LIGHT_RIGHT_X;

export interface ThreeRendererOptions {
  readonly maxPixelRatio?: number;
  readonly initialWidth?: number;
  readonly initialHeight?: number;
  readonly headless?: boolean;
  readonly nowSec?: () => number;
  readonly nowMs?: () => number;
  readonly assetWaiter?: (modelId: string) => Promise<void> | null;
}

export interface ThreeRendererStats {
  readonly graphics: GraphicsTrackerStats;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly activeChunks: number;
  readonly queuedChunks: number;
  readonly contextLost: boolean;
}

/**
 * Facade for the mixed 3D low-poly toon + 2.5D cylindrical billboard + 1-draw-call CDLOD
 * clipmap Three.js renderer. Reads `ReadonlySimState` and subscribes to `EventBus<SimEvents>`
 * without mutating simulation state.
 */
export class ThreeRenderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly tracker: GraphicsTracker;
  readonly gfx: GraphicsUtils;
  readonly clipmapStore: ClipmapDataStore;
  readonly terrainClipmap: TerrainClipmap;
  readonly sceneryStreamer: SceneryCellStreamer;
  readonly landmarkStreamer: LandmarkStreamer;
  readonly skyDome: SkyDome;
  readonly carveSprayVfx: CarveSprayVfx;
  readonly dirLight: THREE.DirectionalLight;

  private readonly nowMs: () => number;
  private readonly container: HTMLElement | null;
  private readonly profiler: Profiler | undefined;
  private readonly maxPixelRatio: number;
  private readonly renderer: THREE.WebGLRenderer | null;

  private readonly sharedMaterials: SharedToonMaterials;
  private readonly outlineMaterial: THREE.ShaderMaterial;
  private readonly billboardAtlas: THREE.Texture;
  private readonly billboardMaterial: THREE.MeshBasicMaterial;

  private readonly hemiLight: THREE.HemisphereLight;
  private readonly skierRig: SkierRig;
  private readonly backpackStack: BackpackStack;
  private readonly instancePools: InstancePools;
  private readonly tossedPresents: TossedPresents;
  private readonly contactShadows: ContactShadows;
  private readonly skiTracks: SkiTracks;
  private readonly snowVfx: SnowVfx;
  private readonly debugOverlay: DebugOverlay3D;

  private readonly unsubscribers: Unsubscribe[] = [];
  private viewportWidth: number;
  private viewportHeight: number;
  private aspect: number;
  private lastMinHFovDeg = 66;
  private lastSpeedFovBoostDeg = 0;
  private lastRebaseCount = 0;
  private lastOriginOffsetX = 0;
  private lastOriginOffsetY = 0;
  private lastOriginOffsetZ = 0;
  private lastTickCount = -1;
  private contextLost = false;
  private disposed = false;

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.handleContextRestored();
  };

  constructor(
    container: HTMLElement | null,
    eventBus: EventBus<SimEvents>,
    profiler?: Profiler,
    options: ThreeRendererOptions = {},
  ) {
    this.container = container;
    this.profiler = profiler;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.maxPixelRatio = options.maxPixelRatio ?? 2;

    this.viewportWidth = Math.max(1, options.initialWidth ?? container?.clientWidth ?? 1280);
    this.viewportHeight = Math.max(1, options.initialHeight ?? container?.clientHeight ?? 720);
    this.aspect = this.viewportWidth / this.viewportHeight;

    this.tracker = new GraphicsTracker({ nowSec: options.nowSec });
    this.gfx = new GraphicsUtils(this.tracker);
    this.scene = new THREE.Scene();

    const initialVfov = computeVerticalFovDeg(this.lastMinHFovDeg, 0, this.aspect);
    this.camera = new THREE.PerspectiveCamera(initialVfov, this.aspect, CAMERA_NEAR_M, CAMERA_FAR_M);

    const canCreateWebGL =
      !options.headless && container !== null && typeof document !== 'undefined';

    if (canCreateWebGL) {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
      });
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      this.renderer.setPixelRatio(Math.min(dpr, this.maxPixelRatio));
      this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.NoToneMapping;
      // 1-tap BasicShadowMap avoids the 17-tap PCFShadowMap mobile bottleneck in three@0.181.0.
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.BasicShadowMap;
      this.renderer.shadowMap.autoUpdate = true;

      const canvas = this.renderer.domElement;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.appendChild(canvas);

      canvas.addEventListener('webglcontextlost', this.onContextLost, false);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    } else {
      this.renderer = null;
    }

    const antialiasEnabled = Boolean(this.renderer?.getContextAttributes()?.antialias === true);

    // Lighting + mobile-friendly 1024x1024 texel-snapped directional shadow camera
    this.hemiLight = new THREE.HemisphereLight('#bce0fd', '#72a3d4', 0.85);
    this.dirLight = new THREE.DirectionalLight('#fff6d6', 1.15);
    this.dirLight.position.set(
      LIGHT_BACK_X * SHADOW_LIGHT_DISTANCE_M,
      LIGHT_BACK_Y * SHADOW_LIGHT_DISTANCE_M,
      LIGHT_BACK_Z * SHADOW_LIGHT_DISTANCE_M,
    );
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.dirLight.shadow.intensity = 0.72;
    this.dirLight.shadow.bias = -0.0008;
    this.dirLight.shadow.normalBias = 0.08;
    this.dirLight.shadow.camera.left = -SHADOW_HALF_WIDTH_M;
    this.dirLight.shadow.camera.right = SHADOW_HALF_WIDTH_M;
    this.dirLight.shadow.camera.top = SHADOW_HALF_HEIGHT_M;
    this.dirLight.shadow.camera.bottom = -SHADOW_HALF_HEIGHT_M;
    this.dirLight.shadow.camera.near = SHADOW_CAMERA_NEAR_M;
    this.dirLight.shadow.camera.far = SHADOW_CAMERA_FAR_M;
    this.dirLight.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.hemiLight, this.dirLight, this.dirLight.target);

    // Shared Materials & Assets
    this.sharedMaterials = createSharedToonMaterials(this.gfx);
    this.outlineMaterial = createSmoothOutlineMaterial(this.gfx);
    this.billboardAtlas = createCartoonSpriteAtlasTexture(this.gfx);
    this.billboardMaterial = createCylindricalBillboardMaterial(
      this.gfx,
      this.billboardAtlas,
      this.sharedMaterials.sharedUniforms,
      antialiasEnabled,
    );

    const meshAssets = createProceduralMeshAssets(this.gfx);
    const billboardQuadGeo = createBillboardQuadGeometry(this.gfx);

    // 1-Draw-Call Instanced CDLOD Clipmap + Decoupled SceneryCellStreamer
    this.clipmapStore = new ClipmapDataStore(this.gfx, { nowMs: options.nowMs });
    bindClipmapStoreToMaterial(this.gfx, this.sharedMaterials, this.clipmapStore);
    this.terrainClipmap = new TerrainClipmap(
      this.gfx,
      this.sharedMaterials.terrainMaterial,
      this.sharedMaterials.clipmapUniforms,
    );
    this.scene.add(this.terrainClipmap.mesh);

    this.sceneryStreamer = new SceneryCellStreamer({ nowMs: options.nowMs });

    this.landmarkStreamer = new LandmarkStreamer(this.gfx, this.sharedMaterials, meshAssets, {
      assetWaiter: options.assetWaiter,
      outlineMaterial: this.outlineMaterial,
    });
    this.scene.add(this.landmarkStreamer.rootGroup);

    this.instancePools = new InstancePools(
      this.gfx,
      this.sharedMaterials,
      this.outlineMaterial,
      this.billboardMaterial,
      billboardQuadGeo,
      meshAssets,
    );
    this.scene.add(this.instancePools.rootGroup);

    this.skierRig = new SkierRig(this.gfx, this.sharedMaterials, this.outlineMaterial);
    this.scene.add(this.skierRig.rootGroup);

    this.backpackStack = new BackpackStack(
      this.gfx,
      this.sharedMaterials,
      meshAssets,
      this.skierRig.backpackAnchor,
    );

    this.tossedPresents = new TossedPresents(this.gfx, this.sharedMaterials, meshAssets);
    this.scene.add(this.tossedPresents.rootGroup);

    this.contactShadows = new ContactShadows(this.gfx);
    this.scene.add(this.contactShadows.instancedMesh);

    this.skiTracks = new SkiTracks(this.gfx);
    this.scene.add(this.skiTracks.mesh);

    this.snowVfx = new SnowVfx(
      this.gfx,
      this.scene,
      this.dirLight,
      this.hemiLight,
      this.sharedMaterials.sharedUniforms,
    );

    this.skyDome = new SkyDome(this.gfx, this.scene);
    this.carveSprayVfx = new CarveSprayVfx(this.gfx, this.scene);

    this.debugOverlay = new DebugOverlay3D(this.gfx);
    this.scene.add(this.debugOverlay.rootGroup);

    // Subscribe to simulation events (read-only reaction)
    this.unsubscribers.push(
      eventBus.on('WORLD_REBASED', (ev) => {
        if (ev.rebaseCount > this.lastRebaseCount) {
          const dx = ev.totalOffsetX - this.lastOriginOffsetX;
          const dy = ev.totalOffsetY - this.lastOriginOffsetY;
          const dz = ev.totalOffsetZ - this.lastOriginOffsetZ;
          this.lastRebaseCount = ev.rebaseCount;
          this.lastOriginOffsetX = ev.totalOffsetX;
          this.lastOriginOffsetY = ev.totalOffsetY;
          this.lastOriginOffsetZ = ev.totalOffsetZ;
          this.syncNoiseOriginUniforms();
          // ClipmapDataStore needs ZERO work/uploads on WORLD_REBASED; only scenery cell origins shift
          this.sceneryStreamer.handleWorldRebased(dx, dy, dz);
          this.landmarkStreamer.handleWorldRebased(dx, dy, dz);
          this.snowVfx.handleWorldRebased(dx, dy, dz);
          this.carveSprayVfx.shiftOrigin(dx, dy, dz);
          this.dirLight.target.position.x -= dx;
          this.dirLight.target.position.y -= dy;
          this.dirLight.target.position.z -= dz;
          this.dirLight.position.x -= dx;
          this.dirLight.position.y -= dy;
          this.dirLight.position.z -= dz;
          this.dirLight.target.updateMatrixWorld();
        }
      }),
      eventBus.on('PRESENT_PICKED_UP', (ev) => {
        this.backpackStack.triggerPickupPop(ev.carriedCount - 1);
      }),
    );
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  getGraphicsTracker(): GraphicsTracker {
    return this.tracker;
  }

  getSharedLightingUniforms(): SharedLightingUniforms {
    return this.sharedMaterials.sharedUniforms;
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.aspect = this.viewportWidth / this.viewportHeight;

    this.camera.aspect = this.aspect;
    this.camera.fov = computeVerticalFovDeg(
      this.lastMinHFovDeg,
      this.lastSpeedFovBoostDeg,
      this.aspect,
    );
    this.camera.updateProjectionMatrix();

    if (this.renderer) {
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      this.renderer.setPixelRatio(Math.min(dpr, this.maxPixelRatio));
      this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);
    }
  }

  /**
   * Synchronizes all Three.js scene objects, CDLOD clipmap textures & quadtree instances,
   * decoupled scenery cells, instanced pools, and VFX with `ReadonlySimState` (zero allocations).
   */
  sync(
    simState: ReadonlySimState,
    alpha: number,
    frameDtSec: number,
    budgetMs?: number,
  ): void {
    if (this.disposed) return;
    const syncStartMs = this.nowMs();

    // Safeguard in case state reset or rebased before event listener attachment
    if (simState.tickCount < this.lastTickCount || simState.rebase.rebaseCount < this.lastRebaseCount) {
      this.lastRebaseCount = simState.rebase.rebaseCount;
      this.lastOriginOffsetX = simState.rebase.offsetX;
      this.lastOriginOffsetY = simState.rebase.offsetY;
      this.lastOriginOffsetZ = simState.rebase.offsetZ;
      this.syncNoiseOriginUniforms();
      this.clipmapStore.reset();
      this.sceneryStreamer.clearAll();
      this.landmarkStreamer.clearAll();
      this.carveSprayVfx.reset();
    } else if (simState.rebase.rebaseCount > this.lastRebaseCount) {
      const dx = simState.rebase.offsetX - this.lastOriginOffsetX;
      const dy = simState.rebase.offsetY - this.lastOriginOffsetY;
      const dz = simState.rebase.offsetZ - this.lastOriginOffsetZ;
      this.lastRebaseCount = simState.rebase.rebaseCount;
      this.lastOriginOffsetX = simState.rebase.offsetX;
      this.lastOriginOffsetY = simState.rebase.offsetY;
      this.lastOriginOffsetZ = simState.rebase.offsetZ;
      this.syncNoiseOriginUniforms();
      this.sceneryStreamer.handleWorldRebased(dx, dy, dz);
      this.landmarkStreamer.handleWorldRebased(dx, dy, dz);
      this.snowVfx.handleWorldRebased(dx, dy, dz);
      this.carveSprayVfx.shiftOrigin(dx, dy, dz);
    } else if (
      simState.rebase.offsetX !== this.lastOriginOffsetX ||
      simState.rebase.offsetY !== this.lastOriginOffsetY ||
      simState.rebase.offsetZ !== this.lastOriginOffsetZ
    ) {
      this.lastOriginOffsetX = simState.rebase.offsetX;
      this.lastOriginOffsetY = simState.rebase.offsetY;
      this.lastOriginOffsetZ = simState.rebase.offsetZ;
      this.syncNoiseOriginUniforms();
    }
    this.lastTickCount = simState.tickCount;

    this.lastMinHFovDeg = simState.currCamera.minHorizontalFovDeg;
    this.lastSpeedFovBoostDeg = simState.currCamera.speedFovBoostDeg;

    syncPerspectiveCamera(
      this.camera,
      simState.prevCamera,
      simState.currCamera,
      alpha,
      this.aspect,
    );

    const camDx = simState.currCamera.lookAtX - simState.currCamera.posX;
    const camDz = simState.currCamera.lookAtZ - simState.currCamera.posZ;
    const camLen = Math.hypot(camDx, camDz);
    const camFwdX = camLen > 1e-4 ? camDx / camLen : -Math.sin(simState.currSkier.headingRad);
    const camFwdZ = camLen > 1e-4 ? camDz / camLen : -Math.cos(simState.currSkier.headingRad);

    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const interpSkierX =
      simState.prevSkier.posX + (simState.currSkier.posX - simState.prevSkier.posX) * t;
    const interpSkierY =
      simState.prevSkier.posY + (simState.currSkier.posY - simState.prevSkier.posY) * t;
    const interpSkierZ =
      simState.prevSkier.posZ + (simState.currSkier.posZ - simState.prevSkier.posZ) * t;
    this.updateDirectionalShadowFrustum(interpSkierX, interpSkierY, interpSkierZ, camFwdX, camFwdZ);

    this.skierRig.sync(simState, alpha, simState.paused ? 0 : frameDtSec);
    this.backpackStack.sync(simState, frameDtSec);

    this.tossedPresents.sync(simState, alpha);
    this.contactShadows.sync(simState, alpha);
    this.skiTracks.sync(simState);
    this.snowVfx.sync(simState, this.camera, frameDtSec);
    this.skyDome.sync(
      this.camera,
      this.snowVfx.fog.color,
      this.snowVfx.skyBottomColor,
      this.snowVfx.skyTopColor,
      this.dirLight.color,
      LIGHT_BACK_X,
      LIGHT_BACK_Y,
      LIGHT_BACK_Z,
      this.sharedMaterials.sharedUniforms.uBlizzardDim.value,
    );
    this.carveSprayVfx.update(
      simState.paused ? 0 : frameDtSec,
      simState.currSkier,
      simState.surfaceSample.surfaceType,
      this.sharedMaterials.sharedUniforms.uBlizzardDim.value,
      this.camera,
    );
    this.debugOverlay.sync(simState);

    const totalBudgetMs =
      budgetMs !== undefined
        ? Math.max(1, budgetMs)
        : Math.max(DEFAULT_TERRAIN_STREAM_BUDGET_MS - Math.max(0, this.nowMs() - syncStartMs), 1);

    this.landmarkStreamer.sync(simState.trailWindow, simState.elapsedSec);

    // 1. Update toroidal CDLOD DataArrayTextures & CPU mirrors within budget
    const clipStartMs = this.nowMs();
    const clipShare = this.sceneryStreamer.queuedCellCount > 0 ? 0.72 : 0.85;
    const clipBudgetMs = Math.max(
      0.5,
      Math.min(totalBudgetMs * clipShare, DEFAULT_CLIPMAP_STREAM_BUDGET_MS + totalBudgetMs * 0.5),
    );
    this.clipmapStore.update(
      simState.mountainField,
      simState.currSkier.posX,
      simState.currSkier.posY,
      simState.currSkier.posZ,
      this.contextLost ? null : this.renderer,
      clipBudgetMs,
    );

    // 2. Rebuild 1-draw-call CDLOD quadtree patch list & clipmap uniforms
    this.terrainClipmap.update(
      this.clipmapStore,
      interpSkierX,
      interpSkierZ,
      simState.mountainField.originOffsetX,
      simState.mountainField.originOffsetY,
      simState.mountainField.originOffsetZ,
      this.camera,
    );

    // 3. Stream decoupled 32m deterministic off-piste scenery cells using remaining budget
    const clipElapsedMs = Math.max(0, this.nowMs() - clipStartMs);
    const sceneryBudgetMs = Math.max(0.5, totalBudgetMs - clipElapsedMs);
    this.sceneryStreamer.step(
      simState.trailWindow,
      simState.mountainField,
      simState.currSkier.posX,
      simState.currSkier.posZ,
      camFwdX,
      camFwdZ,
      sceneryBudgetMs,
    );

    this.instancePools.sync(simState, alpha, this.sceneryStreamer);

    if (this.renderer && !this.contextLost) {
      this.renderer.render(this.scene, this.camera);
    }

    if (this.profiler) {
      this.profiler.setCounter('drawCalls', this.renderer?.info.render.calls ?? 0);
      this.profiler.setCounter('triangles', this.renderer?.info.render.triangles ?? 0);
      this.profiler.setCounter('activeChunks', this.terrainClipmap.patchCount);
      this.profiler.setCounter('trackedObjects', this.tracker.getStats().activeObjects);
    }
  }

  runLeakCheck(minAgeSec = 20, updateSnapshot = true): LeakReport {
    return this.tracker.checkLeaks(minAgeSec, updateSnapshot, this.scene);
  }

  getStats(): ThreeRendererStats {
    return {
      graphics: this.tracker.getStats(),
      drawCalls: this.renderer?.info.render.calls ?? 0,
      triangles: this.renderer?.info.render.triangles ?? 0,
      geometries: this.renderer?.info.memory.geometries ?? 0,
      textures: this.renderer?.info.memory.textures ?? 0,
      activeChunks: this.terrainClipmap.patchCount,
      queuedChunks: this.clipmapStore.pendingWorkCount + this.sceneryStreamer.queuedCellCount,
      contextLost: this.contextLost,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (let i = 0; i < this.unsubscribers.length; i++) {
      this.unsubscribers[i]!();
    }
    this.unsubscribers.length = 0;

    if (this.renderer) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
      if (canvas.parentElement === this.container) {
        this.container?.removeChild(canvas);
      }
      this.renderer.dispose();
    }

    this.dirLight.shadow.dispose();
    this.terrainClipmap.dispose();
    this.clipmapStore.reset();
    this.sceneryStreamer.clearAll();
    this.landmarkStreamer.clearAll();
    this.skierRig.dispose();
    this.skyDome.dispose();
    this.carveSprayVfx.dispose();
    this.tracker.disposeAll();
  }

  private syncNoiseOriginUniforms(): void {
    this.sharedMaterials.sharedUniforms.uNoiseOriginModXZ.value.set(
      positiveMod(this.lastOriginOffsetX, NOISE_ORIGIN_MOD_PERIOD),
      positiveMod(this.lastOriginOffsetZ, NOISE_ORIGIN_MOD_PERIOD),
    );
    this.sharedMaterials.sharedUniforms.uNoiseOriginModY.value = positiveMod(
      this.lastOriginOffsetY,
      NOISE_ORIGIN_MOD_PERIOD,
    );
  }

  /**
   * Centers the directional ortho shadow frustum +28 m ahead of the skier and snaps
   * its light-space axes in absolute (rebase-invariant) coordinates to exact shadow
   * map texel increments to prevent shadow edge shimmer/crawl across motion and rebases.
   */
  private updateDirectionalShadowFrustum(
    skierX: number,
    skierY: number,
    skierZ: number,
    camFwdX: number,
    camFwdZ: number,
  ): void {
    const absFocusX = skierX + camFwdX * SHADOW_FORWARD_BIAS_M + this.lastOriginOffsetX;
    const absFocusY = skierY + SHADOW_VERTICAL_BIAS_M + this.lastOriginOffsetY;
    const absFocusZ = skierZ + camFwdZ * SHADOW_FORWARD_BIAS_M + this.lastOriginOffsetZ;

    const projRight =
      absFocusX * LIGHT_RIGHT_X + absFocusY * LIGHT_RIGHT_Y + absFocusZ * LIGHT_RIGHT_Z;
    const projUp = absFocusX * LIGHT_UP_X + absFocusY * LIGHT_UP_Y + absFocusZ * LIGHT_UP_Z;
    const projBack =
      absFocusX * LIGHT_BACK_X + absFocusY * LIGHT_BACK_Y + absFocusZ * LIGHT_BACK_Z;

    const snappedRight = Math.round(projRight / SHADOW_TEXEL_WORLD_X) * SHADOW_TEXEL_WORLD_X;
    const snappedUp = Math.round(projUp / SHADOW_TEXEL_WORLD_Y) * SHADOW_TEXEL_WORLD_Y;
    const snappedBack = Math.round(projBack / 0.25) * 0.25;

    const targetX =
      snappedRight * LIGHT_RIGHT_X +
      snappedUp * LIGHT_UP_X +
      snappedBack * LIGHT_BACK_X -
      this.lastOriginOffsetX;
    const targetY =
      snappedRight * LIGHT_RIGHT_Y +
      snappedUp * LIGHT_UP_Y +
      snappedBack * LIGHT_BACK_Y -
      this.lastOriginOffsetY;
    const targetZ =
      snappedRight * LIGHT_RIGHT_Z +
      snappedUp * LIGHT_UP_Z +
      snappedBack * LIGHT_BACK_Z -
      this.lastOriginOffsetZ;

    this.dirLight.target.position.set(targetX, targetY, targetZ);
    this.dirLight.position.set(
      targetX + LIGHT_BACK_X * SHADOW_LIGHT_DISTANCE_M,
      targetY + LIGHT_BACK_Y * SHADOW_LIGHT_DISTANCE_M,
      targetZ + LIGHT_BACK_Z * SHADOW_LIGHT_DISTANCE_M,
    );
    this.dirLight.target.updateMatrixWorld();
  }

  private handleContextRestored(): void {
    if (!this.renderer) return;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    this.renderer.setPixelRatio(Math.min(dpr, this.maxPixelRatio));
    this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.shadowMap.needsUpdate = true;

    this.sharedMaterials.gradientMap.needsUpdate = true;
    this.sharedMaterials.terrainMaterial.needsUpdate = true;
    this.sharedMaterials.propToonMaterial.needsUpdate = true;
    this.sharedMaterials.beaconGlowMaterial.needsUpdate = true;
    this.sharedMaterials.cabinAtlasTexture.needsUpdate = true;
    this.sharedMaterials.cabinToonMaterial.needsUpdate = true;
    this.sharedMaterials.cabinSmokeTexture.needsUpdate = true;
    this.sharedMaterials.cabinSmokeMaterial.needsUpdate = true;
    this.outlineMaterial.needsUpdate = true;
    this.billboardAtlas.needsUpdate = true;
    this.billboardMaterial.needsUpdate = true;
    this.skyDome.material.needsUpdate = true;
    this.contactShadows.shadowTexture.needsUpdate = true;
    this.carveSprayVfx.puffTexture.needsUpdate = true;
    (this.carveSprayVfx.instancedMesh.material as THREE.Material).needsUpdate = true;
    // Re-upload all 4 CDLOD DataArrayTextures instantaneously from CPU mirrors
    this.clipmapStore.handleContextRestored(this.renderer);
  }
}
