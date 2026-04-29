/**
 * CRUDE INTENTIONS — Supply Context (Phase 2G)
 *
 * GET /api/supply-context
 *   Auth: x-api-key header (INTERNAL_API_KEY)
 *
 * Pulls last 5 weekly EIA prints for total US crude inventory and Cushing,
 * derives a coarse supply bias, and persists to market:context.supply_context.
 *
 * Silent degradation: if either EIA fetch fails, returns 200 with all
 * derived fields null and { error: 'eia_unavailable' }. Never throws.
 */

import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import {
  readContext,
  writeContext,
  type SupplyContext,
  type CushingTrend,
  type EiaWeeklyTrend,
  type RigCountTrend,
  type SupplyBias,
} from '@/lib/market-memory/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const EIA_KEY = process.env.EIA_API_KEY ?? 'DEMO_KEY';

const FETCH_TIMEOUT_MS = 10_000;

const WSTK_URL =
  `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?api_key=${EIA_KEY}` +
  `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=5`;
const CUSHING_URL =
  `https://api.eia.gov/v2/petroleum/stoc/cushing/data/?api_key=${EIA_KEY}` +
  `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=5`;

interface EiaResponse {
  response?: {
    data?: Array<{ period?: string; value?: number | string }>;
  };
}

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get('x-api-key') ?? req.headers.get('authorization');
  if (!header) return false;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
}

async function fetchEia(url: string): Promise<number[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as EiaResponse;
    const rows = json.response?.data ?? [];
    const values: number[] = [];
    for (const row of rows) {
      const v = typeof row.value === 'string' ? parseFloat(row.value) : row.value;
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
    return values.length > 0 ? values : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function deriveEiaTrend(values: number[]): EiaWeeklyTrend | null {
  // values are in DESC period order (most recent first). Compute WoW changes
  // for the last 4 prints, which means deltas across 5 weekly values.
  if (values.length < 5) return null;
  let positives = 0;
  let negatives = 0;
  for (let i = 0; i < 4; i++) {
    const d = values[i] - values[i + 1];
    if (d > 0) positives++;
    else if (d < 0) negatives++;
  }
  if (positives >= 3) return 'BUILDS';
  if (negatives >= 3) return 'DRAWS';
  return 'MIXED';
}

function deriveCushingTrend(values: number[]): CushingTrend | null {
  if (values.length < 5) return null;
  const latest = values[0];
  const prior4 = values.slice(1, 5);
  const avg = prior4.reduce((a, b) => a + b, 0) / prior4.length;
  if (latest > avg) return 'BUILDING';
  if (latest < avg) return 'DRAWING';
  return 'FLAT';
}

function deriveSupplyBias(
  eia: EiaWeeklyTrend | null,
  cushing: CushingTrend | null,
): SupplyBias {
  if (eia === 'BUILDS' && cushing === 'BUILDING') return 'BEARISH';
  if (eia === 'DRAWS' && cushing === 'DRAWING') return 'BULLISH';
  return 'NEUTRAL';
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const [wstkValues, cushingValues] = await Promise.all([
    fetchEia(WSTK_URL),
    fetchEia(CUSHING_URL),
  ]);

  if (wstkValues === null || cushingValues === null) {
    return NextResponse.json({
      supply_context: {
        cushing_vs_4wk: null,
        eia_4wk_trend: null,
        rig_count_trend: null,
        supply_bias: null,
      },
      raw: { wstk: wstkValues, cushing: cushingValues },
      error: 'eia_unavailable',
    });
  }

  const eia_4wk_trend = deriveEiaTrend(wstkValues);
  const cushing_vs_4wk = deriveCushingTrend(cushingValues);
  const rig_count_trend: RigCountTrend = 'FLAT'; // TODO: Baker Hughes scraping
  const supply_bias = deriveSupplyBias(eia_4wk_trend, cushing_vs_4wk);

  const supplyContext: SupplyContext = {
    cushing_vs_4wk,
    eia_4wk_trend,
    rig_count_trend,
    supply_bias,
    updated_at: new Date().toISOString(),
  };

  // Persist to market:context — additive, never overwrites existing fields
  try {
    const ctx = await readContext(kv);
    await writeContext(kv, { ...ctx, supply_context: supplyContext });
  } catch (err) {
    console.error('[SUPPLY-CONTEXT] persist failed', err);
  }

  return NextResponse.json({
    supply_context: {
      cushing_vs_4wk,
      eia_4wk_trend,
      rig_count_trend,
      supply_bias,
    },
    raw: { wstk: wstkValues, cushing: cushingValues },
  });
}
