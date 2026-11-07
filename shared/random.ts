/** Small deterministic PRNG, so the opt-in demo data comes out the same every time. */
export function seeded(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  }
}

export function round(n: number, step = 1): number {
  return Math.round(n / step) * step
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

export function mean(xs: readonly number[]): number {
  return xs.length ? sum(xs) / xs.length : 0
}
