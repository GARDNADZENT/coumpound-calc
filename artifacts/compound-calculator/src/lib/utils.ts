import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatPercentage(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

export function formatCompactCurrency(value: number): string {
  if (value >= 1_000_000) {
    return '$' + (value / 1_000_000).toFixed(2) + 'M';
  }
  if (value >= 1_000) {
    return '$' + (value / 1_000).toFixed(2) + 'k';
  }
  return formatCurrency(value);
}

// ─── Daily target-hit persistence ──────────────────────────────────────────────
// Records which cycle days have had their profit target met — keyed by the
// calendar date of that day so it survives logout/login and applies across
// account reconnections.

const TARGET_HIT_KEY = 'compoundPro.targetHits.v1';
const TARGET_HIT_ACCOUNT_KEY = 'compoundPro.targetHitsAccount.v1';

export interface DayTargetHit {
  /** Achieved profit at the time the target was met (in account currency). */
  achievedProfit: number;
  /** Day number in the cycle (1-indexed). */
  day: number;
  /** Epoch ms when the target was first hit. */
  hitAt: number;
}

export type TargetHitMap = Record<string, DayTargetHit>;

function dateKey(d: Date): string {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${day}`;
}

function accountScopedKey(loginid?: string | null): string {
  const acc = loginid && loginid.trim().length > 0 ? loginid.trim() : '__none__';
  return `${TARGET_HIT_KEY}:${acc}`;
}

export function loadTargetHits(loginid?: string | null): TargetHitMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(accountScopedKey(loginid));
    return raw ? (JSON.parse(raw) as TargetHitMap) : {};
  } catch {
    return {};
  }
}

export function markTargetHit(date: Date, day: number, achievedProfit: number, loginid?: string | null): TargetHitMap {
  const map = loadTargetHits(loginid);
  const key = dateKey(date);
  if (!map[key]) {
    map[key] = { achievedProfit, day, hitAt: Date.now() };
    persistTargetHits(map, loginid);
  }
  return map;
}

export function getTargetHit(date: Date, loginid?: string | null): DayTargetHit | undefined {
  return loadTargetHits(loginid)[dateKey(date)];
}

export function clearTargetHits(loginid?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(accountScopedKey(loginid));
  } catch {
    // ignore
  }
}

export function getTargetHitAccountId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TARGET_HIT_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

export function setTargetHitAccountId(loginid: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (loginid) {
      window.localStorage.setItem(TARGET_HIT_ACCOUNT_KEY, loginid);
    } else {
      window.localStorage.removeItem(TARGET_HIT_ACCOUNT_KEY);
    }
  } catch {
    // ignore
  }
}

function persistTargetHits(map: TargetHitMap, loginid?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(accountScopedKey(loginid), JSON.stringify(map));
  } catch {
    // ignore storage errors (quota, private mode)
  }
}
