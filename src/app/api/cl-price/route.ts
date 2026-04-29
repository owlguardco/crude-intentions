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
 *          matches the current CME CL session day. Session day rolls at
 *          18:00 ET (Globex open), so on Sunday/weeknight evenings the
 *          anchor advances to the next calendar day.
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

// CME CL Globex session: opens 6:00 PM ET, closes 5:00 PM ET the next
// calendar day. The session is named after the calendar day it closes on,
// so:
//   NY time before 18:00 → sessionDate = today's NY date
//   NY time at/after 18:00 → sessionDate = tomorrow's NY date
function sessionDateInNY(): string {
  const now = new Date();
  const nyHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }).format(now),
    10,
  );
  const target = Number.isFinite(nyHour) && nyHour >= 18
    ? new Date(now.getTime() + 24 * 60 * 60 * 1000)
    : now;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(target);
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
  const sessionDate = sessionDateInNY();
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    if (typeof o !== 'number' || !Number.isFinite(o)) continue;
    if (dateInNY(timestamps[i]) === sessionDate) return o;
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
