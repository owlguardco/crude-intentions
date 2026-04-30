import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { kv } from '@/lib/kv';
import type { CalibrationEntry } from '@/lib/journal/calibration';
import { closeTrade, type CloseStatus } from '@/lib/journal/close-trade';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { checkReplay } from '@/lib/replay-protect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';

const BodySchema = z.object({
  signal_id: z.string(),
  close_price: z.number().finite().min(10).max(500),
  close_reason: z.enum(['TP1_HIT', 'TP2_HIT', 'STOPPED_OUT', 'BREAKEVEN', 'MANUAL']),
  ticks_pnl: z.number().optional(),
}).strict();

function verifyAuth(req: NextRequest, rawBody: string): boolean {
  if (!WEBHOOK_SECRET) return false;
  const sig = req.headers.get('x-signature');
  if (sig) {
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }
  const querySecret = req.nextUrl.searchParams.get('secret');
  if (querySecret) {
    try {
      return crypto.timingSafeEqual(Buffer.from(querySecret), Buffer.from(WEBHOOK_SECRET));
    } catch {
      return false;
    }
  }
  return false;
}

function fireCloseSidePostMortem(req: NextRequest, id: string): void {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  const url = `${proto}://${host}/api/journal/${id}/postmortem`;
  void fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
  }).catch((err) => {
    console.error('[POST-MORTEM] Fire failed for', id, err);
  });
}

function reasonToStatus(reason: z.infer<typeof BodySchema>['close_reason']): CloseStatus {
  if (reason === 'TP1_HIT' || reason === 'TP2_HIT') return 'WIN';
  if (reason === 'STOPPED_OUT') return 'LOSS';
  return 'SCRATCH';
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit('webhook-close:global', 60, 60);
  const rlHeaders = rateLimitHeaders(rl);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: rlHeaders });
  }

  const rawBody = await req.text();
  if (!verifyAuth(req, rawBody)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: rlHeaders });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: rlHeaders });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400, headers: rlHeaders },
    );
  }

  const { signal_id, close_price, close_reason } = parsed.data;
  let { ticks_pnl } = parsed.data;

  // Replay protection — early exit before the journal lookup. Same 409
  // shape the route already returns when an entry's status != OPEN, so
  // legitimate retries see consistent behavior.
  const replay = await checkReplay(`close:${signal_id}`);
  if (replay.seen) {
    return NextResponse.json({ error: 'Already closed' }, { status: 409, headers: rlHeaders });
  }

  const entries = (await kv.get<CalibrationEntry[]>('journal:entries')) ?? [];
  const entry = entries.find((e) => e.id === signal_id);
  if (!entry) {
    return NextResponse.json({ error: `Entry ${signal_id} not found` }, { status: 404, headers: rlHeaders });
  }
  if (entry.outcome?.status && entry.outcome.status !== 'OPEN') {
    return NextResponse.json({ error: 'Already closed' }, { status: 409, headers: rlHeaders });
  }
  if (entry.direction === 'NO TRADE' || entry.entry_price == null) {
    return NextResponse.json({ error: 'Entry not eligible to close' }, { status: 400, headers: rlHeaders });
  }

  if (ticks_pnl == null) {
    const isLong = entry.direction === 'LONG';
    const raw = isLong
      ? (close_price - entry.entry_price) * 100
      : (entry.entry_price - close_price) * 100;
    ticks_pnl = Math.round(raw * 10) / 10;
  }

  const result = await closeTrade({
    id: signal_id,
    close_price,
    forced_status: reasonToStatus(close_reason),
    forced_ticks: ticks_pnl,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: rlHeaders });
  }

  fireCloseSidePostMortem(req, signal_id);

  return NextResponse.json({ ok: true, signal_id, outcome: result.outcome }, { headers: rlHeaders });
}
