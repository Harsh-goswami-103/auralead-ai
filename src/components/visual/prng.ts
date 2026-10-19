/**
 * Deterministic pseudo-random numbers for decorative particles (design spec §0.10). mulberry32
 * uses only 32-bit integer math, so the server render, every browser and Vitest produce the same
 * sequence for a seed and particle styles never cause a hydration mismatch. Never use it for data.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value in [min, max) from the generator, rounded so inline styles serialize identically. */
export function between(next: () => number, min: number, max: number, digits = 2): number {
  return Number((min + next() * (max - min)).toFixed(digits));
}
