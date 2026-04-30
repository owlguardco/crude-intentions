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
import { buildFundamentalContext } from '@/lib/fundamental-scorer';
import { safeEq } from '@/lib/auth/safe-compare';

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
  // v1.9 Layer 6 inputs
  asiaHigh:        z.number().finite().min(10).max(500).optional(),
  asiaLow:         z.number().finite().min(10).max(500).optional(),
  // Fundamental layer inputs (optional — pre-computed upstream, no LLM cost)
  m4Price:           z.number().finite().min(10).max(500).optional(),
  inventoryZScore:   z.number().finite().min(-10).max(10).nullable().optional(),
  momentum20:        z.number().finite().min(-1).max(1).nullable().optional(),
  crackSpread321:    z.number().finite().min(-50).max(100).nullable().optional(),
  month:             z.number().int().min(1).max(12).optional(),
  volumeRatio:       z.number().finite().min(0).max(50).optional(),
  triggerCandleConfirmed: z.boolean().optional(),
}).strict();

// ─── ALFRED response shape (F-5) ──────────────────────────────────────────────
// Strict-validate the parsed ALFRED JSON before echoing to the client. A
// jailbroken or malformed model response (extra keys, prototype pollution,
// out-of-vocabulary enum values) fails validation and we fall through to
// the deterministic fallback scorer instead of round-tripping the raw object.
const AlfredResponseSchema = z.object({
  score: z.number().int().min(0).max(12),
  grade: z.enum(['A+', 'A', 'B+', 'B', 'F']),
  decision: z.enum(['LONG', 'SHORT', 'NO TRADE']),
  confidence_label: z.enum(['CONVICTION', 'HIGH', 'MEDIUM', 'LOW']),
  checklist: z.array(z.object({
    label: z.string().min(1).max(100),
    // v1.9: items 11-12 may emit CONDITIONAL/N/A in addition to PASS/FAIL.
    result: z.enum(['PASS', 'FAIL', 'CONDITIONAL', 'N/A']),
    detail: z.string().min(1).max(500),
  })).min(1).max(20),
  blocked_reasons: z.array(z.string().max(300)).default([]),
  wait_for: z.string().max(500).nullable().default(null),
  reasoning: z.string().min(1).max(2000),
  disclaimer: z.string().max(500).optional(),
}).strict();

// ─── ALFRED v1.9 System Prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are ALFRED — the analysis engine for CRUDE INTENTIONS v1.9.
You score CL futures setups against a 6-layer, 12-point A+ checklist.
Three-timeframe architecture: Daily/Weekly (macro bias) → 4H (setup zone) → 15min (entry trigger).

MINIMUM TO TRADE: 9/12. Below 9 = NO TRADE.
COUNTERTREND MINIMUM: 11/12 required if opposing weekly bias.

A+ CHECKLIST — v1.9:
Layer 1 [Daily/Weekly — 2 pts]:
  1. ema_stack_aligned: Daily EMA20/50/200 aligned + weekly EMA200 slope agrees
  2. daily_confirms: Weekly bias confirms direction

Layer 2 [4H Momentum — 2 pts]:
  3. rsi_reset_zone: 4H RSI 35–55 (longs) or 45–65 (shorts)
  4. volume_confirmed: 15-min trigger candle volume >= 20-bar session average — institutional participation present

Layer 3 [Structure — 2 pts]:
  5. price_at_key_level: FVG structural entry — unfilled 4H FVG exists and price is inside it or within 0.10 of its edge. FVG must be unmitigated and under 75 bars old. EMA20/round-level proximity boost quality but do NOT alone pass this point.
  6. rr_valid: 2:1 minimum R/R to TP1 with stop at 15min structural level

Layer 4 [HTF Context — 2 pts]:
  7. session_timing: NY Open 9:30–11:45 AM ET (primary)
  8. eia_window_clear: NOT within EIA hard block (Wed 7:30 AM–1:30 PM ET)

Layer 5 [15min Trigger — 2 pts]:
  9. vwap_aligned: Above VWAP for longs, below for shorts
  10. htf_structure_clear: No daily/weekly S/R within 0.50 capping the trade

Layer 6 [Session Context — 2 pts] (v1.9 add):
  11. overnight_range_position: price above Asia session high for longs / below Asia session low for shorts at NY open
  12. ovx_regime: OVX 20-35 = PASS, 35-50 = CONDITIONAL, above 50 or below 20 = FAIL

GRADING:
  12/12     = A+ — Full size, take the trade
  10-11/12  = A  — Standard size, take the trade
  9/12      = B+ — Standard to half size
  7-8/12    = B  — Half size or skip
  0-6/12    = F  — NO TRADE

CONFIDENCE: 12→CONVICTION, 10-11→HIGH, 9→MEDIUM, ≤8→LOW

HARD BLOCKS (override all scores): EIA window active, OVX > 50

VOLUME RULES:
- PASS: trigger candle volume >= 1.0x the 20-bar average for that session
- CONDITIONAL: volume 0.85x-0.99x average — note as weak in detail, do not auto-fail, reduce conviction
- FAIL: volume below 0.85x average — thin move, no institutional footprint

OVERNIGHT RANGE RULES:
- PASS (longs): price above Asia session high at NY open
- PASS (shorts): price below Asia session low at NY open
- CONDITIONAL: price within 0.15 of Asia range edge in trade direction — note, reduce conviction
- FAIL: price in middle of range, more than 0.15 from both extremes

OVX REGIME RULES:
- PASS: OVX 20-35 — clean regime
- CONDITIONAL: OVX 35-50 — elevated, size down
- FAIL: OVX above 50 (hard block) or below 20 (choppy)

FVG SCORING RULES (item 5, price_at_key_level):
- PASS: price inside the 4H FVG or within 0.10 of the relevant edge (top of bullish FVG for longs, bottom of bearish FVG for shorts), gap unmitigated, FVG age < 75 bars
- CONDITIONAL: price within 0.20 of the FVG edge — approaching, note as such, do NOT auto-fail (item 5 only emits PASS or FAIL — treat CONDITIONAL as FAIL with "approaching" detail)
- FAIL: no FVG within 0.30 of price, OR FVG is 75+ bars old, OR FVG midpoint already breached (mitigated)
- Quality boosters (mention in detail string only — do NOT change PASS/FAIL):
    * FVG + 4H EMA20 within 0.15 = "high conviction zone"
    * FVG + round dollar level within 0.10 = "institutional confluence"
    * FVG age < 25 bars = "fresh gap"
    * FVG size > 0.30 = "large imbalance"
- EMA20 alone, round level alone, or VWAP alone are NOT sufficient to pass item 5. FVG is the required structural condition.

Output ONLY valid JSON. No preamble, no markdown fences.

Items 1-10 only emit "PASS" or "FAIL". Items 11-12 may also emit "CONDITIONAL"
or "N/A" (when input data is missing). CONDITIONAL contributes 0 to the score
but is not an auto-fail.

SCHEMA:
{
  "score": <0–12>,
  "grade": "A+" | "A" | "B+" | "B" | "F",
  "decision": "LONG" | "SHORT" | "NO TRADE",
  "confidence_label": "CONVICTION" | "HIGH" | "MEDIUM" | "LOW",
  "checklist": [
    {"label": "EMA Stack Aligned",        "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Daily Confirms",           "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "RSI Reset Zone",           "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Volume Confirmed",         "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Price at Key Level",       "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "R/R Valid",                "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Session Timing",           "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "EIA Window Clear",         "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "VWAP Aligned",             "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "HTF Structure Clear",      "result": "PASS"|"FAIL", "detail": "string"},
    {"label": "Overnight Range Position", "result": "PASS"|"FAIL"|"CONDITIONAL"|"N/A", "detail": "string"},
    {"label": "OVX Regime Clean",         "result": "PASS"|"FAIL"|"CONDITIONAL"|"N/A", "detail": "string"}
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
  if (!INTERNAL_API_KEY || !auth || !safeEq(auth, INTERNAL_API_KEY)) {
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

    // Quantitative fundamental layer (pure math, no LLM cost). Direction-aware
    // so we only build it when weeklyBias picks a side; NEUTRAL/unset = skip
    // (carry + alpha deltas are sign-flipped by direction and would be noise).
    const fundamentalDirection: 'LONG' | 'SHORT' | null =
      d.weeklyBias === 'LONG' || d.weeklyBias === 'SHORT' ? d.weeklyBias : null;
    const fundamentalContext =
      fundamentalDirection && typeof d.m4Price === 'number'
        ? buildFundamentalContext(
            { m1Price: d.price, m4Price: d.m4Price, direction: fundamentalDirection },
            {
              m1Price: d.price,
              m4Price: d.m4Price,
              inventoryZScore: d.inventoryZScore ?? null,
              month: d.month ?? new Date().getUTCMonth() + 1,
              momentum20: d.momentum20 ?? null,
              crackSpread321: d.crackSpread321 ?? null,
              direction: fundamentalDirection,
            },
          )
        : null;

    const userPrompt = `Analyze this CL futures setup against the v1.9 A+ checklist:

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
Asia Session High: ${d.asiaHigh ?? 'not provided'} | Asia Session Low: ${d.asiaLow ?? 'not provided'}
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
      asia_high: d.asiaHigh,
      asia_low: d.asiaLow,
    };

    try {
      const fundamentalBlock = fundamentalContext
        ? '\n\n' + fundamentalContext.promptBlock
        : '';
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: SYSTEM_PROMPT + '\n\n' + marketMemorySection + fundamentalBlock,
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
        ...(fundamentalContext ? { fundamental_context: fundamentalContext } : {}),
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
        ...(fundamentalContext ? { fundamental_context: fundamentalContext } : {}),
      }, { headers: rlHeaders });
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[ANALYZE-SETUP] Error:', message);
    return NextResponse.json({ error: 'Analysis failed. Please try again.' }, { status: 500, headers: rlHeaders });
  }
}