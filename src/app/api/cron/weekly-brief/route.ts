/**
 * CRUDE INTENTIONS — Sunday Weekly Brief Cron
 *
 * GET /api/cron/weekly-brief
 *   Auth: Authorization: Bearer ${CRON_SECRET} (Vercel cron default)
 *         or x-cron-secret: ${CRON_SECRET}
 *
 * Schedule: Sunday 20:00 UTC (configured in vercel.json).
 *
 * Pulls DXY / VIX / OVX / XLE quotes from Yahoo, asks ALFRED for a macro
 * read, and writes the result to market:context.weekly_bias.
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { kv } from '@/lib/kv';
import { safeEq } from '@/lib/auth/safe-compare';
import {
  readContext,
  writeContext,
  type WeeklyBrief,
  type BiasDirection,
  type BiasStrength,
} from '@/lib/market-memory/context';
import { fetchAndPersistSupplyContext } from '@/app/api/supply-context/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CRON_SECRET = process.env.CRON_SECRET;
const FETCH_TIMEOUT_MS = 8_000;

const TICKERS = {
  dxy: 'DX=F',
  vix: '%5EVIX',
  ovx: '%5EOVX',
  xle: 'XLE',
} as const;

const SYSTEM_PROMPT =
  'You are a macro market strategist briefing a CL futures trader for the upcoming week. ' +
  'You receive last-known quotes for DXY (dollar index), VIX (equity vol), OVX (oil vol), and XLE (energy ETF). ' +
  'Output ONLY valid JSON, no preamble, no markdown fences. Schema:\n' +
  '{\n' +
  '  "direction": "LONG" | "SHORT" | "NEUTRAL",\n' +
  '  "strength": "STRONG" | "MODERATE" | "WEAK",\n' +
  '  "rationale": "2-3 clinical sentences. No fluff.",\n' +
  '  "invalidation": "string describing what kills the bias, or null",\n' +
  '  "key_levels": { "resistance": [number, ...], "support": [number, ...] }\n' +
  '}\n\n' +
  'Reasoning rules: rising DXY weighs on CL; rising OVX = caution + wider stops; rising VIX = risk-off, often bearish CL; ' +
  'XLE direction confirms energy-equity alignment. Be direct.';

interface YahooMeta {
  regularMarketPrice?: number;
}

async function fetchPrice(symbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.8)' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { chart?: { result?: Array<{ meta?: YahooMeta }> } };
    const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === 'number' && Number.isFinite(price) ? price : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isAuthorised(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get('authorization');
  if (auth && auth.startsWith('Bearer ') && safeEq(auth.slice(7), CRON_SECRET)) return true;
  const direct = req.headers.get('x-cron-secret');
  if (direct && safeEq(direct, CRON_SECRET)) return true;
  return false;
}

interface AlfredBriefShape {
  direction?: string;
  strength?: string;
  rationale?: string;
  invalidation?: string | null;
  key_levels?: { resistance?: number[]; support?: number[] };
}

function normaliseDirection(s: unknown): BiasDirection {
  return s === 'LONG' || s === 'SHORT' ? s : 'NEUTRAL';
}

function normaliseStrength(s: unknown): BiasStrength {
  return s === 'STRONG' || s === 'MODERATE' ? s : 'WEAK';
}

function normaliseLevels(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((n) => (typeof n === 'number' ? n : Number.NaN))
    .filter((n) => Number.isFinite(n));
}

export async function GET(req: NextRequest) {
  // Public read path — no Bearer / x-cron-secret means dashboard polling.
  // Returns whatever the last cron run wrote, or null if never run.
  if (!isAuthorised(req)) {
    try {
      const ctx = await readContext(kv);
      return NextResponse.json({ weekly_bias: ctx.weekly_bias ?? null });
    } catch (err) {
      console.error('[WEEKLY-BRIEF] read failed', err);
      return NextResponse.json({ weekly_bias: null });
    }
  }

  // Authenticated GET = the Vercel cron firing → run the brief and persist.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY missing' }, { status: 500 });
  }

  const [dxy, vix, ovx, xle] = await Promise.all([
    fetchPrice(TICKERS.dxy),
    fetchPrice(TICKERS.vix),
    fetchPrice(TICKERS.ovx),
    fetchPrice(TICKERS.xle),
  ]);

  const userPrompt = [
    'Last-known quotes:',
    `  DXY: ${dxy ?? 'N/A'}`,
    `  VIX: ${vix ?? 'N/A'}`,
    `  OVX: ${ovx ?? 'N/A'}`,
    `  XLE: ${xle ?? 'N/A'}`,
    '',
    'Produce the weekly bias JSON.',
  ].join('\n');

  let parsed: AlfredBriefShape | null = null;
  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = res.content[0];
    const raw = block && block.type === 'text' ? block.text : '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]) as AlfredBriefShape;
  } catch (err) {
    console.error('[WEEKLY-BRIEF] ALFRED call failed:', err);
    return NextResponse.json({ error: 'alfred_unavailable' }, { status: 502 });
  }

  if (!parsed) {
    return NextResponse.json({ error: 'parse_failed' }, { status: 502 });
  }

  const brief: WeeklyBrief = {
    direction: normaliseDirection(parsed.direction),
    strength: normaliseStrength(parsed.strength),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 1000) : '',
    invalidation: typeof parsed.invalidation === 'string' ? parsed.invalidation.slice(0, 500) : null,
    key_levels: {
      resistance: normaliseLevels(parsed.key_levels?.resistance),
      support: normaliseLevels(parsed.key_levels?.support),
    },
    macro_inputs: { dxy, vix, ovx, xle },
    generated_at: new Date().toISOString(),
  };

  try {
    const ctx = await readContext(kv);
    await writeContext(kv, { ...ctx, weekly_bias: brief });
  } catch (err) {
    console.error('[WEEKLY-BRIEF] persist failed:', err);
    return NextResponse.json({ error: 'persist_failed' }, { status: 500 });
  }

  // Refresh supply context as part of the same cron run. A failure here
  // must not block the weekly-bias response from going out.
  let supply_context_refreshed = false;
  try {
    await fetchAndPersistSupplyContext(kv);
    supply_context_refreshed = true;
  } catch (err) {
    console.error('[CRON] Supply context refresh failed:', err);
  }

  return NextResponse.json({ ok: true, weekly_bias: brief, supply_context_refreshed });
}
