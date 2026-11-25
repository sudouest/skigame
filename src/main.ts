import { EventBus } from './core/eventBus';
import { FIXED_DT, FixedLoop } from './core/fixedLoop';
import {
  InputManager,
  createInputFrameState,
  type MutableInputFrameState,
} from './core/input';
import { Profiler, type ProfilerSnapshot } from './core/profiler';
import { ThreeRenderer } from './render/three';
import {
  createMutablePlayerIntent,
  type MutablePlayerIntent,
  type SimEventMap,
} from './sim/contracts';
import { SkiSimulation } from './sim/skiSimulation';
import {
  GameUI,
  createLeakCheckStatus,
  createRenderTelemetryStats,
  type GameUICallbacks,
  type MutableLeakCheckStatus,
  type MutableRenderTelemetryStats,
  type OverlayMode,
} from './ui';

const POINTER_DRAG_STEER_SCALE = 3.2;
const LEAK_CHECK_INTERVAL_SEC = 20.0;
const TELEMETRY_SAMPLE_INTERVAL_SEC = 0.2;
const TILT_PREF_STORAGE_KEY = 'skigame:tiltSteering';

function readSavedTiltPref(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TILT_PREF_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSavedTiltPref(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TILT_PREF_STORAGE_KEY, enabled ? 'true' : 'false');
    }
  } catch {
    // Ignore storage failures in private browsing / restricted WebViews
  }
}

export interface SkiGameAppHandle {
  dispose(): void;
}

/**
 * Composition root wiring core plumbing, headless simulation, Three.js renderer,
 * and responsive cartoon HUD via strict dependency injection (zero singletons).
 */
export function mountSkiGame(
  viewportEl: HTMLElement,
  hudRootEl: HTMLElement,
): SkiGameAppHandle {
  const isDevBuild = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

  const eventBus = new EventBus<SimEventMap>();
  const profiler = new Profiler();
  const input = new InputManager({
    dragSensitivity: 1.0,
    nowMs: () => performance.now(),
  });
  const sim = new SkiSimulation({
    seed: 1337,
    skierId: 'skier_alpine',
    startStageId: 'sunny-blue',
    gameMode: 'endless',
    eventBus,
    debugDrawEnabled: false,
    blizzardEnabled: false,
  });
  const renderer = new ThreeRenderer(viewportEl, eventBus, profiler);

  let currentSeed = 1337;
  let overlayMode: OverlayMode = 'start';
  let debugDrawEnabled = false;
  let telemetryVisible = false;
  let lastRawDtSec = FIXED_DT;
  let leakCheckAccumSec = 0;
  let telemetrySampleAccumSec = TELEMETRY_SAMPLE_INTERVAL_SEC;

  const inputFrame: MutableInputFrameState = createInputFrameState();
  const intent: MutablePlayerIntent = createMutablePlayerIntent();
  const renderStats: MutableRenderTelemetryStats = createRenderTelemetryStats();
  const leakStatus: MutableLeakCheckStatus = createLeakCheckStatus();
  const profilerSnapshot: ProfilerSnapshot = {
    frameMs: 0,
    simMs: 0,
    renderMs: 0,
    streamMs: 0,
    avgFrameMs: 0,
    avgSimMs: 0,
    avgRenderMs: 0,
    maxFrameMs: 0,
    maxSimMs: 0,
    fps: 0,
    simSteps: 0,
  };

  const clearIntent = (): void => {
    intent.steer = 0;
    intent.pointerSteerDelta = 0;
    intent.jumpPressed = false;
    intent.brake = false;
  };

  const refreshRenderStats = (): void => {
    const stats = renderer.getStats();
    const g = stats.graphics;
    renderStats.drawCalls = stats.drawCalls;
    renderStats.triangles = stats.triangles;
    renderStats.geometries = stats.geometries;
    renderStats.textures = stats.textures;
    renderStats.activeChunks = stats.activeChunks;
    renderStats.queuedChunks = stats.queuedChunks;
    renderStats.activeObjects = g.activeObjects;
    renderStats.cachedObjects = g.cachedObjects;
    renderStats.activeResources = g.activeGeometries + g.activeMaterials + g.activeTextures;
    renderStats.cachedResources = g.cachedGeometries + g.cachedMaterials + g.cachedTextures;
    renderStats.contextLost = stats.contextLost;
  };

  const runAndStoreLeakCheck = (): void => {
    const report = renderer.runLeakCheck(20, true);
    leakStatus.hasRun = true;
    leakStatus.checkedAtSec = performance.now() * 0.001;
    leakStatus.totalLeaks = report.totalLeaks;
    leakStatus.detachedObjects = report.detachedObjects.length;
    leakStatus.uncollectedResources = report.uncollectedResources.length;
    leakStatus.untrackedSceneObjects = report.untrackedSceneObjects.length;
    leakStatus.persistingAcrossSnapshots = report.persistingAcrossSnapshots;
  };

  let loop!: FixedLoop;

  const startRun = (): void => {
    overlayMode = 'playing';
    clearIntent();
    input.resetAll();
    input.resetHasSteered();
    sim.setPaused(false);
    loop.resetAccumulator();
    loop.resume();
  };

  const pauseRun = (): void => {
    if (overlayMode !== 'playing') return;
    overlayMode = 'paused';
    clearIntent();
    input.resetHeldInputs();
    sim.setPaused(true);
    loop.pause();
  };

  const resumeRun = (): void => {
    if (overlayMode !== 'paused') return;
    overlayMode = 'playing';
    clearIntent();
    input.resetAll();
    sim.setPaused(false);
    loop.resetAccumulator();
    loop.resume();
  };

  const restartRun = (): void => {
    currentSeed += 1;
    clearIntent();
    input.resetAll();
    input.resetHasSteered();
    sim.reset(currentSeed, sim.getState().skierId);
    sim.setPaused(false);
    sim.setDebugDrawEnabled(debugDrawEnabled);
    overlayMode = 'playing';
    ui.resetRunState();
    profiler.resetPeaks();
    loop.resetAccumulator();
    loop.resume();
  };

  const togglePause = (): void => {
    if (overlayMode === 'playing') {
      pauseRun();
    } else if (overlayMode === 'paused') {
      resumeRun();
    }
  };

  const toggleBlizzard = (): void => {
    const next = !sim.getState().activeWeather.blizzardEnabled;
    sim.setBlizzardEnabled(next);
  };

  const toggleDebugDraw = (): void => {
    debugDrawEnabled = !debugDrawEnabled;
    sim.setDebugDrawEnabled(debugDrawEnabled);
  };

  const toggleTelemetry = (): void => {
    telemetryVisible = !telemetryVisible;
    if (telemetryVisible) {
      refreshRenderStats();
      if (!leakStatus.hasRun) {
        runAndStoreLeakCheck();
      }
      telemetrySampleAccumSec = 0;
    }
  };

  const setTiltEnabled = (enabled: boolean): void => {
    if (enabled) {
      // Invoke enableTilt() synchronously inside the UI click handler for iOS gesture activation
      void input.enableTilt().then((status) => {
        if (status === 'calibrating' || status === 'active') {
          writeSavedTiltPref(true);
        } else if (status === 'denied' || status === 'insecure' || status === 'unsupported') {
          writeSavedTiltPref(false);
        }
      });
    } else {
      input.disableTilt();
      writeSavedTiltPref(false);
    }
  };

  const recenterTilt = (): void => {
    input.recenterTilt();
  };

  const uiCallbacks: GameUICallbacks = {
    onStart: startRun,
    onResume: resumeRun,
    onRestart: restartRun,
    onSelectSkier: (skierId: string) => {
      sim.setSkier(skierId);
    },
    onTogglePause: togglePause,
    onToggleBlizzard: toggleBlizzard,
    onToggleDebugDraw: toggleDebugDraw,
    onToggleTelemetry: toggleTelemetry,
    onSetTiltEnabled: setTiltEnabled,
    onRecenterTilt: recenterTilt,
  };

  const ui = new GameUI(hudRootEl, eventBus, uiCallbacks);

  // Pre-allocated UI update payload (zero per-frame heap allocations)
  const uiUpdateData = {
    simState: sim.getState(),
    profiler: profilerSnapshot,
    renderStats,
    leakStatus,
    hasSteered: false,
    debugDrawEnabled: false,
    telemetryVisible: false,
    tiltEnabled: false,
    tiltStatus: input.tiltStatus,
    overlayMode: 'start' as OverlayMode,
  };

  let lastObservedTiltStatus = input.tiltStatus;

  loop = new FixedLoop({
    fixedDt: FIXED_DT,
    profiler,
    onBeforeFrame: (rawDtSec: number) => {
      lastRawDtSec = rawDtSec;
      const simStateBeforeInput = sim.getState();
      const isActivelyPlaying = overlayMode === 'playing' && !simStateBeforeInput.paused;
      input.sampleFrameInto(inputFrame, isActivelyPlaying);

      const curTiltStatus = input.tiltStatus;
      if (curTiltStatus !== lastObservedTiltStatus) {
        lastObservedTiltStatus = curTiltStatus;
        if (curTiltStatus === 'no-sensor') {
          writeSavedTiltPref(false);
        }
      }

      // Process mode/debug/pause toggles regardless of pause state
      if (inputFrame.toggleBlizzardPressed) {
        toggleBlizzard();
      }
      if (inputFrame.toggleDebugPressed) {
        toggleDebugDraw();
      }
      if (inputFrame.toggleProfilerPressed) {
        toggleTelemetry();
      }
      if (inputFrame.togglePausePressed) {
        togglePause();
      }

      const simState = sim.getState();
      if (simState.gameOver && overlayMode === 'playing') {
        overlayMode = 'gameover';
        clearIntent();
        input.resetHeldInputs();
        sim.setPaused(true);
        loop.pause();
      }

      if (overlayMode !== 'playing' || simState.paused) {
        clearIntent();
        return;
      }

      // Accumulate edge/delta actions so 120/144 Hz zero-step frames never drop taps or drags
      intent.steer = inputFrame.steer;
      intent.brake = inputFrame.brakeHeld;
      intent.pointerSteerDelta += inputFrame.dragDelta * POINTER_DRAG_STEER_SCALE;
      if (inputFrame.jumpPressed) {
        intent.jumpPressed = true;
      }
    },
    onCapturePreviousPose: () => {
      sim.savePreviousPoses();
    },
    onFixedStep: (dt: number) => {
      sim.step(dt, intent);
      // Consume single-frame edge/delta inputs immediately after the first substep
      intent.jumpPressed = false;
      intent.pointerSteerDelta = 0;
    },
    onRender: (alpha: number, frameDtSec: number) => {
      const simState = sim.getState();
      renderer.sync(simState, alpha, frameDtSec);

      if (isDevBuild || telemetryVisible) {
        leakCheckAccumSec += lastRawDtSec;
        if (leakCheckAccumSec >= LEAK_CHECK_INTERVAL_SEC) {
          leakCheckAccumSec = 0;
          runAndStoreLeakCheck();
        }
      }

      if (telemetryVisible) {
        telemetrySampleAccumSec += lastRawDtSec;
        if (telemetrySampleAccumSec >= TELEMETRY_SAMPLE_INTERVAL_SEC) {
          telemetrySampleAccumSec = 0;
          refreshRenderStats();
        }
      }

      profiler.getSnapshot(profilerSnapshot);
      uiUpdateData.simState = simState;
      uiUpdateData.hasSteered = input.hasSteered;
      uiUpdateData.debugDrawEnabled = debugDrawEnabled;
      uiUpdateData.telemetryVisible = telemetryVisible;
      uiUpdateData.tiltEnabled = input.tiltEnabled;
      uiUpdateData.tiltStatus = input.tiltStatus;
      uiUpdateData.overlayMode = overlayMode;
      ui.update(uiUpdateData, frameDtSec);
    },
  });

  // Start paused on the Start / Skier Select card while streaming the 3D scene behind it
  sim.setPaused(true);
  loop.pause();

  input.attach(window, viewportEl);
  if (
    readSavedTiltPref() &&
    !input.tiltRequiresPermission &&
    input.tiltStatus === 'inactive'
  ) {
    void input.enableTilt();
  }

  const handleResize = (): void => {
    const w = viewportEl.clientWidth || window.innerWidth;
    const h = viewportEl.clientHeight || window.innerHeight;
    renderer.resize(w, h);
  };

  const handleBlur = (): void => {
    input.resetHeldInputs();
    clearIntent();
    if (overlayMode === 'playing') {
      pauseRun();
    }
  };

  const handleVisibilityChange = (): void => {
    if (document.hidden) {
      input.resetHeldInputs();
      clearIntent();
      if (overlayMode === 'playing') {
        pauseRun();
      }
    }
  };

  window.addEventListener('resize', handleResize);
  window.addEventListener('blur', handleBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  handleResize();
  loop.start();

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      loop.stop();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      input.detach();
      ui.dispose();
      renderer.dispose();
      eventBus.clear();
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const viewportEl = document.getElementById('viewport');
  const hudRootEl = document.getElementById('hud-root');
  if (viewportEl && hudRootEl) {
    const app = mountSkiGame(viewportEl, hudRootEl);
    window.addEventListener(
      'pagehide',
      () => {
        app.dispose();
      },
      { once: true },
    );
  }
}
