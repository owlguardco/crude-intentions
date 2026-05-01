/**
 * CRUDE INTENTIONS — Shadow Log resolver (single entry)
 *
 * POST /api/journal/shadow-resolve
 *   Auth: x-api-key (INTERNAL_API_KEY)
 *   Body: { entry_id: string }
 *
 * Looks up a journal entry by id, walks 24h of Yahoo 15-min candles
 * forward from entry.timestamp using resolveShadowOutcome(), writes
 * shadow_result back to the entry, and returns the result.
 *
 * Idempotent — re-resolving an already-resolved entry overwrites the
 * previous shadow_result. The cron at /api/cron/journal-shadow only
 * fires for entries that haven't been resolved yet.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { kv } from '@/lib/kv';
import { safeEq } from '@/lib/auth/safe-compare';
import {
  resolveShadowOutcome,
  type ShadowResult,
} from '@/lib/journal/shadow-resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const BodySchema = z.object({
  entry_id: z.string().min(1).max(64),
}).strict();

// Stored journal entries don't all conform to the same shape (NoTradeEntry
// vs JournalEntry vs CalibrationEntry). Use a permissive read type.
type StoredEntry = Record<string, unknown> & {
  id?: string;
  timestamp?: string;
  entry_price?: number | null;
  stop_price?: number | null;
  stop_loss?: number | null;
  tp1_price?: number | null;
  take_profit_1?: number | null;
  direction?: 'LONG' | 'SHORT' | 'NO TRADE';
  shadow_result?: ShadowResult | null;
};

export async function POST(req: NextRequest) {
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY not configured' }, { status: 500 });
  }
  const auth = req.headers.get('x-api-key');
  if (!auth || !safeEq(auth, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const entries = (await kv.get<StoredEntry[]>('journal:entries')) ?? [];
  const idx = entries.findIndex((e) => e.id === parsed.data.entry_id);
  if (idx === -1) {
    return NextResponse.json({ error: `Entry ${parsed.data.entry_id} not found` }, { status: 404 });
  }

  const entry = entries[idx];
  const resolved = await resolveShadowOutcome(entry);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, reason: resolved.reason }, { status: 422 });
  }

  entries[idx] = { ...entry, shadow_result: resolved.result };
  await kv.set('journal:entries', entries);

  return NextResponse.json({ ok: true, entry_id: parsed.data.entry_id, shadow_result: resolved.result });
}
