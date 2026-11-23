import type { Profiler } from './profiler';

export const FIXED_DT = 1 / 60;
export const MAX_FRAME_TIME = 0.25;

export interface FrameScheduler {
  requestFrame(callback: (timestampMs: number) => void): number;
  cancelFrame(handle: number): void;
}

export interface FixedStepResult {
  stepsExecuted: number;
  alpha: number;
  clampedDtSec: number;
  accumulatorSec: number;
}

export interface FixedLoopOptions {
  readonly fixedDt?: number;
  readonly maxFrameTime?: number;
  readonly maxSubSteps?: number;
  readonly onBeforeFrame?: (rawDtSec: number) => void;
  readonly onCapturePreviousPose?: () => void;
  readonly onFixedStep: (fixedDt: number) => void;
  readonly onRender?: (alpha: number, frameDtSec: number) => void;
  readonly onAfterRender?: (frameElapsedMs: number) => void;
  readonly profiler?: Profiler;
  readonly nowMs?: () => number;
  readonly scheduler?: FrameScheduler;
}

function getDefaultScheduler(): FrameScheduler | undefined {
  const g = globalThis as {
    requestAnimationFrame?: (cb: (ts: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  if (typeof g.requestAnimationFrame === 'function' && typeof g.cancelAnimationFrame === 'function') {
    const raf = g.requestAnimationFrame.bind(globalThis);
    const caf = g.cancelAnimationFrame.bind(globalThis);
    return {
      requestFrame: raf,
      cancelFrame: caf,
    };
  }
  return undefined;
}

/**
 * Deterministic 60 Hz fixed-timestep accumulator loop with alpha interpolation.
 * Runs headlessly via stepFrame(rawDtSec) in Node tests or driven by an injected FrameScheduler.
 */
export class FixedLoop {
  readonly fixedDt: number;
  readonly maxFrameTime: number;
  readonly maxSubSteps: number;

  private readonly onBeforeFrame: ((rawDtSec: number) => void) | undefined;
  private readonly onCapturePreviousPose: (() => void) | undefined;
  private readonly onFixedStep: (fixedDt: number) => void;
  private readonly onRender: ((alpha: number, frameDtSec: number) => void) | undefined;
  private readonly onAfterRender: ((frameElapsedMs: number) => void) | undefined;
  private readonly profiler: Profiler | undefined;
  private readonly nowMs: () => number;
  private readonly scheduler: FrameScheduler | undefined;

  private accumulator = 0;
  private alpha = 0;
  private running = false;
  private paused = false;
  private rafHandle: number | null = null;
  private lastTimestampMs: number | null = null;

  private readonly scratchResult: FixedStepResult = {
    stepsExecuted: 0,
    alpha: 0,
    clampedDtSec: 0,
    accumulatorSec: 0,
  };

  constructor(options: FixedLoopOptions) {
    this.fixedDt = options.fixedDt ?? FIXED_DT;
    this.maxFrameTime = options.maxFrameTime ?? MAX_FRAME_TIME;
    this.maxSubSteps = options.maxSubSteps ?? Math.ceil(this.maxFrameTime / this.fixedDt) + 2;
    this.onBeforeFrame = options.onBeforeFrame;
    this.onCapturePreviousPose = options.onCapturePreviousPose;
    this.onFixedStep = options.onFixedStep;
    this.onRender = options.onRender;
    this.onAfterRender = options.onAfterRender;
    this.profiler = options.profiler;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.scheduler = options.scheduler ?? getDefaultScheduler();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get currentAlpha(): number {
    return this.alpha;
  }

  get accumulatorSec(): number {
    return this.accumulator;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.paused) {
      this.paused = false;
      this.lastTimestampMs = null;
    }
  }

  resetAccumulator(): void {
    this.accumulator = 0;
    this.alpha = 0;
  }

  /**
   * Advances one frame deterministically given raw elapsed seconds.
   * Pass `out` for zero-allocation calls in hot loops.
   */
  stepFrame(rawDtSec: number, out?: FixedStepResult): FixedStepResult {
    const frameStartMs = this.nowMs();
    this.profiler?.beginFrame();

    const clampedDt =
      !Number.isFinite(rawDtSec) || rawDtSec <= 0
        ? 0
        : Math.min(rawDtSec, this.maxFrameTime);

    this.onBeforeFrame?.(clampedDt);

    let steps = 0;
    if (!this.paused) {
      this.accumulator += clampedDt;
      this.profiler?.beginSim();
      while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
        this.onCapturePreviousPose?.();
        this.onFixedStep(this.fixedDt);
        this.accumulator -= this.fixedDt;
        steps++;
      }
      if (steps >= this.maxSubSteps && this.accumulator >= this.fixedDt) {
        this.accumulator = this.accumulator % this.fixedDt;
      }
      this.profiler?.endSim(steps);
      this.alpha = Math.min(1, Math.max(0, this.accumulator / this.fixedDt));
    }

    if (this.onRender) {
      this.profiler?.beginRender();
      this.onRender(this.alpha, this.paused ? 0 : clampedDt);
      this.profiler?.endRender();
    }

    if (this.onAfterRender) {
      this.profiler?.beginStream();
      this.onAfterRender(Math.max(0, this.nowMs() - frameStartMs));
      this.profiler?.endStream();
    }

    this.profiler?.endFrame();

    const target: FixedStepResult = out ?? {
      stepsExecuted: 0,
      alpha: 0,
      clampedDtSec: 0,
      accumulatorSec: 0,
    };
    target.stepsExecuted = steps;
    target.alpha = this.alpha;
    target.clampedDtSec = clampedDt;
    target.accumulatorSec = this.accumulator;
    return target;
  }

  start(): void {
    if (this.running) return;
    if (!this.scheduler) {
      throw new Error('FixedLoop.start() requires a FrameScheduler or requestAnimationFrame');
    }
    this.running = true;
    this.lastTimestampMs = null;
    this.rafHandle = this.scheduler.requestFrame(this.onFrame);
  }

  stop(): void {
    this.running = false;
    this.lastTimestampMs = null;
    if (this.rafHandle !== null && this.scheduler) {
      this.scheduler.cancelFrame(this.rafHandle);
    }
    this.rafHandle = null;
  }

  private readonly onFrame = (timestampMs: number): void => {
    if (!this.running || !this.scheduler) return;

    const rawDtSec =
      this.lastTimestampMs === null ? this.fixedDt : (timestampMs - this.lastTimestampMs) / 1000;
    this.lastTimestampMs = timestampMs;

    this.stepFrame(rawDtSec, this.scratchResult);

    if (this.running) {
      this.rafHandle = this.scheduler.requestFrame(this.onFrame);
    }
  };
}
