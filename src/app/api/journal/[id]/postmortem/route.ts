import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { kv } from '@/lib/kv';
import type { CalibrationEntry } from '@/lib/journal/calibration';

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
  notes?: string;
};

const POSTMORTEM_SYSTEM_PROMPT =
  'You are ALFRED, a crude oil trading analyst. Given a closed trade, write a 3-sentence post-mortem. Sentence 1: what the setup was and why it was taken. Sentence 2: what happened and why the outcome occurred. Sentence 3: one concrete rule or adjustment to apply next time. Be direct and specific. No preamble.';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey || apiKey !== process.env.INTERNAL_API_KEY) {
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

  const userLines = [
    `Direction: ${entry.direction}`,
    `Entry: ${entry.entry_price ?? 'N/A'}`,
    `Exit: ${entry.outcome.close_price ?? 'N/A'}`,
    `Outcome: ${status}`,
    `PnL (ticks): ${entry.outcome.result ?? 'N/A'}`,
    `ALFRED score: ${entry.score}/10`,
    `ALFRED confidence: ${entry.confidence_label}`,
    `ALFRED factors: ${JSON.stringify(checklist)}`,
    `Session: ${entry.session}`,
    `Market bias: ${entry.weekly_bias ?? ctx.dxy ?? 'N/A'}`,
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

  entries[idx] = { ...entry, postmortem };
  await kv.set('journal:entries', entries);

  return NextResponse.json({ postmortem });
}
