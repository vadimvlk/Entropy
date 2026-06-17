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
const lsAcct = () => page.evaluate(() => JSON.parse(localStorage.getItem('random-walk-terminal:account:v1') || '{}'));

// Fresh start
await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(5000);

ok('price renders', /\d/.test(await page.locator('#price-value').textContent()));
ok('ticks accrue', num(await page.locator('#st-ticks').textContent()) > 0);
ok('legend shows volume', /^\d/.test((await page.locator('#lg-v').textContent()).trim()));

// Price stays positive (GBM, no negatives)
const st = await lsState();
ok('all candle values > 0 (no negative price)', Array.isArray(st.base) && st.base.every((r) => r[1] > 0 && r[2] > 0 && r[3] > 0 && r[4] > 0));
ok('storage version is 2', st.v === 2);

// --- Trading ---
ok('starting balance $1000', /1,?000/.test(await page.locator('#ac-balance').textContent()));
ok('close disabled when flat', await page.locator('#btn-close').isDisabled());

// Buy 1 contract → LONG 1
await page.fill('#qty-input', '1');
await page.locator('#btn-buy').click();
await page.waitForTimeout(300);
let acct = await lsAcct();
ok('buy 1 → position +1 (long)', Math.abs(acct.position - 1) < 1e-6);
ok('position badge shows LONG', (await page.locator('#pos-side').textContent()).trim() === 'LONG');
ok('close enabled with position', !(await page.locator('#btn-close').isDisabled()));
ok('entry price recorded', acct.avgEntry > 0);

// Sell 2 → flip to SHORT 1 (the user's scenario)
await page.fill('#qty-input', '2');
await page.locator('#btn-sell').click();
await page.waitForTimeout(300);
acct = await lsAcct();
ok('long 1 then sell 2 → SHORT 1', Math.abs(acct.position + 1) < 1e-6);
ok('position badge shows SHORT', (await page.locator('#pos-side').textContent()).trim() === 'SHORT');

// Close → flat
await page.locator('#btn-close').click();
await page.waitForTimeout(300);
acct = await lsAcct();
ok('close → flat', Math.abs(acct.position) < 1e-6);
ok('close disabled again', await page.locator('#btn-close').isDisabled());

// Over-leverage rejected
await page.fill('#qty-input', '999');
await page.locator('#btn-buy').click();
await page.waitForTimeout(300);
acct = await lsAcct();
ok('over-leverage order rejected (stays flat)', Math.abs(acct.position) < 1e-6);

// Open a long and verify it persists across reload
await page.fill('#qty-input', '0.5');
await page.locator('#btn-buy').click();
await page.waitForTimeout(300);
const beforeTicks = num(await page.locator('#st-ticks').textContent());
await page.reload();
await page.waitForTimeout(2500);
acct = await lsAcct();
ok('position persists across reload (0.5 long)', Math.abs(acct.position - 0.5) < 1e-6);
ok('ticks continued after reload', num(await page.locator('#st-ticks').textContent()) >= beforeTicks);
ok('position card restored as LONG', (await page.locator('#pos-side').textContent()).trim() === 'LONG');

// Drawing tools still work (hline + fib)
const box = await page.locator('#chart').boundingBox();
await page.locator('.tool[data-tool="hline"]').click();
await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
await page.waitForTimeout(120); await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
await page.waitForTimeout(300);
ok('hline placed', num(await page.locator('#st-draw').textContent()) >= 1);

// Theme toggle
await page.locator('#btn-theme').click();
await page.waitForTimeout(300);
ok('theme switches to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
await page.screenshot({ path: 'verify-10-light-trade.png' });
await page.locator('#btn-theme').click();
await page.waitForTimeout(200);

// Manual mode
await page.locator('#mode-group .seg-btn[data-mode="manual"]').click();
await page.waitForTimeout(150);
ok('manual controls visible', await page.locator('#manual-controls').isVisible());

// Market-Maker mode: flip, ∞ balance, PUMP nudges the price, flip back
await page.locator('#mm-toggle').click();
await page.waitForTimeout(600);
ok('MM: panel flips (is-mm)', await page.evaluate(() => document.querySelector('.orderpanel').classList.contains('is-mm')));
ok('MM: balance shows ∞', (await page.locator('#mm-balance').textContent()).includes('∞'));
await page.locator('#btn-playpause').click(); // pause so only the nudge moves price
await page.waitForTimeout(200);
await page.locator('.mm-back .qty-presets button[data-impact="5"]').click();
await page.waitForTimeout(120);
const mmP0 = Number((await page.locator('#mm-mark').textContent()).replace(/[^0-9.]/g, ''));
await page.locator('#mm-buy').click();
await page.waitForTimeout(150);
const mmP1 = Number((await page.locator('#mm-mark').textContent()).replace(/[^0-9.]/g, ''));
ok('MM: PUMP +$5 moves price up ~5', Math.abs(mmP1 - mmP0 - 5) < 0.06);
await page.locator('#mm-sell').click();
await page.waitForTimeout(150);
const mmP2 = Number((await page.locator('#mm-mark').textContent()).replace(/[^0-9.]/g, ''));
ok('MM: DUMP -$5 moves price down ~5', Math.abs(mmP2 - mmP1 + 5) < 0.06);
await page.locator('#btn-playpause').click(); // resume
await page.waitForTimeout(150);
await page.locator('#mm-toggle').click(); // flip back to trading
await page.waitForTimeout(400);
ok('MM: flips back to trading', !(await page.evaluate(() => document.querySelector('.orderpanel').classList.contains('is-mm'))));

// --- Timeframe: the seconds dropdown must reach 1s from a minute TF ---
// Regression — a native <select> fires `change` only when its value actually
// changes. The dropdown used to keep a stale second value while a minute TF was
// active, so re-picking that same option (notably "1s", the default) was
// silently ignored: you had to bounce through 5s/15s first. After a minute TF
// is active the dropdown must hold no second value, so every option re-fires.
const secIdx = () => page.locator('#sel-sectf').evaluate((el) => el.selectedIndex);
await page.locator('#sel-sectf').selectOption('15');
await page.waitForTimeout(400);
ok('sec dropdown → 15s applies', (await lsPrefs()).tf === 15);
await page.locator('#tf-group .seg-btn[data-tf="60"]').click();
await page.waitForTimeout(400);
ok('minute TF (1m) applies', (await lsPrefs()).tf === 60);
ok('sec dropdown cleared on minute TF (selectedIndex -1)', (await secIdx()) === -1);
await page.locator('#sel-sectf').selectOption('1');
await page.waitForTimeout(400);
ok('1s reachable directly from a minute TF', (await lsPrefs()).tf === 1);

await page.screenshot({ path: 'verify-11-final.png' });
ok('no console errors (excluding favicon)', errors.filter((e) => !/favicon/.test(e)).length === 0);
if (errors.length) console.log('  console errors:', JSON.stringify(errors.slice(0, 5), null, 2));

await browser.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
