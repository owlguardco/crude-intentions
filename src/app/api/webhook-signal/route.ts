import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { scoreToConfidence } from '@/lib/alfred/confidence';
import { AdversarialScanSchema } from '@/lib/validation/journal-schema';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const ALFRED_SYSTEM_PROMPT = `You are ALFRED — the analysis engine for CRUDE INTENTIONS v1.8.
You score CL futures setups against a 5-layer, 10-point A+ checklist using a
three-timeframe architecture: Daily/Weekly (macro bias) → 4H (setup zone) → 15min (entry trigger).

MINIMUM TO TRADE: 7/10. Below 7 = NO TRADE regardless of direction.
COUNTERTREND MINIMUM: 9/10. If direction opposes daily/weekly bias, require 9 or 10 to proceed.

A+ CHECKLIST — v1.8 (5 layers, 10 points):

Layer 1 — Daily/Weekly Bias [2 pts]:
  1. ema_stack_aligned: Daily EMA20/50/200 all pointing same direction AND weekly EMA200 slope agrees
  2. daily_confirms: Weekly bias set by Sunday agent confirms trade direction

Layer 2 — 4H Setup Zone [2 pts]:
  3. rsi_reset_zone: 4H RSI in reset zone (35-55 for longs, 45-65 for shorts)
  4. macd_confirming: 4H MACD histogram turning in direction of trade

Layer 3 — Structure [2 pts]:
  5. price_at_key_level: Price inside 4H FVG zone OR at 4H EMA20 confluence
  6. rr_valid: R/R valid at 2:1 minimum to TP1 with stop at 15min trigger candle structural level

Layer 4 — HTF Context [2 pts]:
  7. session_timing: NY Open (9:30-11:45 AM ET) or London exception (9/10 only, MCL size, no CL)
  8. eia_window_clear: NOT within EIA hard block window (Wed 7:30 AM-1:30 PM ET).

Layer 5 — 15min Trigger [2 pts]:
  9. vwap_aligned: Price above 15min VWAP for longs, below for shorts
  10. htf_structure_clear: No major daily/weekly S/R level within 0.50 that caps trade before TP1

GRADING: 10=A+ CONVICTION, 8-9=A HIGH, 7=B+ MEDIUM, 5-6=B NO TRADE, 0-4=F NO TRADE
HARD BLOCKS: EIA window active, OVX > 50

You output ONLY valid JSON. No prose, no markdown fences, no preamble.

EXACT OUTPUT SCHEMA:
{
  "score": <integer 0-10>,
  "grade": "A+" | "A" | "B+" | "B" | "F",
  "decision": "LONG" | "SHORT" | "NO TRADE",
  "confidence_label": "CONVICTION" | "HIGH" | "MEDIUM" | "LOW",
  "checklist": [
    {"label": "EMA Stack Aligned",   "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "Daily Confirms",      "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "RSI Reset Zone",      "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "MACD Confirming",     "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "Price at Key Level",  "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "R/R Valid",           "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "Session Timing",      "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "EIA Window Clear",    "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "VWAP Aligned",        "result": "PASS"|"FAIL", "detail": "<brief>"},
    {"label": "HTF Structure Clear", "result": "PASS"|"FAIL", "detail": "<brief>"}
  ],
  "blocked_reasons": [],
  "wait_for": null,
  "reasoning": "<2-3 sentence analysis>",
  "disclaimer": "AI-generated research only. You are responsible for all trading decisions."
}`;

const ADVERSARIAL_SYSTEM_PROMPT = `You are an adversarial trading analyst reviewing CL futures setups.
Your ONLY job is to find reasons this trade should be SKIPPED.
Check: trend alignment, FVG quality, RSI context, macro timing, OVX regime, R:R after slippage, recency bias, score honesty.
Verdict: PASS (no red flags), CONDITIONAL_PASS (valid if condition met), SKIP (disqualifying red flag).
Output ONLY valid JSON: {"verdict":"PASS"|"CONDITIONAL_PASS"|"SKIP","concerns":["string"],"override_note":null}`;

interface WebhookSignal {
  direction: 'LONG' | 'SHORT';
  price: number; ema20: number; ema50: number; ema200: number;
  rsi: number; macd?: number; vwap?: number; ovx: number; dxy: string;
  fvg_direction: string; fvg_top: number; fvg_bottom: number; fvg_age?: number;
  session: 'NY_OPEN' | 'NY_AFTERNOON' | 'LONDON' | 'OVERLAP' | 'ASIA' | 'OFF_HOURS';
  weekly_bias?: string; htf_resistance?: number; htf_support?: number; eia_active: boolean;
}
interface ChecklistItem { label: string; result: 'PASS' | 'FAIL'; detail: string; }
interface AlfredResult {
  score: number; grade: string; decision: 'LONG' | 'SHORT' | 'NO TRADE';
  confidence_label: string; checklist: ChecklistItem[];
  blocked_reasons: string[]; wait_for: string | null; reasoning: string; disclaimer: string;
}

async function runALFRED(signal: WebhookSignal): Promise<AlfredResult> {
  const prompt = `Analyze this CL setup against v1.8 checklist:
Direction: ${signal.direction} | Price: ${signal.price}
EMA20: ${signal.ema20} EMA50: ${signal.ema50} EMA200: ${signal.ema200}
RSI: ${signal.rsi} | MACD: ${signal.macd ?? 'N/A'} | VWAP: ${signal.vwap ?? 'N/A'}
OVX: ${signal.ovx} | DXY: ${signal.dxy}
FVG: ${signal.fvg_direction} ${signal.fvg_bottom}-${signal.fvg_top}
Session: ${signal.session} | Weekly bias: ${signal.weekly_bias ?? 'not set'}
EIA active: ${signal.eia_active ? 'YES HARD BLOCK' : 'NO'}
Return JSON only.`;
  const res = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 1000,
    system: ALFRED_SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }],
  });
  const raw = res.content[0].type === 'text' ? res.content[0].text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in ALFRED response');
  return JSON.parse(match[0]);
}

async function runAdversarialScan(signal: WebhookSignal, alfred: AlfredResult) {
  if (alfred.decision === 'NO TRADE') {
    return { verdict: 'SKIP' as const, concerns: ['ALFRED scored NO TRADE'], override_note: null };
  }
  const prompt = `CL setup: ${alfred.decision} @ ${signal.price} | Score: ${alfred.score}/10
FVG ${signal.fvg_bottom}-${signal.fvg_top} | RSI: ${signal.rsi} | OVX: ${signal.ovx}
Reasoning: ${alfred.reasoning}
Attack this setup. Return JSON only.`;
  const res = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 600,
    system: ADVERSARIAL_SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }],
  });
  const raw = res.content[0].type === 'text' ? res.content[0].text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in adversarial response');
  const parsed = JSON.parse(match[0]);
  const v = AdversarialScanSchema.safeParse(parsed);
  return v.success ? v.data : { verdict: 'CONDITIONAL_PASS' as const, concerns: ['Scan malformed'], override_note: null };
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('x-api-key');
  if (!INTERNAL_API_KEY || auth !== INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let signal: WebhookSignal;
  try { signal = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!signal.direction || !signal.price || !signal.session) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  const receivedAt = new Date().toISOString();
  try {
    const alfred = await runALFRED(signal);
    alfred.confidence_label = scoreToConfidence(alfred.score);
    const adversarial = await runAdversarialScan(signal, alfred);
    const journalId = `CI-${new Date().toISOString().slice(0, 10)}-LIVE`;
    return NextResponse.json({
      received_at: receivedAt, signal,
      alfred: { ...alfred },
      adversarial,
      journal: { id: journalId, auto_logged: false, note: 'Persistent journal requires Vercel KV — Phase 2B+' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[WEBHOOK] Error:', message);
    return NextResponse.json({ error: 'Signal processing failed', detail: message }, { status: 500 });
  }
}