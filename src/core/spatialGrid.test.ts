import { describe, expect, it } from 'vitest';
import { SpatialGrid, SpatialGridPair } from './spatialGrid';

describe('SpatialGrid & SpatialGridPair', () => {
  it('deduplicates multi-cell items, respects radii, and supports zero-alloc queries', () => {
    const grid = new SpatialGrid<string>(8);
    grid.insert('boulder', 7.5, 7.5, 3.0);
    grid.insert('pine', -12.0, 20.0, 1.5);

    const out: string[] = [];
    const count = grid.queryRadius(10.0, 10.0, 1.0, out);
    // distance between (7.5,7.5) and (10,10) is sqrt(12.5) ~ 3.535 <= 3.0 + 1.0
    expect(count).toBe(1);
    expect(out).toEqual(['boulder']);

    // Reusing the same output array clears previous entries cleanly
    const count2 = grid.queryRadius(100, 100, 2, out);
    expect(count2).toBe(0);
    expect(out).toEqual([]);

    expect(grid.hasOverlap(-11.0, 20.0, 1.0)).toBe(true);
    expect(grid.hasOverlap(0, 0, 1.0)).toBe(false);

    const visited: string[] = [];
    grid.forEachInRadius(-12, 20, 30, (item) => {
      visited.push(item);
      return false; // early exit after first hit
    });
    expect(visited).toHaveLength(1);
  });

  it('maintains exact lookups across floating-origin shiftOrigin rebasing', () => {
    const grid = new SpatialGrid<string>(10);
    grid.insert('cabin', 310, -280, 4);

    // Rebase world coordinates by subtracting (256, -256)
    grid.shiftOrigin(256, -256);

    const out: string[] = [];
    grid.queryRadius(310 - 256, -280 - -256, 1, out);
    expect(out).toEqual(['cabin']);

    grid.clear();
    expect(grid.size).toBe(0);
    expect(grid.hasOverlap(54, -24, 1)).toBe(false);
  });

  it('queries both grids in SpatialGridPair without duplicates across grids', () => {
    const chunkScenery = new SpatialGrid<string>(12);
    const stageLayout = new SpatialGrid<string>(12);
    chunkScenery.insert('rock_1', 2, 2, 1);
    stageLayout.insert('delivery_arch', 5, 2, 2);

    const pair = new SpatialGridPair(chunkScenery, stageLayout);
    const out: string[] = [];
    const found = pair.queryRadius(3.5, 2, 1.5, out);

    expect(found).toBe(2);
    expect(out).toEqual(['rock_1', 'delivery_arch']);
    expect(pair.hasOverlap(5, 2, 0.5)).toBe(true);
    expect(pair.hasOverlap(50, 50, 1)).toBe(false);
  });
});
