import type { TiltControlStatus } from '../core/input';
import type { ProfilerSnapshot } from '../core/profiler';
import type { ReadonlySimState } from '../sim/contracts';

export type OverlayMode = 'start' | 'playing' | 'paused' | 'gameover';

export interface RenderTelemetryStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly activeChunks: number;
  readonly queuedChunks: number;
  readonly activeObjects: number;
  readonly cachedObjects: number;
  readonly activeResources: number;
  readonly cachedResources: number;
  readonly contextLost: boolean;
}

export interface MutableRenderTelemetryStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  activeChunks: number;
  queuedChunks: number;
  activeObjects: number;
  cachedObjects: number;
  activeResources: number;
  cachedResources: number;
  contextLost: boolean;
}

export function createRenderTelemetryStats(): MutableRenderTelemetryStats {
  return {
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    activeChunks: 0,
    queuedChunks: 0,
    activeObjects: 0,
    cachedObjects: 0,
    activeResources: 0,
    cachedResources: 0,
    contextLost: false,
  };
}

export interface LeakCheckStatus {
  readonly hasRun: boolean;
  readonly checkedAtSec: number;
  readonly totalLeaks: number;
  readonly detachedObjects: number;
  readonly uncollectedResources: number;
  readonly untrackedSceneObjects: number;
  readonly persistingAcrossSnapshots: number;
}

export interface MutableLeakCheckStatus {
  hasRun: boolean;
  checkedAtSec: number;
  totalLeaks: number;
  detachedObjects: number;
  uncollectedResources: number;
  untrackedSceneObjects: number;
  persistingAcrossSnapshots: number;
}

export function createLeakCheckStatus(): MutableLeakCheckStatus {
  return {
    hasRun: false,
    checkedAtSec: 0,
    totalLeaks: 0,
    detachedObjects: 0,
    uncollectedResources: 0,
    untrackedSceneObjects: 0,
    persistingAcrossSnapshots: 0,
  };
}

export interface GameUICallbacks {
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onSelectSkier(skierId: string): void;
  onTogglePause(): void;
  onToggleBlizzard(): void;
  onToggleDebugDraw(): void;
  onToggleTelemetry(): void;
  onSetTiltEnabled(enabled: boolean): void;
}

export interface GameUIUpdateData {
  readonly simState: ReadonlySimState;
  readonly profiler: Readonly<ProfilerSnapshot>;
  readonly renderStats: RenderTelemetryStats;
  readonly leakStatus: LeakCheckStatus;
  readonly hasSteered: boolean;
  readonly debugDrawEnabled: boolean;
  readonly telemetryVisible: boolean;
  readonly tiltEnabled: boolean;
  readonly tiltStatus: TiltControlStatus;
  readonly overlayMode: OverlayMode;
}
