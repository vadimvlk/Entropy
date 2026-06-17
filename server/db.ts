// Persistence layer backed by the built-in node:sqlite (stable in Node 24+).
// The whole simulation state lives here so the always-on stream survives a
// process restart / redeploy and continues exactly where it left off. The hot
// path stays in memory (SeriesStore); the DB is written in debounced batches.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Candle, TfSeconds } from '../shared/candles';

export interface CandleWrite {
  tf: TfSeconds;
  candle: Candle;
}
export interface Prune {
  tf: TfSeconds;
  beforeT: number; // delete rows with t < beforeT
}
export interface Batch {
  candles: CandleWrite[];
  prune: Prune[];
  meta: Record<string, string>;
}

export interface LoadedState {
  meta: Record<string, string>;
  series: Map<number, Candle[]>; // tf -> ascending candles
}

export class Db {
  private db: DatabaseSync;
  private upsertStmt;
  private deleteStmt;
  private metaStmt;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candle (
        tf INTEGER NOT NULL,
        t  INTEGER NOT NULL,
        o  REAL NOT NULL,
        h  REAL NOT NULL,
        l  REAL NOT NULL,
        c  REAL NOT NULL,
        v  INTEGER NOT NULL,
        PRIMARY KEY (tf, t)
      ) WITHOUT ROWID;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.upsertStmt = this.db.prepare(
      `INSERT INTO candle (tf, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tf, t) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v`,
    );
    this.deleteStmt = this.db.prepare(`DELETE FROM candle WHERE tf = ? AND t < ?`);
    this.metaStmt = this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
  }

  loadAll(): LoadedState {
    const meta: Record<string, string> = {};
    for (const row of this.db.prepare(`SELECT key, value FROM meta`).all() as { key: string; value: string }[]) {
      meta[row.key] = row.value;
    }
    const series = new Map<number, Candle[]>();
    const rows = this.db
      .prepare(`SELECT tf, t, o, h, l, c, v FROM candle ORDER BY tf ASC, t ASC`)
      .all() as { tf: number; t: number; o: number; h: number; l: number; c: number; v: number }[];
    for (const row of rows) {
      let arr = series.get(row.tf);
      if (!arr) {
        arr = [];
        series.set(row.tf, arr);
      }
      arr.push({ time: row.t, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v });
    }
    return { meta, series };
  }

  /** Apply a batch of upserts + prunes + meta inside a single transaction. */
  writeBatch(batch: Batch): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { tf, candle } of batch.candles) {
        this.upsertStmt.run(tf, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume);
      }
      for (const { tf, beforeT } of batch.prune) {
        this.deleteStmt.run(tf, beforeT);
      }
      for (const key of Object.keys(batch.meta)) {
        this.metaStmt.run(key, batch.meta[key]);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Wipe everything (used by reset). */
  clearAll(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM candle');
      this.db.exec('DELETE FROM meta');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}
