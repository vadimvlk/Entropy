// Entry point: wires the simulation engine, the chart controller, the trading
// account and the UI.

import './style.css';
import { Engine, SPEED_NAMES, VOL_NAMES, type Candle, type TfSeconds, type RegimeMode } from './engine';
import { ChartController, type ChartType, type Tool, type Theme } from './chart';
import { Account } from './trading';
import { loadPrefs, savePrefs } from './storage';
import { formatPrice, formatMoney, formatSignedMoney, formatPct, roundStep, formatQty } from './format';

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

const TF_LABEL: Record<number, string> = { 1: '1s', 5: '5s', 15: '15s', 60: '1m', 300: '5m' };
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

function boot(): void {
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

  const stRegime = $('#st-regime');
  const stTps = $('#st-tps');
  const stTicks = $('#st-ticks');
  const stCandles = $('#st-candles');
  const stTf = $('#st-tf');
  const stDraw = $('#st-draw');
  const stClock = $('#st-clock');
  const stSave = $('#st-save');

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

  let prevPrice = NaN;
  const engine = new Engine({
    onTick: (price) => {
      chart.updateLive(engine.base);
      if (account.liquidateIfNeeded(price)) {
        refreshPositionLines();
        toast('⚠ ЛИКВИДАЦИЯ ПОЗИЦИИ', 'warn');
      }
      updateHeader(price);
      updateStatus();
      updateTrading(price);
    },
    onSave: () => {
      stSave.classList.add('flash');
      setTimeout(() => stSave.classList.remove('flash'), 400);
    },
  });

  const restored = engine.init();
  chart.setBase(engine.base, true);
  prevPrice = engine.price;

  // ---- Restore view + behaviour ----
  if (prefs) {
    if (prefs.type && prefs.type !== 'candles') {
      chart.setType(prefs.type as ChartType);
      setActive('#type-group .seg-btn', (b) => b.dataset.type === prefs.type);
    }
    if (prefs.tf && prefs.tf !== 1) {
      const tf = prefs.tf as TfSeconds;
      chart.setTimeframe(tf);
      setActive('#tf-group .seg-btn', (b) => Number(b.dataset.tf) === tf);
      stTf.textContent = TF_LABEL[tf];
    }
  }
  if (prefs?.speed && SPEED_NAMES.includes(prefs.speed)) selSpeed.value = prefs.speed;
  if (prefs?.vol && VOL_NAMES.includes(prefs.vol)) selVol.value = prefs.vol;
  applyMode((prefs?.mode as RegimeMode) === 'manual' ? 'manual' : 'auto', false);
  if (prefs?.showVolume === false) {
    chart.setVolumeVisible(false);
    volBtn.classList.remove('is-active');
  }

  refreshPositionLines();
  updateHeader(engine.price);
  updateStatus();
  updateLegend(latestCandle());
  updateTrading(engine.price);

  // ---- Helpers ----
  function setActive(sel: string, pred: (b: HTMLElement) => boolean): void {
    $all(sel).forEach((b) => b.classList.toggle('is-active', pred(b)));
  }

  function persistPrefs(): void {
    savePrefs({
      tf: chart.getTimeframe(),
      type: chart.getType(),
      theme: chart.getTheme(),
      mode: engine.getMode(),
      speed: selSpeed.value,
      vol: selVol.value,
      showVolume: chart.isVolumeVisible(),
    });
  }

  function latestCandle(): Candle | null {
    return engine.base.length ? engine.base[engine.base.length - 1] : null;
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
    priceEl.textContent = formatPrice(price);
    const up = price >= engine.startPrice;
    priceEl.classList.toggle('up', up);
    priceEl.classList.toggle('down', !up);

    const chg = price - engine.startPrice;
    const pct = engine.startPrice !== 0 ? (chg / Math.abs(engine.startPrice)) * 100 : 0;
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

  function updateStatus(): void {
    stRegime.textContent = `${engine.regimeName().toUpperCase()}·${engine.volName().toUpperCase()}`;
    stTps.textContent = String(engine.ticksPerSecond());
    stTicks.textContent = nfInt.format(engine.tickCount);
    stCandles.textContent = nfInt.format(engine.base.length);
    stClock.textContent = fmtClock(engine.simTimeMs);
    if (engine.getMode() === 'auto') {
      selSpeed.value = engine.regimeName();
      selVol.value = engine.volName();
    }
  }

  // ---- Trading UI ----
  function updateTrading(price: number): void {
    const v = account.view(price);
    acBalance.textContent = '$' + formatMoney(v.balance);
    acEquity.textContent = '$' + formatMoney(v.equity);
    acFree.textContent = '$' + formatMoney(v.freeMargin);
    acRealized.textContent = formatSignedMoney(v.realized);
    signClass(acRealized, v.realized);

    // Position card
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

    // Order meta for the currently entered quantity
    const qty = currentQty();
    ordNotional.textContent = '$' + formatMoney(qty * price);
    ordMargin.textContent = '$' + formatMoney((qty * price) / account.leverage);
    ordMax.textContent = formatQty(v.maxQty) + ' конт.';
  }

  function refreshPositionLines(): void {
    const v = account.view(engine.price);
    chart.setPosition(v.side === 'flat' ? null : v.avgEntry, v.liqPrice, v.side);
  }

  // ---- Quantity controls ----
  function currentQty(): number {
    const raw = parseFloat(qtyInput.value.replace(',', '.'));
    if (!Number.isFinite(raw)) return account.minQty;
    return Math.max(account.minQty, roundStep(raw, account.step));
  }
  function setQty(q: number): void {
    qtyInput.value = formatQty(Math.max(account.minQty, roundStep(q, account.step)));
    updateTrading(engine.price);
  }
  $('#qty-minus').addEventListener('click', () => setQty(currentQty() - account.step));
  $('#qty-plus').addEventListener('click', () => setQty(currentQty() + account.step));
  qtyInput.addEventListener('change', () => setQty(currentQty()));
  $all('.qty-presets button').forEach((b) => {
    b.addEventListener('click', () => {
      const mul = parseFloat(b.dataset.qmul || '1');
      const max = account.view(engine.price).maxQty;
      setQty(Math.max(account.minQty, max * mul));
    });
  });

  // ---- Orders ----
  function order(side: 'buy' | 'sell'): void {
    const qty = currentQty();
    const res = account.market(side, qty, engine.price);
    if (!res.ok) {
      toast('✕ ' + (res.reason ?? 'ошибка'), 'warn');
      return;
    }
    chart.addMarker(Math.floor(engine.simTimeMs / 1000), side);
    refreshPositionLines();
    updateTrading(engine.price);
    toast(`${side === 'buy' ? '▲ Куплено' : '▼ Продано'} ${formatQty(qty)} @ ${formatPrice(engine.price)}`, side);
  }
  btnBuy.addEventListener('click', () => order('buy'));
  btnSell.addEventListener('click', () => order('sell'));
  btnClose.addEventListener('click', () => {
    const res = account.close(engine.price);
    if (!res.ok) return;
    refreshPositionLines();
    updateTrading(engine.price);
    toast(`Позиция закрыта · ${formatSignedMoney(res.realized ?? 0)}`, (res.realized ?? 0) >= 0 ? 'buy' : 'sell');
  });

  function setLiveState(running: boolean): void {
    liveLabel.textContent = running ? 'LIVE' : 'PAUSE';
    liveEl.classList.toggle('paused', !running);
    playBtn.classList.toggle('paused', !running);
    playBtn.setAttribute('data-tip', running ? 'Пауза' : 'Старт');
  }

  function applyMode(mode: RegimeMode, persist = true): void {
    engine.setMode(mode);
    manualControls.hidden = mode !== 'manual';
    setActive('#mode-group .seg-btn', (b) => b.dataset.mode === mode);
    selSpeed.disabled = mode !== 'manual';
    selVol.disabled = mode !== 'manual';
    if (mode === 'manual') {
      engine.setManualSpeed(selSpeed.value);
      engine.setManualVol(selVol.value);
    }
    if (persist) persistPrefs();
    updateStatus();
  }

  // ---- Timeframe / type / mode / theme ----
  $all('#tf-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tf = Number(btn.dataset.tf) as TfSeconds;
      setActive('#tf-group .seg-btn', (b) => b === btn);
      chart.setTimeframe(tf);
      stTf.textContent = TF_LABEL[tf];
      persistPrefs();
    });
  });
  $all('#type-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type as ChartType;
      setActive('#type-group .seg-btn', (b) => b === btn);
      chart.setType(type);
      persistPrefs();
    });
  });
  $all('#mode-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyMode(btn.dataset.mode as RegimeMode));
  });
  selSpeed.addEventListener('change', () => {
    engine.setManualSpeed(selSpeed.value);
    persistPrefs();
    updateStatus();
  });
  selVol.addEventListener('change', () => {
    engine.setManualVol(selVol.value);
    persistPrefs();
    updateStatus();
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

  // ---- Tools ----
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

  // ---- Zoom ----
  $('#zoom-in').addEventListener('click', () => chart.zoomIn());
  $('#zoom-out').addEventListener('click', () => chart.zoomOut());
  $('#zoom-fit').addEventListener('click', () => chart.fit());
  $('#zoom-reset').addEventListener('click', () => {
    chart.resetView();
    chart.scrollToRealtime();
  });

  // ---- Play / pause ----
  playBtn.addEventListener('click', () => {
    if (engine.isRunning()) {
      engine.pause();
      setLiveState(false);
    } else {
      engine.start();
      setLiveState(true);
    }
  });

  // ---- Reset (new chart + fresh account) ----
  $('#btn-reset').addEventListener('click', () => {
    if (!window.confirm('Сбросить график и счёт? Начнётся новая случайная последовательность, депозит вернётся к $1000.')) return;
    engine.reset();
    account.reset();
    chart.clearDrawings();
    chart.clearMarkers();
    chart.setPosition(null, null, 'flat');
    chart.setBase(engine.base, true);
    prevPrice = engine.price;
    updateHeader(engine.price);
    updateStatus();
    updateLegend(latestCandle());
    updateTrading(engine.price);
    engine.start();
    setLiveState(true);
  });

  // ---- Persist on exit / tab hide ----
  const persistAll = () => {
    engine.saveNow();
    account.save();
  };
  window.addEventListener('beforeunload', persistAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistAll();
  });

  // ---- Go ----
  stTf.textContent = TF_LABEL[chart.getTimeframe()];
  const dc = chart.drawingCounts();
  stDraw.textContent = String(dc.h + dc.v + dc.fib);
  engine.start();
  setLiveState(true);

  void restored;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
