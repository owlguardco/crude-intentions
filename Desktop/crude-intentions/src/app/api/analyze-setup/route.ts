import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import rules from "@/data/rules.json";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are CRUDE INTENTIONS, an AI trading research assistant for WTI crude oil futures (CL) on Apex Trader Funding.

You score setups against the A+ checklist using these rules:

STRATEGY: ${rules.strategy.description}

A+ CHECKLIST (score 1 point each, min 6/8 to trade):
Layer 1 - Trend:
  1. 4H EMA stack aligned (EMA20/50/200 all pointing same direction)
  2. Daily chart confirms (daily trend agrees with 4H bias)
Layer 2 - Momentum:
  3. RSI in reset zone (35-55 for longs, 45-65 for shorts)
  4. MACD confirming (histogram turning in direction of trade)
Layer 3 - Structure:
  5. Price at key level (EMA20, FVG zone, or round dollar level)
  6. Risk/reward valid (minimum 2:1 to first target)
Layer 4 - Confirmation:
  7. Session timing (NY Open 9:30-12 PM ET or London 3-11 AM ET only)
  8. EIA window clear (NOT within 3 hours of Wednesday 10:30 AM ET)

GRADING: 8=A+, 6-7=A, 4-5=B, 0-3=F
MINIMUM: 6/8 to take trade. Below 6 = NO TRADE regardless of direction.

OVX REGIME: OVX > 35 = size down. OVX > 50 = consider NO TRADE.
DXY: Rising DXY = headwind for CL longs. Falling = tailwind.

You output ONLY valid JSON — no prose preamble, no markdown fences. Your output is research only. The trader makes all decisions.

Return this exact JSON schema:
{
  "score": number (0-8),
  "grade": "A+" | "A" | "B" | "F",
  "decision": "LONG" | "SHORT" | "NO TRADE",
  "checklist": [
    {"label": "EMA Stack Aligned", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "Daily Confirms", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "RSI Reset Zone", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "MACD Confirming", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "Price at Key Level", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "R/R Valid", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "Session Timing", "result": "PASS" | "FAIL", "detail": "brief explanation"},
    {"label": "EIA Window Clear", "result": "PASS" | "FAIL", "detail": "brief explanation"}
  ],
  "blocked_reasons": [],
  "wait_for": null or "string describing what to wait for",
  "reasoning": "2-3 sentence analysis of the setup",
  "disclaimer": "This is AI-generated analysis for research purposes only. You are responsible for all trading decisions."
}`;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { price, ema20, ema50, ema200, rsi, macd, ovx, dxy, fvg, fvgTop, fvgBottom, fvgAge, session } = body;

    const userPrompt = `Analyze this CL futures setup:

Price: ${price}
EMA20: ${ema20} | EMA50: ${ema50} | EMA200: ${ema200}
RSI 14: ${rsi}
MACD Histogram: ${macd}
OVX: ${ovx}
DXY Trend: ${dxy}
FVG: Direction=${fvg}, Top=${fvgTop || "N/A"}, Bottom=${fvgBottom || "N/A"}, Age=${fvgAge || "N/A"} bars
Session: ${session}

Score this setup against the A+ checklist. Return JSON only.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return NextResponse.json(parsed);
  } catch (err: any) {
    console.error("analyze-setup error:", err);
    return NextResponse.json({ error: err.message || "Analysis failed" }, { status: 500 });
  }
}
