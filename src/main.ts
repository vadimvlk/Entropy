// Entry point: wires the market client (server stream), the chart controller,
// the local paper-trading account and the UI. The simulation itself runs on the
// server; this is a thin client — it fetches a timeframe's history over HTTP,
// streams the live bar + header status over SSE, and issues token-gated control
// commands (reset / nudge / mode / pause).

import './style.css';
import { ChartController, type ChartType, type Tool, type Theme } from './chart';
import { Account } from './trading';
import { loadPrefs, savePrefs } from './storage';
import { formatPrice, formatMoney, formatSignedMoney, formatPct, roundStep, formatQty } from './format';
import { MarketClient, type StreamStatus, type TickPayload } from './marketClient';
import { TF_LABEL, SECOND_TFS, type Candle, type TfSeconds } from '../shared/candles';
import { SPEED_NAMES, VOL_NAMES } from '../shared/regimes';

// ---- DOM helpers ----
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};
const $all = <T extends HTMLElement = HTMLElement>(sel: string): T[] =>
  Array.from(document.querySelectorAll<T>(sel));

const nfInt = new Intl.NumberFormat('en-US');

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const TOOL_HINTS: Partial<Record<Tool, string>> = {
  hline: '◇ Кликните на графике, чтобы поставить горизонтальную линию',
  vline: '◇ Кликните на графике, чтобы поставить вертикальную линию',
  fib: '◇ Протяните мышью на графике, чтобы построить Фибоначчи — затем тяните, чтобы двигать',
  erase: '◇ Кликните по линии или Фибоначчи, чтобы удалить',
};
const SPEED_LABELS: Record<string, string> = {
  burst: 'Взрыв', fast: 'Быстро', steady: 'Ровно', slow: 'Медленно', sparse: 'Редко',
};
const VOL_LABELS: Record<string, string> = {
  quiet: 'Тихо', normal: 'Норма', active: 'Активно', wild: 'Дико',
};

async function boot(): Promise<void> {
  const prefs = loadPrefs();
  const theme: Theme = prefs?.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;

  // ---- Refs ----
  const priceEl = $('#price-value');
  const changeEl = $('#price-change');
  const liveEl = $('#live');
  const liveLabel = $('#live-label');
  const playBtn = $('#btn-playpause');
  const themeBtn = $('#btn-theme');
  const volBtn = $('#btn-vol');
  const lockBtn = $('#btn-lock');

  const stRegime = $('#st-regime');
  const stTps = $('#st-tps');
  const stTicks = $('#st-ticks');
  const stCandles = $('#st-candles');
  const stTf = $('#st-tf');
  const stDraw = $('#st-draw');
  const stClock = $('#st-clock');

  const lgT = $('#lg-t');
  const lgO = $('#lg-o');
  const lgH = $('#lg-h');
  const lgL = $('#lg-l');
  const lgC = $('#lg-c');
  const lgV = $('#lg-v');
  const lgChg = $('#lg-chg');

  const manualControls = $('#manual-controls');
  const selSpeed = $<HTMLSelectElement>('#sel-speed');
  const selVol = $<HTMLSelectElement>('#sel-vol');
  const selSecTf = $<HTMLSelectElement>('#sel-sectf');
  const tfSecLabel = $('#tf-sec');

  const chartWrap = $('.chart-wrap');
  const hintEl = $('#chart-hint');
  const toastEl = $('#toast');

  // Trading refs
  const acBalance = $('#ac-balance');
  const acEquity = $('#ac-equity');
  const acFree = $('#ac-free');
  const acRealized = $('#ac-realized');
  const posSideEl = $('#pos-side');
  const posPnl = $('#pos-pnl');
  const posPnlPct = $('#pos-pnl-pct');
  const posSize = $('#pos-size');
  const posEntryEl = $('#pos-entry');
  const posMark = $('#pos-mark');
  const posLiq = $('#pos-liq');
  const btnClose = $<HTMLButtonElement>('#btn-close');
  const qtyInput = $<HTMLInputElement>('#qty-input');
  const ordNotional = $('#ord-notional');
  const ordMargin = $('#ord-margin');
  const ordMax = $('#ord-max');
  const btnBuy = $('#btn-buy');
  const btnSell = $('#btn-sell');

  // Market-Maker mode refs
  const orderpanel = $('.orderpanel');
  const mmToggle = $('#mm-toggle');
  const mmImpactInput = $<HTMLInputElement>('#mm-impact-input');
  const mmMark = $('#mm-mark');
  const mmDelta = $('#mm-delta');
  const mmNetEl = $('#mm-net');
  const mmBuy = $('#mm-buy');
  const mmSell = $('#mm-sell');
  let mmNet = 0; // net impact: Σ(up) − Σ(down), in $ (local tally for this browser)

  selSpeed.innerHTML = SPEED_NAMES.map((n) => `<option value="${n}">${SPEED_LABELS[n] ?? n}</option>`).join('');
  selVol.innerHTML = VOL_NAMES.map((n) => `<option value="${n}">${VOL_LABELS[n] ?? n}</option>`).join('');

  // ---- Core objects ----
  const chart = new ChartController(
    $('#chart'),
    {
      onBar: (bar) => updateLegend(bar),
      onDrawingsChanged: (c) => {
        stDraw.textContent = String(c.h + c.v + c.fib);
      },
    },
    theme,
  );

  const account = new Account();
  account.init();

  const client = new MarketClient();

  // Live state mirrored from the server stream.
  let activeTf: TfSeconds = (prefs?.tf as TfSeconds) ?? 1;
  let latestPrice = NaN;
  let startPrice = NaN;
  let prevPrice = NaN;
  let simTimeMs = 0;
  let running = true;
  let switching = false;

  // ---- Restore view (client-local prefs) ----
  if (prefs?.type && prefs.type !== 'candles') {
    chart.setType(prefs.type as ChartType);
    setActive('#type-group .seg-btn', (b) => b.dataset.type === prefs.type);
  }
  if (prefs?.showVolume === false) {
    chart.setVolumeVisible(false);
    volBtn.classList.remove('is-active');
  }
  setLocked(!client.hasToken());

  chart.setTimeframe(activeTf);
  setTfActive(activeTf);
  stTf.textContent = TF_LABEL[activeTf];

  const ok = await loadActive(true);
  if (!ok) toast('Сервер недоступен — пробуем переподключиться…', 'warn');

  client.connect(activeTf, {
    onTick,
    onReset,
    onRunning: (r) => {
      running = r;
      setLiveState(r);
    },
    onReconnect: () => void loadActive(false),
  });

  if (prefs?.mm && client.hasToken()) {
    orderpanel.classList.add('no-anim');
    setMM(true);
    requestAnimationFrame(() => orderpanel.classList.remove('no-anim'));
  }

  refreshPositionLines();

  // ---- Data flow ----
  function onTick(p: TickPayload): void {
    latestPrice = p.price;
    startPrice = p.startPrice;
    simTimeMs = p.t;
    running = p.running;
    if (!switching) chart.updateLiveBar(p.bar);
    if (account.liquidateIfNeeded(latestPrice)) {
      refreshPositionLines();
      toast('⚠ ЛИКВИДАЦИЯ ПОЗИЦИИ', 'warn');
    }
    updateHeader(latestPrice);
    updateStatus(p);
    updateTrading(latestPrice);
    setLiveState(p.running);
  }

  async function onReset(): Promise<void> {
    account.reset();
    mmNet = 0;
    renderMmNet();
    chart.clearDrawings();
    chart.clearMarkers();
    chart.setPosition(null, null, 'flat');
    prevPrice = NaN;
    await loadActive(true);
    toast('График сброшен — новая последовательность', 'info');
  }

  /** Fetch + paint the active timeframe's history. Returns false if offline. */
  async function loadActive(resetView: boolean): Promise<boolean> {
    try {
      const snap = await client.fetchSeries(activeTf);
      startPrice = snap.startPrice;
      latestPrice = snap.price;
      simTimeMs = snap.t;
      running = snap.running;
      if (Number.isNaN(prevPrice)) prevPrice = snap.price;
      chart.setSeries(snap.bars, resetView);
      updateHeader(latestPrice);
      updateStatus(snap);
      updateTrading(latestPrice);
      setLiveState(snap.running);
      refreshPositionLines();
      return true;
    } catch {
      return false;
    }
  }

  // ---- Helpers ----
  function setActive(sel: string, pred: (b: HTMLElement) => boolean): void {
    $all(sel).forEach((b) => b.classList.toggle('is-active', pred(b)));
  }

  function setTfActive(tf: TfSeconds): void {
    setActive('#tf-group .seg-btn', (b) => Number(b.dataset.tf) === tf);
    const isSec = (SECOND_TFS as readonly number[]).includes(tf);
    tfSecLabel.classList.toggle('is-active', isSec);
    if (isSec) selSecTf.value = String(tf);
  }

  function persistPrefs(): void {
    savePrefs({
      tf: activeTf,
      type: chart.getType(),
      theme: chart.getTheme(),
      showVolume: chart.isVolumeVisible(),
      mm: orderpanel.classList.contains('is-mm'),
    });
  }

  function toast(msg: string, kind: 'buy' | 'sell' | 'warn' | 'info' = 'info'): void {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (kind === 'info' ? '' : ' ' + kind);
    window.clearTimeout((toast as any)._t);
    (toast as any)._t = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function signClass(el: HTMLElement, v: number): void {
    el.classList.toggle('up', v > 0.0049);
    el.classList.toggle('down', v < -0.0049);
  }

  function updateHeader(price: number): void {
    if (Number.isNaN(price)) return;
    priceEl.textContent = formatPrice(price);
    const up = price >= startPrice;
    priceEl.classList.toggle('up', up);
    priceEl.classList.toggle('down', !up);

    const chg = price - startPrice;
    const pct = startPrice !== 0 ? (chg / Math.abs(startPrice)) * 100 : 0;
    changeEl.textContent = `${formatSignedMoney(chg)}  ${formatPct(pct)}`;
    changeEl.classList.toggle('up', chg >= 0);
    changeEl.classList.toggle('down', chg < 0);

    if (!Number.isNaN(prevPrice) && price !== prevPrice) {
      const cls = price > prevPrice ? 'tick-up' : 'tick-down';
      priceEl.classList.remove('tick-up', 'tick-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(cls);
    }
    prevPrice = price;
  }

  function updateLegend(bar: Candle | null): void {
    if (!bar) {
      lgT.textContent = '—';
      lgO.textContent = lgH.textContent = lgL.textContent = lgC.textContent = lgV.textContent = '—';
      lgChg.textContent = '—';
      lgChg.classList.remove('up', 'down');
      return;
    }
    lgT.textContent = fmtClock(bar.time * 1000);
    lgO.textContent = formatPrice(bar.open);
    lgH.textContent = formatPrice(bar.high);
    lgL.textContent = formatPrice(bar.low);
    lgC.textContent = formatPrice(bar.close);
    lgV.textContent = nfInt.format(bar.volume);
    const d = bar.close - bar.open;
    const pct = bar.open !== 0 ? (d / Math.abs(bar.open)) * 100 : 0;
    lgChg.textContent = `${formatSignedMoney(d)} (${formatPct(pct)})`;
    lgChg.classList.toggle('up', d >= 0);
    lgChg.classList.toggle('down', d < 0);
  }

  function updateStatus(s: StreamStatus): void {
    stRegime.textContent = `${s.regime.toUpperCase()}·${s.vol.toUpperCase()}`;
    stTps.textContent = String(s.tps);
    stTicks.textContent = nfInt.format(s.tickCount);
    stCandles.textContent = nfInt.format(s.baseCount);
    stClock.textContent = fmtClock(s.t);
    const manual = s.mode === 'manual';
    manualControls.hidden = !manual;
    selSpeed.disabled = !manual;
    selVol.disabled = !manual;
    setActive('#mode-group .seg-btn', (b) => b.dataset.mode === s.mode);
    if (!manual) {
      selSpeed.value = s.regime;
      selVol.value = s.vol;
    }
  }

  // ---- Trading UI ----
  function updateTrading(price: number): void {
    if (Number.isNaN(price)) return;
    const v = account.view(price);
    acBalance.textContent = '$' + formatMoney(v.balance);
    acEquity.textContent = '$' + formatMoney(v.equity);
    acFree.textContent = '$' + formatMoney(v.freeMargin);
    acRealized.textContent = formatSignedMoney(v.realized);
    signClass(acRealized, v.realized);

    posSideEl.textContent = v.side === 'long' ? 'LONG' : v.side === 'short' ? 'SHORT' : 'НЕТ';
    posSideEl.className = 'pos-badge ' + v.side;
    posPnl.textContent = (v.unrealized >= 0 ? '+$' : '−$') + formatMoney(Math.abs(v.unrealized));
    posPnl.classList.toggle('up', v.unrealized > 0.0049);
    posPnl.classList.toggle('down', v.unrealized < -0.0049);
    posPnlPct.textContent = formatPct(v.unrealizedPct);
    posPnlPct.classList.toggle('up', v.unrealizedPct > 0.0049);
    posPnlPct.classList.toggle('down', v.unrealizedPct < -0.0049);
    posSize.textContent = v.side === 'flat' ? '0' : formatQty(Math.abs(v.position)) + ' конт.';
    posEntryEl.textContent = v.side === 'flat' ? '—' : formatPrice(v.avgEntry);
    posMark.textContent = formatPrice(price);
    posLiq.textContent = v.liqPrice ? formatPrice(v.liqPrice) : '—';
    posLiq.classList.toggle('active', v.liqPrice !== null);
    btnClose.disabled = v.side === 'flat';

    const qty = currentQty();
    ordNotional.textContent = '$' + formatMoney(qty * price);
    ordMargin.textContent = '$' + formatMoney((qty * price) / account.leverage);
    ordMax.textContent = formatQty(v.maxQty) + ' конт.';

    mmMark.textContent = formatPrice(price);
    mmDelta.textContent = '±$' + mmImpact().toFixed(1);
  }

  function refreshPositionLines(): void {
    if (Number.isNaN(latestPrice)) {
      chart.setPosition(null, null, 'flat');
      return;
    }
    const v = account.view(latestPrice);
    chart.setPosition(v.side === 'flat' ? null : v.avgEntry, v.liqPrice, v.side);
  }

  // ---- Token / lock ----
  function setLocked(locked: boolean): void {
    lockBtn.classList.toggle('is-active', !locked);
    lockBtn.setAttribute('data-tip', locked ? 'Разблокировать управление (токен)' : 'Управление разблокировано — нажмите, чтобы заблокировать');
  }

  function promptToken(cb?: () => void): void {
    const t = window.prompt('Контрольный токен (показан в консоли сервера при запуске):', '');
    if (!t) return;
    client.verify(t).then((r) => {
      if (r.ok) {
        client.setToken(t);
        setLocked(false);
        toast('Управление разблокировано', 'info');
        cb?.();
      } else {
        toast('Неверный токен', 'warn');
      }
    });
  }

  /** Ensure a control token is present. Returns true if one already exists, so
   * the caller proceeds inline. If absent, opens the prompt and runs `cb` only
   * after a successful unlock — it must NOT run `cb` when a token is already
   * present (that would re-invoke the caller and recurse). */
  function ensureToken(cb?: () => void): boolean {
    if (client.hasToken()) return true;
    promptToken(cb);
    return false;
  }

  function handleControlError(r: { ok: boolean; status: number; data: Record<string, unknown> }): void {
    if (r.status === 401) {
      client.clearToken();
      setLocked(true);
      toast('Требуется действительный токен', 'warn');
      promptToken();
    } else if (r.status === 0) {
      toast('Сервер недоступен', 'warn');
    } else {
      toast('✕ ' + (typeof r.data.error === 'string' ? r.data.error : 'ошибка'), 'warn');
    }
  }

  lockBtn.addEventListener('click', () => {
    if (client.hasToken()) {
      client.clearToken();
      setLocked(true);
      toast('Управление заблокировано', 'info');
    } else {
      promptToken();
    }
  });

  // ---- Quantity controls (local paper account — no token needed) ----
  function currentQty(): number {
    const raw = parseFloat(qtyInput.value.replace(',', '.'));
    if (!Number.isFinite(raw)) return account.minQty;
    return Math.max(account.minQty, roundStep(raw, account.step));
  }
  function setQty(q: number): void {
    qtyInput.value = formatQty(Math.max(account.minQty, roundStep(q, account.step)));
    updateTrading(latestPrice);
  }
  $('#qty-minus').addEventListener('click', () => setQty(currentQty() - account.step));
  $('#qty-plus').addEventListener('click', () => setQty(currentQty() + account.step));
  qtyInput.addEventListener('change', () => setQty(currentQty()));
  $all('.qty-presets button').forEach((b) => {
    b.addEventListener('click', () => {
      const mul = parseFloat(b.dataset.qmul || '1');
      const max = account.view(latestPrice).maxQty;
      setQty(Math.max(account.minQty, max * mul));
    });
  });

  // ---- Orders (local) ----
  function order(side: 'buy' | 'sell'): void {
    if (Number.isNaN(latestPrice)) return;
    const qty = currentQty();
    const res = account.market(side, qty, latestPrice);
    if (!res.ok) {
      toast('✕ ' + (res.reason ?? 'ошибка'), 'warn');
      return;
    }
    chart.addMarker(Math.floor(simTimeMs / 1000), side);
    refreshPositionLines();
    updateTrading(latestPrice);
    toast(`${side === 'buy' ? '▲ Куплено' : '▼ Продано'} ${formatQty(qty)} @ ${formatPrice(latestPrice)}`, side);
  }
  btnBuy.addEventListener('click', () => order('buy'));
  btnSell.addEventListener('click', () => order('sell'));
  btnClose.addEventListener('click', () => {
    const res = account.close(latestPrice);
    if (!res.ok) return;
    refreshPositionLines();
    updateTrading(latestPrice);
    toast(`Позиция закрыта · ${formatSignedMoney(res.realized ?? 0)}`, (res.realized ?? 0) >= 0 ? 'buy' : 'sell');
  });

  // ---- Market-Maker mode (token-gated — affects the global stream) ----
  function mmImpact(): number {
    const raw = parseFloat(mmImpactInput.value.replace(',', '.'));
    if (!Number.isFinite(raw)) return 0.1;
    return Math.max(0.1, roundStep(raw, 0.1));
  }
  function setImpact(v: number): void {
    mmImpactInput.value = Math.max(0.1, roundStep(v, 0.1)).toFixed(1);
    updateTrading(latestPrice);
  }
  function renderMmNet(): void {
    mmNetEl.textContent = (mmNet >= 0 ? '+$' : '−$') + formatMoney(Math.abs(mmNet));
    mmNetEl.classList.toggle('up', mmNet > 0.0049);
    mmNetEl.classList.toggle('down', mmNet < -0.0049);
  }
  async function injectMM(dir: 'up' | 'down'): Promise<void> {
    if (!ensureToken(() => void injectMM(dir))) return;
    const amt = mmImpact();
    const delta = dir === 'up' ? amt : -amt;
    const r = await client.nudge(delta);
    if (!r.ok) return handleControlError(r);
    mmNet += delta;
    renderMmNet();
    const px = typeof r.data.price === 'number' ? r.data.price : latestPrice;
    toast(
      `${dir === 'up' ? '▲ ВВЕРХ' : '▼ ВНИЗ'} ${dir === 'up' ? '+' : '−'}$${amt.toFixed(1)} @ ${formatPrice(px)}`,
      dir === 'up' ? 'buy' : 'sell',
    );
  }
  function setMM(on: boolean): void {
    if (on && !ensureToken(() => setMM(true))) return;
    orderpanel.classList.toggle('is-mm', on);
    mmToggle.setAttribute('aria-checked', String(on));
    document.querySelector('.mm-front')?.setAttribute('aria-hidden', on ? 'true' : 'false');
    document.querySelector('.mm-back')?.setAttribute('aria-hidden', on ? 'false' : 'true');
    updateTrading(latestPrice);
    persistPrefs();
  }

  $('#mm-minus').addEventListener('click', () => setImpact(mmImpact() - 0.1));
  $('#mm-plus').addEventListener('click', () => setImpact(mmImpact() + 0.1));
  mmImpactInput.addEventListener('change', () => setImpact(mmImpact()));
  $all('.mm-back .qty-presets button').forEach((b) =>
    b.addEventListener('click', () => setImpact(parseFloat(b.dataset.impact || '1'))),
  );
  mmBuy.addEventListener('click', () => void injectMM('up'));
  mmSell.addEventListener('click', () => void injectMM('down'));
  mmToggle.addEventListener('click', () => setMM(!orderpanel.classList.contains('is-mm')));

  function setLiveState(isRunning: boolean): void {
    liveLabel.textContent = isRunning ? 'LIVE' : 'PAUSE';
    liveEl.classList.toggle('paused', !isRunning);
    playBtn.classList.toggle('paused', !isRunning);
    playBtn.setAttribute('data-tip', isRunning ? 'Пауза' : 'Старт');
  }

  // ---- Timeframe switching (viewing — no token) ----
  async function applyTimeframe(tf: TfSeconds): Promise<void> {
    if (tf === activeTf) return;
    activeTf = tf;
    switching = true;
    setTfActive(tf);
    stTf.textContent = TF_LABEL[tf];
    chart.setTimeframe(tf);
    client.switchTimeframe(tf);
    persistPrefs();
    try {
      const okSwitch = await loadActive(true);
      if (!okSwitch) toast('Не удалось загрузить таймфрейм', 'warn');
    } finally {
      if (activeTf === tf) switching = false;
    }
  }

  $all('#tf-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => void applyTimeframe(Number(btn.dataset.tf) as TfSeconds));
  });
  selSecTf.addEventListener('change', () => void applyTimeframe(Number(selSecTf.value) as TfSeconds));

  // ---- Chart type / theme / volume (local) ----
  $all('#type-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type as ChartType;
      setActive('#type-group .seg-btn', (b) => b === btn);
      chart.setType(type);
      persistPrefs();
    });
  });
  themeBtn.addEventListener('click', () => {
    const next: Theme = chart.getTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    chart.setTheme(next);
    persistPrefs();
  });
  volBtn.addEventListener('click', () => {
    const visible = chart.toggleVolume();
    volBtn.classList.toggle('is-active', visible);
    persistPrefs();
  });

  // ---- Generator mode / regime (token-gated — global) ----
  $all('#mode-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode === 'manual' ? 'manual' : 'auto';
      if (!ensureToken(() => btn.click())) return;
      client.setMode(mode, selSpeed.value, selVol.value).then((r) => {
        if (!r.ok) handleControlError(r);
      });
    });
  });
  selSpeed.addEventListener('change', () => {
    if (!ensureToken()) return;
    client.setRegime(selSpeed.value, selVol.value).then((r) => {
      if (!r.ok) handleControlError(r);
    });
  });
  selVol.addEventListener('change', () => {
    if (!ensureToken()) return;
    client.setRegime(selSpeed.value, selVol.value).then((r) => {
      if (!r.ok) handleControlError(r);
    });
  });

  // ---- Tools (local) ----
  function selectTool(tool: Tool, btn: HTMLElement): void {
    setActive('.toolrail .tool', (b) => b === btn);
    chart.setTool(tool);
    chartWrap.classList.remove('tool-hline', 'tool-vline', 'tool-fib', 'tool-erase');
    if (tool === 'hline' || tool === 'vline' || tool === 'fib' || tool === 'erase') {
      chartWrap.classList.add(`tool-${tool}`);
    }
    const hint = TOOL_HINTS[tool];
    if (hint) {
      hintEl.textContent = hint;
      hintEl.classList.add('show');
    } else {
      hintEl.classList.remove('show');
    }
  }
  $all('.toolrail .tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => selectTool(btn.dataset.tool as Tool, btn));
  });
  $('#btn-clear').addEventListener('click', () => chart.clearDrawings());

  // ---- Zoom (local) ----
  $('#zoom-in').addEventListener('click', () => chart.zoomIn());
  $('#zoom-out').addEventListener('click', () => chart.zoomOut());
  $('#zoom-fit').addEventListener('click', () => chart.fit());
  $('#zoom-reset').addEventListener('click', () => {
    chart.resetView();
    chart.scrollToRealtime();
  });

  // ---- Play / pause (token-gated — global) ----
  playBtn.addEventListener('click', () => {
    if (!ensureToken()) return;
    const call = running ? client.pause() : client.resume();
    call.then((r) => {
      if (!r.ok) handleControlError(r);
    });
  });

  // ---- Reset (token-gated — global; SSE 'reset' refreshes every viewer) ----
  $('#btn-reset').addEventListener('click', () => {
    if (!window.confirm('Сбросить график для всех? Начнётся новая случайная последовательность, ваш депозит вернётся к $1000.')) return;
    if (!ensureToken()) return;
    client.reset().then((r) => {
      if (!r.ok) handleControlError(r);
    });
  });

  // ---- Persist account on exit / tab hide (local) ----
  const persistAll = () => account.save();
  window.addEventListener('beforeunload', persistAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistAll();
  });

  // ---- Go ----
  const dc = chart.drawingCounts();
  stDraw.textContent = String(dc.h + dc.v + dc.fib);
  updateLegend(null);
  renderMmNet();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
