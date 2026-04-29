/**
 * CRUDE INTENTIONS — OVX Live Price Proxy
 *
 * GET /api/ovx
 *
 * Server-side Yahoo Finance fetch for ^OVX (CBOE Crude Oil ETF Volatility
 * Index). Cached in KV at `ovx:latest` for 5 minutes — OVX is slow-moving
 * and there's no point hammering Yahoo from every client tab.
 *
 * Returns: { price: number, timestamp: number, currency: string } or
 *          { error: string } with non-200 status.
 */

import { NextResponse } from 'next/server';
import { kv } from '@/lib/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KV_KEY = 'ovx:latest';
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface CachedOvx { price: number; timestamp: number; currency: string; cached_at: string; }

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        regularMarketTime?: number;
        currency?: string;
      };
    }>;
  };
}

export async function GET() {
  // Cache check
  try {
    const cached = await kv.get<CachedOvx>(KV_KEY);
    if (cached?.cached_at) {
      const age = Date.now() - Date.parse(cached.cached_at);
      if (Number.isFinite(age) && age < CACHE_MAX_AGE_MS) {
        return NextResponse.json({
          price: cached.price,
          timestamp: cached.timestamp,
          currency: cached.currency,
        });
      }
    }
  } catch {
    // fall through to fresh fetch
  }

  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EOVX?interval=1m&range=1d';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.8)' },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Yahoo ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as YahooChartResponse;
    const meta = data.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      return NextResponse.json({ error: 'No price in response' }, { status: 502 });
    }
    const payload: CachedOvx = {
      price,
      timestamp: meta?.regularMarketTime ?? Math.floor(Date.now() / 1000),
      currency: meta?.currency ?? 'USD',
      cached_at: new Date().toISOString(),
    };
    try { await kv.set(KV_KEY, payload); } catch { /* swallow */ }
    return NextResponse.json({
      price: payload.price,
      timestamp: payload.timestamp,
      currency: payload.currency,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'fetch failed';
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
