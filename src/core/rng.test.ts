import { describe, expect, it } from 'vitest';
import { SeededRng, hashCoords2D, hashString } from './rng';

describe('SeededRng', () => {
  it('produces identical deterministic sequences for identical seeds', () => {
    const a = new SeededRng('sunny-blue-run');
    const b = new SeededRng('sunny-blue-run');
    const c = new SeededRng('icy-black-diamond');

    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    const seqC = Array.from({ length: 16 }, () => c.next());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('supports range, int, weighted pick, state save/restore, and independent fork', () => {
    const rng = new SeededRng(42);
    for (let i = 0; i < 50; i++) {
      const r = rng.nextRange(-5, 12);
      expect(r).toBeGreaterThanOrEqual(-5);
      expect(r).toBeLessThan(12);
      const n = rng.nextInt(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThan(7);
      expect(Number.isInteger(n)).toBe(true);
    }

    const saved = rng.getState();
    const fork1 = rng.fork('chunk-7');
    const fork2 = rng.fork('chunk-7');
    expect(fork1.next()).toBe(fork2.next());
    expect(rng.getState()).toBe(saved);

    const nextExpected = rng.next();
    rng.setState(saved);
    expect(rng.next()).toBe(nextExpected);

    const items = [
      { id: 'rare', w: 0 },
      { id: 'common', w: 10 },
    ];
    for (let i = 0; i < 20; i++) {
      expect(rng.pickWeighted(items, (x) => x.w)?.id).toBe('common');
    }

    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashCoords2D(12, -8, 99)).toBe(hashCoords2D(12, -8, 99));
  });
});
