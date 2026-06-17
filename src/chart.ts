// Chart controller: wraps TradingView Lightweight Charts (v5). Owns the price
// series, a volume pane, timeframe + chart-type switching, light/dark theming,
// the live tick update path, drawing tools (horizontal/vertical lines, a
// draggable Fibonacci tool), crosshair/legend wiring and zoom.
//
// Data model: the server is authoritative per timeframe. The controller holds
// the bars of the *currently selected* timeframe (`this.bars`) exactly as the
// server delivers them — it no longer aggregates a 1-second base locally.

import {
  createChart,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  CrosshairMode,
  LineStyle,
  ColorType,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type MouseEventParams,
  type SeriesType,
  type DeepPartial,
  type ChartOptions,
  type PriceFormat,
  type Coordinate,
} from 'lightweight-charts';
import { bucketOf, type Candle, type TfSeconds } from '../shared/candles';
import { VerticalLine } from './verticalLine';
import { FibTool, type FibColors } from './fib';
import { HiLoLabels, type HiLoColors } from './hilo';
import { formatPrice } from './format';
import { loadDrawings, saveDrawings, clearDrawings, type Drawings } from './storage';

export type ChartType = 'candles' | 'line' | 'area';
export type Tool = 'cursor' | 'crosshair' | 'hline' | 'vline' | 'fib' | 'erase';
export type Theme = 'dark' | 'light';
export type PosSide = 'long' | 'short' | 'flat';

const PRICE_FORMAT: PriceFormat = { type: 'custom', formatter: (p) => formatPrice(p as number), minMove: 1e-7 };

interface Palette {
  up: string;
  down: string;
  line: string;
  areaTop: string;
  areaBottom: string;
  grid: string;
  border: string;
  text: string;
  crosshair: string;
  crosshairLabel: string;
  hline: string;
  vline: string;
  bg: string;
  volUp: string;
  volDown: string;
  fib: FibColors;
  hilo: HiLoColors;
}

const PALETTES: Record<Theme, Palette> = {
  dark: {
    up: '#22d39a',
    down: '#ff4d6d',
    line: '#4ee6c4',
    areaTop: 'rgba(78, 230, 196, 0.30)',
    areaBottom: 'rgba(78, 230, 196, 0.0)',
    grid: 'rgba(255, 255, 255, 0.035)',
    border: 'rgba(255, 255, 255, 0.08)',
    text: '#8b97ab',
    crosshair: 'rgba(120, 162, 255, 0.55)',
    crosshairLabel: '#1b2436',
    hline: 'rgba(255, 191, 73, 0.9)',
    vline: 'rgba(120, 162, 255, 0.85)',
    bg: '#0a0e16',
    volUp: 'rgba(34, 211, 154, 0.45)',
    volDown: 'rgba(255, 77, 109, 0.45)',
    fib: {
      lines: ['#ff5c7a', '#ffbf49', '#4ee6c4', '#78a2ff'],
      fills: ['rgba(255,92,122,0.07)', 'rgba(255,191,73,0.07)', 'rgba(78,230,196,0.07)'],
      text: '#e8eef7',
    },
    hilo: { bg: '#39435a', text: '#dbe3ef' },
  },
  light: {
    up: '#0f9d6b',
    down: '#e0245e',
    line: '#0d9488',
    areaTop: 'rgba(13, 148, 136, 0.22)',
    areaBottom: 'rgba(13, 148, 136, 0.0)',
    grid: 'rgba(15, 23, 42, 0.06)',
    border: 'rgba(15, 23, 42, 0.14)',
    text: '#5a6678',
    crosshair: 'rgba(40, 70, 130, 0.5)',
    crosshairLabel: '#33415c',
    hline: 'rgba(217, 119, 6, 0.95)',
    vline: 'rgba(59, 99, 200, 0.85)',
    bg: '#ffffff',
    volUp: 'rgba(15, 157, 107, 0.5)',
    volDown: 'rgba(224, 36, 94, 0.5)',
    fib: {
      lines: ['#e0245e', '#d97706', '#0d9488', '#3b63c8'],
      fills: ['rgba(224,36,94,0.07)', 'rgba(217,119,6,0.07)', 'rgba(13,148,136,0.07)'],
      text: '#0e1420',
    },
    hilo: { bg: '#aab4c4', text: '#16202e' },
  },
};

export interface ChartCallbacks {
  onBar?: (bar: Candle | null, isLatest: boolean) => void;
  onDrawingsChanged?: (counts: { h: number; v: number; fib: number }) => void;
}

const DEFAULT_BAR_SPACING = 9;

export class ChartController {
  private container: HTMLElement;
  private chart: IChartApi;
  private series!: ISeriesApi<SeriesType>;
  private volumeSeries: ISeriesApi<'Histogram'> | null = null;
  private volumeVisible = true;
  private type: ChartType = 'candles';
  private tf: TfSeconds = 1;
  // Bars of the currently selected timeframe, exactly as served.
  private bars: Candle[] = [];
  private tool: Tool = 'cursor';
  private magnet = false;
  private theme: Theme = 'dark';
  private colors: Palette = PALETTES.dark;

  // Drawings stored as plain data; rendered objects are recreated per series.
  private hlinePrices: number[] = [];
  private vlineTimes: number[] = [];
  private fibPrices: [number, number] | null = null;
  private fibTime: number | null = null;
  private priceLineObjs: IPriceLine[] = [];
  private vlineObjs: VerticalLine[] = [];
  private fib: FibTool | null = null;

  // Trading position overlay.
  private posEntry: number | null = null;
  private posLiq: number | null = null;
  private posSide: PosSide = 'flat';
  private entryLine: IPriceLine | null = null;
  private liqLine: IPriceLine | null = null;
  private markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
  private markersData: { time: number; side: 'buy' | 'sell' }[] = [];

  // Visible-range high/low axis labels.
  private hilo: HiLoLabels | null = null;

  // Fib drag state.
  private drag: { kind: 'create' | 'move'; grab: 'a' | 'b' | 'body'; lastPrice: number } | null = null;

  private hovering = false;
  private barSpacing = DEFAULT_BAR_SPACING;
  private cb: ChartCallbacks;

  constructor(container: HTMLElement, cb: ChartCallbacks = {}, theme: Theme = 'dark') {
    this.cb = cb;
    this.container = container;
    this.theme = theme;
    this.colors = PALETTES[theme];

    const options: DeepPartial<ChartOptions> = {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: this.colors.bg },
        textColor: this.colors.text,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: this.colors.grid },
        horzLines: { color: this.colors.grid },
      },
      crosshair: this.crosshairOptions(),
      rightPriceScale: {
        borderColor: this.colors.border,
        scaleMargins: { top: 0.1, bottom: 0.1 },
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: this.colors.border,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 6,
        barSpacing: this.barSpacing,
      },
      handleScroll: true,
      handleScale: true,
    };
    this.chart = createChart(container, options);

    const d = loadDrawings();
    this.hlinePrices = d.hlines.slice();
    this.vlineTimes = d.vlines.slice();
    this.fibPrices = d.fib ? [d.fib[0], d.fib[1]] : null;
    this.fibTime = d.fib ? d.fib[2] : null;

    this.createSeries();
    this.createVolume();

    this.chart.subscribeClick((p) => this.onClick(p));
    this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.updateHiLo());
    // Raw pointer handling for the draggable Fibonacci tool (capture phase so
    // we can intercept before the chart starts panning).
    this.container.addEventListener('pointerdown', this.onPointerDown, true);
  }

  private crosshairOptions() {
    return {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: this.colors.crosshair,
        width: 1 as const,
        style: LineStyle.LargeDashed,
        labelBackgroundColor: this.colors.crosshairLabel,
      },
      horzLine: {
        color: this.colors.crosshair,
        width: 1 as const,
        style: LineStyle.LargeDashed,
        labelBackgroundColor: this.colors.crosshairLabel,
      },
    };
  }

  // ---- Series lifecycle ----

  private createSeries(): void {
    const priceFormat = PRICE_FORMAT;
    if (this.type === 'candles') {
      this.series = this.chart.addSeries(
        CandlestickSeries,
        {
          upColor: this.colors.up,
          downColor: this.colors.down,
          borderUpColor: this.colors.up,
          borderDownColor: this.colors.down,
          wickUpColor: this.colors.up,
          wickDownColor: this.colors.down,
          priceFormat,
        },
        0,
      );
    } else if (this.type === 'line') {
      this.series = this.chart.addSeries(LineSeries, { color: this.colors.line, lineWidth: 2, priceFormat }, 0);
    } else {
      this.series = this.chart.addSeries(
        AreaSeries,
        {
          lineColor: this.colors.line,
          topColor: this.colors.areaTop,
          bottomColor: this.colors.areaBottom,
          lineWidth: 2,
          priceFormat,
        },
        0,
      );
    }
    // Keep the main pane alive even while its series is briefly removed (type
    // switch). Otherwise the empty pane collapses, the volume pane becomes
    // pane 0, and the recreated main series overlaps the volume bars.
    this.chart.panes()[0]?.setPreserveEmptyPane(true);
    this.markersPlugin = createSeriesMarkers(this.series, []);
    this.applyMarkers();
    this.hilo = new HiLoLabels(this.colors.hilo);
    this.series.attachPrimitive(this.hilo);
  }

  private createVolume(): void {
    if (this.volumeSeries) return;
    this.volumeSeries = this.chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false },
      1, // separate pane below the price pane
    );
    this.volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
    this.volumeSeries.setData(this.toVolumeData(this.bars));
    this.applyVolumeStretch();
  }

  private applyVolumeStretch(): void {
    const panes = this.chart.panes();
    if (panes.length > 1) {
      panes[0].setStretchFactor(5);
      panes[1].setStretchFactor(1);
    }
  }

  private removeVolume(): void {
    if (!this.volumeSeries) return;
    this.chart.removeSeries(this.volumeSeries);
    this.volumeSeries = null; // its (now empty, non-preserved) pane auto-collapses
  }

  /** Show / hide the volume pane (chart uses full height when hidden). */
  setVolumeVisible(visible: boolean): void {
    if (visible === this.volumeVisible) return;
    this.volumeVisible = visible;
    if (visible) this.createVolume();
    else this.removeVolume();
  }

  toggleVolume(): boolean {
    this.setVolumeVisible(!this.volumeVisible);
    return this.volumeVisible;
  }

  isVolumeVisible(): boolean {
    return this.volumeVisible;
  }

  private applySeriesColors(): void {
    if (this.type === 'candles') {
      this.series.applyOptions({
        upColor: this.colors.up,
        downColor: this.colors.down,
        borderUpColor: this.colors.up,
        borderDownColor: this.colors.down,
        wickUpColor: this.colors.up,
        wickDownColor: this.colors.down,
      });
    } else if (this.type === 'line') {
      this.series.applyOptions({ color: this.colors.line });
    } else {
      this.series.applyOptions({ lineColor: this.colors.line, topColor: this.colors.areaTop, bottomColor: this.colors.areaBottom });
    }
  }

  private toSeriesData(candles: Candle[]): any[] {
    if (this.type === 'candles') {
      return candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
    }
    return candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }));
  }

  private toSeriesPoint(c: Candle): any {
    if (this.type === 'candles') {
      return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
    }
    return { time: c.time as UTCTimestamp, value: c.close };
  }

  private toVolumeData(candles: Candle[]): any[] {
    return candles.map((c) => ({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? this.colors.volUp : this.colors.volDown,
    }));
  }

  private toVolumePoint(c: Candle): any {
    return { time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? this.colors.volUp : this.colors.volDown };
  }

  /** Full rebuild of the visible series (after init / timeframe / type change). */
  setSeries(bars: Candle[], resetView = true): void {
    this.bars = bars;
    this.series.setData(this.toSeriesData(bars));
    if (this.volumeSeries) {
      this.volumeSeries.setData(this.toVolumeData(bars));
      this.applyVolumeStretch();
    }
    this.renderDrawings();
    this.applyMarkers();
    if (resetView) this.showRecent(bars.length);
    this.emitLatest();
    this.updateHiLo();
  }

  private showRecent(n: number): void {
    if (n <= 0) return;
    const span = Math.min(n, 150);
    this.chart.timeScale().setVisibleLogicalRange({ from: n - span, to: n + 6 });
  }

  /** Live update of the latest bar (the server-computed live bar for this TF). */
  updateLiveBar(bar: Candle | null): void {
    if (!bar) return;
    this.series.update(this.toSeriesPoint(bar));
    if (this.volumeSeries) this.volumeSeries.update(this.toVolumePoint(bar));
    // Keep the local bars tail in sync (used for visible high/low + tools).
    const n = this.bars.length;
    if (n && this.bars[n - 1].time === bar.time) this.bars[n - 1] = bar;
    else this.bars.push(bar);
    if (!this.hovering) this.cb.onBar?.(bar, true);
    for (const v of this.vlineObjs) v.updateAllViews();
    this.fib?.updateAllViews();
    this.updateHiLo();
  }

  private emitLatest(): void {
    this.cb.onBar?.(this.bars.length ? this.bars[this.bars.length - 1] : null, true);
  }

  /** Highest high / lowest low across the currently visible bars → axis labels. */
  private updateHiLo(): void {
    if (!this.hilo) return;
    const n = this.bars.length;
    if (n === 0) {
      this.hilo.set(null, null);
      return;
    }
    const range = this.chart.timeScale().getVisibleLogicalRange();
    let from = 0;
    let to = n - 1;
    if (range) {
      from = Math.max(0, Math.floor(range.from as number));
      to = Math.min(n - 1, Math.ceil(range.to as number));
    }
    if (from > to) {
      this.hilo.set(null, null);
      return;
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = from; i <= to; i++) {
      if (this.bars[i].high > hi) hi = this.bars[i].high;
      if (this.bars[i].low < lo) lo = this.bars[i].low;
    }
    this.hilo.set(hi, lo);
  }

  // ---- Theme ----

  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.colors = PALETTES[theme];
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: this.colors.bg }, textColor: this.colors.text },
      grid: { vertLines: { color: this.colors.grid }, horzLines: { color: this.colors.grid } },
      crosshair: this.crosshairOptions(),
      rightPriceScale: { borderColor: this.colors.border },
      timeScale: { borderColor: this.colors.border },
    });
    this.applySeriesColors();
    this.volumeSeries?.setData(this.toVolumeData(this.bars));
    this.renderDrawings();
    this.applyMarkers();
    this.hilo?.setColors(this.colors.hilo);
    this.updateHiLo();
  }

  getTheme(): Theme {
    return this.theme;
  }

  // ---- Timeframe / type switching ----

  /** Switch the active timeframe. The caller is responsible for fetching the
   * new series and calling setSeries() afterwards. */
  setTimeframe(tf: TfSeconds): void {
    if (tf === this.tf) return;
    this.tf = tf;
    this.chart.timeScale().applyOptions({ secondsVisible: tf < 60 });
  }

  getTimeframe(): TfSeconds {
    return this.tf;
  }

  setType(type: ChartType): void {
    if (type === this.type) return;
    this.type = type;
    // Recreate the price series; drawings re-render against the new one.
    this.priceLineObjs = [];
    this.entryLine = null;
    this.liqLine = null;
    for (const v of this.vlineObjs) this.series.detachPrimitive(v);
    this.vlineObjs = [];
    if (this.fib) {
      this.series.detachPrimitive(this.fib);
      this.fib = null;
    }
    this.chart.removeSeries(this.series);
    this.createSeries();
    this.setSeries(this.bars, false);
  }

  getType(): ChartType {
    return this.type;
  }

  // ---- Tools ----

  setTool(tool: Tool): void {
    this.tool = tool;
    this.magnet = tool === 'crosshair';
    this.chart.applyOptions({ crosshair: { mode: this.magnet ? CrosshairMode.Magnet : CrosshairMode.Normal } });
  }

  getTool(): Tool {
    return this.tool;
  }

  isMagnet(): boolean {
    return this.magnet;
  }

  private onClick(p: MouseEventParams): void {
    if (!p.point) return;
    if (this.tool === 'hline') {
      const price = this.series.coordinateToPrice(p.point.y);
      if (price === null) return;
      this.hlinePrices.push(price as number);
      this.persistAndRenderDrawings();
    } else if (this.tool === 'vline') {
      const t = this.timeAtClick(p);
      if (t === null) return;
      this.vlineTimes.push(t);
      this.persistAndRenderDrawings();
    } else if (this.tool === 'erase') {
      this.eraseNear(p);
    }
  }

  private timeAtClick(p: MouseEventParams): number | null {
    if (typeof p.time === 'number') return p.time as number;
    if (!p.point) return null;
    const t = this.chart.timeScale().coordinateToTime(p.point.x);
    if (typeof t === 'number') return t as number;
    if (p.logical !== undefined && this.bars.length) {
      const lastT = this.bars[this.bars.length - 1].time;
      const steps = Math.round((p.logical as number) - (this.bars.length - 1));
      return lastT + steps * this.tf;
    }
    return null;
  }

  private eraseNear(p: MouseEventParams): void {
    if (!p.point) return;
    const THRESH = 7;
    for (let i = 0; i < this.hlinePrices.length; i++) {
      const y = this.series.priceToCoordinate(this.hlinePrices[i]);
      if (y !== null && Math.abs((y as number) - p.point.y) <= THRESH) {
        this.hlinePrices.splice(i, 1);
        this.persistAndRenderDrawings();
        return;
      }
    }
    for (let i = 0; i < this.vlineTimes.length; i++) {
      const x = this.chart.timeScale().timeToCoordinate(this.vlineTimes[i] as UTCTimestamp);
      if (x !== null && Math.abs((x as number) - p.point.x) <= THRESH) {
        this.vlineTimes.splice(i, 1);
        this.persistAndRenderDrawings();
        return;
      }
    }
    // Fib: erase if clicking near any of its level lines.
    if (this.fib && this.hitTestFib(p.point.x, p.point.y)) {
      this.removeFib();
      this.persistAndRenderDrawings();
    }
  }

  clearDrawings(): void {
    this.hlinePrices = [];
    this.vlineTimes = [];
    this.removeFib();
    this.fibPrices = null;
    clearDrawings();
    this.renderDrawings();
    this.cb.onDrawingsChanged?.({ h: 0, v: 0, fib: 0 });
  }

  private persistAndRenderDrawings(): void {
    const d: Drawings = { hlines: this.hlinePrices, vlines: this.vlineTimes, fib: this.fibTuple() };
    saveDrawings(d);
    this.renderDrawings();
    this.emitDrawingCounts();
  }

  /** Persist only (drawings already rendered live, e.g. after a fib drag). */
  private persistDrawings(): void {
    saveDrawings({ hlines: this.hlinePrices, vlines: this.vlineTimes, fib: this.fibTuple() });
    this.emitDrawingCounts();
  }

  private emitDrawingCounts(): void {
    this.cb.onDrawingsChanged?.({ h: this.hlinePrices.length, v: this.vlineTimes.length, fib: this.fibPrices ? 1 : 0 });
  }

  private renderDrawings(): void {
    // Horizontal price lines.
    for (const pl of this.priceLineObjs) this.series.removePriceLine(pl);
    this.priceLineObjs = this.hlinePrices.map((price) =>
      this.series.createPriceLine({
        price,
        color: this.colors.hline,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      }),
    );
    // Vertical lines.
    for (const v of this.vlineObjs) this.series.detachPrimitive(v);
    this.vlineObjs = this.vlineTimes.map((t) => {
      const v = new VerticalLine(t as UTCTimestamp as Time, this.colors.vline);
      this.series.attachPrimitive(v);
      return v;
    });
    // Fibonacci.
    if (this.fib) {
      this.series.detachPrimitive(this.fib);
      this.fib = null;
    }
    if (this.fibPrices) {
      this.fib = new FibTool(this.fibPrices[0], this.fibPrices[1], this.fibAnchorTime(), this.colors.fib);
      this.series.attachPrimitive(this.fib);
    }
    this.renderPositionLines();
  }

  // ---- Trading position overlay ----

  /** Show entry + liquidation price lines for the open position (or clear). */
  setPosition(entry: number | null, liq: number | null, side: PosSide): void {
    this.posEntry = entry;
    this.posLiq = liq;
    this.posSide = side;
    this.renderPositionLines();
  }

  private renderPositionLines(): void {
    if (this.entryLine) {
      this.series.removePriceLine(this.entryLine);
      this.entryLine = null;
    }
    if (this.liqLine) {
      this.series.removePriceLine(this.liqLine);
      this.liqLine = null;
    }
    if (this.posEntry === null || this.posSide === 'flat') return;
    const col = this.posSide === 'long' ? this.colors.up : this.colors.down;
    this.entryLine = this.series.createPriceLine({
      price: this.posEntry,
      color: col,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: this.posSide === 'long' ? 'LONG' : 'SHORT',
    });
    if (this.posLiq !== null && this.posLiq > 0) {
      this.liqLine = this.series.createPriceLine({
        price: this.posLiq,
        color: this.colors.down,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'LIQ',
      });
    }
  }

  /** Add a trade marker (buy/sell arrow) at the given base time. */
  addMarker(time: number, side: 'buy' | 'sell'): void {
    this.markersData.push({ time, side });
    if (this.markersData.length > 200) this.markersData.splice(0, this.markersData.length - 200);
    this.applyMarkers();
  }

  clearMarkers(): void {
    this.markersData = [];
    this.applyMarkers();
  }

  private applyMarkers(): void {
    if (!this.markersPlugin) return;
    const markers: SeriesMarker<Time>[] = this.markersData.map((m) => {
      const t = bucketOf(m.time, this.tf) as UTCTimestamp as Time;
      return m.side === 'buy'
        ? { time: t, position: 'belowBar' as const, color: this.colors.up, shape: 'arrowUp' as const, text: 'B' }
        : { time: t, position: 'aboveBar' as const, color: this.colors.down, shape: 'arrowDown' as const, text: 'S' };
    });
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    this.markersPlugin.setMarkers(markers);
  }

  private removeFib(): void {
    if (this.fib) {
      this.series.detachPrimitive(this.fib);
      this.fib = null;
    }
    this.fibPrices = null;
    this.fibTime = null;
  }

  drawingCounts(): { h: number; v: number; fib: number } {
    return { h: this.hlinePrices.length, v: this.vlineTimes.length, fib: this.fibPrices ? 1 : 0 };
  }

  // ---- Fibonacci drag interaction ----

  private localY(clientY: number): number {
    return clientY - this.container.getBoundingClientRect().top;
  }

  /** Time (UTCTimestamp s) under a screen X — used as the fib's left anchor. */
  private timeFromX(x: number): number {
    const t = this.chart.timeScale().coordinateToTime(x as Coordinate);
    if (typeof t === 'number') return t as number;
    return this.bars.length ? this.bars[this.bars.length - 1].time : 0;
  }

  private fibAnchorTime(): number {
    if (this.fibTime !== null) return this.fibTime;
    return this.bars.length ? this.bars[this.bars.length - 1].time : 0;
  }

  private fibTuple(): [number, number, number] | null {
    return this.fibPrices ? [this.fibPrices[0], this.fibPrices[1], this.fibAnchorTime()] : null;
  }

  private hitTestFib(x: number, y: number): 'a' | 'b' | 'body' | null {
    if (!this.fib) return null;
    // Respect the fib's horizontal extent — nothing to the left of its anchor.
    let x0 = 0;
    const c = this.chart.timeScale().timeToCoordinate(this.fibAnchorTime() as UTCTimestamp as Time);
    if (c !== null) x0 = Math.max(0, c as number);
    if (x < x0 - 2) return null;
    // Grab only when the cursor is near a horizontal level line (the line ± a
    // few px) — not anywhere inside the band.
    const T = 6;
    const levels = this.fib.levelPrices();
    for (let i = 0; i < levels.length; i++) {
      const ly = this.series.priceToCoordinate(levels[i]);
      if (ly !== null && Math.abs((ly as number) - y) <= T) {
        if (i === 0) return 'a'; // 0% line → drag the low anchor
        if (i === 2) return 'b'; // 100% line → drag the high anchor
        return 'body'; // 50% / 200% lines → translate the whole fib
      }
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (this.tool !== 'fib' && this.tool !== 'cursor') return; // other tools use subscribeClick
    // Ignore the axis gutters — dragging the right price scale must scale the
    // axis, and the bottom time scale must scale time, NOT move a drawing.
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yLocal = e.clientY - rect.top;
    const priceScaleW = this.chart.priceScale('right').width();
    const timeScaleH = this.chart.timeScale().height();
    if (x > rect.width - priceScaleW || yLocal > rect.height - timeScaleH) return;
    const y = yLocal;
    const price = this.series.coordinateToPrice(y);
    if (price === null) return;
    const p = price as number;

    const hit = this.hitTestFib(x, y);
    if (hit) {
      this.drag = { kind: 'move', grab: hit, lastPrice: p };
      this.beginDrag(e);
    } else if (this.tool === 'fib' && !this.fib) {
      // The press point anchors the 100% level; the cursor drives the 0% level
      // (grab 'a'). That makes the 200% extension grow opposite to the drag:
      // dragging down extends the fib up, dragging up extends it down.
      this.fibTime = this.timeFromX(x);
      this.fibPrices = [p, p];
      this.fib = new FibTool(p, p, this.fibTime, this.colors.fib);
      this.series.attachPrimitive(this.fib);
      this.drag = { kind: 'create', grab: 'a', lastPrice: p };
      this.beginDrag(e);
    }
    // Otherwise let the chart handle the event (pan / crosshair).
  };

  private beginDrag(e: PointerEvent): void {
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    window.addEventListener('pointermove', this.onPointerMove, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    e.preventDefault();
    e.stopPropagation();
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag || !this.fib) return;
    const price = this.series.coordinateToPrice(this.localY(e.clientY));
    if (price === null) return;
    const p = price as number;
    if (this.drag.grab === 'a') this.fib.priceA = p;
    else if (this.drag.grab === 'b') this.fib.priceB = p;
    else {
      const d = p - this.drag.lastPrice;
      this.fib.priceA += d;
      this.fib.priceB += d;
    }
    this.drag.lastPrice = p;
    this.fibPrices = [this.fib.priceA, this.fib.priceB];
    this.fib.setPrices(this.fib.priceA, this.fib.priceB);
    e.preventDefault();
    e.stopPropagation();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    // A plain click while creating → give the fib a sensible default height.
    if (this.drag.kind === 'create' && this.fib && Math.abs(this.fib.priceA - this.fib.priceB) < 1e-9) {
      const a = this.fib.priceA;
      const range = Math.max(Math.abs(a) * 0.01, 1);
      this.fib.setPrices(a, a + range);
      this.fibPrices = [a, a + range];
    }
    this.drag = null;
    this.chart.applyOptions({ handleScroll: true, handleScale: true });
    window.removeEventListener('pointermove', this.onPointerMove, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    this.persistDrawings();
    e.stopPropagation();
  };

  // ---- Crosshair / legend ----

  private onCrosshair(p: MouseEventParams): void {
    if (!p.point) {
      this.hovering = false;
      this.emitLatest();
      return;
    }
    this.hovering = true;
    if (p.time === undefined) return;
    const sd = p.seriesData.get(this.series);
    if (!sd) return;
    const anySd = sd as any;
    const vd = this.volumeSeries ? (p.seriesData.get(this.volumeSeries) as any) : null;
    const vol = vd && typeof vd.value === 'number' ? vd.value : 0;
    const bar: Candle =
      'open' in anySd
        ? { time: p.time as number, open: anySd.open, high: anySd.high, low: anySd.low, close: anySd.close, volume: vol }
        : { time: p.time as number, open: anySd.value, high: anySd.value, low: anySd.value, close: anySd.value, volume: vol };
    this.cb.onBar?.(bar, false);
  }

  // ---- Zoom / navigation ----

  fit(): void {
    this.chart.timeScale().fitContent();
  }

  zoomIn(): void {
    this.barSpacing = Math.min(this.barSpacing * 1.35, 80);
    this.chart.timeScale().applyOptions({ barSpacing: this.barSpacing });
  }

  zoomOut(): void {
    this.barSpacing = Math.max(this.barSpacing / 1.35, 0.8);
    this.chart.timeScale().applyOptions({ barSpacing: this.barSpacing });
  }

  resetView(): void {
    this.barSpacing = DEFAULT_BAR_SPACING;
    this.chart.timeScale().applyOptions({ barSpacing: this.barSpacing });
    this.showRecent(this.bars.length);
  }

  scrollToRealtime(): void {
    this.chart.timeScale().scrollToRealTime();
  }
}
