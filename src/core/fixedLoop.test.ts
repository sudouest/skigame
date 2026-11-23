import { describe, expect, it } from 'vitest';
import { FIXED_DT, FixedLoop, MAX_FRAME_TIME, type FrameScheduler } from './fixedLoop';
import { Profiler } from './profiler';

describe('FixedLoop', () => {
  it('executes deterministic 60 Hz steps with alpha interpolation and MAX_FRAME_TIME clamping', () => {
    const events: string[] = [];
    let renderCalls = 0;
    let lastAlpha = -1;
    const profiler = new Profiler();

    const loop = new FixedLoop({
      onCapturePreviousPose: () => events.push('capture'),
      onFixedStep: (dt) => {
        expect(dt).toBe(FIXED_DT);
        events.push('step');
      },
      onRender: (alpha) => {
        renderCalls++;
        lastAlpha = alpha;
      },
      profiler,
    });

    // Half step accumulates without stepping
    const r1 = loop.stepFrame(FIXED_DT * 0.5);
    expect(r1.stepsExecuted).toBe(0);
    expect(r1.alpha).toBeCloseTo(0.5, 6);
    expect(events).toEqual([]);
    expect(renderCalls).toBe(1);

    // Another full step crosses 1.5 * FIXED_DT => 1 step, alpha ~ 0.5
    const r2 = loop.stepFrame(FIXED_DT);
    expect(r2.stepsExecuted).toBe(1);
    expect(r2.alpha).toBeCloseTo(0.5, 6);
    expect(lastAlpha).toBeCloseTo(0.5, 6);
    expect(events).toEqual(['capture', 'step']);

    // Huge frame spike (1.5s) clamps strictly to MAX_FRAME_TIME = 0.25s
    loop.resetAccumulator();
    events.length = 0;
    const rSpike = loop.stepFrame(1.5);
    expect(rSpike.clampedDtSec).toBe(MAX_FRAME_TIME);
    expect(rSpike.stepsExecuted).toBeGreaterThanOrEqual(14);
    expect(rSpike.stepsExecuted).toBeLessThanOrEqual(15);
    expect(events[0]).toBe('capture');
    expect(events[1]).toBe('step');
  });

  it('freezes accumulator while paused and supports injectable FrameScheduler', () => {
    let steps = 0;
    let renders = 0;
    let scheduledCb: ((ts: number) => void) | null = null;
    let cancelled = false;

    const scheduler: FrameScheduler = {
      requestFrame: (cb) => {
        scheduledCb = cb;
        return 7;
      },
      cancelFrame: () => {
        cancelled = true;
      },
    };

    const loop = new FixedLoop({
      onFixedStep: () => {
        steps++;
      },
      onRender: () => {
        renders++;
      },
      scheduler,
    });

    loop.pause();
    const pausedRes = loop.stepFrame(0.1);
    expect(pausedRes.stepsExecuted).toBe(0);
    expect(steps).toBe(0);
    expect(renders).toBe(1);

    loop.resume();
    loop.start();
    expect(loop.isRunning).toBe(true);
    expect(scheduledCb).not.toBeNull();

    scheduledCb!(1000);
    scheduledCb!(1000 + FIXED_DT * 1000 * 2);
    expect(steps).toBeGreaterThanOrEqual(2);

    loop.stop();
    expect(loop.isRunning).toBe(false);
    expect(cancelled).toBe(true);
  });
});
