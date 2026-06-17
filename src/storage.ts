// Client-side persistence for per-browser state only. The market stream itself
// now lives on the server (SQLite); the browser keeps just the things that are
// local to this viewer: drawings, view preferences and the paper trading
// account.

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

// ---- Drawings (horizontal price lines + vertical time lines) ----

const DKEY = 'random-walk-terminal:drawings:v1';

export interface Drawings {
  hlines: number[]; // prices
  vlines: number[]; // UTCTimestamp seconds
  fib: [number, number, number] | null; // [price0, price100, anchorTime]
}

export function loadDrawings(): Drawings {
  const empty: Drawings = { hlines: [], vlines: [], fib: null };
  try {
    const raw = localStorage.getItem(DKEY);
    if (!raw) return empty;
    const d = JSON.parse(raw) as Drawings;
    const fib =
      Array.isArray(d.fib) && d.fib.length === 3 && d.fib.every((n) => isNum(n))
        ? ([d.fib[0], d.fib[1], d.fib[2]] as [number, number, number])
        : null;
    return {
      hlines: Array.isArray(d.hlines) ? d.hlines.filter(isNum) : [],
      vlines: Array.isArray(d.vlines) ? d.vlines.filter(isNum) : [],
      fib,
    };
  } catch {
    return empty;
  }
}

export function saveDrawings(d: Drawings): void {
  try {
    localStorage.setItem(DKEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

export function clearDrawings(): void {
  try {
    localStorage.removeItem(DKEY);
  } catch {
    /* ignore */
  }
}

// ---- View preferences (timeframe + chart type + theme + …) ----

const PKEY = 'random-walk-terminal:prefs:v1';

export interface Prefs {
  tf: number;
  type: string;
  theme?: string;
  showVolume?: boolean;
  mm?: boolean;
}

const ALLOWED_TF = [1, 5, 15, 60, 300, 900, 1800, 3600, 14400, 43200, 86400];
const ALLOWED_TYPE = ['candles', 'line', 'area'];
const ALLOWED_THEME = ['dark', 'light'];

export function loadPrefs(): Prefs | null {
  try {
    const raw = localStorage.getItem(PKEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Prefs;
    if (!p || !ALLOWED_TF.includes(p.tf) || !ALLOWED_TYPE.includes(p.type)) return null;
    // Optional fields are sanitized but never invalidate the whole record.
    if (p.theme !== undefined && !ALLOWED_THEME.includes(p.theme)) delete p.theme;
    if (typeof p.showVolume !== 'boolean') delete p.showVolume;
    if (typeof p.mm !== 'boolean') delete p.mm;
    return p;
  } catch {
    return null;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PKEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

// ---- Trading account ----

const AKEY = 'random-walk-terminal:account:v1';

export interface PersistedAccount {
  balance: number;
  position: number;
  avgEntry: number;
  realized: number;
  startDeposit: number;
}

export function loadAccount(): PersistedAccount | null {
  try {
    const raw = localStorage.getItem(AKEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as PersistedAccount;
    if (!a || !isNum(a.balance) || !isNum(a.position) || !isNum(a.avgEntry) || !isNum(a.realized)) return null;
    if (!isNum(a.startDeposit)) a.startDeposit = a.balance;
    return a;
  } catch {
    return null;
  }
}

export function saveAccount(a: PersistedAccount): void {
  try {
    localStorage.setItem(AKEY, JSON.stringify(a));
  } catch {
    /* ignore */
  }
}

export function clearAccount(): void {
  try {
    localStorage.removeItem(AKEY);
  } catch {
    /* ignore */
  }
}
