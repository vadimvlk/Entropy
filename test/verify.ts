// Standalone verification of the real engine + storage + fib logic (run under
// node via esbuild bundling). Exercises aggregation, volume, persistence
// validation and Fibonacci level math.

// --- Minimal localStorage shim so storage.ts works under node ---
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

import { aggregate, lastGroup, Engine, MIN_PRICE, type Candle } from '../src/engine';
import { loadState, saveState, compactBase, type PersistedState } from '../src/storage';
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

// --- aggregate (OHLC + volume) ---
const agg5 = aggregate(base, 5);
check('aggregate produces 2 buckets', agg5.length === 2);
check('bucket0 open=10 high=15 low=6 close=7', agg5[0].open === 10 && agg5[0].high === 15 && agg5[0].low === 6 && agg5[0].close === 7);
check('bucket0 volume summed = 15', agg5[0].volume === 15);
check('bucket1 open=7 high=20 low=5 close=6', agg5[1].open === 7 && agg5[1].high === 20 && agg5[1].low === 5 && agg5[1].close === 6);
check('bucket1 volume summed = 13', agg5[1].volume === 13);
const invariantOk = agg5.every((c) => c.high >= c.open && c.high >= c.close && c.low <= c.open && c.low <= c.close && c.high >= c.low);
check('all aggregated bars satisfy OHLC invariants', invariantOk);

// --- lastGroup ---
const lg = lastGroup(base, 5)!;
check('lastGroup matches last bucket (incl volume 13)', lg.time === 105 && lg.open === 7 && lg.high === 20 && lg.low === 5 && lg.close === 6 && lg.volume === 13);

// --- storage validation incl volume round-trip ---
const goodState: PersistedState = {
  v: 2,
  price: 100,
  simTimeMs: 1_000_000,
  tickCount: 5,
  startPrice: 100,
  regime: { name: 'steady', volName: 'normal', minDelay: 260, maxDelay: 620, vol: 0.5, speedTtl: 1000, volTtl: 2000 },
  base: compactBase(base),
};
saveState(goodState);
const reloaded = loadState();
check('valid state round-trips', reloaded !== null);
check('volume persisted in compact base (row has 6 cols)', goodState.base[0].length === 6 && goodState.base[0][5] === 3);

mem.set('random-walk-terminal:v1', JSON.stringify({ ...goodState, price: NaN, base: compactBase(base) }));
check('NaN price rejected -> null', loadState() === null);

mem.set('random-walk-terminal:v1', JSON.stringify({ ...goodState, regime: undefined, base: compactBase(base) }));
check('missing regime rejected -> null', loadState() === null);

mem.set('random-walk-terminal:v1', JSON.stringify({ ...goodState, base: [[100, 1, 1, 1, 1, 1], [100, 1, 1, 1, 1, 1]] }));
check('non-monotonic base rejected -> null', loadState() === null);

mem.set('random-walk-terminal:v1', JSON.stringify({ ...goodState, base: [[100, 1, 1, 1, 1, NaN]] }));
check('NaN volume rejected -> null', loadState() === null);

// legacy length-5 rows (no volume) still accepted
mem.set('random-walk-terminal:v1', JSON.stringify({ ...goodState, base: [[100, 1, 1, 1, 1]] }));
check('legacy length-5 base accepted', loadState() !== null);

// --- Fibonacci level math (0/50/100/200%) ---
const fib = new FibTool(100, 200, { lines: [], fills: [], text: '#fff' });
const lvls = fib.levelPrices();
check('fib levels = [100,150,200,300]', lvls[0] === 100 && lvls[1] === 150 && lvls[2] === 200 && lvls[3] === 300);
fib.setPrices(50, 40); // inverted
const lvls2 = fib.levelPrices();
check('fib inverted levels = [50,45,40,30]', lvls2[0] === 50 && lvls2[1] === 45 && lvls2[2] === 40 && lvls2[3] === 30);

// --- Trading account ---
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

// margin reject
acc.reset(false);
const rej = acc.market('buy', 11, 1000); // needs 1100 margin > 1000 equity
check('over-leverage rejected', rej.ok === false);
check('rejected leaves flat', acc.position === 0);

// flip: long 1, sell 2 → short 1 (the user's scenario)
acc.reset(false);
acc.market('buy', 1, 100);
const flip = acc.market('sell', 2, 110);
check('flip ok', flip.ok === true);
check('flip → short 1', approx(acc.position, -1) && acc.side() === 'short');
check('flip entry = 110', approx(acc.avgEntry, 110));
check('flip realized +10 (closed long)', approx(acc.realized, 10) && approx(acc.balance, 1010));

// partial close
acc.reset(false);
acc.market('buy', 1, 100);
acc.market('sell', 0.4, 130); // close 0.4 of long, realized 0.4*(130-100)=12
check('partial close → pos 0.6', approx(acc.position, 0.6));
check('partial close realized +12', approx(acc.realized, 12));
check('partial close keeps entry 100', approx(acc.avgEntry, 100));

// liquidation keeps balance positive
acc.reset(false);
acc.market('buy', 10, 1000); // full margin, equity 1000
check('no liq at 960', acc.liquidateIfNeeded(960) === false);
check('liquidates at 947', acc.liquidateIfNeeded(947) === true);
check('after liq: flat & balance > 0', acc.position === 0 && acc.balance > 0);

// --- Market-Maker nudge (manual tick injection) ---
mem.delete('random-walk-terminal:v1');
const eng = new Engine();
eng.init(); // fresh seed: price 1000, one candle
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
