/**
 * CRUDE INTENTIONS — No-Trade Session Logger
 *
 * POST /api/journal/no-trade
 *
 * End-of-session audit. Writes a NO_TRADE entry to journal:entries so
 * the trader has a complete daily record even on days where nothing
 * was taken. Excluded from win-rate / calibration aggregation by
 * design — discriminated by `type: 'no_trade'` AND outcome.status =
 * 'BLOCKED', neither of which matches the WIN/LOSS/SCRATCH filter
 * recalculateCalibration uses.
 *
 * Auth: x-api-key (INTERNAL_API_KEY).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { kv } from '@/lib/kv';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const BodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  session: z.enum(['NY_OPEN', 'NY_AFTERNOON', 'LONDON', 'OVERLAP', 'ASIA', 'OFF_HOURS']),
  blockers: z.array(z.string().min(1).max(120)).min(1).max(20),
  notes: z.string().max(1000).optional(),
  conditions_snapshot: z.record(z.string(), z.unknown()).default({}),
}).strict();

type StoredEntry = Record<string, unknown> & { id?: string };

export interface NoTradeEntry {
  id: string;
  type: 'no_trade';
  timestamp: string;
  date: string;
  session: 'NY_OPEN' | 'NY_AFTERNOON' | 'LONDON' | 'OVERLAP' | 'ASIA' | 'OFF_HOURS';
  direction: 'NO TRADE';
  blockers: string[];
  notes: string | null;
  conditions_snapshot: Record<string, unknown>;
  source: 'NO_TRADE_LOG';
  outcome: {
    status: 'BLOCKED';
    result: null;
    result_dollars: null;
    result_r: null;
    close_timestamp: null;
    close_price: null;
    post_mortem: null;
    post_mortem_timestamp: null;
  };
}

function generateNoTradeId(entries: StoredEntry[], date: string): string {
  const prefix = `NT-${date}-`;
  const n = entries.filter((e) => typeof e.id === 'string' && e.id.startsWith(prefix)).length;
  return `${prefix}${String(n + 1).padStart(3, '0')}`;
}

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

  const { date, session, blockers, notes, conditions_snapshot } = parsed.data;

  const entries = (await kv.get<StoredEntry[]>('journal:entries')) ?? [];
  const id = generateNoTradeId(entries, date);

  const entry: NoTradeEntry = {
    id,
    type: 'no_trade',
    timestamp: new Date().toISOString(),
    date,
    session,
    direction: 'NO TRADE',
    blockers,
    notes: notes ?? null,
    conditions_snapshot,
    source: 'NO_TRADE_LOG',
    outcome: {
      status: 'BLOCKED',
      result: null,
      result_dollars: null,
      result_r: null,
      close_timestamp: null,
      close_price: null,
      post_mortem: null,
      post_mortem_timestamp: null,
    },
  };

  await kv.set('journal:entries', [...entries, entry as unknown as StoredEntry]);

  return NextResponse.json({ ok: true, entry });
}
