// Entry point: wires the simulation engine, the chart controller and the UI.

import './style.css';
import { Engine, SPEED_NAMES, VOL_NAMES, type Candle, type TfSeconds, type RegimeMode } from './engine';
import { ChartController, type ChartType, type Tool, type Theme } from './chart';
import { loadPrefs, savePrefs } from './storage';

// ---- DOM helpers ----
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};
const $all = <T extends HTMLElement = HTMLElement>(sel: string): T[] =>
  Array.from(document.querySelectorAll<T>(sel));

// ---- Formatting ----
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfInt = new Intl.NumberFormat('en-US');
const fmt = (v: number): string => nf2.format(v);
const fmtSigned = (v: number): string => {
  const r = Math.abs(v) < 0.005 ? 0 : v;
  return (r >= 0 ? '+' : '-') + nf2.format(Math.abs(r));
};
const fmtPct = (v: number): string => {
  const r = Math.abs(v) < 0.005 ? 0 : v;
  return (r >= 0 ? '+' : '-') + Math.abs(r).toFixed(2) + '%';
};

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

// ---- Boot ----
function boot(): void {
  const prefs = loadPrefs();

  // Theme must be applied before the chart is created.
  const theme: Theme = prefs?.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;

  // Refs
  const priceEl = $('#price-value');
  const changeEl = $('#price-change');
  const liveEl = $('#live');
  const liveLabel = $('#live-label');
  const playBtn = $('#btn-playpause');
  const themeBtn = $('#btn-theme');

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

  // Populate manual-mode selects.
  selSpeed.innerHTML = SPEED_NAMES.map((n) => `<option value="${n}">${SPEED_LABELS[n] ?? n}</option>`).join('');
  selVol.innerHTML = VOL_NAMES.map((n) => `<option value="${n}">${VOL_LABELS[n] ?? n}</option>`).join('');

  // Chart controller
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

  // Engine
  let prevPrice = NaN;
  const engine = new Engine({
    onTick: (price) => {
      chart.updateLive(engine.base);
      updateHeader(price);
      updateStatus();
    },
    onSave: () => {
      stSave.classList.add('flash');
      setTimeout(() => stSave.classList.remove('flash'), 400);
    },
  });

  const restored = engine.init();
  chart.setBase(engine.base, true);
  prevPrice = engine.price;

  // ---- Restore saved view + behaviour ----
  if (prefs) {
    if (prefs.type && prefs.type !== 'candles') {
      chart.setType(prefs.type as ChartType);
      setActive('#type-group .seg-btn', (b) => b.dataset.type === prefs.type);
    }
    if (prefs.tf && prefs.tf !== 1) {
      const tf = prefs.tf as TfSeconds;
      chart.setTimeframe(tf);
      setActive('#tf-group .seg-btn', (b) => Number(b.dataset.tf) === tf);
    }
  }
  // Manual regime selections.
  if (prefs?.speed && SPEED_NAMES.includes(prefs.speed)) selSpeed.value = prefs.speed;
  if (prefs?.vol && VOL_NAMES.includes(prefs.vol)) selVol.value = prefs.vol;
  applyMode((prefs?.mode as RegimeMode) === 'manual' ? 'manual' : 'auto', false);

  updateHeader(engine.price);
  updateStatus();
  updateLegend(latestCandle());

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
    });
  }

  function latestCandle(): Candle | null {
    return engine.base.length ? engine.base[engine.base.length - 1] : null;
  }

  function updateHeader(price: number): void {
    priceEl.textContent = fmt(price);
    const up = price >= engine.startPrice;
    priceEl.classList.toggle('up', up);
    priceEl.classList.toggle('down', !up);

    const chg = price - engine.startPrice;
    const pct = engine.startPrice !== 0 ? (chg / Math.abs(engine.startPrice)) * 100 : 0;
    changeEl.textContent = `${fmtSigned(chg)}  ${fmtPct(pct)}`;
    changeEl.classList.toggle('up', chg >= 0);
    changeEl.classList.toggle('down', chg < 0);

    if (!Number.isNaN(prevPrice) && price !== prevPrice) {
      const cls = price > prevPrice ? 'tick-up' : 'tick-down';
      priceEl.classList.remove('tick-up', 'tick-down');
      void priceEl.offsetWidth; // reflow to restart animation
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
    lgO.textContent = fmt(bar.open);
    lgH.textContent = fmt(bar.high);
    lgL.textContent = fmt(bar.low);
    lgC.textContent = fmt(bar.close);
    lgV.textContent = nfInt.format(bar.volume);
    const d = bar.close - bar.open;
    const pct = bar.open !== 0 ? (d / Math.abs(bar.open)) * 100 : 0;
    lgChg.textContent = `${fmtSigned(d)} (${fmtPct(pct)})`;
    lgChg.classList.toggle('up', d >= 0);
    lgChg.classList.toggle('down', d < 0);
  }

  function updateStatus(): void {
    stRegime.textContent = `${engine.regimeName().toUpperCase()}·${engine.volName().toUpperCase()}`;
    stTps.textContent = String(engine.ticksPerSecond());
    stTicks.textContent = nfInt.format(engine.tickCount);
    stCandles.textContent = nfInt.format(engine.base.length);
    stClock.textContent = fmtClock(engine.simTimeMs);
    // In auto mode reflect the live regime in the (disabled) selects.
    if (engine.getMode() === 'auto') {
      selSpeed.value = engine.regimeName();
      selVol.value = engine.volName();
    }
  }

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

  // ---- Timeframe buttons ----
  $all('#tf-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tf = Number(btn.dataset.tf) as TfSeconds;
      setActive('#tf-group .seg-btn', (b) => b === btn);
      chart.setTimeframe(tf);
      stTf.textContent = TF_LABEL[tf];
      persistPrefs();
    });
  });

  // ---- Chart type buttons ----
  $all('#type-group .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type as ChartType;
      setActive('#type-group .seg-btn', (b) => b === btn);
      chart.setType(type);
      persistPrefs();
    });
  });

  // ---- Mode buttons + manual selects ----
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

  // ---- Theme toggle ----
  themeBtn.addEventListener('click', () => {
    const next: Theme = chart.getTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    chart.setTheme(next);
    persistPrefs();
  });

  // ---- Tool buttons ----
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

  // ---- Zoom buttons ----
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

  // ---- Reset (new chart) ----
  $('#btn-reset').addEventListener('click', () => {
    if (!window.confirm('Сбросить график и начать новую случайную последовательность?')) return;
    engine.reset();
    chart.clearDrawings();
    chart.setBase(engine.base, true);
    prevPrice = engine.price;
    updateHeader(engine.price);
    updateStatus();
    updateLegend(latestCandle());
    engine.start();
    setLiveState(true);
  });

  // ---- Persist on exit / tab hide ----
  window.addEventListener('beforeunload', () => engine.saveNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') engine.saveNow();
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
