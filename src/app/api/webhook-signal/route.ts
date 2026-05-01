import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { writeJournalEntry } from '@/lib/journal/writer';
import { scoreToConfidence } from '@/lib/alfred/confidence';
import { AdversarialScanSchema } from '@/lib/validation/journal-schema';
import { safeEq } from '@/lib/auth/safe-compare';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const DISCORD_BOT_SIGNAL_URL = process.env.DISCORD_BOT_SIGNAL_URL;

// ─── ALFRED v1.8 System Prompt (3-TF MTF architecture) ───────────────────────
const ALFRED_SYSTEM_PROMPT = `You are ALFRED — the analysis engine for CRUDE INTENTIONS v1.8.
You score CL futures setups against a 5-layer, 10-point A+ checklist using a
three-timeframe architecture: Daily/Weekly (macro bias) → 4H (setup zone) → 15min (entry trigger).

MINIMUM TO TRADE: 7/10. Below 7 = NO TRADE regardless of direction.
COUNTERTREND MINIMUM: 9/10. If direction opposes daily/weekly bias, require 9 or 10 to proceed.

A+ CHECKLIST — v1.8 (5 layers, 10 points):

Layer 1 — Daily/Weekly Bias [2 pts]:
  1. ema_stack_aligned: Daily EMA20/50/200 all pointing same direction AND weekly EMA200 slope agrees
  2. daily_confirms: Weekly bias set by Sunday agent confirms trade direction (LONG bias = only LONG setups, etc.)

Layer 2 — 4H Setup Zone [2 pts]:
  3. rsi_reset_zone: 4H RSI in reset zone (35–55 for longs, 45–65 for shorts) — momentum exhausted and ready
  4. macd_confirming: 4H MACD histogram turning in direction of trade

Layer 3 — Structure [2 pts]:
  5. price_at_key_level: Price inside 4H FVG zone OR at 4H EMA20 confluence — structural entry, not chase
  6. rr_valid: R/R valid at 2:1 minimum to TP1 with stop at 15min trigger candle structural level

Layer 4 — HTF Context [2 pts]:
  7. session_timing: NY Open (9:30–11:45 AM ET) or London exception (9/10 only, MCL size, no CL)
  8. eia_window_clear: NOT within EIA hard block window (Wed 7:30 AM–1:30 PM ET). Hard block overrides everything.

Layer 5 — 15min Trigger [2 pts]:
  9. vwap_aligned: Price above 15min VWAP for longs, below for shorts — OR bouncing off VWAP as S/R at entry
  10. htf_structure_clear: No major daily/weekly S/R level within 0.50 that caps trade before TP1

GRADING:
  10/10   = A+  — CONVICTION — full size
  8–9/10  = A   — HIGH — standard size
  7/10    = B+  — MEDIUM — standard to half size
  5–6/10  = B   — NO TRADE — below minimum
  0–4/10  = F   — NO TRADE — do not trade

HARD BLOCKS (override checklist regardless of score):
- EIA window active (Wed 7:30 AM–1:30 PM ET)
- OVX > 50
- Price not inside a mapped FVG zone or at EMA20

STOP PLACEMENT: Below the low of the 15min trigger candle (longs) or above the high (shorts).
Minimum stop: 15 ticks. Maximum stop: 40 ticks ($400/contract). Beyond 40 ticks = NO TRADE.

CONFIDENCE LABELS (emit exactly one):
  10/10 → CONVICTION
  8–9/10 → HIGH
  7/10 → MEDIUM
  ≤6/10 → LOW

You output ONLY valid JSON. No prose, no markdown fences, no preamble.

EXACT OUTPUT SCHEMA:
{
  "score": <integer 0–10>,
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
  "reasoning": "<2–3 sentence analysis>",
  "disclaimer": "This is AI-generated research for CL futures. You are responsible for all trading decisions."
}`;

// ─── Adversarial Scanner System Prompt ───────────────────────────────────────
const ADVERSARIAL_SYSTEM_PROMPT = `You are an adversarial trading analyst reviewing CL futures setups.
Your ONLY job is to find reasons this trade should be SKIPPED.
You are not here to validate the setup. You are here to attack it.

Review the setup for these red flags:
1. Trend alignment — is this trade fighting the 4H or daily trend?
2. FVG quality — is the gap live, weakened, or invalidated?
3. RSI context — is momentum actually reset or just drifting?
4. Timing risk — any macro event (EIA, FOMC, OPEC) within 4 hours?
5. OVX regime — is volatility elevated enough to hit the stop by noise alone?
6. R:R reality — does R:R hold after 2–3 tick entry slippage?
7. Recency bias — is entry driven by watching the level too long?
8. Score honesty — does the confluence score genuinely pass, or is it being rounded up?

Final verdict: PASS (no serious red flags), CONDITIONAL_PASS (valid if specific condition met), or SKIP (one or more red flags are disqualifying).

Output ONLY valid JSON. No prose, no markdown.

EXACT OUTPUT SCHEMA:
{
  "verdict": "PASS" | "CONDITIONAL_PASS" | "SKIP",
  "concerns": ["<concern 1>", "<concern 2>"],
  "override_note": null | "<what would change this verdict>"
}`;

// ─── Types ────────────────────────────────────────────────────────────────────
interface WebhookSignal {
  direction:       'LONG' | 'SHORT';
  price:           number;
  ema20:           number;
  ema50:           number;
  ema200:          number;
  rsi:             number;
  macd?:           number;
  vwap?:           number;
  ovx:             number;
  dxy:             string;
  fvg_direction:   string;
  fvg_top:         number;
  fvg_bottom:      number;
  fvg_age?:        number;
  session:         'NY_OPEN' | 'NY_AFTERNOON' | 'LONDON' | 'OVERLAP' | 'ASIA' | 'OFF_HOURS';
  weekly_bias?:    string;
  htf_resistance?: number;
  htf_support?:    number;
  eia_active:      boolean;
  timestamp?:      string;
}

interface ChecklistItem {
  label:  string;
  result: 'PASS' | 'FAIL';
  detail: string;
}

interface AlfredResult {
  score:            number;
  grade:            string;
  decision:         'LONG' | 'SHORT' | 'NO TRADE';
  confidence_label: string;
  checklist:        ChecklistItem[];
  blocked_reasons:  string[];
  wait_for:         string | null;
  reasoning:        string;
  disclaimer:       string;
}

// ─── Run ALFRED analysis ──────────────────────────────────────────────────────
async function runALFRED(signal: WebhookSignal) {
  const userPrompt = `Analyze this CL futures setup against the v1.8 A+ checklist:

SIGNAL SOURCE: TradingView 15min trigger candle inside 4H zone
Direction triggered: ${signal.direction}
Current price: ${signal.price}

MARKET DATA:
EMA20: ${signal.ema20} | EMA50: ${signal.ema50} | EMA200: ${signal.ema200}
4H RSI: ${signal.rsi}
4H MACD Histogram: ${signal.macd ?? 'not provided'}
VWAP (15min): ${signal.vwap ?? 'not provided'}
OVX: ${signal.ovx}
DXY Trend: ${signal.dxy}

4H FVG ZONE:
Direction: ${signal.fvg_direction}
Top: ${signal.fvg_top} | Bottom: ${signal.fvg_bottom}
Age (bars): ${signal.fvg_age ?? 'unknown'}

SESSION: ${signal.session}
Weekly Bias: ${signal.weekly_bias ?? 'not set'}
HTF Resistance above: ${signal.htf_resistance ?? 'not provided'}
HTF Support below: ${signal.htf_support ?? 'not provided'}
EIA window active: ${signal.eia_active ? 'YES — HARD BLOCK IN EFFECT' : 'NO'}

Score this setup against v1.8 checklist. Return JSON only.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: ALFRED_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── Run Adversarial Scanner ──────────────────────────────────────────────────
async function runAdversarialScan(signal: WebhookSignal, alfredResult: AlfredResult) {
  if (alfredResult.decision === 'NO TRADE') {
    return {
      verdict: 'SKIP' as const,
      concerns: ['ALFRED already scored this NO TRADE — adversarial scan skipped'],
      override_note: null,
    };
  }

  // F-4 — sanitize reasoning before interpolating into the adversarial
  // prompt: cap length, strip newlines, neutralise triple-backticks so a
  // crafted reasoning string can't escape the user-prompt context.
  const safeReasoning = (alfredResult.reasoning ?? '')
    .slice(0, 500)
    .replace(/[\r\n]+/g, ' ')
    .replace(/```/g, "'''");

  const userPrompt = `CL futures setup under review:

Direction: ${alfredResult.decision}
Entry zone: ${signal.fvg_direction} FVG ${signal.fvg_bottom}–${signal.fvg_top}
Current price: ${signal.price}
EMA20: ${signal.ema20} | VWAP: ${signal.vwap ?? 'N/A'}
RSI: ${signal.rsi} | OVX: ${signal.ovx} | DXY: ${signal.dxy}
Session: ${signal.session}
Confluence score: ${alfredResult.score}/10 (${alfredResult.grade})
ALFRED reasoning: ${safeReasoning}

Checklist summary:
${alfredResult.checklist.map((c: ChecklistItem) => `  ${c.result} — ${c.label}: ${c.detail}`).join('\n')}

Attack this setup. Find every reason to skip it. Return JSON only.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: ADVERSARIAL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  const clean = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  const validated = AdversarialScanSchema.safeParse(parsed);
  if (!validated.success) {
    console.error('[ADVERSARIAL] Schema validation failed:', validated.error);
    return { verdict: 'CONDITIONAL_PASS' as const, concerns: ['Adversarial scan output malformed — treat as conditional'], override_note: null };
  }
  return validated.data;
}

// ─── Map ALFRED checklist array → journal checklist object ───────────────────
function mapChecklistToObject(checklist: ChecklistItem[]) {
  const get = (label: string) =>
    checklist.find((c) => c.label === label) ?? { result: 'FAIL', detail: 'Not evaluated' };

  return {
    ema_stack_aligned:        { result: get('EMA Stack Aligned').result,   detail: get('EMA Stack Aligned').detail },
    daily_confirms:           { result: get('Daily Confirms').result,       detail: get('Daily Confirms').detail },
    rsi_reset_zone:           { result: get('RSI Reset Zone').result,       detail: get('RSI Reset Zone').detail },
    macd_confirming:          { result: get('MACD Confirming').result,      detail: get('MACD Confirming').detail },
    price_at_key_level:       { result: get('Price at Key Level').result,   detail: get('Price at Key Level').detail },
    rr_valid:                 { result: get('R/R Valid').result,            detail: get('R/R Valid').detail },
    session_timing:           { result: get('Session Timing').result,       detail: get('Session Timing').detail },
    eia_window_clear:         { result: get('EIA Window Clear').result,     detail: get('EIA Window Clear').detail },
    vwap_aligned:             { result: get('VWAP Aligned').result,         detail: get('VWAP Aligned').detail },
    htf_structure_clear:      { result: get('HTF Structure Clear').result,  detail: get('HTF Structure Clear').detail },
    volume_confirmed:         { result: 'FAIL' as const,                    detail: 'Not evaluated in v1.8' },
    overnight_range_position: { result: 'FAIL' as const,                    detail: 'Not evaluated in v1.8' },
    ovx_regime:               { result: 'FAIL' as const,                    detail: 'Not evaluated in v1.8' },
  } as const;
}

// ─── Notify Discord bot (fire and forget) ────────────────────────────────────
function notifyDiscordBot(payload: Record<string, unknown>): void {
  if (!DISCORD_BOT_SIGNAL_URL) return;
  fetch(DISCORD_BOT_SIGNAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(err => {
    console.warn('[Discord notify] failed (non-fatal):', err?.message ?? err);
  });
}

// ─── POST /api/webhook-signal ─────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // F-12 — constant-time comparison via safeEq.
  const authHeader = req.headers.get('x-api-key');
  if (!INTERNAL_API_KEY || !authHeader || !safeEq(authHeader, INTERNAL_API_KEY)) {
    console.error('[WEBHOOK] Unauthorized request — bad or missing x-api-key');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let signal: WebhookSignal;
  try {
    signal = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!signal.direction || !signal.price || !signal.session) {
    return NextResponse.json({ error: 'Missing required signal fields: direction, price, session' }, { status: 400 });
  }

  const receivedAt = new Date().toISOString();
  console.log(`[WEBHOOK] Signal received: ${signal.direction} @ ${signal.price} | ${signal.session} | ${receivedAt}`);

  try {
    const alfredResult: AlfredResult = await runALFRED(signal);
    console.log(`[ALFRED] Decision: ${alfredResult.decision} | Score: ${alfredResult.score}/10 | Grade: ${alfredResult.grade}`);

    const confidence_label = scoreToConfidence(alfredResult.score);
    alfredResult.confidence_label = confidence_label;

    const adversarialResult = await runAdversarialScan(signal, alfredResult);
    console.log(`[ADVERSARIAL] Verdict: ${adversarialResult.verdict}`);

    const journalPayload = {
      rules_version:    '1.8',
      session:          signal.session,
      direction:        alfredResult.decision,
      source:           'WEBHOOK' as const,
      score:            alfredResult.score,
      grade:            alfredResult.grade as 'A+' | 'A' | 'B+' | 'B' | 'F',
      confidence_label: confidence_label,
      entry_price:      alfredResult.decision !== 'NO TRADE' ? signal.price : null,
      stop_loss:        null,
      take_profit_1:    null,
      take_profit_2:    null,
      contracts:        null,
      risk_dollars:     null,
      checklist:        mapChecklistToObject(alfredResult.checklist),
      blocked_reasons:  alfredResult.blocked_reasons ?? [],
      wait_for:         alfredResult.wait_for ?? null,
      reasoning:        alfredResult.reasoning,
      market_context_snapshot: {
        price:  signal.price,
        ema20:  signal.ema20,
        ema50:  signal.ema50,
        ema200: signal.ema200,
        rsi:    signal.rsi,
        ovx:    signal.ovx,
        dxy:    signal.dxy,
        ...(signal.vwap ? { vwap: signal.vwap } : {}),
      },
      adversarial_verdict: adversarialResult.verdict,
      adversarial_notes:   adversarialResult.concerns.join(' | '),
      paper_trading:       true,
    };

    const journalWrite = await writeJournalEntry(journalPayload);
    console.log(`[JOURNAL] Auto-wrote entry: ${journalWrite.id}`);

    // Notify Discord bot — fire and forget, never blocks response
    notifyDiscordBot({
      direction:           signal.direction,
      price:               signal.price,
      score:               alfredResult.score,
      grade:               alfredResult.grade,
      decision:            alfredResult.decision,
      confidence_label:    confidence_label,
      reasoning:           alfredResult.reasoning,
      adversarial_verdict: adversarialResult.verdict,
      journal_id:          journalWrite.id,
      received_at:         receivedAt,
    });

    // F-11 — drop the raw caller-supplied `signal` from the response so
    // an attacker probing this endpoint can't read it back. alfred +
    // adversarial + journal blocks already cover what a legitimate
    // caller needs.
    return NextResponse.json({
      received_at: receivedAt,
      alfred: {
        ...alfredResult,
        confidence_label,
      },
      adversarial: adversarialResult,
      journal: {
        id:             journalWrite.id,
        integrity_hash: journalWrite.integrity_hash,
        auto_logged:    true,
      },
    });

  } catch (err: unknown) {
    // F-7 — log the raw error server-side, return a generic message.
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[webhook-signal] processing error:', message);
    return NextResponse.json({ error: 'Signal processing failed' }, { status: 500 });
  }
}
