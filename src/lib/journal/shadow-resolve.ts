/**
 * CRUDE INTENTIONS — Shadow Log resolver
 *
 * Walks Yahoo Finance 15-min candles forward from a journal entry's
 * timestamp to produce a counterfactual outcome — "what would have
 * happened if this NO TRADE had been taken?". Mirrors the walk-forward
 * pattern in /api/journal/backtest (route.ts) but writes the result
 * to entry.shadow_result instead of mutating outcome/calibration.
 *
 * Display-only for now; downstream calibration consumers can opt-in
 * later by reading shadow_result from the entry.
 */

const TICK = 0.01;
const SHADOW_WINDOW_HOURS = 24;

export type ShadowOutcome = 'WIN' | 'LOSS' | 'SCRATCH';

export interface ShadowResult {
  outcome: ShadowOutcome;
  result_r: number;
  resolved_at: string;
  exit_price: number;
}

export interface ShadowResolveError {
  ok: false;
  reason:
    | 'missing_levels'      // entry_price / stop / tp1 not all present
    | 'invalid_levels'      // stop on the wrong side, zero risk, etc
    | 'invalid_timestamp'
    | 'feed_unavailable'
    | 'no_candles';
}

export interface ShadowResolveOk {
  ok: true;
  result: ShadowResult;
}

export type ShadowResolveResponse = ShadowResolveOk | ShadowResolveError;

interface ShadowInputEntry {
  timestamp?: string;
  entry_price?: number | null;
  // Both pre-trade payload (stop_price/tp1_price) and JournalWriteSchema
  // (stop_loss/take_profit_1) shapes are accepted; the resolver picks
  // whichever side is non-null.
  stop_price?: number | null;
  stop_loss?: number | null;
  tp1_price?: number | null;
  take_profit_1?: number | null;
  direction?: 'LONG' | 'SHORT' | 'NO TRADE';
}

interface YahooCandle { ts: number; high: number; low: number }

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
        }>;
      };
    }>;
  };
}

async function fetchCandles(unixStart: number, unixEnd: number): Promise<{
  candles: YahooCandle[];
  closes: number[];
} | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=15m&period1=${unixStart}&period2=${unixEnd}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.9)' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as YahooChartResponse;
    const result = data.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    const highs = quote?.high ?? [];
    const lows = quote?.low ?? [];
    const closes = quote?.close ?? [];
    const candles: YahooCandle[] = [];
    const closeArr: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      if (h == null || l == null) continue;
      candles.push({ ts: ts[i], high: h, low: l });
      if (c != null) closeArr.push(c);
    }
    return { candles, closes: closeArr };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveShadowOutcome(entry: ShadowInputEntry): Promise<ShadowResolveResponse> {
  const entryPrice = typeof entry.entry_price === 'number' ? entry.entry_price : null;
  const stop = typeof entry.stop_loss === 'number' ? entry.stop_loss
             : typeof entry.stop_price === 'number' ? entry.stop_price : null;
  const tp1 = typeof entry.take_profit_1 === 'number' ? entry.take_profit_1
            : typeof entry.tp1_price === 'number' ? entry.tp1_price : null;

  if (entryPrice === null || stop === null || tp1 === null) {
    return { ok: false, reason: 'missing_levels' };
  }

  // Direction inference: explicit LONG/SHORT wins; otherwise infer from
  // stop position relative to entry. NO TRADE entries with valid levels
  // (e.g. B-grade rejected setups) get their direction from the stop side.
  const direction: 'LONG' | 'SHORT' =
    entry.direction === 'LONG' || entry.direction === 'SHORT'
      ? entry.direction
      : stop < entryPrice ? 'LONG' : 'SHORT';

  // Validate levels are on the right sides for the inferred direction.
  if (direction === 'LONG' && (stop >= entryPrice || tp1 <= entryPrice)) {
    return { ok: false, reason: 'invalid_levels' };
  }
  if (direction === 'SHORT' && (stop <= entryPrice || tp1 >= entryPrice)) {
    return { ok: false, reason: 'invalid_levels' };
  }
  const riskTicks = Math.abs(entryPrice - stop) / TICK;
  if (riskTicks <= 0) {
    return { ok: false, reason: 'invalid_levels' };
  }

  const startMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(startMs)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const unixStart = Math.floor(startMs / 1000);
  const unixEnd = unixStart + SHADOW_WINDOW_HOURS * 3600;

  const fetched = await fetchCandles(unixStart, unixEnd);
  if (!fetched) return { ok: false, reason: 'feed_unavailable' };
  const { candles, closes } = fetched;
  if (candles.length === 0) return { ok: false, reason: 'no_candles' };

  // Walk forward — first hit wins. Conservative: when both touch in the
  // same bar, stop fills first (matches backtest_engine.simulate logic).
  for (const c of candles) {
    let hitTp = false;
    let hitStop = false;
    if (direction === 'LONG') {
      hitTp = c.high >= tp1;
      hitStop = c.low <= stop;
    } else {
      hitTp = c.low <= tp1;
      hitStop = c.high >= stop;
    }
    if (hitTp && hitStop) {
      return finalize('LOSS', stop, entryPrice, direction, riskTicks, c.ts);
    }
    if (hitTp) {
      return finalize('WIN', tp1, entryPrice, direction, riskTicks, c.ts);
    }
    if (hitStop) {
      return finalize('LOSS', stop, entryPrice, direction, riskTicks, c.ts);
    }
  }

  // No hit within 24h — SCRATCH at last bar's close. Falls back to the
  // last bar's high/low midpoint when close[] is short of candles[].
  const last = candles[candles.length - 1];
  const lastClose = closes.length > 0 ? closes[closes.length - 1] : (last.high + last.low) / 2;
  return finalize('SCRATCH', lastClose, entryPrice, direction, riskTicks, last.ts);
}

function finalize(
  outcome: ShadowOutcome,
  exitPrice: number,
  entryPrice: number,
  direction: 'LONG' | 'SHORT',
  riskTicks: number,
  resolvedTs: number,
): ShadowResolveOk {
  const ticksPnl = direction === 'LONG'
    ? (exitPrice - entryPrice) / TICK
    : (entryPrice - exitPrice) / TICK;
  const result_r = riskTicks > 0 ? ticksPnl / riskTicks : 0;
  return {
    ok: true,
    result: {
      outcome,
      result_r: Math.round(result_r * 100) / 100,
      resolved_at: new Date(resolvedTs * 1000).toISOString(),
      exit_price: Math.round(exitPrice * 100) / 100,
    },
  };
}
