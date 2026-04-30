import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { scoreToConfidence } from '@/lib/alfred/confidence';
import {
  runFallbackScorer,
  type FallbackScorerInput,
} from '@/lib/alfred/fallback-scorer';
import { kv } from '@/lib/kv';
import { readContext, buildMarketMemoryPromptSection } from '@/lib/market-memory/context';
import {
  getPredictedAccuracy,
  type CalibrationSnapshot,
  type CalibrationEntry,
} from '@/lib/journal/calibration';
import { computeMTFConsensus } from '@/lib/alfred/mtf-consensus';
import { computeEntryAlignment } from '@/lib/mtf/consensus';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// ─── Input validation schema (SECURITY.md Phase 1 clearance) ─────────────────
const SetupInputSchema = z.object({
  price:  z.number().finite().min(10).max(500),
  ema20:  z.number().finite().min(10).max(500),
  ema50:  z.number().finite().min(10).max(500),
  ema200: z.number().finite().min(10).max(500),
  rsi:  z.number().finite().min(0).max(100),
  triggerVolume: z.number().finite().min(0).max(1_000_000_000).optional(),
  avgVolume:     z.number().finite().min(0).max(1_000_000_000).optional(),
  ovx: z.number().finite().min(0).max(300),
  dxy: z.enum(['rising', 'falling', 'flat', 'neutral']),
  fvg:       z.enum(['bullish', 'bearish', 'none']),
  fvgTop:    z.number().finite().min(10).max(500).optional(),
  fvgBottom: z.number().finite().min(10).max(500).optional(),
  fvgAge:    z.number().int().min(0).max(1000).optional(),
  session: z.enum(['NY_OPEN', 'NY_AFTERNOON', 'LONDON', 'OVERLAP', 'ASIA', 'OFF_HOURS']),
  vwap:          z.number().finite().min(10).max(500).optional(),
  htfResistance: z.number().finite().min(10).max(500).optional(),
  htfSupport:    z.number().finite().min(10).max(500).optional(),
  weeklyBias:    z.enum(['LONG', 'SHORT', 'NEUTRAL']).optional(),
  eiaActive:     z.boolean().optional(),
  mtf_signals: z.array(z.object({
    timeframe: z.enum(['1H', '4H', 'D']),
    ema_aligned: z.boolean(),
    rsi_value: z.number().finite().min(0).max(100),
    above_vwap: z.boolean().nullable(),
    trend: z.enum(['UP', 'DOWN', 'NEUTRAL']),
  })).min(1).max(3).optional(),
  htf_ema_stack:   z.enum(['BULLISH', 'BEARISH', 'MIXED']).optional(),
  setup_ema_stack: z.enum(['BULLISH', 'BEARISH', 'MIXED']).optional(),
}).strict();

// ─── ALFRED response shape (F-5) ──────────────────────────────────────────────
// Strict-validate the parsed ALFRED JSON before echoing to the client. A
// jailbroken or malformed model response (extra keys, prototype pollution,
// out-of-vocabulary enum values) fails validation and we fall through to
// the deterministic fallback scorer instead of round-tripping the raw object.
const AlfredResponseSchema = z.object({
  score: z.number().int().min(0).max(10),
  grade: z.enum(['A+', 'A', 'B+', 'B', 'F']),
  decision: z.enum(['LONG', 'SHORT', 'NO TRADE']),
  confidence_label: z.enum(['CONVICTION', 'HIGH', 'MEDIUM', 'LOW']),
  checklist: z.array(z.object({
    label: z.string().min(1).max(100),
    result: z.enum(['PASS', 'FAIL']),
    detail: z.string().min(1).max(500),
  })).min(1).max(20),
  blocked_reasons: z.array(z.string().max(300)).default([]),
  wait_for: z.string().max(500).nullable().default(null),
  reasoning: z.string().min(1).max(2000),
  disclaimer: z.string().max(500).optional(),
}).strict();

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
  4. volume_confirmed: 15-min trigger candle volume >= 20-bar session average — institutional participation present

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

VOLUME RULES:
- PASS: trigger candle volume >= 1.0x the 20-bar average for that session
- CONDITIONAL: volume 0.85x-0.99x average — note as weak in detail, do not auto-fail, reduce conviction
- FAIL: volume below 0.85x average — thin move, no institutional footprint

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
    {"label": "Volume Confirmed",    "result": "PASS"|"FAIL", "detail": "string"},
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
  const rl = await checkRateLimit('analyze-setup:global', 30, 60);
  const rlHeaders = rateLimitHeaders(rl);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded — 30 requests per minute maximum' },
      { status: 429, headers: rlHeaders },
    );
  }
  const auth = req.headers.get('x-api-key');
  if (!INTERNAL_API_KEY || auth !== INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: rlHeaders });
  }
  try {
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 10 * 1024) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413, headers: rlHeaders });
    }

    const body = await req.json();

    const parsed = SetupInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400, headers: rlHeaders },
      );
    }

    const d = parsed.data;

    const mtf_consensus =
      d.mtf_signals && d.mtf_signals.length > 0
        ? computeMTFConsensus(d.mtf_signals)
        : undefined;

    const marketContext = await readContext(kv);
    const marketMemorySection = buildMarketMemoryPromptSection(marketContext);

    const userPrompt = `Analyze this CL futures setup against the v1.8 A+ checklist:

Price: ${d.price}
EMA20: ${d.ema20} | EMA50: ${d.ema50} | EMA200: ${d.ema200}
RSI 14: ${d.rsi}
Trigger Candle Volume: ${d.triggerVolume ?? 'not provided'}
Avg Volume (20-bar): ${d.avgVolume ?? 'not provided'}
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

    // Build the fallback-scorer input once so we can use it on outage.
    const fallbackInput: FallbackScorerInput = {
      price: d.price,
      ema20: d.ema20,
      ema50: d.ema50,
      ema200: d.ema200,
      rsi: d.rsi,
      trigger_volume: d.triggerVolume,
      avg_volume: d.avgVolume,
      vwap: d.vwap,
      ovx: d.ovx,
      dxy: d.dxy,
      fvg_direction: d.fvg,
      fvg_top: d.fvgTop,
      fvg_bottom: d.fvgBottom,
      session: d.session,
      weekly_bias: d.weeklyBias ?? 'NEUTRAL',
      eia_active: d.eiaActive ?? false,
    };

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: SYSTEM_PROMPT + '\n\n' + marketMemorySection,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const raw = response.content[0].type === 'text' ? response.content[0].text : '';
      const clean = raw.replace(/```json|```/g, '').trim();
      let parsedAlfred: unknown;
      try {
        parsedAlfred = JSON.parse(clean);
      } catch {
        throw new Error('ALFRED returned non-JSON');
      }

      // Override confidence_label from score so the schema's enum check
      // catches model drift even when ALFRED itself returned a stale label.
      if (
        parsedAlfred && typeof parsedAlfred === 'object' &&
        typeof (parsedAlfred as Record<string, unknown>).score === 'number'
      ) {
        (parsedAlfred as Record<string, unknown>).confidence_label =
          scoreToConfidence((parsedAlfred as { score: number }).score);
      }

      const validated = AlfredResponseSchema.safeParse(parsedAlfred);
      if (!validated.success) {
        console.error('[ANALYZE-SETUP] ALFRED response failed schema validation:', validated.error.flatten());
        throw new Error('ALFRED response failed schema validation');
      }
      const result = { ...validated.data, fallback: false };

      // Append predicted accuracy from calibration history (null until first trade closes)
      let predicted_accuracy = null;
      try {
        const snapshot = await kv.get<CalibrationSnapshot>('calibration:latest');
        if (snapshot) {
          const allEntries = (await kv.get<CalibrationEntry[]>('journal:entries')) ?? [];
          const closedEntries = allEntries.filter(
            (e) =>
              e.outcome?.status === 'WIN' ||
              e.outcome?.status === 'LOSS' ||
              e.outcome?.status === 'SCRATCH'
          );
          predicted_accuracy = getPredictedAccuracy(
            {
              score: result.score as number,
              grade: result.grade as string,
              confidence_label: result.confidence_label as string,
              session: d.session,
            },
            snapshot,
            closedEntries
          );
        }
      } catch (calibErr) {
        console.warn('[ANALYZE-SETUP] Calibration read skipped:', calibErr);
      }

      const entry_alignment =
        d.htf_ema_stack && d.setup_ema_stack
          ? computeEntryAlignment({
              htf_ema_stack: d.htf_ema_stack,
              setup_ema_stack: d.setup_ema_stack,
              trigger_direction: result.decision as 'LONG' | 'SHORT' | 'NO TRADE',
            })
          : undefined;

      return NextResponse.json({
        ...result,
        predicted_accuracy,
        ...(mtf_consensus ? { mtf_consensus } : {}),
        ...(entry_alignment ? { entry_alignment } : {}),
      }, { headers: rlHeaders });
    } catch (alfredErr) {
      console.error('[ALFRED FALLBACK] Anthropic unreachable, using fallback scorer:', alfredErr);
      const fallbackResult = runFallbackScorer(fallbackInput);
      const entry_alignment =
        d.htf_ema_stack && d.setup_ema_stack
          ? computeEntryAlignment({
              htf_ema_stack: d.htf_ema_stack,
              setup_ema_stack: d.setup_ema_stack,
              trigger_direction: fallbackResult.decision as 'LONG' | 'SHORT' | 'NO TRADE',
            })
          : undefined;
      return NextResponse.json({
        ...fallbackResult,
        ...(mtf_consensus ? { mtf_consensus } : {}),
        ...(entry_alignment ? { entry_alignment } : {}),
      }, { headers: rlHeaders });
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[ANALYZE-SETUP] Error:', message);
    return NextResponse.json({ error: 'Analysis failed. Please try again.' }, { status: 500, headers: rlHeaders });
  }
}