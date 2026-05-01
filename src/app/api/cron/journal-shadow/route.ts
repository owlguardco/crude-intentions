/**
 * CRUDE INTENTIONS — Shadow Log daily cron
 *
 * GET /api/cron/journal-shadow
 *   Auth: Authorization: Bearer ${CRON_SECRET}  (Vercel cron default)
 *         or x-cron-secret: ${CRON_SECRET}
 *
 * Schedule: 05:00 UTC daily (vercel.json) — that's midnight ET during
 * EST and 1am ET during EDT. Same DST trade-off as journal-reminder;
 * resolving a few hours late doesn't matter because the 15-min candles
 * the resolver walks are stable in arrears.
 *
 * Logic:
 *   - Read journal:entries from KV
 *   - Filter to entries that:
 *       a) belong to "yesterday" (UTC date match against entry.timestamp)
 *       b) have direction === 'NO TRADE'
 *       c) have entry_price + stop + tp1 levels populated
 *       d) don't have shadow_result yet (idempotent — won't overwrite)
 *   - Resolve each via resolveShadowOutcome() and persist back to KV
 *   - Return { resolved: N, skipped: N, errors: [{id, reason}] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import { safeEq } from '@/lib/auth/safe-compare';
import {
  resolveShadowOutcome,
  type ShadowResult,
} from '@/lib/journal/shadow-resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CRON_SECRET = process.env.CRON_SECRET;

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

function isAuthorised(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get('authorization');
  if (auth && auth.startsWith('Bearer ') && safeEq(auth.slice(7), CRON_SECRET)) return true;
  const direct = req.headers.get('x-cron-secret');
  if (direct && safeEq(direct, CRON_SECRET)) return true;
  return false;
}

function yesterdayUtcDate(now: Date): string {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function hasLevels(e: StoredEntry): boolean {
  const entryPrice = typeof e.entry_price === 'number';
  const stop = typeof e.stop_loss === 'number' || typeof e.stop_price === 'number';
  const tp1 = typeof e.take_profit_1 === 'number' || typeof e.tp1_price === 'number';
  return entryPrice && stop && tp1;
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const yesterday = yesterdayUtcDate(new Date());
  const entries = (await kv.get<StoredEntry[]>('journal:entries')) ?? [];
  const errors: Array<{ id: string; reason: string }> = [];
  let resolved = 0;
  let skipped = 0;
  let mutated = false;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.id) { skipped++; continue; }
    const day = typeof e.timestamp === 'string' ? e.timestamp.slice(0, 10) : null;
    if (day !== yesterday) continue;
    if (e.direction !== 'NO TRADE') { skipped++; continue; }
    if (e.shadow_result) { skipped++; continue; }
    if (!hasLevels(e)) {
      errors.push({ id: e.id, reason: 'missing_levels' });
      continue;
    }
    const r = await resolveShadowOutcome(e);
    if (!r.ok) {
      errors.push({ id: e.id, reason: r.reason });
      continue;
    }
    entries[i] = { ...e, shadow_result: r.result };
    mutated = true;
    resolved++;
  }

  if (mutated) {
    await kv.set('journal:entries', entries);
  }

  return NextResponse.json({
    ok: true,
    yesterday,
    resolved,
    skipped,
    errors,
  });
}
