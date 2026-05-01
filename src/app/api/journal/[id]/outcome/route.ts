import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { kv } from '@/lib/kv';
import {
  recalculateCalibration,
  type CalibrationEntry,
  type CalibrationSnapshot,
} from '@/lib/journal/calibration';
import { pruneHistory } from '@/lib/journal/observer';
import {
  readContext,
  writeContext,
  updateContextFromOutcome,
  type ClosedTradeForContext,
} from '@/lib/market-memory/context';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const ClosePatchSchema = z.object({
  close_price: z.number().finite().min(10).max(500),
  run_postmortem: z.boolean().optional().default(false),
  runner_management: z.enum([
    'HELD_TO_TP2',
    'TRAILED_TO_STRUCTURE',
    'TRAILED_TO_VWAP',
    'MANUAL_CLOSE',
    'NO_RUNNER',
  ]).nullable().optional(),
});

const PostmortemPatchSchema = z.object({
  postmortem: z.string().min(1).max(4000),
}).strict();

function firePostMortem(req: NextRequest, id: string): void {
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY not configured' }, { status: 500 });
  }
  const auth = req.headers.get('x-api-key');
  if (!auth || !safeEq(auth, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Postmortem-only branch — writes the postmortem field without
  // touching outcome status or recalculating calibration.
  const pmParsed = PostmortemPatchSchema.safeParse(body);
  if (pmParsed.success) {
    type StoredEntryWithPm = CalibrationEntry & {
      postmortem?: string | null;
      postmortem_at?: string | null;
    };
    const entries = (await kv.get<StoredEntryWithPm[]>('journal:entries')) ?? [];
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      return NextResponse.json({ error: `Entry ${id} not found` }, { status: 404 });
    }
    entries[idx] = {
      ...entries[idx],
      postmortem: pmParsed.data.postmortem,
      postmortem_at: new Date().toISOString(),
    };
    await kv.set('journal:entries', entries);
    return NextResponse.json({ ok: true, postmortem_written: true });
  }

  const parsed = ClosePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { close_price, run_postmortem, runner_management } = parsed.data;

  // Step 1 — Load entries, find by id, compute and write outcome
  const entries = (await kv.get<CalibrationEntry[]>('journal:entries')) ?? [];
  const idx = entries.findIndex((e) => e.id === id);

  if (idx === -1) {
    return NextResponse.json({ error: `Entry ${id} not found` }, { status: 404 });
  }

  const entry = entries[idx];

  if (entry.direction === 'NO TRADE') {
    return NextResponse.json(
      { error: 'Cannot log outcome for a NO TRADE entry' },
      { status: 400 }
    );
  }

  const entryPrice = entry.entry_price;
  const stopLoss = entry.stop_loss;

  if (entryPrice == null) {
    return NextResponse.json(
      { error: 'Entry is missing entry_price' },
      { status: 400 }
    );
  }

  const isLong = entry.direction === 'LONG';
  const rawTicks = (close_price - entryPrice) / 0.01;
  const ticks = isLong ? rawTicks : -rawTicks;
  const contracts = entry.contracts ?? 1;
  const dollars = ticks * 10 * contracts;

  // R-multiple requires a stop. If none, skip the calculation and emit null
  // for downstream consumers (calibration, market memory) instead of failing.
  const riskTicks = stopLoss != null ? Math.abs((entryPrice - stopLoss) / 0.01) : 0;
  const rMultiple: number | null =
    stopLoss != null && riskTicks > 0 ? ticks / riskTicks : null;

  const status: 'WIN' | 'LOSS' | 'SCRATCH' =
    Math.abs(ticks) <= 2 ? 'SCRATCH' : ticks > 0 ? 'WIN' : 'LOSS';

  const close_timestamp = new Date().toISOString();

  entries[idx] = {
    ...entry,
    outcome: {
      ...entry.outcome,
      status,
      result: ticks,
      result_dollars: dollars,
      result_r: rMultiple,
      close_price,
      close_timestamp,
    },
    // Top-level alongside postmortem / shadow_result. undefined means
    // the field was omitted by the caller (skipped on save) — preserve
    // any existing value rather than wiping. null means explicit clear.
    ...(runner_management !== undefined ? { runner_management } : {}),
  };

  await kv.set('journal:entries', entries);

  // Step 2 — Recalculate calibration, persist snapshot + append to history
  const snapshot = recalculateCalibration(entries);
  await kv.set('calibration:latest', snapshot);

  const history = (await kv.get<CalibrationSnapshot[]>('calibration:history')) ?? [];
  await kv.set('calibration:history', pruneHistory([...history, snapshot]));

  // Step 3 — Feed closed trade into ALFRED's market memory
  const closedTrade: ClosedTradeForContext = {
    id: entry.id,
    direction: entry.direction as 'LONG' | 'SHORT',
    outcome: status,
    // Market memory's prompt builder formats result_r with .toFixed(); pass 0
    // when the trade had no stop so the renderer doesn't crash.
    result_r: rMultiple ?? 0,
    score: entry.score,
    confidence_label: entry.confidence_label,
    session: entry.session,
    close_timestamp,
    reasoning: entry.reasoning,
  };

  const ctx = await readContext(kv);
  const updatedCtx = updateContextFromOutcome(ctx, closedTrade);
  await writeContext(kv, updatedCtx);

  // Step 4 — Fire post-mortem in background (non-blocking)
  if (run_postmortem) {
    firePostMortem(req, entry.id);
  }

  return NextResponse.json({ ok: true, calibration_trades: snapshot.totals.trades_closed });
}
