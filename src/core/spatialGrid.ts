interface GridEntry<T> {
  item: T;
  x: number;
  z: number;
  radius: number;
  stamp: number;
}

const CELL_OFFSET = 0x2000000;
const CELL_STRIDE = 0x4000000;

function packCell(cx: number, cz: number): number {
  const ux = (cx + CELL_OFFSET) >>> 0;
  const uz = (cz + CELL_OFFSET) >>> 0;
  return ux * CELL_STRIDE + uz;
}

/**
 * World (X, Z) spatial hash supporting circular footprints and zero-allocation hot-loop queries.
 * Non-reentrant during query traversal on the same grid instance.
 */
export class SpatialGrid<T> {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly entries: GridEntry<T>[] = [];
  private activeEntryCount = 0;
  private readonly buckets = new Map<number, number[]>();
  private readonly freeBuckets: number[][] = [];
  private queryStamp = 0;
  private originOffsetX = 0;
  private originOffsetZ = 0;

  constructor(cellSize = 16) {
    if (cellSize <= 0) {
      throw new Error(`SpatialGrid cellSize must be positive, got ${cellSize}`);
    }
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  get size(): number {
    return this.activeEntryCount;
  }

  get cellExtent(): number {
    return this.cellSize;
  }

  /**
   * Shifts the spatial hash lookup origin when floating-origin rebasing subtracts (deltaX, deltaZ)
   * from active world coordinates, avoiding O(N) re-hashing for static grids.
   */
  shiftOrigin(deltaX: number, deltaZ: number): void {
    this.originOffsetX += deltaX;
    this.originOffsetZ += deltaZ;
  }

  insert(item: T, x: number, z: number, radius = 0): void {
    const r = radius > 0 ? radius : 0;
    const gx = x + this.originOffsetX;
    const gz = z + this.originOffsetZ;

    let entryIdx: number;
    if (this.activeEntryCount < this.entries.length) {
      entryIdx = this.activeEntryCount;
      const existing = this.entries[entryIdx]!;
      existing.item = item;
      existing.x = gx;
      existing.z = gz;
      existing.radius = r;
      existing.stamp = 0;
    } else {
      entryIdx = this.entries.length;
      this.entries.push({ item, x: gx, z: gz, radius: r, stamp: 0 });
    }
    this.activeEntryCount++;

    const minCx = Math.floor((gx - r) * this.invCellSize);
    const maxCx = Math.floor((gx + r) * this.invCellSize);
    const minCz = Math.floor((gz - r) * this.invCellSize);
    const maxCz = Math.floor((gz + r) * this.invCellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = packCell(cx, cz);
        let bucket = this.buckets.get(key);
        if (!bucket) {
          bucket = this.freeBuckets.pop() ?? [];
          this.buckets.set(key, bucket);
        }
        bucket.push(entryIdx);
      }
    }
  }

  /**
   * Populates caller-provided output array with matching items within (radius + item.radius).
   * Clears `out` before appending unless `append` is true. Returns number of items added.
   */
  queryRadius(x: number, z: number, radius: number, out: T[], append = false): number {
    if (!append) {
      out.length = 0;
    }
    const r = radius > 0 ? radius : 0;
    const gx = x + this.originOffsetX;
    const gz = z + this.originOffsetZ;
    const stamp = this.nextStamp();

    const minCx = Math.floor((gx - r) * this.invCellSize);
    const maxCx = Math.floor((gx + r) * this.invCellSize);
    const minCz = Math.floor((gz - r) * this.invCellSize);
    const maxCz = Math.floor((gz + r) * this.invCellSize);

    let matched = 0;
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.buckets.get(packCell(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const idx = bucket[i]!;
          const entry = this.entries[idx]!;
          if (entry.stamp === stamp) continue;
          entry.stamp = stamp;

          const dx = entry.x - gx;
          const dz = entry.z - gz;
          const combinedR = r + entry.radius;
          if (dx * dx + dz * dz <= combinedR * combinedR) {
            out.push(entry.item);
            matched++;
          }
        }
      }
    }
    return matched;
  }

  /**
   * Zero-allocation callback traversal over matching items. Return `false` to stop early.
   */
  forEachInRadius(
    x: number,
    z: number,
    radius: number,
    visitor: (item: T, distSq: number) => boolean | void,
  ): void {
    const r = radius > 0 ? radius : 0;
    const gx = x + this.originOffsetX;
    const gz = z + this.originOffsetZ;
    const stamp = this.nextStamp();

    const minCx = Math.floor((gx - r) * this.invCellSize);
    const maxCx = Math.floor((gx + r) * this.invCellSize);
    const minCz = Math.floor((gz - r) * this.invCellSize);
    const maxCz = Math.floor((gz + r) * this.invCellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.buckets.get(packCell(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const idx = bucket[i]!;
          const entry = this.entries[idx]!;
          if (entry.stamp === stamp) continue;
          entry.stamp = stamp;

          const dx = entry.x - gx;
          const dz = entry.z - gz;
          const distSq = dx * dx + dz * dz;
          const combinedR = r + entry.radius;
          if (distSq <= combinedR * combinedR) {
            if (visitor(entry.item, distSq) === false) {
              return;
            }
          }
        }
      }
    }
  }

  hasOverlap(x: number, z: number, radius: number): boolean {
    const r = radius > 0 ? radius : 0;
    const gx = x + this.originOffsetX;
    const gz = z + this.originOffsetZ;
    const stamp = this.nextStamp();

    const minCx = Math.floor((gx - r) * this.invCellSize);
    const maxCx = Math.floor((gx + r) * this.invCellSize);
    const minCz = Math.floor((gz - r) * this.invCellSize);
    const maxCz = Math.floor((gz + r) * this.invCellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.buckets.get(packCell(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const idx = bucket[i]!;
          const entry = this.entries[idx]!;
          if (entry.stamp === stamp) continue;
          entry.stamp = stamp;

          const dx = entry.x - gx;
          const dz = entry.z - gz;
          const combinedR = r + entry.radius;
          if (dx * dx + dz * dz <= combinedR * combinedR) {
            return true;
          }
        }
      }
    }
    return false;
  }

  clear(): void {
    this.activeEntryCount = 0;
    this.originOffsetX = 0;
    this.originOffsetZ = 0;
    for (const bucket of this.buckets.values()) {
      bucket.length = 0;
      this.freeBuckets.push(bucket);
    }
    this.buckets.clear();
  }

  private nextStamp(): number {
    this.queryStamp++;
    if (this.queryStamp >= 0x7fffffff) {
      for (let i = 0; i < this.activeEntryCount; i++) {
        this.entries[i]!.stamp = 0;
      }
      this.queryStamp = 1;
    }
    return this.queryStamp;
  }
}

/**
 * Dual-grid query coordinator (e.g., chunk scenery grid + stage layout requirements grid).
 */
export class SpatialGridPair<A, B = A> {
  readonly primary: SpatialGrid<A>;
  readonly secondary: SpatialGrid<B>;

  constructor(primary: SpatialGrid<A>, secondary: SpatialGrid<B>) {
    this.primary = primary;
    this.secondary = secondary;
  }

  queryRadius(x: number, z: number, radius: number, out: (A | B)[]): number {
    out.length = 0;
    const countA = this.primary.queryRadius(x, z, radius, out as A[], true);
    const countB = this.secondary.queryRadius(x, z, radius, out as B[], true);
    return countA + countB;
  }

  forEachInRadius(
    x: number,
    z: number,
    radius: number,
    visitor: (item: A | B, distSq: number) => boolean | void,
  ): void {
    let stopped = false;
    this.primary.forEachInRadius(x, z, radius, (item, distSq) => {
      if (visitor(item, distSq) === false) {
        stopped = true;
        return false;
      }
      return true;
    });
    if (stopped) return;
    this.secondary.forEachInRadius(x, z, radius, visitor);
  }

  hasOverlap(x: number, z: number, radius: number): boolean {
    return this.primary.hasOverlap(x, z, radius) || this.secondary.hasOverlap(x, z, radius);
  }
}
