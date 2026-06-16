// Persistence layer. The whole simulation state lives in localStorage so the
// chart survives a full shutdown / restart and continues exactly where it left
// off (same price, same simulated clock — no gap).

import type { Candle } from './engine';

const KEY = 'random-walk-terminal:v1';

export interface PersistedRegime {
  minDelay: number;
  maxDelay: number;
  vol: number;
  speedTtl: number;
  volTtl: number;
  name: string;
  volName?: string;
}

export interface PersistedState {
  v: 1;
  price: number;
  simTimeMs: number;
  tickCount: number;
  startPrice: number;
  regime: PersistedRegime;
  /** Compact 1-second base candles: [time, open, high, low, close, volume]. */
  base: number[][];
}

const ROUND = 1e4; // 4 decimals of price precision in storage
const r = (x: number) => (Number.isFinite(x) ? Math.round(x * ROUND) / ROUND : 0);

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function validRegime(r: unknown): r is PersistedRegime {
  const o = r as PersistedRegime;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.name === 'string' &&
    isNum(o.minDelay) &&
    isNum(o.maxDelay) &&
    isNum(o.vol) &&
    isNum(o.speedTtl) &&
    isNum(o.volTtl)
  );
}

export function compactBase(base: Candle[]): number[][] {
  const out: number[][] = new Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const c = base[i];
    out[i] = [c.time, r(c.open), r(c.high), r(c.low), r(c.close), c.volume];
  }
  return out;
}

export function expandBase(raw: number[][]): Candle[] {
  const out: Candle[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    // Tolerate legacy length-5 rows (no volume) by defaulting volume to 0.
    out[i] = { time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a.length > 5 ? a[5] : 0 };
  }
  return out;
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedState;
    if (!p || p.v !== 1) return null;
    // Validate all numeric fields are finite — a corrupt/partial record must
    // fall back to a fresh seed, not boot the engine into a broken state
    // (e.g. a NaN delay would busy-loop, a NaN price would poison every candle).
    if (!isNum(p.price) || !isNum(p.simTimeMs) || !isNum(p.tickCount) || !isNum(p.startPrice)) return null;
    if (!validRegime(p.regime)) return null;
    if (!Array.isArray(p.base)) return null;
    // Each base row must be a length-5 finite tuple with strictly increasing
    // time (the invariant Lightweight Charts requires for setData/update).
    let prevT = -Infinity;
    for (const row of p.base) {
      if (!Array.isArray(row) || row.length < 5) return null;
      if (!isNum(row[0]) || !isNum(row[1]) || !isNum(row[2]) || !isNum(row[3]) || !isNum(row[4])) return null;
      if (row.length > 5 && !isNum(row[5])) return null; // volume, when present
      if (row[0] <= prevT) return null;
      prevT = row[0];
    }
    return p;
  } catch {
    return null;
  }
}

export function saveState(state: PersistedState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    // Quota exceeded — drop the oldest half of the history and retry once.
    try {
      const trimmed: PersistedState = {
        ...state,
        base: state.base.slice(Math.floor(state.base.length / 2)),
      };
      localStorage.setItem(KEY, JSON.stringify(trimmed));
      return true;
    } catch {
      return false;
    }
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// ---- Drawings (horizontal price lines + vertical time lines) ----

const DKEY = 'random-walk-terminal:drawings:v1';

export interface Drawings {
  hlines: number[]; // prices
  vlines: number[]; // UTCTimestamp seconds
  fib: [number, number] | null; // [price0, price100]
}

export function loadDrawings(): Drawings {
  const empty: Drawings = { hlines: [], vlines: [], fib: null };
  try {
    const raw = localStorage.getItem(DKEY);
    if (!raw) return empty;
    const d = JSON.parse(raw) as Drawings;
    const fib =
      Array.isArray(d.fib) && d.fib.length === 2 && isNum(d.fib[0]) && isNum(d.fib[1])
        ? ([d.fib[0], d.fib[1]] as [number, number])
        : null;
    return {
      hlines: Array.isArray(d.hlines) ? d.hlines.filter(isNum) : [],
      vlines: Array.isArray(d.vlines) ? d.vlines.filter(isNum) : [],
      fib,
    };
  } catch {
    return empty;
  }
}

export function saveDrawings(d: Drawings): void {
  try {
    localStorage.setItem(DKEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

export function clearDrawings(): void {
  try {
    localStorage.removeItem(DKEY);
  } catch {
    /* ignore */
  }
}

// ---- View preferences (timeframe + chart type) ----

const PKEY = 'random-walk-terminal:prefs:v1';

export interface Prefs {
  tf: number;
  type: string;
  theme?: string;
  mode?: string;
  speed?: string;
  vol?: string;
}

const ALLOWED_TF = [1, 5, 15, 60, 300];
const ALLOWED_TYPE = ['candles', 'line', 'area'];
const ALLOWED_THEME = ['dark', 'light'];
const ALLOWED_MODE = ['auto', 'manual'];

export function loadPrefs(): Prefs | null {
  try {
    const raw = localStorage.getItem(PKEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Prefs;
    if (!p || !ALLOWED_TF.includes(p.tf) || !ALLOWED_TYPE.includes(p.type)) return null;
    // Optional fields are sanitized but never invalidate the whole record.
    if (p.theme !== undefined && !ALLOWED_THEME.includes(p.theme)) delete p.theme;
    if (p.mode !== undefined && !ALLOWED_MODE.includes(p.mode)) delete p.mode;
    if (typeof p.speed !== 'string') delete p.speed;
    if (typeof p.vol !== 'string') delete p.vol;
    return p;
  } catch {
    return null;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PKEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
