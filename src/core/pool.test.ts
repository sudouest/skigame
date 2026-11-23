import { describe, expect, it } from 'vitest';
import { ObjectPool } from './pool';

describe('ObjectPool', () => {
  it('prewarms, reuses released objects, and calls reset hooks', () => {
    let idCounter = 0;
    const pool = new ObjectPool({
      factory: () => ({ id: ++idCounter, value: 0 }),
      reset: (item) => {
        item.value = 0;
      },
      initialCapacity: 3,
      maxCapacity: 4,
    });

    expect(pool.freeCount).toBe(3);
    expect(pool.totalCreated).toBe(3);
    expect(pool.activeCount).toBe(0);

    const a = pool.acquire();
    const b = pool.acquire();
    a.value = 99;
    expect(pool.activeCount).toBe(2);
    expect(pool.freeCount).toBe(1);
    expect(pool.totalCreated).toBe(3);

    pool.release(a);
    expect(a.value).toBe(0);
    expect(pool.activeCount).toBe(1);
    expect(pool.freeCount).toBe(2);

    const aReused = pool.acquire();
    expect(aReused).toBe(a);

    const active = [aReused, b, pool.acquire(), pool.acquire(), pool.acquire()];
    expect(pool.totalCreated).toBe(5);
    pool.releaseAll(active);
    expect(active).toHaveLength(0);
    expect(pool.activeCount).toBe(0);
    expect(pool.freeCount).toBe(4); // capped by maxCapacity
  });
});
