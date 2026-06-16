// Price-axis labels for the highest high and lowest low of the VISIBLE range.
// Rendered as neutral badges on the right price scale (no line across the
// chart), like the auto price label. They recompute on pan / zoom / new ticks.

import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  ISeriesPrimitiveAxisView,
} from 'lightweight-charts';
import { formatPrice } from './format';

export interface HiLoColors {
  bg: string;
  text: string;
}

class HiLoAxisView implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly src: HiLoLabels,
    private readonly which: 'high' | 'low',
  ) {}

  private price(): number | null {
    return this.which === 'high' ? this.src.high : this.src.low;
  }

  coordinate(): number {
    const s = this.src.series;
    const p = this.price();
    if (!s || p === null) return -100;
    const c = s.priceToCoordinate(p);
    return c === null ? -100 : (c as number);
  }

  visible(): boolean {
    return this.src.series !== null && this.price() !== null;
  }

  tickVisible(): boolean {
    return true;
  }

  text(): string {
    const p = this.price();
    return p === null ? '' : formatPrice(p);
  }

  textColor(): string {
    return this.src.colors.text;
  }

  backColor(): string {
    return this.src.colors.bg;
  }
}

export class HiLoLabels implements ISeriesPrimitive<Time> {
  series: SeriesAttachedParameter<Time>['series'] | null = null;
  high: number | null = null;
  low: number | null = null;
  private requestUpdate?: () => void;
  private readonly views: HiLoAxisView[];

  constructor(public colors: HiLoColors) {
    this.views = [new HiLoAxisView(this, 'high'), new HiLoAxisView(this, 'low')];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = undefined;
  }

  updateAllViews(): void {
    /* axis views read live values on demand */
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.views;
  }

  set(high: number | null, low: number | null): void {
    if (high === this.high && low === this.low) return;
    this.high = high;
    this.low = low;
    this.requestUpdate?.();
  }

  setColors(c: HiLoColors): void {
    this.colors = c;
    this.requestUpdate?.();
  }
}
