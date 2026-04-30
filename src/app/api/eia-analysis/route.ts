import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { safeEq } from "@/lib/auth/safe-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// Weekly EIA petroleum supply numbers are reported in millions of barrels.
// The largest weekly delta in recent decades is well inside ±20 MB; bounds
// here exist to prevent prompt injection via numeric overflow tricks rather
// than to police real-world plausibility.
const BodySchema = z.object({
  actual:      z.number().finite().min(-50).max(50),
  expected:    z.number().finite().min(-50).max(50),
  cushing:     z.number().finite().min(-20).max(20).optional(),
  gasoline:    z.number().finite().min(-20).max(20).optional(),
  distillates: z.number().finite().min(-20).max(20).optional(),
  refinery:    z.number().finite().min(0).max(100).optional(),
}).strict();

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
  const rl = await checkRateLimit("eia-analysis:global", 10, 60);
  const rlHeaders = rateLimitHeaders(rl);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: rlHeaders });
  }

  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: "INTERNAL_API_KEY not configured" }, { status: 500, headers: rlHeaders });
  }
  const auth = req.headers.get("x-api-key");
  if (!auth || !safeEq(auth, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: rlHeaders });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: rlHeaders });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400, headers: rlHeaders },
    );
  }

  const { actual, expected, cushing, gasoline, distillates, refinery } = parsed.data;

  try {
    const surprise = actual - expected;
    const prompt = `EIA Crude Oil Inventory Report:
Actual: ${actual}MB
Expected: ${expected}MB
Surprise: ${surprise.toFixed(1)}MB ${actual < expected ? "(DRAW vs expected)" : "(BUILD vs expected)"}
Cushing Hub: ${cushing ?? "not provided"}MB
Gasoline Stocks: ${gasoline ?? "not provided"}MB
Distillate Stocks: ${distillates ?? "not provided"}MB
Refinery Utilization: ${refinery ?? "not provided"}%

Analyze this report. Return JSON only.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const clean = raw.replace(/```json|```/g, "").trim();
    return NextResponse.json(JSON.parse(clean), { headers: rlHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[eia-analysis] processing error:", message);
    return NextResponse.json({ error: "EIA analysis failed" }, { status: 500, headers: rlHeaders });
  }
}
