import * as THREE from 'three';
import type { EventBus, Unsubscribe } from '../../core/eventBus';
import type { Profiler } from '../../core/profiler';
import type { ReadonlySimState, SimEvents } from '../../sim/contracts';
import { BackpackStack } from './backpackStack';
import { createBillboardQuadGeometry, createCylindricalBillboardMaterial } from './billboardMaterial';
import { computeVerticalFovDeg, syncPerspectiveCamera } from './cameraSync';
import { ChunkStreamer } from './chunkStreamer';
import { ContactShadows } from './contactShadows';
import { DebugOverlay3D } from './debugOverlay';
import {
  GraphicsTracker,
  type GraphicsTrackerStats,
  type LeakReport,
} from './graphicsTracker';
import { GraphicsUtils } from './graphicsUtils';
import { InstancePools } from './instancePools';
import { createProceduralMeshAssets } from './meshFactory';
import { createSmoothOutlineMaterial } from './outlineShader';
import { SkierRig } from './skierRig';
import { SkiTracks } from './skiTracks';
import { SnowVfx } from './snowVfx';
import { createCartoonSpriteAtlasTexture } from './spriteAtlas';
import { createSharedToonMaterials, type SharedToonMaterials } from './toonMaterials';
import { TossedPresents } from './tossedPresents';

export interface ThreeRendererOptions {
  readonly maxPixelRatio?: number;
  readonly initialWidth?: number;
  readonly initialHeight?: number;
  readonly headless?: boolean;
  readonly nowSec?: () => number;
  readonly nowMs?: () => number;
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
 * Facade for the mixed 3D low-poly toon + 2.5D cylindrical billboard Three.js renderer.
 * Reads `ReadonlySimState` and subscribes to `EventBus<SimEvents>` without mutating simulation state.
 */
export class ThreeRenderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly tracker: GraphicsTracker;
  readonly gfx: GraphicsUtils;
  readonly chunkStreamer: ChunkStreamer;

  private readonly nowMs: () => number;
  private readonly container: HTMLElement | null;
  private readonly profiler: Profiler | undefined;
  private readonly maxPixelRatio: number;
  private readonly renderer: THREE.WebGLRenderer | null;

  private readonly sharedMaterials: SharedToonMaterials;
  private readonly outlineMaterial: THREE.ShaderMaterial;
  private readonly billboardAtlas: THREE.Texture;
  private readonly billboardMaterial: THREE.MeshBasicMaterial;

  private readonly dirLight: THREE.DirectionalLight;
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
    this.camera = new THREE.PerspectiveCamera(initialVfov, this.aspect, 0.25, 480);

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
      this.renderer.shadowMap.enabled = false;

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

    // Lighting
    this.hemiLight = new THREE.HemisphereLight('#bce0fd', '#72a3d4', 0.85);
    this.dirLight = new THREE.DirectionalLight('#fff6d6', 1.15);
    this.dirLight.position.set(35, 65, 40);
    this.scene.add(this.hemiLight, this.dirLight);

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

    // Subsystems
    this.chunkStreamer = new ChunkStreamer(this.gfx, this.sharedMaterials, meshAssets, {
      nowMs: options.nowMs,
    });
    this.scene.add(this.chunkStreamer.ribbonPool.rootGroup);

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

    this.debugOverlay = new DebugOverlay3D(this.gfx);
    this.scene.add(this.debugOverlay.rootGroup);

    // Subscribe to simulation events (read-only reaction)
    this.unsubscribers.push(
      eventBus.on('WORLD_REBASED', (ev) => {
        if (ev.rebaseCount > this.lastRebaseCount) {
          this.lastRebaseCount = ev.rebaseCount;
          this.chunkStreamer.handleWorldRebased(ev.deltaX, ev.deltaY, ev.deltaZ);
          this.snowVfx.handleWorldRebased(ev.deltaX, ev.deltaY, ev.deltaZ);
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
   * Synchronizes all Three.js scene objects, chunk meshes, instanced pools, and VFX
   * with `ReadonlySimState` (interpolating `prev -> curr` by `alpha`) with zero allocations.
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
      this.chunkStreamer.clearAll();
    } else if (simState.rebase.rebaseCount > this.lastRebaseCount) {
      this.lastRebaseCount = simState.rebase.rebaseCount;
      this.chunkStreamer.handleWorldRebased(
        simState.rebase.lastDeltaX,
        simState.rebase.lastDeltaY,
        simState.rebase.lastDeltaZ,
      );
      this.snowVfx.handleWorldRebased(
        simState.rebase.lastDeltaX,
        simState.rebase.lastDeltaY,
        simState.rebase.lastDeltaZ,
      );
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

    this.skierRig.sync(simState, alpha);
    this.backpackStack.sync(simState, frameDtSec);

    this.tossedPresents.sync(simState, alpha);
    this.contactShadows.sync(simState, alpha);
    this.skiTracks.sync(simState);
    this.snowVfx.sync(simState, this.camera, frameDtSec);
    this.debugOverlay.sync(simState);

    const effectiveBudgetMs =
      budgetMs !== undefined
        ? Math.max(1, budgetMs)
        : Math.max(14 - Math.max(0, this.nowMs() - syncStartMs), 1);
    this.chunkStreamer.step(simState.trailWindow, effectiveBudgetMs);
    this.instancePools.sync(simState, alpha, this.chunkStreamer);

    if (this.renderer && !this.contextLost) {
      this.renderer.render(this.scene, this.camera);
    }

    if (this.profiler) {
      this.profiler.setCounter('drawCalls', this.renderer?.info.render.calls ?? 0);
      this.profiler.setCounter('triangles', this.renderer?.info.render.triangles ?? 0);
      this.profiler.setCounter('activeChunks', this.chunkStreamer.activeChunkCount);
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
      activeChunks: this.chunkStreamer.activeChunkCount,
      queuedChunks: this.chunkStreamer.queuedChunkCount,
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

    this.chunkStreamer.clearAll();
    this.skierRig.dispose();
    this.tracker.disposeAll();
  }

  private handleContextRestored(): void {
    if (!this.renderer) return;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    this.renderer.setPixelRatio(Math.min(dpr, this.maxPixelRatio));
    this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.sharedMaterials.gradientMap.needsUpdate = true;
    this.sharedMaterials.terrainMaterial.needsUpdate = true;
    this.sharedMaterials.propToonMaterial.needsUpdate = true;
    this.sharedMaterials.beaconGlowMaterial.needsUpdate = true;
    this.outlineMaterial.needsUpdate = true;
    this.billboardAtlas.needsUpdate = true;
    this.billboardMaterial.needsUpdate = true;
    this.contactShadows.shadowTexture.needsUpdate = true;
  }
}
