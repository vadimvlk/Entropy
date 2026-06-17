// Speed + volatility regimes for the tick generator. Extracted into shared/ so
// both the engine (server) and the UI controls (client manual-mode selects) can
// reference the same canonical lists without dragging the whole Engine into the
// browser bundle.

// Speed regimes control the inter-tick delay range — this is what makes the
// stream visibly speed up and slow down over time. Delays are in ms; the rough
// tick-rate is 1000/delay. Even the slowest regime ("sparse") stays ≥ ~4.5
// ticks/sec so the feed never feels dead.
export const SPEED_REGIMES = [
  { name: 'burst', minDelay: 20, maxDelay: 55 }, // ~18–50 t/s
  { name: 'fast', minDelay: 50, maxDelay: 110 }, // ~9–20 t/s
  { name: 'steady', minDelay: 90, maxDelay: 160 }, // ~6–11 t/s
  { name: 'slow', minDelay: 140, maxDelay: 200 }, // ~5–7 t/s
  { name: 'sparse', minDelay: 170, maxDelay: 220 }, // ~4.5–6 t/s
] as const;

// Volatility regimes — standard deviation of log-returns per sqrt-second (i.e.
// fractional moves). Multiplicative steps keep the price positive.
export const VOL_REGIMES = [
  { name: 'quiet', vol: 0.0008 },
  { name: 'normal', vol: 0.002 },
  { name: 'active', vol: 0.0045 },
  { name: 'wild', vol: 0.01 },
] as const;

export const SPEED_NAMES: string[] = SPEED_REGIMES.map((s) => s.name);
export const VOL_NAMES: string[] = VOL_REGIMES.map((v) => v.name);
