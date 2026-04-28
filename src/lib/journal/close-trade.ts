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

export type CloseStatus = 'WIN' | 'LOSS' | 'SCRATCH';

export interface CloseTradeInput {
  id: string;
  close_price: number;
  forced_status?: CloseStatus;
  forced_ticks?: number;
  backtest_source?: boolean;
}

export interface CloseTradeResult {
  ok: boolean;
  error?: string;
  status: number;
  signal_id?: string;
  outcome?: CloseStatus;
  calibration_trades?: number;
}

export async function closeTrade(input: CloseTradeInput): Promise<CloseTradeResult> {
  const entries = (await kv.get<CalibrationEntry[]>('journal:entries')) ?? [];
  const idx = entries.findIndex((e) => e.id === input.id);
  if (idx === -1) return { ok: false, status: 404, error: `Entry ${input.id} not found` };

  const entry = entries[idx];
  if (entry.direction === 'NO TRADE') {
    return { ok: false, status: 400, error: 'Cannot log outcome for a NO TRADE entry' };
  }
  if (entry.outcome?.status && entry.outcome.status !== 'OPEN') {
    return { ok: false, status: 409, error: 'Already closed' };
  }

  const entryPrice = entry.entry_price;
  const stopLoss = entry.stop_loss;
  if (entryPrice == null) {
    return { ok: false, status: 400, error: 'Entry is missing entry_price' };
  }

  const isLong = entry.direction === 'LONG';
  const rawTicks = (input.close_price - entryPrice) / 0.01;
  const ticks = input.forced_ticks ?? (isLong ? rawTicks : -rawTicks);
  const contracts = entry.contracts ?? 1;
  const dollars = ticks * 10 * contracts;
  const riskTicks = stopLoss != null ? Math.abs((entryPrice - stopLoss) / 0.01) : 0;
  const rMultiple = riskTicks > 0 ? ticks / riskTicks : 0;

  const status: CloseStatus =
    input.forced_status ?? (Math.abs(ticks) <= 2 ? 'SCRATCH' : ticks > 0 ? 'WIN' : 'LOSS');

  const close_timestamp = new Date().toISOString();

  const updated: CalibrationEntry = {
    ...entry,
    outcome: {
      ...entry.outcome,
      status,
      result: ticks,
      result_dollars: dollars,
      result_r: rMultiple,
      close_price: input.close_price,
      close_timestamp,
    },
  };
  if (input.backtest_source) {
    (updated as CalibrationEntry & { backtest_source?: boolean }).backtest_source = true;
  }
  entries[idx] = updated;

  await kv.set('journal:entries', entries);

  const snapshot = recalculateCalibration(entries);
  await kv.set('calibration:latest', snapshot);

  const history = (await kv.get<CalibrationSnapshot[]>('calibration:history')) ?? [];
  await kv.set('calibration:history', pruneHistory([...history, snapshot]));

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

  return {
    ok: true,
    status: 200,
    signal_id: entry.id,
    outcome: status,
    calibration_trades: snapshot.totals.trades_closed,
  };
}
