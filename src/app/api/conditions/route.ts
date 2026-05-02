/**
 * CRUDE INTENTIONS — Conditions Now
 *
 * GET /api/conditions (no auth)
 *
 * Lightweight glanceable readout for the dashboard CONDITIONS NOW tile.
 * Returns 8 booleans (or null when a data source is unreachable) so the
 * widget can render dots without each tab fanning out to the underlying
 * KV keys / Yahoo endpoints itself.
 *
 *   ema_4h           — price + EMA20/50 stack on 4H Yahoo candles
 *   ema_15m          — price + EMA20/50 stack on 15M Yahoo candles
 *   rsi_reset        — RSI(14) on 15M closes within [35, 65] reset band
 *   fvg_present      — derived from market:fvg_scan auto-detected gaps
 *   vwap             — |price - session VWAP| ≤ $0.30 on 15M anchored to 09:30 ET
 *   ovx_clean        — true when OVX in [20, 35]
 *   session_window   — true when NY-local time is 09:30..11:45
 *   eia_clear        — true when NOT inside Wed 07:30..13:30 ET window
 *
 * Yahoo fetches use the same pattern as cl-price / fvg-scan-auto / shadow-
 * resolve — direct fetch to query1.finance.yahoo.com with a 10s abort.
 * Failures leave the corresponding dot null so the widget renders dim.
 */

import { NextResponse } from 'next/server';
import { kv } from '@/lib/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FETCH_TIMEOUT_MS = 10_000;
const VWAP_PROXIMITY_USD = 0.30;
const RSI_RESET_LOW = 35;
const RSI_RESET_HIGH = 65;
const RSI_PERIOD = 14;
const EMA_FAST = 20;
const EMA_SLOW = 50;

interface OvxCached { price?: number }
interface FvgItem { type: 'BULLISH' | 'BEARISH'; midpoint?: number; top?: number; bottom?: number }
interface FvgSnapshot { bullish?: FvgItem[]; bearish?: FvgItem[] }
interface ClPriceCached { price?: number }

interface YahooQuoteArr {
  open?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  close?: Array<number | null>;
  volume?: Array<number | null>;
}
interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: YahooQuoteArr[] };
    }>;
  };
}

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ConditionsResponse {
  ema_4h: boolean | null;
  ema_15m: boolean | null;
  rsi_reset: boolean | null;
  fvg_present: boolean | null;
  vwap: boolean | null;
  ovx_clean: boolean | null;
  session_window: boolean | null;
  eia_clear: boolean | null;
  generated_at: string;
}

// ─── Time helpers ──────────────────────────────────────────────────────────

function nyLocalParts(now: Date): { hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const wkd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute, weekday: weekdayMap[wkd] ?? 1 };
}

function sessionPass(hour: number, minute: number): boolean {
  const totalMin = hour * 60 + minute;
  return totalMin >= 9 * 60 + 30 && totalMin <= 11 * 60 + 45;
}

function eiaClear(weekday: number, hour: number, minute: number): boolean {
  if (weekday !== 3) return true; // not Wed
  const totalMin = hour * 60 + minute;
  const start = 7 * 60 + 30;
  const end = 13 * 60 + 30;
  return totalMin < start || totalMin > end;
}

/** ISO YYYY-MM-DD in NY local time for a unix-seconds timestamp. */
function nyDateForTs(unixSec: number): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(unixSec * 1000));
}

/** Minute-of-day in NY local for a unix-seconds timestamp. */
function nyMinutesForTs(unixSec: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(unixSec * 1000));
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return h * 60 + m;
}

// ─── Yahoo fetch ───────────────────────────────────────────────────────────

async function fetchYahooBars(url: string): Promise<Bar[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.9)' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as YahooChartResponse;
    const r0 = data.chart?.result?.[0];
    const ts = r0?.timestamp ?? [];
    const q = r0?.indicators?.quote?.[0];
    if (!q) return null;
    const opens = q.open ?? [];
    const highs = q.high ?? [];
    const lows = q.low ?? [];
    const closes = q.close ?? [];
    const vols = q.volume ?? [];
    const out: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = opens[i], h = highs[i], l = lows[i], c = closes[i], v = vols[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.push({ ts: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Indicators ────────────────────────────────────────────────────────────

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsiWilder(closes: number[], period: number): number {
  if (closes.length <= period) return NaN;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function emaStackPass(price: number, ema20: number, ema50: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(ema20) || !Number.isFinite(ema50)) return false;
  const longStack = price > ema20 && ema20 > ema50;
  const shortStack = price < ema20 && ema20 < ema50;
  return longStack || shortStack;
}

/**
 * Session VWAP anchored to 09:30 NY local. Walks bars whose NY date matches
 * the latest bar's NY date and whose minute-of-day ≥ 09:30. Returns NaN if
 * no eligible bars (overnight session, pre-open, or weekend).
 */
function sessionVwap(bars15m: Bar[]): number {
  if (bars15m.length === 0) return NaN;
  const latest = bars15m[bars15m.length - 1];
  const sessionDate = nyDateForTs(latest.ts);
  const SESSION_OPEN_MIN = 9 * 60 + 30;
  let pvSum = 0;
  let vSum = 0;
  for (const b of bars15m) {
    if (nyDateForTs(b.ts) !== sessionDate) continue;
    if (nyMinutesForTs(b.ts) < SESSION_OPEN_MIN) continue;
    if (b.volume <= 0) continue;
    const tp = (b.high + b.low + b.close) / 3;
    pvSum += tp * b.volume;
    vSum += b.volume;
  }
  if (vSum === 0) return NaN;
  return pvSum / vSum;
}

// ─── Per-timeframe wiring ──────────────────────────────────────────────────

interface IntradayMetrics {
  ema_15m: boolean | null;
  rsi_reset: boolean | null;
  vwap: boolean | null;
  last_price: number | null;
}

async function compute15mMetrics(): Promise<IntradayMetrics> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=15m&range=2d';
  const bars = await fetchYahooBars(url);
  if (!bars || bars.length < EMA_SLOW + 1) {
    return { ema_15m: null, rsi_reset: null, vwap: null, last_price: null };
  }
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const e20 = ema(closes, EMA_FAST);
  const e50 = ema(closes, EMA_SLOW);
  const e20Last = e20[e20.length - 1];
  const e50Last = e50[e50.length - 1];

  const ema_15m = emaStackPass(last, e20Last, e50Last);
  const rsiVal = rsiWilder(closes, RSI_PERIOD);
  const rsi_reset = Number.isFinite(rsiVal) ? rsiVal >= RSI_RESET_LOW && rsiVal <= RSI_RESET_HIGH : null;

  const vwapVal = sessionVwap(bars);
  const vwap = Number.isFinite(vwapVal) ? Math.abs(last - vwapVal) <= VWAP_PROXIMITY_USD : null;

  return { ema_15m, rsi_reset, vwap, last_price: last };
}

async function compute4hEmaStack(): Promise<boolean | null> {
  // 60d at 4h ≈ 360 bars — plenty of slack for the 50-period EMA seed.
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=4h&range=60d';
  const bars = await fetchYahooBars(url);
  if (!bars || bars.length < EMA_SLOW + 1) return null;
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const e20 = ema(closes, EMA_FAST);
  const e50 = ema(closes, EMA_SLOW);
  return emaStackPass(last, e20[e20.length - 1], e50[e50.length - 1]);
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function GET() {
  const now = new Date();
  const { hour, minute, weekday } = nyLocalParts(now);

  // OVX from KV (the price strip already polls /api/ovx, no need to refetch).
  let ovxClean: boolean | null = null;
  try {
    const ovx = await kv.get<OvxCached>('ovx:latest');
    if (ovx && typeof ovx.price === 'number' && Number.isFinite(ovx.price)) {
      ovxClean = ovx.price >= 20 && ovx.price <= 35;
    }
  } catch { /* leave null */ }

  // Run the three Yahoo fetches in parallel — 4H stack, 15M metrics, plus
  // KV reads for FVG presence. Any failure leaves its dot null.
  const [emaH4, intraday, fvgPresent] = await Promise.all([
    compute4hEmaStack(),
    compute15mMetrics(),
    (async (): Promise<boolean | null> => {
      try {
        const [snap, cl] = await Promise.all([
          kv.get<FvgSnapshot>('market:fvg_scan'),
          kv.get<ClPriceCached>('cl-price:latest'),
        ]);
        if (!snap) return null;
        const all: FvgItem[] = [...(snap.bullish ?? []), ...(snap.bearish ?? [])];
        const price = typeof cl?.price === 'number' ? cl.price : null;
        if (price === null) return all.length > 0;
        const PROX = 1.5;
        return all.some((f) => {
          const mid = typeof f.midpoint === 'number'
            ? f.midpoint
            : (typeof f.top === 'number' && typeof f.bottom === 'number' ? (f.top + f.bottom) / 2 : null);
          return mid !== null && Math.abs(price - mid) <= PROX;
        });
      } catch {
        return null;
      }
    })(),
  ]);

  const result: ConditionsResponse = {
    ema_4h: emaH4,
    ema_15m: intraday.ema_15m,
    rsi_reset: intraday.rsi_reset,
    fvg_present: fvgPresent,
    vwap: intraday.vwap,
    ovx_clean: ovxClean,
    session_window: sessionPass(hour, minute),
    eia_clear: eiaClear(weekday, hour, minute),
    generated_at: now.toISOString(),
  };

  return NextResponse.json(result);
}
