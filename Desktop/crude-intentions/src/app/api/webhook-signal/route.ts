/**
 * CRUDE INTENTIONS — /api/webhook-signal
 *
 * Receives a verified, pre-validated signal from the Railway webhook server.
 * Runs ALFRED analysis on it automatically and stores the result.
 *
 * This route is NOT called directly by TradingView — it is only called by Railway
 * after HMAC verification and payload validation have passed.
 *
 * File location: /app/api/webhook-signal/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Internal key guard ────────────────────────────────────────────────────────
// Only Railway can call this endpoint — it must send the INTERNAL_API_KEY header
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// ── Updated system prompt for v1.8 MTF architecture ──────────────────────────
const SYSTEM_PROMPT = `You are CRUDE INTENTIONS v1.8, an AI trading research assistant for WTI crude oil futures (CL) on Apex Trader Funding.

You score setups against the three-timeframe A+ checklist (10 points, minimum 7/10 to trade).

THREE-TIMEFRAME ARCHITECTURE:
- Daily/Weekly = Macro bias layer (which direction are we trading?)
- 4H           = Setup identification layer (where are the FVG and EMA zones?)
- 15min        = Entry trigger layer (has the candle confirmed inside the zone?)

A+ CHECKLIST — score 1 point each, minimum 7/10 to trade:

Layer 1 — Macro Bias [DAILY/WEEKLY] (2 pts):
  1. Daily EMA stack aligned (EMA20/50/200 all pointing in trade direction on daily chart)
  2. Weekly bias confirms (weekly-bias is LONG for longs, SHORT for shorts — not NEUTRAL)

Layer 2 — Setup Zone [4H] (2 pts):
  3. 4H EMA stack aligned (EMA20/50/200 intermediate trend confirms daily bias)
  4. Price inside mapped 4H setup zone (at EMA20, inside unfilled FVG, or VWAP confluence)

Layer 3 — Momentum [4H] (2 pts):
  5. 4H RSI in reset zone (35-55 for longs on pullback, 45-65 for shorts on rally)
  6. 4H MACD histogram turning in trade direction (actively turning, not just positive/negative)

Layer 4 — Structure [4H + DAILY] (2 pts):
  7. HTF structure clear (no major daily/weekly S/R within 0.50 capping the trade)
  8. Risk/reward valid (minimum 2:1 from 15min entry to first target using 15min stop)

Layer 5 — Entry Trigger [15MIN] (2 pts):
  9. 15min trigger candle confirmed (closed inside 4H zone showing rejection: pin bar, engulfing, or reclaim)
  10. 15min VWAP aligned (reclaiming VWAP on trigger candle for longs, rejecting for shorts) AND session is NY Open or London exception

EIA HARD BLOCK: Wednesday 7:30 AM - 1:30 PM ET. A perfect 10/10 setup = NO TRADE during this window. Override all other checks.

GRADING:
  10/10 = A+ — Full size, take the trade
  8-9/10 = A  — Standard size, take the trade
  7/10  = B+ — Standard to half size, take the trade if other factors clean
  5-6/10 = B  — Half size or skip
  0-4/10 = F  — NO TRADE

STOP PLACEMENT (v1.8):
- Place stop below the low of the 15min trigger candle (longs) or above the high (shorts)
- Minimum stop: 15 ticks to absorb spread and noise
- Hard maximum: 40 ticks ($400/contract) — never exceed

OVX REGIME: OVX > 35 = size down. OVX > 50 = consider NO TRADE.
DXY: Rising DXY = headwind for CL longs. Falling = tailwind.
WEEKLY BIAS: If weekly_bias is NEUTRAL, countertrend trades require 9+/10 minimum.

You output ONLY valid JSON — no prose preamble, no markdown fences.

Return this exact JSON schema:
{
  "score": number (0-10),
  "grade": "A+" | "A" | "B+" | "B" | "F",
  "decision": "LONG" | "SHORT" | "NO TRADE",
  "checklist": [
    {"label": "Daily EMA Stack", "timeframe": "Daily", "result": "PASS" | "FAIL" | "UNKNOWN", "detail": "brief explanation"},
    {"label": "Weekly Bias Confirms", "timeframe": "Weekly", "result": "PASS" | "FAIL" | "UNKNOWN", "detail": "brief explanation"},
    {"label": "4H EMA Stack", "timeframe": "4H", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "Price in Setup Zone", "timeframe": "4H", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "RSI Reset Zone", "timeframe": "4H", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "MACD Confirming", "timeframe": "4H", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "HTF Structure Clear", "timeframe": "Daily", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "R/R Valid (15min stop)", "timeframe": "15min", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "15min Trigger Candle", "timeframe": "15min", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "15min VWAP + Session", "timeframe": "15min", "result": "PASS" | "FAIL", "detail": "brief explanation"}
  ],
  "suggested_stop": number | null,
  "suggested_entry": number | null,
  "blocked_reasons": [],
  "wait_for": null | "string describing what to wait for",
  "reasoning": "2-3 sentence analysis of the setup across all three timeframes",
  "timeframe_summary": {
    "daily_weekly": "one sentence on macro bias state",
    "four_hour": "one sentence on setup zone quality",
    "fifteen_min": "one sentence on trigger quality"
  },
  "disclaimer": "This is AI-generated analysis for research purposes only. You are responsible for all trading decisions."
}`;


function buildUserPrompt(signal: Record<string, unknown>): string {
  return `Analyze this CL futures setup — signal received from TradingView 15min trigger:

── MACRO BIAS (Daily/Weekly) ──
Weekly Bias: ${signal.weekly_bias || "unknown"}
Daily EMA Stack: ${signal.daily_ema_stack || "unknown"}

── SETUP ZONE (4H) ──
Price: ${signal.price}
EMA20: ${signal.ema20} | EMA50: ${signal.ema50} | EMA200: ${signal.ema200}
RSI 14 (4H): ${signal.rsi}
MACD Histogram (4H): ${signal.macd}
FVG: Direction=${signal.fvg}, Top=${signal.fvg_top ?? "N/A"}, Bottom=${signal.fvg_bottom ?? "N/A"}, Age=${signal.fvg_age ?? "N/A"} bars
VWAP: ${signal.vwap ?? "not provided"}
Nearest HTF Resistance: ${signal.htf_resistance ?? "not provided"}
Nearest HTF Support: ${signal.htf_support ?? "not provided"}
OVX: ${signal.ovx}
DXY Trend: ${signal.dxy}

── ENTRY TRIGGER (15min) ──
Trigger Candle Type: ${signal.trigger_candle}
Trigger Candle Low: ${signal.trigger_candle_low ?? "not provided"} (stop reference for longs)
Trigger Candle High: ${signal.trigger_candle_high ?? "not provided"} (stop reference for shorts)
Direction Signal: ${signal.direction}
Session: ${signal.session}
MTF Alignment Score: ${signal.mtf_score ?? "not provided"} / 3

Score this setup against the v1.8 A+ checklist (10 points). Return JSON only.`;
}


export async function POST(req: NextRequest) {
  try {
    // ── 1. Verify internal key ──────────────────────────────────────────────
    const internalKey = req.headers.get("X-Internal-Key");
    if (!INTERNAL_API_KEY || internalKey !== INTERNAL_API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── 2. Parse payload ────────────────────────────────────────────────────
    const signal = await req.json();

    // ── 3. Basic sanity check ───────────────────────────────────────────────
    if (!signal.price || !signal.direction) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // ── 4. Run ALFRED analysis ──────────────────────────────────────────────
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(signal) }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(clean);

    // ── 5. Build response with signal metadata attached ─────────────────────
    const result = {
      signal_id: `CI-${Date.now()}`,
      received_at: new Date().toISOString(),
      source: "tradingview_webhook",
      signal: {
        direction: signal.direction,
        price: signal.price,
        session: signal.session,
        trigger_candle: signal.trigger_candle,
        weekly_bias: signal.weekly_bias,
      },
      analysis,
    };

    // ── 6. Return result ─────────────────────────────────────────────────────
    // The dashboard polls or subscribes to this — result is the auto-triggered analysis
    return NextResponse.json(result);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[webhook-signal] error:", message);
    return NextResponse.json({ error: "Signal processing failed" }, { status: 500 });
  }
}
