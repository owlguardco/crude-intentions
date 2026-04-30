/**
 * CRUDE INTENTIONS — OVX Live Price Proxy
 *
 * GET /api/ovx
 *
 * Server-side fetch for ^OVX (CBOE Crude Oil ETF Volatility Index).
 *
 * Primary source: FRED series OVXCLS (api.stlouisfed.org), keyed by
 * EIA_API_KEY env var. Cached in KV at `ovx:latest` for 5 minutes —
 * OVX is slow-moving and there is no point hammering the upstream
 * from every client tab.
 *
 * Fallback: Yahoo Finance ^OVX chart endpoint, used when EIA_API_KEY
 * is not set or the FRED call fails. Keeps the dashboard alive even
 * when the primary feed is down.
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

interface FredObservationsResponse {
  observations?: Array<{
    date?: string;
    value?: string;
  }>;
}

async function fetchFromFred(apiKey: string): Promise<CachedOvx | null> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=OVXCLS&api_key=${encodeURIComponent(apiKey)}` +
    `&sort_order=desc&limit=1&file_type=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as FredObservationsResponse;
    const obs = data.observations?.[0];
    if (!obs) return null;
    const value = obs.value ? parseFloat(obs.value) : NaN;
    if (!Number.isFinite(value)) return null;
    const ts = obs.date ? Math.floor(Date.parse(obs.date) / 1000) : Math.floor(Date.now() / 1000);
    return {
      price: value,
      timestamp: Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000),
      currency: 'USD',
      cached_at: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromYahoo(): Promise<CachedOvx | null> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EOVX?interval=1m&range=1d';
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
    const meta = data.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number' || !Number.isFinite(price)) return null;
    return {
      price,
      timestamp: meta?.regularMarketTime ?? Math.floor(Date.now() / 1000),
      currency: meta?.currency ?? 'USD',
      cached_at: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

  const fredKey = process.env.EIA_API_KEY;
  const payload: CachedOvx | null =
    (fredKey ? await fetchFromFred(fredKey) : null) ?? (await fetchFromYahoo());

  if (!payload) {
    return NextResponse.json({ error: 'OVX feed unavailable' }, { status: 502 });
  }

  try { await kv.set(KV_KEY, payload); } catch { /* swallow */ }
  return NextResponse.json({
    price: payload.price,
    timestamp: payload.timestamp,
    currency: payload.currency,
  });
}
