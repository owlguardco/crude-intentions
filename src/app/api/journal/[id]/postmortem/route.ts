import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { kv } from '@/lib/kv';
import type { CalibrationEntry } from '@/lib/journal/calibration';
import { safeEq } from '@/lib/auth/safe-compare';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type StoredJournalEntry = CalibrationEntry & {
  checklist?: Record<string, { result: string; detail: string }>;
  market_context_snapshot?: {
    price?: number;
    ema20?: number;
    ema50?: number;
    ema200?: number;
    rsi?: number;
    dxy?: string;
    vwap?: number;
  };
  weekly_bias?: string;
  postmortem?: string | null;
  postmortem_at?: string | null;
  notes?: string;
};

const POSTMORTEM_SYSTEM_PROMPT =
  'You are CRUDE INTENTIONS post-mortem analyst. You write exactly 3 sentences about a closed trade. No more, no less. Sentence 1: what the setup was and why it was taken (score, key confluences that passed). Sentence 2: what happened in the trade (outcome, R achieved, where price went). Sentence 3: one specific observation about execution quality or what this trade reveals about the current market regime. Be direct and clinical. No encouragement, no softening. Output plain text only — no JSON, no markdown.';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const apiKey = req.headers.get('x-api-key');
  if (!INTERNAL_API_KEY || !apiKey || !safeEq(apiKey, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const entries = (await kv.get<StoredJournalEntry[]>('journal:entries')) ?? [];
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: `Entry ${id} not found` }, { status: 400 });
  }

  const entry = entries[idx];
  const status = entry.outcome?.status;
  const isClosed = status === 'WIN' || status === 'LOSS' || status === 'SCRATCH';
  if (!isClosed) {
    return NextResponse.json({ error: 'Entry is not closed' }, { status: 400 });
  }

  const ctx = entry.market_context_snapshot ?? {};
  const checklist = entry.checklist ?? {};
  const ema = checklist.ema_stack_aligned;
  const fvgItem = checklist.price_at_key_level;

  const passes = Object.entries(checklist)
    .filter(([, v]) => v?.result === 'PASS')
    .map(([k]) => k.replace(/_/g, ' '));
  const fails = Object.entries(checklist)
    .filter(([, v]) => v?.result === 'FAIL')
    .map(([k]) => k.replace(/_/g, ' '));

  const openMs = Date.parse(entry.timestamp ?? '');
  const closeMs = entry.outcome.close_timestamp ? Date.parse(entry.outcome.close_timestamp) : NaN;
  const holdTime =
    Number.isFinite(openMs) && Number.isFinite(closeMs)
      ? (() => {
          const mins = Math.max(0, (closeMs - openMs) / 60_000);
          if (mins < 60) return `${Math.round(mins)} min`;
          return `${(mins / 60).toFixed(1)} h`;
        })()
      : 'N/A';

  const userLines = [
    `Direction: ${entry.direction}`,
    `Entry: ${entry.entry_price ?? 'N/A'}`,
    `Exit: ${entry.outcome.close_price ?? 'N/A'}`,
    `Outcome: ${status}`,
    `PnL (ticks): ${entry.outcome.result ?? 'N/A'}`,
    `R achieved: ${entry.outcome.result_r ?? 'N/A'}`,
    `Dollars: ${entry.outcome.result_dollars ?? 'N/A'}`,
    `Hold time: ${holdTime}`,
    `ALFRED score: ${entry.score}/12`,
    `ALFRED confidence: ${entry.confidence_label}`,
    `Session: ${entry.session}`,
    `Market bias: ${entry.weekly_bias ?? ctx.dxy ?? 'N/A'}`,
    `Confluences PASSED: ${passes.length ? passes.join(', ') : 'none'}`,
    `Confluences FAILED: ${fails.length ? fails.join(', ') : 'none'}`,
    `FVG proximity: ${fvgItem ? `${fvgItem.result} — ${fvgItem.detail}` : 'N/A'}`,
    `EMA alignment: ${ema ? `${ema.result} — ${ema.detail}` : 'N/A'}`,
    `RSI value: ${ctx.rsi ?? 'N/A'}`,
    entry.notes ? `Notes: ${entry.notes}` : null,
    entry.reasoning ? `Reasoning: ${entry.reasoning}` : null,
  ].filter(Boolean) as string[];

  let postmortem = '';
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: POSTMORTEM_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userLines.join('\n') }],
    });
    postmortem = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
  } catch (err) {
    console.error('[POSTMORTEM] Anthropic call failed:', err);
    return NextResponse.json({ error: 'Post-mortem generation failed' }, { status: 500 });
  }

  if (!postmortem) {
    return NextResponse.json({ error: 'Empty post-mortem returned' }, { status: 500 });
  }

  const postmortem_at = new Date().toISOString();
  entries[idx] = { ...entry, postmortem, postmortem_at };
  await kv.set('journal:entries', entries);

  return NextResponse.json({ postmortem, postmortem_at });
}
