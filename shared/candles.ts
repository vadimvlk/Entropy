// Candle model + timeframe ladder + pure aggregation helpers. Shared by the
// server (authoritative rollups + persistence) and the browser (types + the
// occasional client-side time-extrapolation in the chart tools).

export interface Candle {
  time: number; // UTCTimestamp, seconds (bucket start)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // number of ticks ("trades") folded into this candle
}

// The full TradingView-style ladder, in seconds. 1/5/15s are the "live" feel;
// 1m and up are the market-structure view.
export type TfSeconds = 1 | 5 | 15 | 60 | 300 | 900 | 1800 | 3600 | 14400 | 43200 | 86400;

export const ALL_TF: readonly TfSeconds[] = [
  1, 5, 15, 60, 300, 900, 1800, 3600, 14400, 43200, 86400,
];

export const TF_LABEL: Record<TfSeconds, string> = {
  1: '1s',
  5: '5s',
  15: '15s',
  60: '1m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '1h',
  14400: '4h',
  43200: '12h',
  86400: '1d',
};

// Sub-minute timeframes are grouped behind a dropdown in the UI so the panel
// isn't 11 buttons wide.
export const SECOND_TFS: readonly TfSeconds[] = [1, 5, 15];
export const MAIN_TFS: readonly TfSeconds[] = [60, 300, 900, 1800, 3600, 14400, 43200, 86400];

// Retention caps (max bars kept per timeframe). The 1-second series is pinned
// to at least 24h of dense data per the design; every coarser series keeps a
// generous fixed bar count. With these defaults the deep timeframes still span
// from days (5s) to decades (1d) while total storage stays in the low MBs.
export const BASE_CAP = 86_400; // 24h of 1s candles — hard minimum
const ROLLUP_CAP = 20_000;

export const TF_CAP: Record<TfSeconds, number> = {
  1: BASE_CAP,
  5: ROLLUP_CAP,
  15: ROLLUP_CAP,
  60: ROLLUP_CAP,
  300: ROLLUP_CAP,
  900: ROLLUP_CAP,
  1800: ROLLUP_CAP,
  3600: ROLLUP_CAP,
  14400: ROLLUP_CAP,
  43200: ROLLUP_CAP,
  86400: ROLLUP_CAP,
};

export function isTf(n: unknown): n is TfSeconds {
  return typeof n === 'number' && (ALL_TF as readonly number[]).includes(n);
}

/** The bucket-start time a given second belongs to for a timeframe. */
export function bucketOf(timeSec: number, tf: TfSeconds): number {
  return tf === 1 ? timeSec : Math.floor(timeSec / tf) * tf;
}

/** Build a full higher-timeframe series from 1-second base candles. */
export function aggregate(base: Candle[], tf: TfSeconds): Candle[] {
  if (tf === 1) return base.slice();
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curKey = -1;
  for (let i = 0; i < base.length; i++) {
    const c = base[i];
    const key = Math.floor(c.time / tf) * tf;
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      curKey = key;
    } else {
      if (c.high > cur!.high) cur!.high = c.high;
      if (c.low < cur!.low) cur!.low = c.low;
      cur!.close = c.close;
      cur!.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Recompute only the most recent aggregated bucket (cheap, ≤ tf base candles).
 * Used for live `series.update()` calls on every tick.
 */
export function lastGroup(base: Candle[], tf: TfSeconds): Candle | null {
  const n = base.length;
  if (n === 0) return null;
  const lastT = base[n - 1].time;
  const key = bucketOf(lastT, tf);
  let high = -Infinity;
  let low = Infinity;
  let open = base[n - 1].open;
  let volume = 0;
  const close = base[n - 1].close;
  for (let i = n - 1; i >= 0; i--) {
    const c = base[i];
    if (c.time < key) break;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume;
    open = c.open; // earliest in-group candle wins (loop ends on it)
  }
  return { time: key, open, high, low, close, volume };
}

// Compact wire/storage form: [time, open, high, low, close, volume].
export type CompactCandle = [number, number, number, number, number, number];

const PRICE_ROUND = 1e4; // 4 decimals of price precision on the wire / in storage
const r = (x: number) => (Number.isFinite(x) ? Math.round(x * PRICE_ROUND) / PRICE_ROUND : 0);

export function compact(c: Candle): CompactCandle {
  return [c.time, r(c.open), r(c.high), r(c.low), r(c.close), c.volume];
}

export function expand(a: CompactCandle | number[]): Candle {
  return { time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a.length > 5 ? a[5] : 0 };
}
