import { describe, expect, it } from 'vitest';
import { Profiler } from './profiler';

describe('Profiler', () => {
  it('accumulates frame, sim, render timings and arbitrary counters without allocations', () => {
    let fakeNow = 100;
    const profiler = new Profiler({
      emaAlpha: 0.5,
      nowMs: () => fakeNow,
    });

    profiler.beginFrame();
    profiler.beginSim();
    fakeNow += 4;
    profiler.endSim(2);

    profiler.beginRender();
    fakeNow += 6;
    profiler.endRender();

    profiler.beginStream();
    fakeNow += 2;
    profiler.endStream();
    profiler.endFrame();

    const snap = profiler.getSnapshot();
    expect(snap.simMs).toBe(4);
    expect(snap.renderMs).toBe(6);
    expect(snap.streamMs).toBe(2);
    expect(snap.frameMs).toBe(12);
    expect(snap.simSteps).toBe(2);
    expect(snap.maxFrameMs).toBe(12);
    expect(snap.fps).toBeCloseTo(1000 / 12, 4);

    profiler.setCounter('drawCalls', 42);
    profiler.incrementCounter('activePines', 3);
    profiler.incrementCounter('activePines', 2);
    expect(profiler.getCounter('drawCalls')).toBe(42);
    expect(profiler.getCounter('activePines')).toBe(5);

    profiler.resetPeaks();
    expect(profiler.getSnapshot().maxFrameMs).toBe(0);

    profiler.resetCounters();
    expect(profiler.getCounter('drawCalls')).toBe(0);
  });
});
