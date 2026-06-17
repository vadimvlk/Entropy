// Shared number formatting. Prices span a wide dynamic range (≈1000 down to
// 1e-7, crypto-style), so precision adapts to magnitude.

export function priceDecimals(p: number): number {
  const ap = Math.abs(p);
  if (!Number.isFinite(ap) || ap === 0) return 2;
  if (ap >= 100) return 2;
  if (ap >= 1) return 3;
  if (ap >= 0.1) return 4;
  if (ap >= 0.01) return 5;
  if (ap >= 0.001) return 6;
  if (ap >= 0.0001) return 7;
  return 8;
}

export function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return '0';
  const d = priceDecimals(p);
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

const money2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(v: number): string {
  return money2.format(v);
}

export function formatSignedMoney(v: number): string {
  const r = Math.abs(v) < 0.005 ? 0 : v;
  return (r >= 0 ? '+' : '-') + money2.format(Math.abs(r));
}

export function formatPct(v: number): string {
  const r = Math.abs(v) < 0.005 ? 0 : v;
  return (r >= 0 ? '+' : '-') + Math.abs(r).toFixed(2) + '%';
}

/** Trim a quantity to a 0.1 step and avoid binary float dust. */
export function roundStep(qty: number, step = 0.1): number {
  return Math.round(qty / step) * step;
}

export function formatQty(qty: number): string {
  return (Math.round(qty * 100) / 100).toFixed(1);
}

/** Wall-clock HH:MM:SS in UTC. The chart's time axis (lightweight-charts)
 * renders in UTC, so the status clock and OHLC legend must match — local
 * getters here would offset them by the viewer's timezone. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
