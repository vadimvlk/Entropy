// Headless end-to-end smoke test of the running dev server.
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5173/';
const results = [];
const ok = (n, c) => { results.push([!!c, n]); console.log((c ? '  ok  - ' : '  FAIL- ') + n); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const num = (s) => parseInt(String(s).replace(/[^0-9-]/g, ''), 10);
const lsState = () => page.evaluate(() => JSON.parse(localStorage.getItem('random-walk-terminal:v1') || '{}'));
const lsDraw = () => page.evaluate(() => JSON.parse(localStorage.getItem('random-walk-terminal:drawings:v1') || '{}'));
const lsPrefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('random-walk-terminal:prefs:v1') || '{}'));

// Fresh start
await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(6000);

ok('price renders', /\d/.test(await page.locator('#price-value').textContent()));
ok('ticks accrue', num(await page.locator('#st-ticks').textContent()) > 0);
ok('candles accrue', num(await page.locator('#st-candles').textContent()) > 0);
ok('legend shows time', /^\d{2}:\d{2}:\d{2}$/.test((await page.locator('#lg-t').textContent()).trim()));
ok('legend shows volume', /^\d/.test((await page.locator('#lg-v').textContent()).trim()));

// Volume actually recorded in persisted base
const st = await lsState();
const lastRow = st.base?.[st.base.length - 1];
ok('volume stored per candle (col 6 > 0 somewhere)', Array.isArray(st.base) && st.base.some((r) => (r[5] || 0) > 0));
ok('last candle has 6 columns', Array.isArray(lastRow) && lastRow.length === 6);

const box = await page.locator('#chart').boundingBox();
const clickAt = async (fx, fy) => {
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(120);
  await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  await page.waitForTimeout(320);
};

// Horizontal + vertical lines
await page.locator('.tool[data-tool="hline"]').click();
await clickAt(0.4, 0.3);
await page.locator('.tool[data-tool="vline"]').click();
await clickAt(0.6, 0.5);
ok('2 line drawings placed', num(await page.locator('#st-draw').textContent()) === 2);

// Fibonacci: place via drag, then move it
await page.locator('.tool[data-tool="fib"]').click();
const dragFib = async (fx, fy0, fy1) => {
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy0);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy1, { steps: 8 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(300);
};
await dragFib(0.5, 0.35, 0.6);
let draw = await lsDraw();
ok('fib created (stored fib pair)', Array.isArray(draw.fib) && draw.fib.length === 2 && draw.fib[0] !== draw.fib[1]);
ok('drawings count includes fib (3)', num(await page.locator('#st-draw').textContent()) === 3);
const fibBefore = (await lsDraw()).fib.slice();
// Move the fib body by grabbing its midpoint and dragging
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.475);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.30, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const fibAfter = (await lsDraw()).fib;
ok('fib moved by drag (prices changed)', fibAfter[0] !== fibBefore[0] && fibAfter[1] !== fibBefore[1]);

// Theme toggle
await page.locator('#btn-theme').click();
await page.waitForTimeout(300);
ok('theme switches to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
ok('theme persisted', (await lsPrefs()).theme === 'light');
await page.screenshot({ path: 'verify-07-light.png' });
await page.locator('#btn-theme').click(); // back to dark
await page.waitForTimeout(200);
ok('theme switches back to dark', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

// Manual regime mode
await page.locator('#mode-group .seg-btn[data-mode="manual"]').click();
await page.waitForTimeout(200);
ok('manual controls visible', await page.locator('#manual-controls').isVisible());
await page.selectOption('#sel-speed', 'burst');
await page.selectOption('#sel-vol', 'wild');
await page.waitForTimeout(200);
const prefs = await lsPrefs();
ok('manual mode persisted', prefs.mode === 'manual' && prefs.speed === 'burst' && prefs.vol === 'wild');
// burst+wild should produce a high tick rate; sample tps a few times
let maxTps = 0;
for (let i = 0; i < 6; i++) { await page.waitForTimeout(400); maxTps = Math.max(maxTps, num(await page.locator('#st-tps').textContent())); }
ok('manual burst raises tick rate (tps>=4)', maxTps >= 4);

// Timeframe + type, then persistence + reload
await page.locator('#tf-group .seg-btn[data-tf="15"]').click();
await page.locator('#type-group .seg-btn[data-type="area"]').click();
await page.waitForTimeout(400);
const ticksBefore = num(await page.locator('#st-ticks').textContent());
await page.reload();
await page.waitForTimeout(2500);
ok('ticks continued after reload', num(await page.locator('#st-ticks').textContent()) >= ticksBefore);
ok('view restored (15s + area)', (await page.locator('#tf-group .seg-btn.is-active').textContent()).trim() === '15s' && (await page.locator('#type-group .seg-btn.is-active').getAttribute('data-type')) === 'area');
ok('drawings preserved after reload (3)', num(await page.locator('#st-draw').textContent()) === 3);
ok('manual mode restored', (await page.locator('#mode-group .seg-btn.is-active').getAttribute('data-mode')) === 'manual');

// Corrupt-state resilience
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('random-walk-terminal:v1'));
  s.price = null;
  localStorage.setItem('random-walk-terminal:v1', JSON.stringify(s));
});
await page.reload();
await page.waitForTimeout(2500);
ok('recovers from corrupt state', num(await page.locator('#st-candles').textContent()) > 0 && !/NaN/.test(await page.locator('#price-value').textContent()));

await page.screenshot({ path: 'verify-08-final.png' });
ok('no console errors (excluding favicon)', errors.filter((e) => !/favicon/.test(e)).length === 0);
if (errors.length) console.log('  console errors:', JSON.stringify(errors.slice(0, 5), null, 2));

await browser.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
