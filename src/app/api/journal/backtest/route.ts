import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { kv } from '@/lib/kv';
import type { CalibrationEntry } from '@/lib/journal/calibration';
import { closeTrade } from '@/lib/journal/close-trade';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const BodySchema = z.object({
  signal_ids: z.array(z.string()).optional(),
}).strict();

interface YahooCandle { ts: number; high: number; low: number; }

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ high?: Array<number | null>; low?: Array<number | null> }> };
    }>;
  };
}

async function fetchCandles(unixStart: number, unixEnd: number): Promise<YahooCandle[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=15m&period1=${unixStart}&period2=${unixEnd}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.8)' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as YahooChartResponse;
    const result = data.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    const highs = quote?.high ?? [];
    const lows = quote?.low ?? [];
    const candles: YahooCandle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const h = highs[i];
      const l = lows[i];
      if (h == null || l == null) continue;
      candles.push({ ts: ts[i], high: h, low: l });
    }
    return candles;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type BacktestOutcome = 'TP1_HIT' | 'STOPPED_OUT';

function walkCandles(
  candles: YahooCandle[],
  direction: 'LONG' | 'SHORT',
  tp1: number,
  stop: number,
): BacktestOutcome | null {
  for (const c of candles) {
    if (direction === 'LONG') {
      if (c.high >= tp1) return 'TP1_HIT';
      if (c.low <= stop) return 'STOPPED_OUT';
    } else {
      if (c.low <= tp1) return 'TP1_HIT';
      if (c.high >= stop) return 'STOPPED_OUT';
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BacktestResult { signal_id: string; outcome: 'WIN' | 'LOSS' | 'OPEN' | 'SKIPPED'; reason: string; }

export async function POST(req: NextRequest) {
  const auth = req.headers.get('x-api-key');
  if (!INTERNAL_API_KEY || !auth || !safeEq(auth, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
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

  const requested = parsed.data.signal_ids;
  const entries = (await kv.get<CalibrationEntry[]>('journal:entries')) ?? [];

  type Eligible = CalibrationEntry & { tp1_price?: number | null; stop_price?: number | null };
  const eligible = entries.filter((e) => {
    if (e.outcome?.status !== 'OPEN') return false;
    if (e.direction !== 'LONG' && e.direction !== 'SHORT') return false;
    if (e.entry_price == null) return false;
    const ee = e as Eligible;
    if (ee.tp1_price == null || ee.stop_price == null) return false;
    if (requested && !requested.includes(e.id)) return false;
    return true;
  }) as Eligible[];

  // F-22: cap the per-request workload so a runaway eligible set can't
  // wedge the function near Vercel's 300s ceiling. Each iteration sleeps
  // 500ms between Yahoo fetches; 50 entries is ~25s of work, well inside.
  const MAX_ELIGIBLE = 50;
  const capped = eligible.slice(0, MAX_ELIGIBLE);
  if (eligible.length > MAX_ELIGIBLE) {
    console.warn('[journal/backtest] cap hit:', eligible.length, 'entries, running first 50');
  }

  const results: BacktestResult[] = [];
  let resolved = 0;
  let skipped = 0;

  for (let i = 0; i < capped.length; i++) {
    const entry = capped[i];
    if (i > 0) await sleep(500);

    const tp1 = entry.tp1_price as number;
    const stop = entry.stop_price as number;
    const entryPrice = entry.entry_price as number;
    const direction = entry.direction as 'LONG' | 'SHORT';
    const startMs = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(startMs)) {
      skipped++;
      results.push({ signal_id: entry.id, outcome: 'SKIPPED', reason: 'Invalid timestamp' });
      continue;
    }
    const unixStart = Math.floor(startMs / 1000);
    const unixEnd = unixStart + 48 * 3600;

    const candles = await fetchCandles(unixStart, unixEnd);
    if (candles == null) {
      skipped++;
      results.push({ signal_id: entry.id, outcome: 'SKIPPED', reason: 'Yahoo fetch failed' });
      continue;
    }

    const outcome = walkCandles(candles, direction, tp1, stop);
    if (outcome == null) {
      results.push({ signal_id: entry.id, outcome: 'OPEN', reason: 'No TP1 or stop hit in 48h' });
      continue;
    }

    const isLong = direction === 'LONG';
    const closePrice = outcome === 'TP1_HIT' ? tp1 : stop;
    const rawTicks = isLong ? (closePrice - entryPrice) * 100 : (entryPrice - closePrice) * 100;
    const ticks = Math.round(rawTicks * 10) / 10;

    const closeRes = await closeTrade({
      id: entry.id,
      close_price: closePrice,
      forced_status: outcome === 'TP1_HIT' ? 'WIN' : 'LOSS',
      forced_ticks: ticks,
      backtest_source: true,
    });

    if (!closeRes.ok) {
      skipped++;
      results.push({ signal_id: entry.id, outcome: 'SKIPPED', reason: closeRes.error ?? 'Close failed' });
      continue;
    }

    resolved++;
    results.push({
      signal_id: entry.id,
      outcome: outcome === 'TP1_HIT' ? 'WIN' : 'LOSS',
      reason: outcome,
    });
  }

  return NextResponse.json({
    processed: capped.length,
    resolved,
    skipped,
    results,
  });
}
