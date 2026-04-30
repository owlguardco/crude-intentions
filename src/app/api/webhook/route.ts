/**
 * CRUDE INTENTIONS — Webhook Router
 *
 * POST /api/webhook?secret=WEBHOOK_SECRET
 *
 * Single-URL TradingView entry point that dispatches to the right handler
 * based on payload shape:
 *   - body has `close_reason`  → forwards to /api/webhook-close logic
 *   - body has `direction`     → forwards to /api/webhook-signal logic
 *   - neither                  → 400 Unknown payload
 *
 * close_reason is checked FIRST because TradingView close alerts often
 * also carry the original `direction` (LONG/SHORT) as context. Routing
 * by `direction` first would mis-route close payloads into the open
 * handler and 400 on missing ema/rsi fields.
 *
 * Auth: ?secret= query param matches WEBHOOK_SECRET (constant-time compare).
 *
 * Reuses the underlying handler functions; no duplicated business logic.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { POST as webhookSignalPOST } from '../webhook-signal/route';
import { POST as webhookClosePOST } from '../webhook-close/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

function verifySecret(req: NextRequest): boolean {
  if (!WEBHOOK_SECRET) return false;
  const provided = req.nextUrl.searchParams.get('secret');
  if (!provided) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(WEBHOOK_SECRET),
    );
  } catch {
    return false;
  }
}

function forward(
  req: NextRequest,
  rawBody: string,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const headers = new Headers(req.headers);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new NextRequest(req.nextUrl, {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody = await req.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Unknown payload' }, { status: 400 });
  }

  const obj = payload as Record<string, unknown>;

  // Close payloads first — TradingView close alerts often also carry
  // `direction` (LONG/SHORT) as context, so checking `direction` first
  // would mis-route them into the open handler and 400 on missing fields.
  if ('close_reason' in obj) {
    // webhook-close authorizes via x-signature HMAC OR ?secret= — the URL
    // already carries ?secret=, so the forwarded request will pass.
    return webhookClosePOST(forward(req, rawBody));
  }

  if ('direction' in obj) {
    // webhook-signal authorizes via x-api-key — stamp it ourselves now that
    // the outer ?secret= has been verified.
    return webhookSignalPOST(forward(req, rawBody, { 'x-api-key': INTERNAL_API_KEY }));
  }

  return NextResponse.json({ error: 'Unknown payload' }, { status: 400 });
}
