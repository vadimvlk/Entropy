// A custom series primitive that draws a full-height vertical line at a given
// time. Lightweight Charts has no built-in vertical drawing tool, so we render
// one ourselves on the chart canvas and re-project it on every pan/zoom.

import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitivePaneViewZOrder,
  Coordinate,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

class VerticalLineRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly x: Coordinate | null,
    private readonly color: string,
    private readonly hovered: boolean,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    if (this.x === null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const px = Math.round(this.x! * scope.horizontalPixelRatio);
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = (this.hovered ? 2 : 1.4) * scope.horizontalPixelRatio;
      ctx.setLineDash([6 * scope.horizontalPixelRatio, 6 * scope.horizontalPixelRatio]);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, scope.bitmapSize.height);
      ctx.stroke();
      ctx.restore();
    });
  }
}

class VerticalLinePaneView implements IPrimitivePaneView {
  private x: Coordinate | null = null;
  constructor(private readonly source: VerticalLine) {}

  update(): void {
    const chart = this.source.chart;
    if (!chart) {
      this.x = null;
      return;
    }
    this.x = chart.timeScale().timeToCoordinate(this.source.time);
  }

  renderer(): IPrimitivePaneRenderer {
    return new VerticalLineRenderer(this.x, this.source.color, this.source.hovered);
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }
}

export class VerticalLine implements ISeriesPrimitive<Time> {
  chart: SeriesAttachedParameter<Time>['chart'] | null = null;
  hovered = false;
  private readonly views: VerticalLinePaneView[];
  private requestUpdate?: () => void;

  constructor(
    public readonly time: Time,
    public color = 'rgba(120, 162, 255, 0.9)',
  ) {
    this.views = [new VerticalLinePaneView(this)];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = undefined;
  }

  updateAllViews(): void {
    for (const v of this.views) v.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Screen x for this line right now, or null if off-screen. */
  currentX(): number | null {
    if (!this.chart) return null;
    return this.chart.timeScale().timeToCoordinate(this.time);
  }

  requestRedraw(): void {
    this.requestUpdate?.();
  }
}
