// Trading account: market orders only, net (one-way) position with reversal,
// isolated-style margin at fixed 1:10 leverage, mark-to-market P&L and a
// liquidation safeguard so the balance can never go negative.
//
// Contract math (multiplier = 1): notional = qty * price, margin = notional / leverage.
// At the start price 1000 the 1000$ deposit equals exactly one full contract of
// notional (10 contracts with leverage).

import { loadAccount, saveAccount, clearAccount } from './storage';

export type Side = 'buy' | 'sell';
export type PosSide = 'long' | 'short' | 'flat';

export const LEVERAGE = 10;
export const QTY_STEP = 0.1;
export const MIN_QTY = 0.1;
export const START_DEPOSIT = 1000;
const MAINTENANCE = 0.5; // liquidate when equity ≤ 50% of used margin

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export interface OrderResult {
  ok: boolean;
  reason?: string;
  realized?: number;
}

export interface AccountView {
  balance: number;
  equity: number;
  position: number; // signed contracts
  side: PosSide;
  avgEntry: number;
  unrealized: number;
  unrealizedPct: number; // relative to position margin
  realized: number;
  marginUsed: number;
  freeMargin: number;
  liqPrice: number | null;
  startDeposit: number;
  maxQty: number; // additional contracts openable now
}

export class Account {
  balance = START_DEPOSIT;
  position = 0;
  avgEntry = 0;
  realized = 0;
  startDeposit = START_DEPOSIT;

  readonly leverage = LEVERAGE;
  readonly step = QTY_STEP;
  readonly minQty = MIN_QTY;

  init(): void {
    const a = loadAccount();
    if (a) {
      this.balance = a.balance;
      this.position = a.position;
      this.avgEntry = a.avgEntry;
      this.realized = a.realized;
      this.startDeposit = a.startDeposit;
    } else {
      this.reset(false);
    }
  }

  reset(persist = true): void {
    this.balance = START_DEPOSIT;
    this.position = 0;
    this.avgEntry = 0;
    this.realized = 0;
    this.startDeposit = START_DEPOSIT;
    if (persist) this.save();
  }

  side(): PosSide {
    if (this.position > 1e-9) return 'long';
    if (this.position < -1e-9) return 'short';
    return 'flat';
  }

  unrealized(price: number): number {
    return this.position === 0 ? 0 : this.position * (price - this.avgEntry);
  }
  equity(price: number): number {
    return this.balance + this.unrealized(price);
  }
  marginUsed(price: number): number {
    return (Math.abs(this.position) * price) / LEVERAGE;
  }
  freeMargin(price: number): number {
    return this.equity(price) - this.marginUsed(price);
  }

  /** Additional contracts that can be opened given current free equity. */
  maxQty(price: number): number {
    if (price <= 0) return 0;
    const avail = Math.max(0, this.equity(price));
    const raw = (avail * LEVERAGE) / price;
    return Math.max(0, Math.floor(raw / QTY_STEP + 1e-9) * QTY_STEP);
  }

  /** Price at which the position would be liquidated, or null if flat. */
  liqPrice(): number | null {
    if (this.position === 0) return null;
    const k = (MAINTENANCE * Math.abs(this.position)) / LEVERAGE;
    const denom = this.position - k;
    if (Math.abs(denom) < 1e-12) return null;
    const liq = (this.position * this.avgEntry - this.balance) / denom;
    return liq > 0 ? liq : null;
  }

  private requiredMarginFor(newPos: number, price: number): number {
    return (Math.abs(newPos) * price) / LEVERAGE;
  }

  /** Place a market order. Returns ok=false (with a reason) if margin is insufficient. */
  market(side: Side, qty: number, price: number): OrderResult {
    const q = r6(qty);
    if (q < MIN_QTY - 1e-9) return { ok: false, reason: 'мин. 0.1' };
    const delta = side === 'buy' ? q : -q;
    const newPos = r6(this.position + delta);
    // Opening / increasing exposure must fit in equity; reducing always allowed.
    if (Math.abs(newPos) > Math.abs(this.position) + 1e-9) {
      if (this.requiredMarginFor(newPos, price) > this.equity(price) + 1e-6) {
        return { ok: false, reason: 'недостаточно маржи' };
      }
    }
    const realized = this.apply(delta, price);
    this.save();
    return { ok: true, realized };
  }

  /** Flatten the whole position at market. */
  close(price: number): OrderResult {
    if (this.position === 0) return { ok: false, reason: 'нет позиции' };
    const realized = this.apply(-this.position, price);
    this.save();
    return { ok: true, realized };
  }

  /** Force-close if equity has fallen to the maintenance threshold. */
  liquidateIfNeeded(price: number): boolean {
    if (this.position === 0) return false;
    if (this.equity(price) <= MAINTENANCE * this.marginUsed(price)) {
      this.apply(-this.position, price);
      this.save();
      return true;
    }
    return false;
  }

  /** Apply a signed delta at execution price; returns realized P&L of this fill. */
  private apply(delta: number, price: number): number {
    const oldPos = this.position;
    let realized = 0;
    if (oldPos === 0 || Math.sign(oldPos) === Math.sign(delta)) {
      // Opening or adding to the same side → weighted-average entry.
      const newAbs = Math.abs(oldPos) + Math.abs(delta);
      this.avgEntry = (Math.abs(oldPos) * this.avgEntry + Math.abs(delta) * price) / newAbs;
      this.position = r6(oldPos + delta);
    } else {
      // Opposite side → close (and possibly flip).
      const closeQty = Math.min(Math.abs(delta), Math.abs(oldPos));
      realized = closeQty * (price - this.avgEntry) * Math.sign(oldPos);
      this.realized += realized;
      this.balance += realized;
      const remaining = Math.abs(delta) - Math.abs(oldPos);
      if (remaining > 1e-9) {
        this.position = r6(Math.sign(delta) * remaining);
        this.avgEntry = price; // flipped: new entry
      } else {
        this.position = r6(oldPos + delta);
        if (Math.abs(this.position) < 1e-9) {
          this.position = 0;
          this.avgEntry = 0;
        }
      }
    }
    return realized;
  }

  view(price: number): AccountView {
    const margin = this.marginUsed(price);
    const uPnl = this.unrealized(price);
    return {
      balance: this.balance,
      equity: this.equity(price),
      position: this.position,
      side: this.side(),
      avgEntry: this.avgEntry,
      unrealized: uPnl,
      unrealizedPct: margin > 0 ? (uPnl / margin) * 100 : 0,
      realized: this.realized,
      marginUsed: margin,
      freeMargin: this.freeMargin(price),
      liqPrice: this.liqPrice(),
      startDeposit: this.startDeposit,
      maxQty: this.maxQty(price),
    };
  }

  save(): void {
    saveAccount({
      balance: this.balance,
      position: this.position,
      avgEntry: this.avgEntry,
      realized: this.realized,
      startDeposit: this.startDeposit,
    });
  }

  clear(): void {
    clearAccount();
  }
}
