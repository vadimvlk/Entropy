// Thin client for the always-on market server. Pulls a timeframe's history over
// HTTP, streams the live bar + header status over SSE, and issues token-gated
// control commands (reset / nudge / mode / …). All paths are same-origin: the
// Vite dev server proxies /api and /stream to the backend, and in production
// the backend serves the built client itself.

import { expand, type Candle, type TfSeconds } from '../shared/candles';

const TOKEN_KEY = 'random-walk-terminal:token:v1';

export interface StreamStatus {
  price: number;
  startPrice: number;
  t: number; // simulated clock, ms
  tps: number;
  tickCount: number;
  regime: string;
  vol: string;
  mode: string;
  multiplier: number;
  baseCount: number;
  running: boolean;
}

export interface TickPayload extends StreamStatus {
  bar: Candle | null;
}

export interface SeriesSnapshot extends StreamStatus {
  tf: TfSeconds;
  bars: Candle[];
}

export interface StreamHandlers {
  onTick: (p: TickPayload) => void;
  onReset: () => void;
  onRunning: (running: boolean) => void;
  /** Fired when SSE reconnects after a drop — caller should re-fetch the series. */
  onReconnect: () => void;
}

export interface ControlResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

export class MarketClient {
  private token: string | null;
  private es: EventSource | null = null;
  private tf: TfSeconds = 1;
  private handlers: StreamHandlers | null = null;
  private everOpened = false;

  constructor() {
    this.token = this.readToken();
  }

  // ---- Token ----
  private readToken(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }
  hasToken(): boolean {
    return !!this.token;
  }
  setToken(t: string): void {
    this.token = t.trim() || null;
    try {
      if (this.token) localStorage.setItem(TOKEN_KEY, this.token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
  clearToken(): void {
    this.setToken('');
  }

  // ---- History ----
  async fetchSeries(tf: TfSeconds, limit?: number): Promise<SeriesSnapshot> {
    const q = `tf=${tf}` + (limit ? `&limit=${limit}` : '');
    const res = await fetch(`/api/series?${q}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`series ${res.status}`);
    const j = (await res.json()) as { tf: TfSeconds; bars: number[][] } & StreamStatus;
    return { ...j, bars: j.bars.map(expand) };
  }

  // ---- Live stream ----
  connect(tf: TfSeconds, handlers: StreamHandlers): void {
    this.handlers = handlers;
    this.tf = tf;
    this.open();
  }

  switchTimeframe(tf: TfSeconds): void {
    if (tf === this.tf && this.es) return;
    this.tf = tf;
    this.open();
  }

  private open(): void {
    if (this.es) this.es.close();
    const es = new EventSource(`/api/stream?tf=${this.tf}`);
    this.es = es;

    es.addEventListener('tick', (ev) => {
      const p = JSON.parse((ev as MessageEvent).data) as StreamStatus & { bar: number[] | null };
      this.handlers?.onTick({ ...p, bar: p.bar ? expand(p.bar) : null });
    });
    es.addEventListener('reset', () => this.handlers?.onReset());
    es.addEventListener('running', (ev) => {
      const p = JSON.parse((ev as MessageEvent).data) as { running: boolean };
      this.handlers?.onRunning(p.running);
    });
    es.addEventListener('open', () => {
      if (this.everOpened) this.handlers?.onReconnect();
      this.everOpened = true;
    });
    // EventSource reconnects on error automatically; nothing to do here.
  }

  close(): void {
    this.es?.close();
    this.es = null;
  }

  // ---- Control (token-gated) ----
  private async control(action: string, body?: Record<string, unknown>): Promise<ControlResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(`/api/control/${action}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    } catch {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  }

  verify(token: string): Promise<ControlResult> {
    const prev = this.token;
    this.token = token.trim() || null;
    return this.control('verify').then((r) => {
      if (!r.ok) this.token = prev; // don't keep a bad token
      return r;
    });
  }

  reset(): Promise<ControlResult> {
    return this.control('reset');
  }
  nudge(delta: number): Promise<ControlResult> {
    return this.control('nudge', { delta });
  }
  pause(): Promise<ControlResult> {
    return this.control('pause');
  }
  resume(): Promise<ControlResult> {
    return this.control('resume');
  }
  setMode(mode: 'auto' | 'manual', speed?: string, vol?: string): Promise<ControlResult> {
    return this.control('mode', { mode, speed, vol });
  }
  setRegime(speed?: string, vol?: string): Promise<ControlResult> {
    return this.control('regime', { speed, vol });
  }
}
