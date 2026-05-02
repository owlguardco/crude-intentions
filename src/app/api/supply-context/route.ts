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
import { safeEq } from '@/lib/auth/safe-compare';
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
const FETCH_TIMEOUT_MS = 10_000;

// URLs built per-call so a fresh process.env.EIA_API_KEY value (e.g. swapped
// in Vercel between deploys) is picked up without redeploying this file.
function buildWstkUrl(): string {
  return (
    `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?api_key=${process.env.EIA_API_KEY ?? 'DEMO_KEY'}` +
    `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=5`
  );
}
function buildCushingUrl(): string {
  return (
    `https://api.eia.gov/v2/petroleum/sum/sndw/data/?api_key=${process.env.EIA_API_KEY ?? 'DEMO_KEY'}` +
    `&frequency=weekly&data[0]=value&facets[series][]=WCSSTUS1&sort[0][column]=period&sort[0][direction]=desc&length=5`
  );
}

const BAKER_HUGHES_RSS_URL = 'https://rigcount.bakerhughes.com/static-files/rss-feed';
const RIG_FETCH_TIMEOUT_MS = 5_000;

async function fetchBakerHughesRigCounts(): Promise<number[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RIG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(BAKER_HUGHES_RSS_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.8)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const xml = await res.text();
    return parseRigCountsFromRss(xml);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Walk RSS <item> blocks, extract a plausible US oil rig total per item.
// US weekly rig counts run roughly 100-2000; we use that band to filter
// noise (dates, year-over-year deltas, percentage changes, etc.). Order of
// items in the feed is most-recent first, so the first two valid hits are
// "latest" and "prior".
function parseRigCountsFromRss(xml: string): number[] | null {
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const numRe = /\b([1-9]\d{2,3})\b/g; // 100..9999
  const counts: number[] = [];

  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && counts.length < 2) {
    const block = m[1].toLowerCase();
    // Strip CDATA + tags so the regex sees plain text
    const stripped = block
      .replace(/<!\[cdata\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ');
    let best: number | null = null;
    let nm: RegExpExecArray | null;
    while ((nm = numRe.exec(stripped)) !== null) {
      const n = parseInt(nm[1], 10);
      if (n >= 100 && n <= 2000) {
        // Prefer the largest plausible number in the block — rig totals tend
        // to dominate the description; year numbers (e.g. 2025) are filtered
        // out by the upper bound, percentages and small deltas by the lower.
        if (best === null || n > best) best = n;
      }
    }
    numRe.lastIndex = 0;
    if (best !== null) counts.push(best);
  }
  return counts.length === 2 ? counts : null;
}

async function fetchEiaRigCounts(): Promise<number[] | null> {
  const url =
    `https://api.eia.gov/v2/drilling/rigs/data/?api_key=${process.env.EIA_API_KEY ?? 'DEMO_KEY'}` +
    `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=3`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RIG_FETCH_TIMEOUT_MS);
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
    return values.length >= 2 ? values.slice(0, 2) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRigCountTrend(): Promise<RigCountTrend> {
  // Baker Hughes RSS first (no API key, public feed). Fall through to EIA
  // drilling endpoint if RSS fails or returns no parseable values. Either
  // way, FLAT is the safe default — the supply_bias derivation never reads
  // rig_count_trend, so a "wrong" FLAT can't propagate to a bad bias.
  let pair = await fetchBakerHughesRigCounts();
  if (!pair) pair = await fetchEiaRigCounts();
  if (!pair || pair.length < 2) return 'FLAT';
  const [latest, prior] = pair;
  if (latest > prior) return 'RISING';
  if (latest < prior) return 'FALLING';
  return 'FLAT';
}

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
  return safeEq(token, INTERNAL_API_KEY);
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

// Shared core: fetch EIA, derive the four fields, persist to market:context.
// Throws Error('eia_unavailable') if either feed is unreachable so the caller
// can decide how to surface the failure (POST returns 200 + error field; the
// Sunday cron logs and continues without blocking the weekly_bias response).
export async function fetchAndPersistSupplyContext(
  kvStore: typeof kv,
): Promise<void> {
  const [wstkValues, cushingValues] = await Promise.all([
    fetchEia(buildWstkUrl()),
    fetchEia(buildCushingUrl()),
  ]);
  if (wstkValues === null || cushingValues === null) {
    throw new Error('eia_unavailable');
  }
  const eia_4wk_trend = deriveEiaTrend(wstkValues);
  const cushing_vs_4wk = deriveCushingTrend(cushingValues);
  const rig_count_trend = await fetchRigCountTrend();
  const supply_bias = deriveSupplyBias(eia_4wk_trend, cushing_vs_4wk);
  const supplyContext: SupplyContext = {
    cushing_vs_4wk,
    eia_4wk_trend,
    rig_count_trend,
    supply_bias,
    updated_at: new Date().toISOString(),
  };
  const ctx = await readContext(kvStore);
  await writeContext(kvStore, { ...ctx, supply_context: supplyContext });
}

// GET — cached read. No EIA fetch, no rate-limit risk, safe to call on
// every page mount. Returns the last-persisted supply_context (or null
// if the route has never been triggered via POST).
export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const ctx = await readContext(kv);
    return NextResponse.json({ supply_context: ctx.supply_context ?? null });
  } catch (err) {
    console.error('[SUPPLY-CONTEXT] read failed', err);
    return NextResponse.json({ supply_context: null });
  }
}

// POST — fresh fetch. Hits EIA, derives the four fields, persists to
// market:context, returns the computed shape plus raw values. Use from
// settings page or a cron, not from page mounts.
export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const [wstkValues, cushingValues] = await Promise.all([
    fetchEia(buildWstkUrl()),
    fetchEia(buildCushingUrl()),
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
  const rig_count_trend = await fetchRigCountTrend();
  const supply_bias = deriveSupplyBias(eia_4wk_trend, cushing_vs_4wk);

  const supplyContext: SupplyContext = {
    cushing_vs_4wk,
    eia_4wk_trend,
    rig_count_trend,
    supply_bias,
    updated_at: new Date().toISOString(),
  };

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
