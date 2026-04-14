/**
 * File: src/lib/seededRandom.ts
 *
 * Purpose:
 *   Provide deterministic pseudo-random helpers so input generation and run
 *   subsampling stay reproducible across browsers and sessions.
 *
 * Usage example:
 *   const rng = createSeededRng(9101);
 *   const idx = sampleInt(rng, 0, 10);
 *
 * Notes:
 *   - Mulberry32 is compact and deterministic for this experimental tooling.
 *   - This module intentionally avoids global Math.random mutation.
 */

export type SeededRng = () => number;

/**
 * Create a deterministic RNG that returns values in [0, 1).
 */
export function createSeededRng(seedInput: number): SeededRng {
  let seed = seedInput >>> 0;
  return () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform integer sample in [min, max] inclusive.
 */
export function sampleInt(rng: SeededRng, min: number, max: number): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  if (high < low) {
    return low;
  }
  return low + Math.floor(rng() * (high - low + 1));
}

/**
 * Deterministic in-place Fisher-Yates shuffle.
 */
export function shuffleInPlace<T>(arr: T[], rng: SeededRng): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = sampleInt(rng, 0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Deterministically choose k unique indices from [0, n-1].
 */
export function chooseSortedIndices(rng: SeededRng, n: number, k: number): number[] {
  const pool = Array.from({ length: n }, (_, i) => i);
  shuffleInPlace(pool, rng);
  return pool.slice(0, k).sort((a, b) => a - b);
}

/**
 * Choose one item deterministically from a non-empty array.
 */
export function chooseOne<T>(rng: SeededRng, items: T[]): T {
  if (items.length === 0) {
    throw new Error('chooseOne called with empty array');
  }
  const idx = sampleInt(rng, 0, items.length - 1);
  return items[idx];
}
