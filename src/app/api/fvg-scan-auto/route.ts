/**
 * CRUDE INTENTIONS — FVG Auto-Scan (Phase 2F, server-driven)
 *
 * POST /api/fvg-scan-auto
 *   Auth: x-api-key header (INTERNAL_API_KEY)
 *   Server-fetches CL=F 4H candles from Yahoo Finance, detects unfilled FVGs,
 *   scores them, persists top-2-bullish + top-2-bearish snapshot to KV key
 *   `market:fvg_scan`, and returns the snapshot.
 *
 * GET  /api/fvg-scan-auto
 *   Returns the persisted snapshot from `market:fvg_scan` (or empty defaults).
 *
 * Persistence is intentionally in a separate key from `market:context` so
 * the existing manual FVG flow (`/api/fvg-scan`, `MarketContext.active_fvgs`)
 * is not affected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const KV_KEY = 'market:fvg_scan';

const YAHOO_URL =
  'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=4h&range=60d';

export interface ScannedFVG {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  midpoint: number;
  score: number;
  age_bars: number;
  formed_at: string;
}

export interface FvgScanSnapshot {
  bullish: ScannedFVG[];
  bearish: ScannedFVG[];
  scanned_at: string;
}

interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface YahooResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
        }>;
      };
    }>;
  };
}

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get('x-api-key') ?? req.headers.get('authorization');
  if (!header) return false;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return safeEq(token, INTERNAL_API_KEY);
}

async function fetchCandles(): Promise<Candle[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(YAHOO_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.8)' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as YahooResponse;
    const r0 = data.chart?.result?.[0];
    const ts = r0?.timestamp ?? [];
    const q = r0?.indicators?.quote?.[0];
    const opens = q?.open ?? [];
    const highs = q?.high ?? [];
    const lows = q?.low ?? [];
    const closes = q?.close ?? [];
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.push({ ts: ts[i], open: o, high: h, low: l, close: c });
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function computeEMA20(closes: number[]): number[] {
  const period = 20;
  const k = 2 / (period + 1);
  const out: number[] = [];
  if (closes.length === 0) return out;
  out.push(closes[0]);
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function gapContainsRoundDollar(top: number, bottom: number): boolean {
  return Math.floor(top) >= Math.ceil(bottom);
}

function scoreFVG(
  type: 'BULLISH' | 'BEARISH',
  top: number,
  bottom: number,
  ageBars: number,
  ema20AtFormation: number,
): number {
  const gapDollars = top - bottom;
  const gapSizeScore = Math.min(40, (gapDollars / 0.25) * 40);
  const ageScore = Math.max(0, 30 - (ageBars / 50) * 30);
  const midpoint = (top + bottom) / 2;
  const emaProximityScore = Math.abs(midpoint - ema20AtFormation) <= 0.5 ? 20 : 0;
  const roundLevelScore = gapContainsRoundDollar(top, bottom) ? 10 : 0;
  const total = gapSizeScore + ageScore + emaProximityScore + roundLevelScore;
  return Math.round(Math.max(0, Math.min(100, total)) * 10) / 10;
}

function detectUnfilledFVGs(candles: Candle[], ema20: number[]): ScannedFVG[] {
  const out: ScannedFVG[] = [];
  const lastIdx = candles.length - 1;

  for (let i = 0; i + 2 <= lastIdx; i++) {
    const a = candles[i];
    const c = candles[i + 2];

    let type: 'BULLISH' | 'BEARISH' | null = null;
    let top = 0;
    let bottom = 0;

    if (c.low > a.high) {
      type = 'BULLISH';
      top = c.low;
      bottom = a.high;
    } else if (c.high < a.low) {
      type = 'BEARISH';
      top = a.low;
      bottom = c.high;
    } else {
      continue;
    }

    // Unfilled test: scan all candles after formation (i+2)
    let filled = false;
    for (let j = i + 3; j <= lastIdx; j++) {
      if (type === 'BULLISH' && candles[j].close < bottom) { filled = true; break; }
      if (type === 'BEARISH' && candles[j].close > top)    { filled = true; break; }
    }
    if (filled) continue;

    const ageBars = lastIdx - (i + 2);
    const ema20Formation = ema20[i + 2] ?? candles[i + 2].close;
    const score = scoreFVG(type, top, bottom, ageBars, ema20Formation);
    const midpoint = Math.round(((top + bottom) / 2) * 100) / 100;
    const formed_at = new Date(candles[i + 2].ts * 1000).toISOString();

    out.push({
      type,
      top: Math.round(top * 100) / 100,
      bottom: Math.round(bottom * 100) / 100,
      midpoint,
      score,
      age_bars: ageBars,
      formed_at,
    });
  }

  return out;
}

function emptySnapshot(): FvgScanSnapshot {
  return { bullish: [], bearish: [], scanned_at: '' };
}

export async function GET() {
  const snap = (await kv.get<FvgScanSnapshot>(KV_KEY)) ?? emptySnapshot();
  return NextResponse.json(snap);
}

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const candles = await fetchCandles();
  if (!candles || candles.length < 3) {
    return NextResponse.json({ error: 'feed_unavailable' }, { status: 500 });
  }

  const closes = candles.map((c) => c.close);
  const ema20 = computeEMA20(closes);
  const detected = detectUnfilledFVGs(candles, ema20);

  const bullish = detected
    .filter((f) => f.type === 'BULLISH')
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const bearish = detected
    .filter((f) => f.type === 'BEARISH')
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  const snapshot: FvgScanSnapshot = {
    bullish,
    bearish,
    scanned_at: new Date().toISOString(),
  };

  await kv.set(KV_KEY, snapshot);

  return NextResponse.json({ ok: true, ...snapshot });
}
