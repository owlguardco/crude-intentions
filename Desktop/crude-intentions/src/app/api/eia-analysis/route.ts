import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are CRUDE INTENTIONS, analyzing EIA crude oil inventory data for WTI crude oil futures (CL) trading.

Analyze the EIA report data and return ONLY valid JSON with this schema:
{
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "trade_action": "TRADE THE REACTION" | "FADE THE REACTION" | "WAIT FOR CONFIRMATION",
  "analysis": "2-3 sentence analysis of what the data means for price action",
  "session_bias": "1-3 session directional bias explanation",
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "disclaimer": "This is AI-generated analysis for research purposes only. You are responsible for all trading decisions."
}

Rules for interpretation:
- Draw larger than expected = bullish signal (supply declining)
- Build larger than expected = bearish signal (supply increasing)  
- Cushing draw = bullish (delivery point for WTI)
- Gasoline/distillate builds = slightly bearish demand signal
- Refinery utilization spike = bullish (processing more crude)
- Always consider the surprise vs expectation, not just the raw number
- Initial reaction is often faded — distinguish between "trade it" and "fade it"

Return JSON only — no markdown, no preamble.`;

export async function POST(req: NextRequest) {
  try {
    const { actual, expected, cushing, gasoline, distillates, refinery } = await req.json();

    const prompt = `EIA Crude Oil Inventory Report:
Actual: ${actual}MB
Expected: ${expected}MB
Surprise: ${(parseFloat(actual) - parseFloat(expected)).toFixed(1)}MB ${parseFloat(actual) < parseFloat(expected) ? "(DRAW vs expected)" : "(BUILD vs expected)"}
Cushing Hub: ${cushing || "not provided"}MB
Gasoline Stocks: ${gasoline || "not provided"}MB
Distillate Stocks: ${distillates || "not provided"}MB
Refinery Utilization: ${refinery || "not provided"}%

Analyze this report. Return JSON only.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const clean = raw.replace(/```json|```/g, "").trim();
    return NextResponse.json(JSON.parse(clean));
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "EIA analysis failed" }, { status: 500 });
  }
}
