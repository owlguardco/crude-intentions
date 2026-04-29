/**
 * CRUDE INTENTIONS — Live CL Price Proxy
 *
 * GET /api/cl-price
 *
 * Server-side Yahoo Finance fetch for CL=F. Yahoo blocks browser CORS, so the
 * client polls this endpoint every 10s instead of hitting Yahoo directly.
 *
 * Returns: { price, timestamp, currency, session_open } where session_open is
 *          the open of the earliest intraday candle whose NY-local date
 *          matches today, or null if no such candle exists.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        regularMarketTime?: number;
        currency?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
        }>;
      };
    }>;
  };
}

function todayInNY(): string {
  // YYYY-MM-DD in America/New_York. en-CA gives ISO-style ordering.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function dateInNY(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

function findSessionOpen(
  timestamps: number[],
  opens: Array<number | null>,
): number | null {
  const today = todayInNY();
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    if (typeof o !== 'number' || !Number.isFinite(o)) continue;
    if (dateInNY(timestamps[i]) === today) return o;
  }
  return null;
}

export async function GET() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1m&range=1d';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

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
    const r0 = data.chart?.result?.[0];
    const meta = r0?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      return NextResponse.json({ error: 'No price in response' }, { status: 502 });
    }

    const timestamps = r0?.timestamp ?? [];
    const opens = r0?.indicators?.quote?.[0]?.open ?? [];
    const session_open =
      timestamps.length === opens.length && timestamps.length > 0
        ? findSessionOpen(timestamps, opens)
        : null;

    return NextResponse.json({
      price,
      timestamp: meta?.regularMarketTime ?? Math.floor(Date.now() / 1000),
      currency: meta?.currency ?? 'USD',
      session_open,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'fetch failed';
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
