// Core simulation: a continuous stream of "trades" (ticks) driving a random
// walk, bucketed into 1-second base candles. The simulated clock advances by
// each tick's delay, so after a restart the stream continues seamlessly from
// the restored state (same price, same clock — no gap in candle times).
//
// This module is storage-free and DOM-free: it runs identically in Node (the
// always-on server) and could run in a browser. Persistence and higher-
// timeframe rollups are owned by the server's SeriesStore, which subscribes to
// `onTick`. The engine only keeps a short-lived 1-second base internally so it
// can fold ticks into the current candle and report the live bar.

import { gaussian, uniform, pick, clamp } from './rng';
import { SPEED_REGIMES, VOL_REGIMES } from './regimes';
import type { Candle } from './candles';

export type RegimeMode = 'auto' | 'manual';

// Price is a multiplicative (geometric) random walk: always positive, can drift
// arbitrarily close to zero like a crypto asset but never below this floor.
export const MIN_PRICE = 1e-7;

const DEFAULT_START_PRICE = 1000;
// The engine keeps a modest internal base purely so `commitTick` can fold into
// the current second and emit the live bar. The authoritative, long-retention
// 1s series lives in the SeriesStore. A few minutes of head-room is plenty.
const ENGINE_BASE_KEEP = 4096;

export interface RegimeState {
  name: string;
  volName: string;
  minDelay: number;
  maxDelay: number;
  vol: number;
  speedTtl: number;
  volTtl: number;
}

/** Full engine state for persistence (everything except the candle series). */
export interface EngineState {
  price: number;
  startPrice: number;
  simTimeMs: number;
  tickCount: number;
  mode: RegimeMode;
  speedMultiplier: number;
  regime: RegimeState;
}

export interface EngineCallbacks {
  /** Fired on every tick with the new price and the live base (1s) candle. */
  onTick?: (price: number, baseLast: Candle) => void;
}

export class Engine {
  price = DEFAULT_START_PRICE;
  startPrice = DEFAULT_START_PRICE;
  simTimeMs = 0;
  tickCount = 0;
  base: Candle[] = [];

  private regime: RegimeState = {
    name: 'steady',
    volName: 'normal',
    minDelay: 260,
    maxDelay: 620,
    vol: 0.002,
    speedTtl: 0,
    volTtl: 0,
  };
  private mode: RegimeMode = 'auto';
  private speedMultiplier = 1;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cb: EngineCallbacks = {};

  // Rolling tick-rate estimate (ticks per simulated second).
  private rateWindow: number[] = [];

  constructor(cb: EngineCallbacks = {}) {
    this.cb = cb;
  }

  /** Seed a brand-new random chart (in memory; persistence is the caller's job). */
  seedFresh(now = Date.now()): void {
    this.price = DEFAULT_START_PRICE;
    this.startPrice = DEFAULT_START_PRICE;
    this.simTimeMs = now;
    this.tickCount = 0;
    this.base = [];
    this.rateWindow = [];
    this.mode = 'auto';
    this.speedMultiplier = 1;
    this.rollSpeedRegime();
    this.rollVolRegime();
    // Seed an opening candle so the series is never empty.
    const sec = Math.floor(this.simTimeMs / 1000);
    this.base.push({ time: sec, open: this.price, high: this.price, low: this.price, close: this.price, volume: 0 });
  }

  /** Restore engine state. `baseTail` seeds the internal base so the current
   * second continues correctly; pass the persisted 1s series tail. */
  restore(s: EngineState, baseTail: Candle[] = []): void {
    this.price = Math.max(s.price, MIN_PRICE);
    this.startPrice = s.startPrice ?? s.price;
    this.simTimeMs = s.simTimeMs;
    this.tickCount = s.tickCount ?? 0;
    this.mode = s.mode === 'manual' ? 'manual' : 'auto';
    this.speedMultiplier = clamp(s.speedMultiplier ?? 1, 0.1, 10);
    this.regime = {
      name: s.regime.name,
      volName: s.regime.volName ?? 'normal',
      minDelay: s.regime.minDelay,
      maxDelay: s.regime.maxDelay,
      vol: s.regime.vol,
      speedTtl: s.regime.speedTtl,
      volTtl: s.regime.volTtl,
    };
    this.base = baseTail.length ? baseTail.slice(-ENGINE_BASE_KEEP) : [];
    if (this.base.length === 0) {
      const sec = Math.floor(this.simTimeMs / 1000);
      this.base.push({ time: sec, open: this.price, high: this.price, low: this.price, close: this.price, volume: 0 });
    }
  }

  serialize(): EngineState {
    return {
      price: this.price,
      startPrice: this.startPrice,
      simTimeMs: this.simTimeMs,
      tickCount: this.tickCount,
      mode: this.mode,
      speedMultiplier: this.speedMultiplier,
      regime: { ...this.regime },
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

  getSpeedMultiplier(): number {
    return this.speedMultiplier;
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

  /** Stop ticking (no persistence side-effects — the server owns that). */
  pause(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Market-Maker mode: inject one extra tick that nudges the price by `delta`
   * dollars (positive = up, negative = down). The random generator keeps
   * running on its own timer — this is an additional manual tick on top.
   */
  nudge(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    const np = this.price + delta;
    this.price = np < MIN_PRICE ? MIN_PRICE : np;
    this.tickCount++;
    this.commitTick();
    this.trackRate();
    const last = this.base[this.base.length - 1];
    this.cb.onTick?.(this.price, last);
  }

  private nextDelay(): number {
    const d = uniform(this.regime.minDelay, this.regime.maxDelay) / this.speedMultiplier;
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

    this.scheduleNext(this.nextDelay());
  }

  /** Fold the current price into the 1-second base candle. */
  private commitTick(): void {
    const sec = Math.floor(this.simTimeMs / 1000);
    const last = this.base[this.base.length - 1];
    if (!last || sec > last.time) {
      this.base.push({ time: sec, open: this.price, high: this.price, low: this.price, close: this.price, volume: 1 });
      if (this.base.length > ENGINE_BASE_KEEP * 2) {
        this.base.splice(0, this.base.length - ENGINE_BASE_KEEP);
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
}
