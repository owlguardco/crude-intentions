import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { writeJournalEntry } from '@/lib/journal/writer';
import { scoreToConfidence } from '@/lib/alfred/confidence';
import {
  runFallbackScorer,
  type FallbackScorerInput,
} from '@/lib/alfred/fallback-scorer';
import { AdversarialScanSchema } from '@/lib/validation/journal-schema';
import { kv } from '@/lib/kv';
import { readContext, buildMarketMemoryPromptSection } from '@/lib/market-memory/context';
import { computeEntryAlignment } from '@/lib/mtf/consensus';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { checkReplay } from '@/lib/replay-protect';
import { safeEq } from '@/lib/auth/safe-compare';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const ALFRED_SYSTEM_PROMPT = `You are ALFRED — the analysis engine for CRUDE INTENTIONS v1.9.
You score CL futures setups against a 6-layer, 12-point A+ checklist.
Three-timeframe architecture: Daily/Weekly (macro bias) → 4H (setup zone) → 15min (entry trigger).
MINIMUM TO TRADE: 9/12. COUNTERTREND MINIMUM: 11/12.
Layer 1 [Daily/Weekly 2pts]: ema_stack_aligned, daily_confirms
Layer 2 [4H Momentum 2pts]: rsi_reset_zone (35-55 longs 45-65 shorts), volume_confirmed (15min trigger candle volume >= 20-bar avg)
Layer 3 [Structure 2pts]: price_at_key_level (UNFILLED 4H FVG REQUIRED — price inside gap or within 0.10 of edge, FVG <75 bars, midpoint not breached. EMA20/round-level proximity = quality boosters only, NOT standalone pass conditions), rr_valid (2:1 min)
Layer 4 [HTF Context 2pts]: session_timing (NY Open 9:30-11:45 ET), eia_window_clear
Layer 5 [15min Trigger 2pts]: vwap_aligned, htf_structure_clear
Layer 6 [Session Context 2pts]: overnight_range_position (price above Asia high LONGS / below Asia low SHORTS), ovx_regime (OVX 20-35 PASS, 35-50 CONDITIONAL, >50 or <20 FAIL)
FVG RULES (item 5): PASS = inside FVG or within 0.10 of edge. FAIL = no FVG within 0.30, or 75+ bars old, or midpoint breached. Quality boosters (detail only, no PASS/FAIL change): FVG+EMA20<0.15="high conviction", FVG+round level<0.10="institutional confluence", age<25="fresh gap", size>0.30="large imbalance".
HARD BLOCKS: EIA window active, OVX > 50
GRADING: 12=A+ CONVICTION, 10-11=A HIGH, 9=B+ MEDIUM, 7-8=B NO TRADE, 0-6=F NO TRADE
Items 1-10 emit PASS or FAIL only. Items 11-12 may also emit CONDITIONAL or N/A.
Output ONLY valid JSON. No prose, no markdown fences, no preamble.
SCHEMA:
{"score":<0-12>,"grade":"A+"|"A"|"B+"|"B"|"F","decision":"LONG"|"SHORT"|"NO TRADE","confidence_label":"CONVICTION"|"HIGH"|"MEDIUM"|"LOW","checklist":[{"label":"EMA Stack Aligned","result":"PASS"|"FAIL","detail":"string"},{"label":"Daily Confirms","result":"PASS"|"FAIL","detail":"string"},{"label":"RSI Reset Zone","result":"PASS"|"FAIL","detail":"string"},{"label":"Volume Confirmed","result":"PASS"|"FAIL","detail":"string"},{"label":"Price at Key Level","result":"PASS"|"FAIL","detail":"string"},{"label":"R/R Valid","result":"PASS"|"FAIL","detail":"string"},{"label":"Session Timing","result":"PASS"|"FAIL","detail":"string"},{"label":"EIA Window Clear","result":"PASS"|"FAIL","detail":"string"},{"label":"VWAP Aligned","result":"PASS"|"FAIL","detail":"string"},{"label":"HTF Structure Clear","result":"PASS"|"FAIL","detail":"string"},{"label":"Overnight Range Position","result":"PASS"|"FAIL"|"CONDITIONAL"|"N/A","detail":"string"},{"label":"OVX Regime Clean","result":"PASS"|"FAIL"|"CONDITIONAL"|"N/A","detail":"string"}],"blocked_reasons":[],"wait_for":null,"reasoning":"2-3 sentences","disclaimer":"AI-generated research only."}`;

const ADVERSARIAL_SYSTEM_PROMPT = `You are an adversarial trading analyst. Find every reason to SKIP this CL trade.
Check: trend alignment, FVG quality, RSI context, macro timing, OVX regime, R:R after slippage, recency bias, score honesty.
Verdict: PASS, CONDITIONAL_PASS, or SKIP.
Output ONLY valid JSON: {"verdict":"PASS"|"CONDITIONAL_PASS"|"SKIP","concerns":["string"],"override_note":null}`;

const WebhookSignalSchema = z.object({
  direction: z.enum(['LONG', 'SHORT']),
  price: z.number().finite().min(10).max(500),
  ema20: z.number().finite().min(10).max(500),
  ema50: z.number().finite().min(10).max(500),
  ema200: z.number().finite().min(10).max(500),
  rsi: z.number().finite().min(0).max(100),
  trigger_volume: z.number().finite().min(0).max(1_000_000_000).optional(),
  avg_volume:     z.number().finite().min(0).max(1_000_000_000).optional(),
  vwap: z.number().finite().min(10).max(500).optional(),
  ovx: z.number().finite().min(0).max(300),
  dxy: z.enum(['rising', 'falling', 'flat', 'neutral']),
  fvg_direction: z.enum(['bullish', 'bearish', 'none']),
  fvg_top: z.number().finite().min(10).max(500),
  fvg_bottom: z.number().finite().min(10).max(500),
  fvg_age: z.number().int().min(0).max(1000).optional(),
  session: z.enum(['NY_OPEN', 'NY_AFTERNOON', 'LONDON', 'OVERLAP', 'ASIA', 'OFF_HOURS']),
  weekly_bias: z.enum(['LONG', 'SHORT', 'NEUTRAL']).optional(),
  htf_resistance: z.number().finite().min(10).max(500).optional(),
  htf_support: z.number().finite().min(10).max(500).optional(),
  eia_active: z.boolean(),
  stop_loss: z.number().finite().min(10).max(500).optional(),
  htf_ema_stack: z.enum(['BULLISH', 'BEARISH', 'MIXED']).optional(),
  setup_ema_stack: z.enum(['BULLISH', 'BEARISH', 'MIXED']).optional(),
  signal_id: z.string().min(1).max(64).optional(),
  // v1.9 Layer 6 — TradingView alerts may not always carry these.
  asia_high: z.number().finite().min(10).max(500).optional(),
  asia_low:  z.number().finite().min(10).max(500).optional(),
}).strict();

type WebhookSignal = z.infer<typeof WebhookSignalSchema>;

function computeTradeLevels(direction: 'LONG' | 'SHORT' | 'NO TRADE', entry: number | null, stop: number | null | undefined) {
  if (entry == null || stop == null || direction === 'NO TRADE') {
    return { stop_price: null, tp1_price: null, tp2_price: null };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  if (direction === 'LONG') {
    const risk = entry - stop;
    if (risk <= 0) return { stop_price: null, tp1_price: null, tp2_price: null };
    return { stop_price: round2(stop), tp1_price: round2(entry + 2 * risk), tp2_price: round2(entry + 4 * risk) };
  }
  const risk = stop - entry;
  if (risk <= 0) return { stop_price: null, tp1_price: null, tp2_price: null };
  return { stop_price: round2(stop), tp1_price: round2(entry - 2 * risk), tp2_price: round2(entry - 4 * risk) };
}
interface ChecklistItem { label: string; result: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'N/A'; detail: string; }
interface AlfredResult {
  score: number; grade: string; decision: 'LONG' | 'SHORT' | 'NO TRADE';
  confidence_label: string; checklist: ChecklistItem[];
  blocked_reasons: string[]; wait_for: string | null; reasoning: string; disclaimer: string;
  fallback?: boolean;
}

function signalToFallbackInput(s: WebhookSignal): FallbackScorerInput {
  const dxy: 'rising' | 'falling' | 'flat' | 'neutral' =
    s.dxy === 'rising' || s.dxy === 'falling' || s.dxy === 'flat' || s.dxy === 'neutral'
      ? s.dxy
      : 'neutral';
  const fvgDir: 'bullish' | 'bearish' | 'none' =
    s.fvg_direction === 'bullish' || s.fvg_direction === 'bearish' ? s.fvg_direction : 'none';
  const wb: 'LONG' | 'SHORT' | 'NEUTRAL' =
    s.weekly_bias === 'LONG' || s.weekly_bias === 'SHORT' ? s.weekly_bias : 'NEUTRAL';
  return {
    direction: s.direction,
    price: s.price, ema20: s.ema20, ema50: s.ema50, ema200: s.ema200,
    rsi: s.rsi, trigger_volume: s.trigger_volume, avg_volume: s.avg_volume, vwap: s.vwap, ovx: s.ovx,
    dxy, fvg_direction: fvgDir, fvg_top: s.fvg_top, fvg_bottom: s.fvg_bottom,
    fvg_age_bars: s.fvg_age,
    session: s.session, weekly_bias: wb, eia_active: s.eia_active,
    asia_high: s.asia_high, asia_low: s.asia_low,
  };
}

async function runALFRED(signal: WebhookSignal): Promise<AlfredResult> {
  const marketContext = await readContext(kv);
  const marketMemorySection = buildMarketMemoryPromptSection(marketContext);

  const prompt = `Analyze this CL setup against v1.9 checklist:
Direction: ${signal.direction} | Price: ${signal.price}
EMA20: ${signal.ema20} EMA50: ${signal.ema50} EMA200: ${signal.ema200}
RSI: ${signal.rsi} | Trigger Vol: ${signal.trigger_volume ?? 'N/A'} | Avg Vol (20-bar): ${signal.avg_volume ?? 'N/A'} | VWAP: ${signal.vwap ?? 'N/A'}
OVX: ${signal.ovx} | DXY: ${signal.dxy}
FVG: ${signal.fvg_direction} ${signal.fvg_bottom}-${signal.fvg_top} | Age: ${signal.fvg_age ?? 'N/A'} bars
Session: ${signal.session} | Weekly bias: ${signal.weekly_bias ?? 'not set'}
Asia High: ${signal.asia_high ?? 'N/A'} | Asia Low: ${signal.asia_low ?? 'N/A'}
EIA active: ${signal.eia_active ? 'YES HARD BLOCK' : 'NO'}
Return JSON only.`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 1000,
    system: ALFRED_SYSTEM_PROMPT + '\n\n' + marketMemorySection,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = res.content[0].type === 'text' ? res.content[0].text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in ALFRED response');
  return JSON.parse(match[0]);
}

async function runAdversarialScan(signal: WebhookSignal, alfred: AlfredResult) {
  const fallback = { verdict: 'CONDITIONAL_PASS' as const, concerns: ['Adversarial scan unavailable'], override_note: null };
  if (alfred.decision === 'NO TRADE') {
    return { verdict: 'SKIP' as const, concerns: ['ALFRED scored NO TRADE'], override_note: null };
  }
  const safeReasoning = (alfred.reasoning ?? '')
    .slice(0, 500)
    .replace(/[\r\n]+/g, ' ')
    .replace(/```/g, "'''");
  const prompt = `CL setup: ${alfred.decision} @ ${signal.price} | Score: ${alfred.score}/12
FVG ${signal.fvg_bottom}-${signal.fvg_top} | RSI: ${signal.rsi} | OVX: ${signal.ovx}
Reasoning: ${safeReasoning}
Attack this setup. Return JSON only.`;
  const res = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 600,
    system: ADVERSARIAL_SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }],
  });
  const raw = res.content[0].type === 'text' ? res.content[0].text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return fallback; }
  const v = AdversarialScanSchema.safeParse(parsed);
  return v.success ? v.data : { verdict: 'CONDITIONAL_PASS' as const, concerns: ['Scan malformed'], override_note: null };
}

// Coerce ALFRED-emitted result strings into the binary 'PASS'|'FAIL' shape
// expected by the journal schema for items 1-10. ALFRED is told in the prompt
// to emit only those two for items 1-10, but if it ever drifts into
// CONDITIONAL/N/A on a binary slot we treat as FAIL rather than failing
// the whole journal write.
function bin(r: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'N/A'): 'PASS' | 'FAIL' {
  return r === 'PASS' ? 'PASS' : 'FAIL';
}

function mapChecklist(checklist: ChecklistItem[]) {
  const g = (label: string) =>
    checklist.find(c => c.label === label) ?? { result: 'FAIL' as const, detail: 'Not evaluated' };
  return {
    ema_stack_aligned:   { result: bin(g('EMA Stack Aligned').result),   detail: g('EMA Stack Aligned').detail },
    daily_confirms:      { result: bin(g('Daily Confirms').result),       detail: g('Daily Confirms').detail },
    rsi_reset_zone:      { result: bin(g('RSI Reset Zone').result),       detail: g('RSI Reset Zone').detail },
    volume_confirmed:    { result: bin(g('Volume Confirmed').result),     detail: g('Volume Confirmed').detail },
    price_at_key_level:  { result: bin(g('Price at Key Level').result),   detail: g('Price at Key Level').detail },
    rr_valid:            { result: bin(g('R/R Valid').result),            detail: g('R/R Valid').detail },
    session_timing:      { result: bin(g('Session Timing').result),       detail: g('Session Timing').detail },
    eia_window_clear:    { result: bin(g('EIA Window Clear').result),     detail: g('EIA Window Clear').detail },
    vwap_aligned:        { result: bin(g('VWAP Aligned').result),         detail: g('VWAP Aligned').detail },
    htf_structure_clear: { result: bin(g('HTF Structure Clear').result),  detail: g('HTF Structure Clear').detail },
    // Layer 6 (v1.9) — pass through 4-state values directly.
    overnight_range_position: { result: g('Overnight Range Position').result, detail: g('Overnight Range Position').detail },
    ovx_regime:               { result: g('OVX Regime Clean').result,         detail: g('OVX Regime Clean').detail },
  } as const;
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit('webhook-signal:global', 60, 60);
  const rlHeaders = rateLimitHeaders(rl);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: rlHeaders });
  }
  const auth = req.headers.get('x-api-key');
  if (!INTERNAL_API_KEY || !auth || !safeEq(auth, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: rlHeaders });
  }
  let rawBody: unknown;
  try { rawBody = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: rlHeaders });
  }
  const parsed = WebhookSignalSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid signal', details: parsed.error.flatten() },
      { status: 400, headers: rlHeaders },
    );
  }
  const signal: WebhookSignal = parsed.data;

  // Replay protection — caller-supplied signal_id is preferred; otherwise
  // build a deterministic 30-second-bucket key from the signal shape so a
  // chatty source can't accidentally fire the same setup twice.
  const replayKey =
    signal.signal_id ??
    `${signal.direction}:${signal.price}:${signal.session}:${Math.floor(Date.now() / 1000 / 30)}`;
  const replay = await checkReplay(replayKey);
  if (replay.seen) {
    return NextResponse.json(
      { error: 'Duplicate signal — already processed' },
      { status: 409, headers: rlHeaders },
    );
  }

  const receivedAt = new Date().toISOString();
  try {
    let alfred: AlfredResult;
    let isFallback = false;
    try {
      alfred = await runALFRED(signal);
      alfred.confidence_label = scoreToConfidence(alfred.score);
      alfred.fallback = false;
    } catch (alfredErr) {
      console.error('[ALFRED FALLBACK] Anthropic unreachable, using fallback scorer:', alfredErr);
      alfred = runFallbackScorer(signalToFallbackInput(signal));
      isFallback = true;
    }
    const adversarial = isFallback
      ? { verdict: 'CONDITIONAL_PASS' as const, concerns: ['Adversarial scan skipped — fallback mode'], override_note: null }
      : await runAdversarialScan(signal, alfred);
    const entryPrice = alfred.decision !== 'NO TRADE' ? signal.price : null;
    const levels = computeTradeLevels(alfred.decision, entryPrice, signal.stop_loss);
    const journalWrite = await writeJournalEntry({
      rules_version: '1.8', session: signal.session, direction: alfred.decision,
      source: 'WEBHOOK', score: alfred.score,
      grade: alfred.grade as 'A+' | 'A' | 'B+' | 'B' | 'F',
      confidence_label: alfred.confidence_label as 'CONVICTION' | 'HIGH' | 'MEDIUM' | 'LOW',
      entry_price: entryPrice,
      stop_loss: levels.stop_price, take_profit_1: levels.tp1_price, take_profit_2: levels.tp2_price,
      contracts: null, risk_dollars: null,
      stop_price: levels.stop_price, tp1_price: levels.tp1_price, tp2_price: levels.tp2_price,
      checklist: mapChecklist(alfred.checklist),
      blocked_reasons: alfred.blocked_reasons ?? [], wait_for: alfred.wait_for ?? null,
      reasoning: alfred.reasoning,
      market_context_snapshot: {
        price: signal.price, ema20: signal.ema20, ema50: signal.ema50,
        ema200: signal.ema200, rsi: signal.rsi, ovx: signal.ovx, dxy: signal.dxy,
        ...(signal.vwap ? { vwap: signal.vwap } : {}),
      },
      adversarial_verdict: adversarial.verdict,
      adversarial_notes: adversarial.concerns.join(' | '),
      paper_trading: true,
      alfred_fallback: isFallback,
    });
    console.log(`[JOURNAL] Wrote: ${journalWrite.id}`);
    const entry_alignment =
      signal.htf_ema_stack && signal.setup_ema_stack
        ? computeEntryAlignment({
            htf_ema_stack: signal.htf_ema_stack,
            setup_ema_stack: signal.setup_ema_stack,
            trigger_direction: alfred.decision,
          })
        : undefined;
    return NextResponse.json({
      received_at: receivedAt, alfred, adversarial,
      journal: { id: journalWrite.id, integrity_hash: journalWrite.integrity_hash, auto_logged: true },
      ...(entry_alignment ? { entry_alignment } : {}),
    }, { headers: rlHeaders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[webhook-signal] processing error:', message);
    return NextResponse.json({ error: 'Signal processing failed' }, { status: 500, headers: rlHeaders });
  }
}