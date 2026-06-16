// Core simulation: a continuous stream of "trades" (ticks) driving a random
// walk, bucketed into 1-second base candles. Higher timeframes are aggregated
// from the base on demand. The simulated clock advances by each tick's delay,
// so after a restart the chart continues seamlessly from the stored state.

import { gaussian, uniform, pick, clamp } from './rng';
import {
  loadState,
  saveState,
  clearState,
  compactBase,
  expandBase,
  type PersistedRegime,
} from './storage';

export interface Candle {
  time: number; // UTCTimestamp, seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // number of ticks ("trades") in this candle
}

export type TfSeconds = 1 | 5 | 15 | 60 | 300;
export type RegimeMode = 'auto' | 'manual';

/** Keep at most this many base (1s) candles in memory / storage. */
const MAX_BASE = 28800; // ~8h of dense 1s data
const TRIM_CHUNK = 1024;
// Persisting the full history is the heaviest recurring cost, so keep it off the
// hot tick path: save at most every few seconds (plus on pause/hide/unload).
const SAVE_DEBOUNCE_MS = 6000;
const DEFAULT_START_PRICE = 1000;
const MAX_TF = 300; // largest supported timeframe — trim on its boundary
// Price is a multiplicative (geometric) random walk: always positive, can drift
// arbitrarily close to zero like a crypto asset but never below this floor.
export const MIN_PRICE = 1e-7;

// Speed regimes control the inter-tick delay range — this is what makes the
// stream visibly speed up and slow down over time.
const SPEED_REGIMES = [
  { name: 'burst', minDelay: 45, maxDelay: 130 },
  { name: 'fast', minDelay: 110, maxDelay: 320 },
  { name: 'steady', minDelay: 260, maxDelay: 620 },
  { name: 'slow', minDelay: 550, maxDelay: 1150 },
  { name: 'sparse', minDelay: 950, maxDelay: 1900 },
] as const;

// Volatility regimes — standard deviation of log-returns per sqrt-second
// (i.e. fractional moves). Multiplicative steps keep the price positive.
const VOL_REGIMES = [
  { name: 'quiet', vol: 0.0008 },
  { name: 'normal', vol: 0.002 },
  { name: 'active', vol: 0.0045 },
  { name: 'wild', vol: 0.01 },
] as const;

export const SPEED_NAMES: string[] = SPEED_REGIMES.map((s) => s.name);
export const VOL_NAMES: string[] = VOL_REGIMES.map((v) => v.name);

interface Regime {
  name: string;
  volName: string;
  minDelay: number;
  maxDelay: number;
  vol: number;
  speedTtl: number;
  volTtl: number;
}

export interface EngineCallbacks {
  /** Fired on every tick with the new price and the live base (1s) candle. */
  onTick?: (price: number, baseLast: Candle) => void;
  /** Fired after state is persisted to storage. */
  onSave?: () => void;
}

export class Engine {
  price = DEFAULT_START_PRICE;
  startPrice = DEFAULT_START_PRICE;
  simTimeMs = 0;
  tickCount = 0;
  base: Candle[] = [];

  private regime: Regime = {
    name: 'steady',
    volName: 'normal',
    minDelay: 260,
    maxDelay: 620,
    vol: 0.5,
    speedTtl: 0,
    volTtl: 0,
  };
  private mode: RegimeMode = 'auto';
  private speedMultiplier = 1;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cb: EngineCallbacks = {};

  // Rolling tick-rate estimate (ticks per second).
  private rateWindow: number[] = [];

  constructor(cb: EngineCallbacks = {}) {
    this.cb = cb;
  }

  /** Restore from storage or seed a fresh chart. Returns true if restored. */
  init(): boolean {
    const s = loadState();
    // Only restore a non-empty, validated record; otherwise seed a fresh chart.
    if (s && s.base.length > 0) {
      this.price = Math.max(s.price, MIN_PRICE);
      this.startPrice = s.startPrice ?? s.price;
      this.simTimeMs = s.simTimeMs;
      this.tickCount = s.tickCount ?? 0;
      this.base = expandBase(s.base);
      this.applyRegime(s.regime);
      return true;
    }
    this.seedFresh();
    return false;
  }

  private seedFresh(): void {
    this.price = DEFAULT_START_PRICE;
    this.startPrice = DEFAULT_START_PRICE;
    this.simTimeMs = Date.now();
    this.tickCount = 0;
    this.base = [];
    this.rateWindow = [];
    this.rollSpeedRegime();
    this.rollVolRegime();
    // Seed an opening candle so the chart is never empty.
    const sec = Math.floor(this.simTimeMs / 1000);
    this.base.push({ time: sec, open: this.price, high: this.price, low: this.price, close: this.price, volume: 0 });
  }

  private applyRegime(r: PersistedRegime): void {
    this.regime = {
      name: r.name,
      volName: r.volName ?? 'normal',
      minDelay: r.minDelay,
      maxDelay: r.maxDelay,
      vol: r.vol,
      speedTtl: r.speedTtl,
      volTtl: r.volTtl,
    };
  }

  private rollSpeedRegime(): void {
    const sr = pick(SPEED_REGIMES);
    this.regime.name = sr.name;
    this.regime.minDelay = sr.minDelay;
    this.regime.maxDelay = sr.maxDelay;
    this.regime.speedTtl = uniform(3500, 14000);
  }

  private rollVolRegime(): void {
    // Bias toward calmer regimes; "wild" is rare.
    const roll = Math.random();
    const vr = roll < 0.35 ? VOL_REGIMES[0] : roll < 0.75 ? VOL_REGIMES[1] : roll < 0.95 ? VOL_REGIMES[2] : VOL_REGIMES[3];
    this.regime.vol = vr.vol;
    this.regime.volName = vr.name;
    this.regime.volTtl = uniform(6000, 22000);
  }

  setSpeedMultiplier(m: number): void {
    this.speedMultiplier = clamp(m, 0.1, 10);
  }

  // ---- Auto / manual regime control ----

  setMode(mode: RegimeMode): void {
    this.mode = mode;
  }

  getMode(): RegimeMode {
    return this.mode;
  }

  /** Manually pin the speed regime (used in manual mode). */
  setManualSpeed(name: string): void {
    const sr = SPEED_REGIMES.find((s) => s.name === name);
    if (!sr) return;
    this.regime.name = sr.name;
    this.regime.minDelay = sr.minDelay;
    this.regime.maxDelay = sr.maxDelay;
  }

  /** Manually pin the volatility regime (used in manual mode). */
  setManualVol(name: string): void {
    const vr = VOL_REGIMES.find((v) => v.name === name);
    if (!vr) return;
    this.regime.vol = vr.vol;
    this.regime.volName = vr.name;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(this.nextDelay());
  }

  private stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  pause(): void {
    this.stop();
    this.saveNow();
  }

  private nextDelay(): number {
    let d = uniform(this.regime.minDelay, this.regime.maxDelay) / this.speedMultiplier;
    return clamp(d, 12, 5000);
  }

  private scheduleNext(delay: number): void {
    this.timer = setTimeout(() => this.fire(delay), delay);
  }

  private fire(delay: number): void {
    if (!this.running) return;

    // In auto mode the regimes drift over time; in manual mode they stay pinned.
    if (this.mode === 'auto') {
      this.regime.speedTtl -= delay;
      this.regime.volTtl -= delay;
      if (this.regime.speedTtl <= 0) this.rollSpeedRegime();
      if (this.regime.volTtl <= 0) this.rollVolRegime();
    }

    // Advance the simulated clock and step the price. Geometric (multiplicative)
    // random walk, no drift: price *= exp(σ·√dt·N(0,1)). Stays strictly positive,
    // can approach (but never cross) MIN_PRICE — like a crypto asset toward zero.
    this.simTimeMs += delay;
    const dt = delay / 1000;
    const factor = Math.exp(gaussian() * this.regime.vol * Math.sqrt(dt));
    if (Number.isFinite(factor)) this.price *= factor;
    if (this.price < MIN_PRICE) this.price = MIN_PRICE;
    this.tickCount++;

    this.commitTick();
    this.trackRate();

    const last = this.base[this.base.length - 1];
    this.cb.onTick?.(this.price, last);

    this.scheduleSave();
    this.scheduleNext(this.nextDelay());
  }

  /** Fold the current price into the 1-second base candle. */
  private commitTick(): void {
    const sec = Math.floor(this.simTimeMs / 1000);
    const last = this.base[this.base.length - 1];
    if (!last || sec > last.time) {
      this.base.push({ time: sec, open: this.price, high: this.price, low: this.price, close: this.price, volume: 1 });
      if (this.base.length > MAX_BASE + TRIM_CHUNK) {
        // Trim on a 5m boundary so the oldest aggregated bar keeps a true open.
        let cut = this.base.length - MAX_BASE;
        while (cut < this.base.length && this.base[cut].time % MAX_TF !== 0) cut++;
        this.base.splice(0, cut);
      }
    } else {
      if (this.price > last.high) last.high = this.price;
      if (this.price < last.low) last.low = this.price;
      last.close = this.price;
      last.volume++;
    }
  }

  private trackRate(): void {
    const now = this.simTimeMs;
    this.rateWindow.push(now);
    const cutoff = now - 1000;
    while (this.rateWindow.length && this.rateWindow[0] < cutoff) {
      this.rateWindow.shift();
    }
  }

  /** Ticks observed in the last simulated second. */
  ticksPerSecond(): number {
    return this.rateWindow.length;
  }

  regimeName(): string {
    return this.regime.name;
  }

  volName(): string {
    return this.regime.volName;
  }

  // ---- Persistence ----

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  saveNow(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveState({
      v: 2,
      price: this.price,
      simTimeMs: this.simTimeMs,
      tickCount: this.tickCount,
      startPrice: this.startPrice,
      regime: {
        name: this.regime.name,
        volName: this.regime.volName,
        minDelay: this.regime.minDelay,
        maxDelay: this.regime.maxDelay,
        vol: this.regime.vol,
        speedTtl: this.regime.speedTtl,
        volTtl: this.regime.volTtl,
      },
      // Cap persisted history to MAX_BASE regardless of in-memory overshoot.
      base: compactBase(this.base.length > MAX_BASE ? this.base.slice(-MAX_BASE) : this.base),
    });
    this.cb.onSave?.();
  }

  /** Wipe everything and seed a brand-new random chart. */
  reset(): void {
    // Stop WITHOUT saving so we don't persist the soon-to-be-deleted state,
    // then clear, seed fresh, and durably persist the new state.
    this.stop();
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    clearState();
    this.seedFresh();
    this.saveNow();
  }
}

// ---- Timeframe aggregation (pure functions) ----

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
  const key = tf === 1 ? lastT : Math.floor(lastT / tf) * tf;
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
