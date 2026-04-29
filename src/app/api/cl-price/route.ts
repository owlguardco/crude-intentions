/**
 * CRUDE INTENTIONS — Live CL Price Proxy
 *
 * GET /api/cl-price
 *
 * Server-side Yahoo Finance fetch for CL=F. Yahoo blocks browser CORS, so the
 * client polls this endpoint every 10s instead of hitting Yahoo directly.
 *
 * Returns: { price: number, timestamp: number, currency: string } or
 *          { error: string } with non-200 status.
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
    }>;
  };
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
    const meta = data.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      return NextResponse.json({ error: 'No price in response' }, { status: 502 });
    }
    return NextResponse.json({
      price,
      timestamp: meta?.regularMarketTime ?? Math.floor(Date.now() / 1000),
      currency: meta?.currency ?? 'USD',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'fetch failed';
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
