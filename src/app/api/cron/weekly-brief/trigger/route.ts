/**
 * CRUDE INTENTIONS — Weekly Brief Manual Trigger Proxy
 *
 * POST /api/cron/weekly-brief/trigger
 *   Auth: x-api-key (INTERNAL_API_KEY)
 *   No body.
 *
 * Internally fetches POST /api/cron/weekly-brief with the server-side
 * CRON_SECRET as a Bearer token. Returns the upstream response body as
 * a passthrough, or { error: 'cron_failed' } with 502 on upstream failure.
 *
 * This exists so the settings RUN NOW button can authenticate with the
 * already-client-safe INTERNAL_API_KEY (mirrored to the browser via
 * NEXT_PUBLIC_INTERNAL_API_KEY) without exposing CRON_SECRET to the
 * browser bundle.
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(req: NextRequest) {
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY not configured' }, { status: 500 });
  }
  if (req.headers.get('x-api-key') !== INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  const url = `${proto}://${host}/api/cron/weekly-brief`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      cache: 'no-store',
    });
    let body: unknown = {};
    try {
      body = await upstream.json();
    } catch {
      // upstream returned non-JSON; preserve status but return a generic error
      return NextResponse.json({ error: 'cron_failed' }, { status: 502 });
    }
    return NextResponse.json(body, { status: upstream.status });
  } catch (err) {
    console.error('[CRON-TRIGGER] upstream fetch failed:', err);
    return NextResponse.json({ error: 'cron_failed' }, { status: 502 });
  }
}
