// Authoritative, in-memory multi-timeframe store. Subscribes to the engine's
// tick stream and folds each tick into the current bucket of every timeframe
// (1s base + rollups), enforcing per-TF retention caps. Periodically flushes
// dirty bars + engine state to the Db in debounced batches.
//
// Folding ticks directly is equivalent to aggregating the 1s base: a bucket's
// open is the first tick in it, high/low/close track the extremes/last, and
// volume counts ticks — identical to aggregate() over the base candles.

import { ALL_TF, TF_CAP, bucketOf, type Candle, type TfSeconds } from '../shared/candles';
import type { Engine } from '../shared/engine';
import type { Batch, Db, LoadedState } from './db';

interface Series {
  tf: TfSeconds;
  cap: number;
  bars: Candle[];
  dirtyFrom: number | null; // earliest bar time changed since last flush
  pendingPruneT: number | null; // delete DB rows with t < this on next flush
}

const META_KEY = 'engineState';

export class SeriesStore {
  private series = new Map<TfSeconds, Series>();

  constructor(private engine: Engine, private db: Db) {
    for (const tf of ALL_TF) {
      this.series.set(tf, { tf, cap: TF_CAP[tf], bars: [], dirtyFrom: null, pendingPruneT: null });
    }
  }

  /** Repopulate series from a loaded DB snapshot (already persisted → not dirty). */
  restore(loaded: LoadedState): void {
    for (const tf of ALL_TF) {
      const s = this.series.get(tf)!;
      const arr = loaded.series.get(tf);
      s.bars = arr ? arr.slice(-s.cap) : [];
      s.dirtyFrom = null;
      s.pendingPruneT = null;
    }
  }

  /** The persisted 1s tail used to seed the engine's internal base on boot. */
  baseTail(): Candle[] {
    return this.series.get(1)!.bars;
  }

  /** Fold one tick (price at second `t`) into every timeframe. */
  onTick(price: number, t: number): void {
    for (const s of this.series.values()) {
      const key = bucketOf(t, s.tf);
      const last = s.bars.length ? s.bars[s.bars.length - 1] : null;
      if (!last || key > last.time) {
        s.bars.push({ time: key, open: price, high: price, low: price, close: price, volume: 1 });
        this.markDirty(s, key);
        this.trim(s);
      } else if (key === last.time) {
        if (price > last.high) last.high = price;
        if (price < last.low) last.low = price;
        last.close = price;
        last.volume++;
        this.markDirty(s, last.time);
      }
      // key < last.time can't happen: the simulated clock is monotonic.
    }
  }

  private markDirty(s: Series, barTime: number): void {
    if (s.dirtyFrom === null || barTime < s.dirtyFrom) s.dirtyFrom = barTime;
  }

  private trim(s: Series): void {
    if (s.bars.length > s.cap) {
      s.bars.splice(0, s.bars.length - s.cap);
      s.pendingPruneT = s.bars[0].time; // drop anything older from the DB too
    }
  }

  /** Most-recent `limit` bars for a timeframe (ascending). */
  getSeries(tf: TfSeconds, limit?: number): Candle[] {
    const s = this.series.get(tf);
    if (!s) return [];
    return limit && limit < s.bars.length ? s.bars.slice(s.bars.length - limit) : s.bars.slice();
  }

  /** The live (current) bar for a timeframe, or null. */
  liveBar(tf: TfSeconds): Candle | null {
    const s = this.series.get(tf);
    return s && s.bars.length ? s.bars[s.bars.length - 1] : null;
  }

  baseCount(): number {
    return this.series.get(1)!.bars.length;
  }

  /** Build the pending write batch and clear dirty markers. */
  private buildBatch(): Batch {
    const batch: Batch = { candles: [], prune: [], meta: {} };
    for (const s of this.series.values()) {
      if (s.dirtyFrom !== null) {
        // Collect the dirty tail (bars with time >= dirtyFrom), ascending.
        let i = s.bars.length - 1;
        while (i >= 0 && s.bars[i].time >= s.dirtyFrom) i--;
        for (let j = i + 1; j < s.bars.length; j++) {
          batch.candles.push({ tf: s.tf, candle: s.bars[j] });
        }
        // Only the live (last) bar can change again before the next flush.
        s.dirtyFrom = s.bars.length ? s.bars[s.bars.length - 1].time : null;
      }
      if (s.pendingPruneT !== null) {
        batch.prune.push({ tf: s.tf, beforeT: s.pendingPruneT });
        s.pendingPruneT = null;
      }
    }
    batch.meta[META_KEY] = JSON.stringify(this.engine.serialize());
    return batch;
  }

  flush(): void {
    const batch = this.buildBatch();
    if (batch.candles.length === 0 && batch.prune.length === 0 && Object.keys(batch.meta).length === 0) return;
    this.db.writeBatch(batch);
  }

  /** Wipe all series + DB and seed a fresh opening bar per timeframe. */
  reset(): void {
    this.db.clearAll();
    this.engine.seedFresh();
    const price = this.engine.price;
    const second = Math.floor(this.engine.simTimeMs / 1000);
    for (const s of this.series.values()) {
      s.bars = [{ time: bucketOf(second, s.tf), open: price, high: price, low: price, close: price, volume: 0 }];
      s.dirtyFrom = s.bars[0].time;
      s.pendingPruneT = null;
    }
    this.flush();
  }

  /** Read engine state JSON from a loaded snapshot, if present + valid. */
  static parseEngineState(loaded: LoadedState): unknown {
    const raw = loaded.meta[META_KEY];
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
