import { describe, expect, it } from 'vitest';
import { EventBus } from './eventBus';

interface TestEvents {
  ping: { seq: number };
  alert: string;
}

describe('EventBus', () => {
  it('delivers typed payloads and respects once/off/unsubscribe/clear', () => {
    const bus = new EventBus<TestEvents>();
    const seen: number[] = [];
    const alerts: string[] = [];

    const unsub = bus.on('ping', (p) => seen.push(p.seq));
    bus.once('alert', (msg) => alerts.push(msg));

    bus.emit('ping', { seq: 1 });
    bus.emit('alert', 'storm');
    bus.emit('alert', 'second-ignored');

    expect(seen).toEqual([1]);
    expect(alerts).toEqual(['storm']);
    expect(bus.listenerCount('alert')).toBe(0);

    unsub();
    bus.emit('ping', { seq: 2 });
    expect(seen).toEqual([1]);

    const handler = (p: { seq: number }) => seen.push(p.seq * 10);
    bus.on('ping', handler);
    bus.emit('ping', { seq: 3 });
    expect(seen).toEqual([1, 30]);

    bus.off('ping', handler);
    expect(bus.listenerCount()).toBe(0);

    bus.on('alert', (msg) => alerts.push(msg));
    bus.clear('alert');
    expect(bus.listenerCount()).toBe(0);
  });

  it('handles unsubscribe and subscribe safely while inside emit', () => {
    const bus = new EventBus<TestEvents>();
    const log: string[] = [];

    let unsubA: () => void = () => {};
    unsubA = bus.on('ping', (p) => {
      log.push(`A:${p.seq}`);
      unsubA();
      bus.on('ping', (p2) => log.push(`C:${p2.seq}`));
    });
    bus.on('ping', (p) => log.push(`B:${p.seq}`));

    bus.emit('ping', { seq: 1 });
    expect(log).toEqual(['A:1', 'B:1']);

    bus.emit('ping', { seq: 2 });
    expect(log).toEqual(['A:1', 'B:1', 'B:2', 'C:2']);
  });
});
