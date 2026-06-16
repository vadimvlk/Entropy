// Fibonacci tool primitive with fixed levels 0 / 50 / 100 / 200%.
// Two price anchors (priceA = 0%, priceB = 100%); the levels are drawn as
// horizontal lines spanning the full pane width with translucent bands and
// labels. Dragging (place / move / adjust anchors) is handled in chart.ts.

import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitivePaneViewZOrder,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export const FIB_LEVELS = [0, 50, 100, 200];

export interface FibColors {
  lines: string[]; // per level
  fills: string[]; // per gap (len = levels - 1)
  text: string;
}

class FibRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly ys: (number | null)[],
    private readonly prices: number[],
    private readonly colors: FibColors,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const w = scope.bitmapSize.width;

      // Band fills between consecutive levels.
      for (let i = 0; i < this.ys.length - 1; i++) {
        const y0 = this.ys[i];
        const y1 = this.ys[i + 1];
        if (y0 == null || y1 == null) continue;
        ctx.fillStyle = this.colors.fills[i] ?? 'rgba(120,162,255,0.06)';
        const top = Math.min(y0, y1) * vr;
        const h = Math.abs(y1 - y0) * vr;
        ctx.fillRect(0, top, w, h);
      }

      ctx.font = `${Math.round(11 * vr)}px 'JetBrains Mono', monospace`;
      ctx.textBaseline = 'middle';
      ctx.setLineDash([]);

      for (let i = 0; i < this.ys.length; i++) {
        const y = this.ys[i];
        if (y == null) continue;
        const py = Math.round(y * vr) + 0.5;
        const col = this.colors.lines[i] ?? this.colors.text;
        ctx.beginPath();
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, Math.round(hr));
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
        ctx.stroke();

        const label = `${FIB_LEVELS[i]}%  ${this.prices[i].toFixed(2)}`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(6 * hr, py - 9 * vr, tw + 10 * hr, 18 * vr);
        ctx.fillStyle = col;
        ctx.fillText(label, 11 * hr, py);
      }
    });
  }
}

class FibPaneView implements IPrimitivePaneView {
  private ys: (number | null)[] = [];
  private prices: number[] = [];
  constructor(private readonly source: FibTool) {}

  update(): void {
    const s = this.source.series;
    this.prices = this.source.levelPrices();
    this.ys = this.prices.map((p) => {
      if (!s) return null;
      const c = s.priceToCoordinate(p);
      return c === null ? null : (c as number);
    });
  }

  renderer(): IPrimitivePaneRenderer {
    return new FibRenderer(this.ys, this.prices, this.source.colors);
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }
}

export class FibTool implements ISeriesPrimitive<Time> {
  series: SeriesAttachedParameter<Time>['series'] | null = null;
  private requestUpdate?: () => void;
  private readonly views: FibPaneView[];

  constructor(
    public priceA: number,
    public priceB: number,
    public colors: FibColors,
  ) {
    this.views = [new FibPaneView(this)];
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
    for (const v of this.views) v.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  levelPrices(): number[] {
    const d = this.priceB - this.priceA;
    return FIB_LEVELS.map((p) => this.priceA + d * (p / 100));
  }

  setPrices(a: number, b: number): void {
    this.priceA = a;
    this.priceB = b;
    this.requestUpdate?.();
  }

  setColors(c: FibColors): void {
    this.colors = c;
    this.requestUpdate?.();
  }
}
