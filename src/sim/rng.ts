export type Rng = () => number;

/** Small seeded PRNG so a world can be regenerated from its seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const pick = <T>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length)];
export const between = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
export const chance = (r: Rng, p: number) => r() < p;

/** Roughly normal (sum of three uniforms), clamped to 0..1. */
export const normal01 = (r: Rng, mean: number, sd: number) => clamp01(mean + (r() + r() + r() - 1.5) * sd * 2);

/** Pick up to n distinct items. */
export function sample<T>(r: Rng, a: readonly T[], n: number): T[] {
  const copy = [...a];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(r() * copy.length), 1)[0]);
  return out;
}

/** Sample an index from weights (need not sum to 1). */
export function weighted(r: Rng, weights: number[]): number {
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total <= 0) return Math.floor(r() * weights.length);
  let x = r() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= Math.max(0, weights[i]);
    if (x <= 0) return i;
  }
  return weights.length - 1;
}
