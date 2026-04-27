import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { scoreToConfidence } from '@/lib/alfred/confidence';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Input validation schema (SECURITY.md Phase 1 clearance) ─────────────────
const SetupInputSchema = z.object({
  // Price fields — CL realistic range
  price:  z.number().finite().min(10).max(500),
  ema20:  z.number().finite().min(10).max(500),
  ema50:  z.number().finite().min(10).max(500),
  ema200: z.number().finite().min(10).max(500),

  // Oscillators
  rsi:  z.number().finite().min(0).max(100),
  macd: z.number().finite().min(-100).max(100).optional(),

  // Market conditions
  ovx: z.number().finite().min(0).max(300),
  dxy: z.enum(['rising', 'falling', 'flat', 'neutral']),

  // FVG
  fvg:       z.enum(['bullish', 'bearish', 'none']),
  fvgTop:    z.number().finite().min(10).max(500).optional(),
  fvgBottom: z.number().finite().min(10).max(500).optional(),
  fvgAge:    z.number().int().min(0).max(1000).optional(),

  // Session
  session: z.enum(['NY_OPEN', 'NY_AFTERNOON', 'LONDON', 'OVERLAP', 'ASIA', 'OFF_HOURS']),

  // Optional context
  vwap:          z.number().finite().min(10).max(500).optional(),
  htfResistance: z.number().finite().min(10).max(500).optional(),
  htfSupport:    z.number().finite().min(10).max(500).optional(),

  // 3-TF additions (v1.8)
  weeklyBias:    z.enum(['LONG', 'SHORT', 'NEUTRAL']).optional(),
  eiaActive:     z.boolean().optional(),
}).strict(); // rejects extra fields

// ─── ALFRED v1.8 System Prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are ALFRED — the analysis engine for CRUDE INTENTIONS v1.8.
You score CL futures setups against a 5-layer, 10-point A+ checklist.
Three-timeframe architecture: Daily/Weekly (macro bias) → 4H (setup zone) → 15min (entry trigger).

MINIMUM TO TRADE: 7/10. Below 7 = NO TRADE.
COUNTERTREND MINIMUM: 9/10 required if opposing weekly bias.

A+ CHECKLIST — v1.8:
Layer 1 [Daily/Weekly — 2 pts]:
  1. ema_stack_aligned: Daily EMA20/50/200 aligned + weekly EMA200 slope agrees
  2. daily_confirms: Weekly bias confirms direction

Layer 2 [4H Momentum — 2 pts]:
  3. rsi_reset_zone: 4H RSI 35–55 (longs) or 45–65 (shorts)
  4. macd_confirming: 4H MACD histogram turning in trade direction

Layer 3 [Structure — 2 pts]:
  5. price_at_key_level: Price inside 4H FVG or at 4H EMA20
  6. rr_valid: 2:1 minimum R/R to TP1 with stop at 15min structural level

Layer 4 [HTF Context — 2 pts]:
  7. session_timing: NY Open 9:30–11:45 AM ET (primary)
  8. eia_window_clear: NOT within EIA hard block (Wed 7:30 AM–1:30 PM ET)

Layer 5 [15min Trigger — 2 pts]:
  9. vwap_aligned: Above VWAP for longs, below for shorts
  10. htf_structure_clear: No daily/weekly S/R within 0.50 capping the trade

GRADING: 10=A+, 8–9=A, 7=B+, 5–6=B, 0–4=F
CONFIDENCE: 10→CONVICTION, 8–9→HIGH, 7→MEDIUM, ≤6→LOW

HARD BLOCKS (override all scores): EIA window active, OVX > 50

Output ONLY valid JSON. No preamble, no markdown fences.

SCHEMA:
{
  "score": <0–10>,
  "grade": "A+" | "A" | "B+" | "B" | "F",
  "decision": "LONG" | "SHORT" | "NO TRADE",
  "confidence_label": "CONVICTION" | "HIGH" | "MEDIUM" | "LOW",
  "checklist": [
    {"label": "EMA Stack Aligned",   "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Daily Confirms",      "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "RSI Reset Zone",      "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "MACD Confirming",     "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Price at Key Level",  "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "R/R Valid",           "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Session Timing",      "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "EIA Window Clear",    "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "VWAP Aligned",        "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "HTF Structure Clear", "result": "PASS"|"FAIL", "detail": "string"}
  ],
  "blocked_reasons": [],
  "wait_for": null,
  "reasoning": "2–3 sentence analysis",
  "disclaimer": "This is AI-generated research for CL futures. You are responsible for all trading decisions."
}`;

// ─── POST /api/analyze-setup ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    // ── Request size guard ─────────────────────────────────────────────────
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 10 * 1024) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    const body = await req.json();

    // ── Zod validation ────────────────────────────────────────────────────
    const parsed = SetupInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const d = parsed.data;

    const userPrompt = `Analyze this CL futures setup against the v1.8 A+ checklist:

Price: ${d.price}
EMA20: ${d.ema20} | EMA50: ${d.ema50} | EMA200: ${d.ema200}
RSI 14: ${d.rsi}
MACD Histogram: ${d.macd ?? 'not provided'}
OVX: ${d.ovx}
DXY Trend: ${d.dxy}
FVG: Direction=${d.fvg}, Top=${d.fvgTop ?? 'N/A'}, Bottom=${d.fvgBottom ?? 'N/A'}, Age=${d.fvgAge ?? 'N/A'} bars
Session: ${d.session}
VWAP: ${d.vwap ?? 'not provided'}
HTF Resistance above: ${d.htfResistance ?? 'not provided'}
HTF Support below: ${d.htfSupport ?? 'not provided'}
Weekly Bias: ${d.weeklyBias ?? 'not set'}
EIA Window Active: ${d.eiaActive ? 'YES — HARD BLOCK IN EFFECT' : 'NO'}

Score this setup. Return JSON only.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text : '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // Enforce confidence label from our pure function (guards against model drift)
    result.confidence_label = scoreToConfidence(result.score);

    return NextResponse.json(result);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[ANALYZE-SETUP] Error:', message);
    return NextResponse.json({ error: 'Analysis failed. Please try again.' }, { status: 500 });
  }
}
