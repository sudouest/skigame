export interface ProfilerSnapshot {
  frameMs: number;
  simMs: number;
  renderMs: number;
  streamMs: number;
  avgFrameMs: number;
  avgSimMs: number;
  avgRenderMs: number;
  maxFrameMs: number;
  maxSimMs: number;
  fps: number;
  simSteps: number;
}

export interface ProfilerOptions {
  readonly emaAlpha?: number;
  readonly nowMs?: () => number;
}

/**
 * Zero-allocation frame telemetry and arbitrary counter accumulator.
 */
export class Profiler {
  private readonly emaAlpha: number;
  private readonly nowMs: () => number;
  private readonly counters = new Map<string, number>();

  private frameStartMs = 0;
  private simStartMs = 0;
  private renderStartMs = 0;
  private streamStartMs = 0;

  private readonly snapshot: ProfilerSnapshot = {
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

  constructor(options: ProfilerOptions = {}) {
    this.emaAlpha = options.emaAlpha ?? 0.1;
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  beginFrame(): void {
    this.frameStartMs = this.nowMs();
  }

  endFrame(): number {
    const ms = Math.max(0, this.nowMs() - this.frameStartMs);
    this.recordFrameMs(ms);
    return ms;
  }

  beginSim(): void {
    this.simStartMs = this.nowMs();
  }

  endSim(steps = 1): number {
    const ms = Math.max(0, this.nowMs() - this.simStartMs);
    this.recordSimMs(ms, steps);
    return ms;
  }

  beginRender(): void {
    this.renderStartMs = this.nowMs();
  }

  endRender(): number {
    const ms = Math.max(0, this.nowMs() - this.renderStartMs);
    this.recordRenderMs(ms);
    return ms;
  }

  beginStream(): void {
    this.streamStartMs = this.nowMs();
  }

  endStream(): number {
    const ms = Math.max(0, this.nowMs() - this.streamStartMs);
    this.recordStreamMs(ms);
    return ms;
  }

  recordFrameMs(ms: number): void {
    const val = ms < 0 ? 0 : ms;
    this.snapshot.frameMs = val;
    this.snapshot.avgFrameMs =
      this.snapshot.avgFrameMs === 0
        ? val
        : this.snapshot.avgFrameMs + (val - this.snapshot.avgFrameMs) * this.emaAlpha;
    if (val > this.snapshot.maxFrameMs) {
      this.snapshot.maxFrameMs = val;
    }
    this.snapshot.fps = this.snapshot.avgFrameMs > 0 ? 1000 / this.snapshot.avgFrameMs : 0;
  }

  recordSimMs(ms: number, steps = this.snapshot.simSteps): void {
    const val = ms < 0 ? 0 : ms;
    this.snapshot.simMs = val;
    this.snapshot.simSteps = steps;
    this.snapshot.avgSimMs =
      this.snapshot.avgSimMs === 0
        ? val
        : this.snapshot.avgSimMs + (val - this.snapshot.avgSimMs) * this.emaAlpha;
    if (val > this.snapshot.maxSimMs) {
      this.snapshot.maxSimMs = val;
    }
  }

  recordRenderMs(ms: number): void {
    const val = ms < 0 ? 0 : ms;
    this.snapshot.renderMs = val;
    this.snapshot.avgRenderMs =
      this.snapshot.avgRenderMs === 0
        ? val
        : this.snapshot.avgRenderMs + (val - this.snapshot.avgRenderMs) * this.emaAlpha;
  }

  recordStreamMs(ms: number): void {
    this.snapshot.streamMs = ms < 0 ? 0 : ms;
  }

  setCounter(name: string, value: number): void {
    this.counters.set(name, value);
  }

  incrementCounter(name: string, delta = 1): number {
    const next = (this.counters.get(name) ?? 0) + delta;
    this.counters.set(name, next);
    return next;
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  getCounters(): ReadonlyMap<string, number> {
    return this.counters;
  }

  resetCounters(): void {
    this.counters.clear();
  }

  resetPeaks(): void {
    this.snapshot.maxFrameMs = 0;
    this.snapshot.maxSimMs = 0;
  }

  getSnapshot(out?: ProfilerSnapshot): Readonly<ProfilerSnapshot> {
    if (out) {
      out.frameMs = this.snapshot.frameMs;
      out.simMs = this.snapshot.simMs;
      out.renderMs = this.snapshot.renderMs;
      out.streamMs = this.snapshot.streamMs;
      out.avgFrameMs = this.snapshot.avgFrameMs;
      out.avgSimMs = this.snapshot.avgSimMs;
      out.avgRenderMs = this.snapshot.avgRenderMs;
      out.maxFrameMs = this.snapshot.maxFrameMs;
      out.maxSimMs = this.snapshot.maxSimMs;
      out.fps = this.snapshot.fps;
      out.simSteps = this.snapshot.simSteps;
      return out;
    }
    return this.snapshot;
  }
}
