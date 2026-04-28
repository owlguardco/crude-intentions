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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchBodySchema = z.object({
  close_price: z.number().finite().min(10).max(500),
  run_postmortem: z.boolean().optional().default(false),
});

function firePostMortem(id: string): void {
  console.log('[POST-MORTEM] Queued for', id, '— implementation pending');
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = PatchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { close_price, run_postmortem } = parsed.data;

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

  if (entryPrice == null || stopLoss == null) {
    return NextResponse.json(
      { error: 'Entry is missing entry_price or stop_loss' },
      { status: 400 }
    );
  }

  const isLong = entry.direction === 'LONG';
  const rawTicks = (close_price - entryPrice) / 0.01;
  const ticks = isLong ? rawTicks : -rawTicks;
  const contracts = entry.contracts ?? 1;
  const dollars = ticks * 10 * contracts;
  const riskTicks = Math.abs((entryPrice - stopLoss) / 0.01);
  const rMultiple = riskTicks > 0 ? ticks / riskTicks : 0;

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
    result_r: rMultiple,
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
    firePostMortem(entry.id);
  }

  return NextResponse.json({ ok: true, calibration_trades: snapshot.totals.trades_closed });
}
