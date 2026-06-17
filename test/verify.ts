// Standalone verification of the shared core + server store + db + fib/trading
// logic (run under node via esbuild bundling). Exercises aggregation across the
// full timeframe ladder, the incremental-rollup ⇔ aggregate equivalence, SQLite
// persistence round-trip, Fibonacci level math and the trading account.

// --- Minimal localStorage shim so trading.ts (account) works under node ---
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { aggregate, lastGroup, type Candle, type TfSeconds } from '../shared/candles';
import { Engine, MIN_PRICE } from '../shared/engine';
import { Db } from '../server/db';
import { SeriesStore } from '../server/seriesStore';
import { FibTool } from '../src/fib';
import { Account } from '../src/trading';

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log('  ok  - ' + name);
  } else {
    failed++;
    console.log('  FAIL- ' + name);
  }
}

function sameCandles(a: Candle[], b: Candle[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.time !== y.time ||
      !approx(x.open, y.open) ||
      !approx(x.high, y.high) ||
      !approx(x.low, y.low) ||
      !approx(x.close, y.close) ||
      x.volume !== y.volume
    ) {
      return false;
    }
  }
  return true;
}

// ============ aggregation ============
// Two 5s buckets, with tick volumes.
const base: Candle[] = [
  { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 3 },
  { time: 101, open: 11, high: 15, low: 11, close: 13, volume: 5 },
  { time: 102, open: 13, high: 13, low: 8, close: 9, volume: 2 },
  { time: 103, open: 9, high: 10, low: 7, close: 8, volume: 4 },
  { time: 104, open: 8, high: 8, low: 6, close: 7, volume: 1 }, // bucket 100..104, vol 15
  { time: 105, open: 7, high: 20, low: 7, close: 18, volume: 7 },
  { time: 106, open: 18, high: 19, low: 5, close: 6, volume: 6 }, // bucket 105.., vol 13
];

const agg5 = aggregate(base, 5);
check('aggregate produces 2 buckets', agg5.length === 2);
check('bucket0 open=10 high=15 low=6 close=7', agg5[0].open === 10 && agg5[0].high === 15 && agg5[0].low === 6 && agg5[0].close === 7);
check('bucket0 volume summed = 15', agg5[0].volume === 15);
check('bucket1 open=7 high=20 low=5 close=6', agg5[1].open === 7 && agg5[1].high === 20 && agg5[1].low === 5 && agg5[1].close === 6);
check('bucket1 volume summed = 13', agg5[1].volume === 13);
const invariantOk = agg5.every((c) => c.high >= c.open && c.high >= c.close && c.low <= c.open && c.low <= c.close && c.high >= c.low);
check('all aggregated bars satisfy OHLC invariants', invariantOk);

const lg = lastGroup(base, 5)!;
check('lastGroup matches last bucket (incl volume 13)', lg.time === 105 && lg.open === 7 && lg.high === 20 && lg.low === 5 && lg.close === 6 && lg.volume === 13);

// ============ incremental rollups ⇔ aggregate over the whole ladder ============
// Build a deterministic-ish tick sequence, fold it into a 1s base the same way
// the engine's commitTick does, AND feed it into a SeriesStore. The store's
// per-TF series must match aggregate(base, tf) for every timeframe.
{
  const ticks: { t: number; price: number }[] = [];
  let t = 1_000_000;
  let price = 1000;
  for (let i = 0; i < 2000; i++) {
    if (Math.random() < 0.45) t += 1 + Math.floor(Math.random() * 3); // advance 1..3 s sometimes
    price *= Math.exp((Math.random() - 0.5) * 0.01);
    ticks.push({ t, price });
  }

  const oracleBase: Candle[] = [];
  for (const { t: tt, price: pp } of ticks) {
    const last = oracleBase[oracleBase.length - 1];
    if (!last || tt > last.time) {
      oracleBase.push({ time: tt, open: pp, high: pp, low: pp, close: pp, volume: 1 });
    } else {
      if (pp > last.high) last.high = pp;
      if (pp < last.low) last.low = pp;
      last.close = pp;
      last.volume++;
    }
  }

  const db = new Db(':memory:');
  const engine = new Engine();
  engine.seedFresh();
  const store = new SeriesStore(engine, db);
  // reset() seeds an empty opening bar per TF; clear them so we fold from scratch
  // exactly like the oracle.
  store.restore({ meta: {}, series: new Map() });
  for (const { t: tt, price: pp } of ticks) store.onTick(pp, tt);

  const tfs: TfSeconds[] = [1, 5, 15, 60, 300, 900, 1800, 3600, 14400, 43200, 86400];
  let allMatch = true;
  for (const tf of tfs) {
    if (!sameCandles(store.getSeries(tf), aggregate(oracleBase, tf))) {
      allMatch = false;
      console.log(`    mismatch at tf=${tf}`);
    }
  }
  check('incremental rollups equal aggregate() for all 11 timeframes', allMatch);
  db.close();
}

// ============ SQLite persistence round-trip ============
{
  const path = join(tmpdir(), `entropy-verify-${process.pid}.db`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  };
  cleanup();

  const db1 = new Db(path);
  const eng1 = new Engine();
  eng1.seedFresh();
  const store1 = new SeriesStore(eng1, db1);
  let tt = 500_000;
  let pp = 1000;
  for (let i = 0; i < 300; i++) {
    if (Math.random() < 0.5) tt += 1;
    pp *= Math.exp((Math.random() - 0.5) * 0.01);
    store1.onTick(pp, tt);
  }
  store1.flush();
  const before1 = store1.getSeries(1);
  const before60 = store1.getSeries(60);
  const savedPrice = eng1.price;
  db1.close();

  const db2 = new Db(path);
  const loaded = db2.loadAll();
  const parsed = SeriesStore.parseEngineState(loaded);
  const eng2 = new Engine();
  const store2 = new SeriesStore(eng2, db2);
  store2.restore(loaded);
  eng2.restore(parsed as any, store2.baseTail());

  check('round-trip: 1s series survives reload', sameCandles(store2.getSeries(1), before1));
  check('round-trip: 1m rollup survives reload', sameCandles(store2.getSeries(60), before60));
  check('round-trip: engine price persisted', approx(eng2.price, savedPrice));
  check('round-trip: engine base seeded from persisted tail', eng2.base.length > 0);
  db2.close();
  cleanup();
}

// ============ store.reset() seeds one opening bar per TF ============
{
  const db = new Db(':memory:');
  const engine = new Engine();
  const store = new SeriesStore(engine, db);
  store.reset();
  check('reset seeds exactly one 1s bar', store.getSeries(1).length === 1);
  check('reset seeds exactly one 1d bar', store.getSeries(86400).length === 1);
  check('reset opening bar has zero volume', store.getSeries(1)[0].volume === 0);
  db.close();
}

// ============ db: upsert + prune semantics ============
{
  const db = new Db(':memory:');
  db.writeBatch({
    candles: [
      { tf: 1, candle: { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 } },
      { tf: 1, candle: { time: 101, open: 1.5, high: 1.8, low: 1.4, close: 1.7, volume: 2 } },
    ],
    prune: [],
    meta: { engineState: '{"price":1.7}' },
  });
  let loaded = db.loadAll();
  check('db: 2 rows loaded', (loaded.series.get(1)?.length ?? 0) === 2);
  check('db: meta round-trips', loaded.meta.engineState === '{"price":1.7}');

  // Upsert the same (tf,t): row count stays 2, value updates.
  db.writeBatch({ candles: [{ tf: 1, candle: { time: 100, open: 9, high: 9, low: 9, close: 9, volume: 9 } }], prune: [], meta: {} });
  loaded = db.loadAll();
  check('db: upsert keeps row count', (loaded.series.get(1)?.length ?? 0) === 2);
  check('db: upsert updates value', loaded.series.get(1)![0].close === 9 && loaded.series.get(1)![0].volume === 9);

  // Prune everything before t=101.
  db.writeBatch({ candles: [], prune: [{ tf: 1, beforeT: 101 }], meta: {} });
  loaded = db.loadAll();
  check('db: prune drops old rows', (loaded.series.get(1)?.length ?? 0) === 1 && loaded.series.get(1)![0].time === 101);

  db.clearAll();
  loaded = db.loadAll();
  check('db: clearAll empties everything', (loaded.series.get(1)?.length ?? 0) === 0 && Object.keys(loaded.meta).length === 0);
  db.close();
}

// ============ Fibonacci level math (0/50/100/200%) ============
const fib = new FibTool(100, 200, 0, { lines: [], fills: [], text: '#fff' });
const lvls = fib.levelPrices();
check('fib levels = [100,150,200,300]', lvls[0] === 100 && lvls[1] === 150 && lvls[2] === 200 && lvls[3] === 300);
fib.setPrices(50, 40); // inverted
const lvls2 = fib.levelPrices();
check('fib inverted levels = [50,45,40,30]', lvls2[0] === 50 && lvls2[1] === 45 && lvls2[2] === 40 && lvls2[3] === 30);

// ============ Trading account ============
const acc = new Account();
acc.reset(false);
check('fresh: balance 1000, flat', acc.balance === 1000 && acc.position === 0);
check('fresh maxQty @1000 = 10 contracts', approx(acc.maxQty(1000), 10));

acc.market('buy', 1, 1000);
check('buy 1 @1000: pos 1, entry 1000', acc.position === 1 && acc.avgEntry === 1000);
check('margin used = 100 (1:10)', approx(acc.marginUsed(1000), 100));
check('unrealized @1100 = +100', approx(acc.unrealized(1100), 100));
check('equity @1100 = 1100', approx(acc.equity(1100), 1100));

acc.market('buy', 1, 1200); // add → avg (1000+1200)/2 = 1100
check('add: pos 2, avg 1100', acc.position === 2 && approx(acc.avgEntry, 1100));

acc.reset(false);
const rej = acc.market('buy', 11, 1000); // needs 1100 margin > 1000 equity
check('over-leverage rejected', rej.ok === false);
check('rejected leaves flat', acc.position === 0);

acc.reset(false);
acc.market('buy', 1, 100);
const flip = acc.market('sell', 2, 110);
check('flip ok', flip.ok === true);
check('flip → short 1', approx(acc.position, -1) && acc.side() === 'short');
check('flip entry = 110', approx(acc.avgEntry, 110));
check('flip realized +10 (closed long)', approx(acc.realized, 10) && approx(acc.balance, 1010));

acc.reset(false);
acc.market('buy', 1, 100);
acc.market('sell', 0.4, 130); // close 0.4 of long, realized 0.4*(130-100)=12
check('partial close → pos 0.6', approx(acc.position, 0.6));
check('partial close realized +12', approx(acc.realized, 12));
check('partial close keeps entry 100', approx(acc.avgEntry, 100));

acc.reset(false);
acc.market('buy', 10, 1000);
check('no liq at 960', acc.liquidateIfNeeded(960) === false);
check('liquidates at 947', acc.liquidateIfNeeded(947) === true);
check('after liq: flat & balance > 0', acc.position === 0 && acc.balance > 0);

// ============ Market-Maker nudge (manual tick injection) ============
const eng = new Engine();
eng.seedFresh(); // fresh seed: price 1000, one candle
const t0 = eng.tickCount;
eng.nudge(5);
check('nudge +5 → price 1005', approx(eng.price, 1005));
check('nudge increments tickCount', eng.tickCount === t0 + 1);
check('nudge folds into candle (close=1005)', approx(eng.base[eng.base.length - 1].close, 1005));
eng.nudge(-10);
check('nudge -10 → price 995', approx(eng.price, 995));
eng.nudge(-1e9);
check('nudge cannot push price below MIN_PRICE', eng.price === MIN_PRICE);
eng.nudge(0);
check('nudge(0) is a no-op for price', eng.price === MIN_PRICE);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
