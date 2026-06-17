// Random helpers for the tick generator.
// Fully stochastic — no fixed seed. A standard-normal sampler drives the
// random walk so the price can wander freely (multiplicative, stays positive).

let spare: number | null = null;

/** Standard normal sample (mean 0, variance 1) via Box-Muller with a cached spare. */
export function gaussian(): number {
  if (spare !== null) {
    const v = spare;
    spare = null;
    return v;
  }
  let u = 0;
  let v = 0;
  let s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  spare = v * mul;
  return u * mul;
}

/** Uniform float in [min, max). */
export function uniform(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Pick a random element. */
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
