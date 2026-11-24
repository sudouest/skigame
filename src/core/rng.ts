/**
 * FNV-1a 32-bit string hash for deterministic PRNG seeding.
 */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Stateless deterministic 2D integer hash returning an unsigned 32-bit integer.
 */
export function hashCoords2DU32(ix: number, iz: number, seed = 0): number {
  let h = (seed ^ Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Stateless deterministic 2D integer hash returning a float in [0, 1).
 */
export function hashCoords2D(ix: number, iz: number, seed = 0): number {
  return hashCoords2DU32(ix, iz, seed) / 4294967296;
}

export function normalizeSeedUint(seed: number | string): number {
  if (typeof seed === 'string') {
    return hashString(seed);
  }
  return seed >>> 0;
}

/**
 * Deterministic Mulberry32 PRNG. Zero heap allocations during number generation.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number | string = 1) {
    this.state = normalizeSeedUint(seed);
  }

  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }

  /**
   * Returns a deterministic float in [0, 1).
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns a deterministic float in [min, max).
   */
  nextRange(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /**
   * Returns a deterministic integer in [minInclusive, maxExclusive).
   */
  nextInt(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive) return minInclusive;
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  nextBool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.nextInt(0, items.length)];
  }

  pickWeighted<T>(items: readonly T[], getWeight: (item: T) => number): T | undefined {
    if (items.length === 0) return undefined;
    let totalWeight = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== undefined) {
        const w = getWeight(item);
        if (w > 0) totalWeight += w;
      }
    }
    if (totalWeight <= 0) return items[0];

    let roll = this.next() * totalWeight;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== undefined) {
        const w = getWeight(item);
        if (w > 0) {
          roll -= w;
          if (roll <= 0) return item;
        }
      }
    }
    return items[items.length - 1];
  }

  /**
   * Derives a deterministic child RNG without advancing this generator's state.
   */
  fork(salt: number | string): SeededRng {
    const saltHash = typeof salt === 'string' ? hashString(salt) : salt >>> 0;
    let mixed = (this.state ^ Math.imul(saltHash ^ 0x9e3779b9, 0x85ebca6b)) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0xc2b2ae35) >>> 0;
    mixed = (mixed ^ (mixed >>> 16)) >>> 0;
    return new SeededRng(mixed);
  }
}
