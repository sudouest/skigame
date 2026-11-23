export interface ObjectPoolOptions<T> {
  readonly factory: () => T;
  readonly reset?: (item: T) => void;
  readonly initialCapacity?: number;
  readonly maxCapacity?: number;
}

/**
 * Pre-warmable reusable object pool to avoid hot-loop allocations.
 */
export class ObjectPool<T> {
  private readonly factory: () => T;
  private readonly resetFn: ((item: T) => void) | undefined;
  private readonly maxCapacity: number;
  private readonly freeList: T[] = [];
  private _activeCount = 0;
  private _totalCreated = 0;

  constructor(options: ObjectPoolOptions<T>) {
    this.factory = options.factory;
    this.resetFn = options.reset;
    this.maxCapacity = options.maxCapacity ?? Number.POSITIVE_INFINITY;
    const initial = options.initialCapacity ?? 0;
    if (initial > 0) {
      this.prewarm(initial);
    }
  }

  get freeCount(): number {
    return this.freeList.length;
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get totalCreated(): number {
    return this._totalCreated;
  }

  prewarm(targetFreeCount: number): void {
    const cap = Math.min(targetFreeCount, this.maxCapacity);
    while (this.freeList.length < cap) {
      const item = this.factory();
      this._totalCreated++;
      this.freeList.push(item);
    }
  }

  acquire(): T {
    this._activeCount++;
    const recycled = this.freeList.pop();
    if (recycled !== undefined) {
      return recycled;
    }
    this._totalCreated++;
    return this.factory();
  }

  release(item: T): void {
    if (this._activeCount > 0) {
      this._activeCount--;
    }
    this.resetFn?.(item);
    if (this.freeList.length < this.maxCapacity) {
      this.freeList.push(item);
    }
  }

  /**
   * Releases all items in the given array back to the pool and clears the array in-place.
   */
  releaseAll(items: T[]): void {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== undefined) {
        this.release(item);
      }
    }
    items.length = 0;
  }
}
