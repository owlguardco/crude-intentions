import { NextRequest, NextResponse } from 'next/server';
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

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const ALFRED_SYSTEM_PROMPT = `You are ALFRED — the analysis engine for CRUDE INTENTIONS v1.8.
You score CL futures setups against a 5-layer, 10-point A+ checklist.
Three-timeframe architecture: Daily/Weekly (macro bias) → 4H (setup zone) → 15min (entry trigger).
MINIMUM TO TRADE: 7/10. COUNTERTREND MINIMUM: 9/10.
Layer 1 [Daily/Weekly 2pts]: ema_stack_aligned, daily_confirms
Layer 2 [4H Momentum 2pts]: rsi_reset_zone (35-55 longs 45-65 shorts), macd_confirming
Layer 3 [Structure 2pts]: price_at_key_level (inside 4H FVG or EMA20), rr_valid (2:1 min)
Layer 4 [HTF Context 2pts]: session_timing (NY Open 9:30-11:45 ET), eia_window_clear
Layer 5 [15min Trigger 2pts]: vwap_aligned, htf_structure_clear
HARD BLOCKS: EIA window active, OVX > 50
GRADING: 10=A+ CONVICTION, 8-9=A HIGH, 7=B+ MEDIUM, 5-6=B NO TRADE, 0-4=F NO TRADE
Output ONLY valid JSON. No prose, no markdown fences, no preamble.
SCHEMA:
{"score":<0-10>,"grade":"A+"|"A"|"B+"|"B"|"F","decision":"LONG"|"SHORT"|"NO TRADE","confidence_label":"CONVICTION"|"HIGH"|"MEDIUM"|"LOW","checklist":[{"label":"EMA Stack Aligned","result":"PASS"|"FAIL","detail":"string"},{"label":"Daily Confirms","result":"PASS"|"FAIL","detail":"string"},{"label":"RSI Reset Zone","result":"PASS"|"FAIL","detail":"string"},{"label":"MACD Confirming","result":"PASS"|"FAIL","detail":"string"},{"label":"Price at Key Level","result":"PASS"|"FAIL","detail":"string"},{"label":"R/R Valid","result":"PASS"|"FAIL","detail":"string"},{"label":"Session Timing","result":"PASS"|"FAIL","detail":"string"},{"label":"EIA Window Clear","result":"PASS"|"FAIL","detail":"string"},{"label":"VWAP Aligned","result":"PASS"|"FAIL","detail":"string"},{"label":"HTF Structure Clear","result":"PASS"|"FAIL","detail":"string"}],"blocked_reasons":[],"wait_for":null,"reasoning":"2-3 sentences","disclaimer":"AI-generated research only."}`;

const ADVERSARIAL_SYSTEM_PROMPT = `You are an adversarial trading analyst. Find every reason to SKIP this CL trade.
Check: trend alignment, FVG quality, RSI context, macro timing, OVX regime, R:R after slippage, recency bias, score honesty.
Verdict: PASS, CONDITIONAL_PASS, or SKIP.
Output ONLY valid JSON: {"verdict":"PASS"|"CONDITIONAL_PASS"|"SKIP","concerns":["string"],"override_note":null}`;

interface WebhookSignal {
  direction: 'LONG' | 'SHORT'; price: number; ema20: number; ema50: number; ema200: number;
  rsi: number; macd?: number; vwap?: number; ovx: number; dxy: string;
  fvg_direction: string; fvg_top: number; fvg_bottom: number; fvg_age?: number;
  session: 'NY_OPEN' | 'NY_AFTERNOON' | 'LONDON' | 'OVERLAP' | 'ASIA' | 'OFF_HOURS';
  weekly_bias?: string; htf_resistance?: number; htf_support?: number; eia_active: boolean;
  stop_loss?: number;
}

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
interface ChecklistItem { label: string; result: 'PASS' | 'FAIL'; detail: string; }
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
    rsi: s.rsi, macd: s.macd, vwap: s.vwap, ovx: s.ovx,
    dxy, fvg_direction: fvgDir, fvg_top: s.fvg_top, fvg_bottom: s.fvg_bottom,
    session: s.session, weekly_bias: wb, eia_active: s.eia_active,
  };
}

async function runALFRED(signal: WebhookSignal): Promise<AlfredResult> {
  const marketContext = await readContext(kv);
  const marketMemorySection = buildMarketMemoryPromptSection(marketContext);

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
  if (!match) return fallback;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return fallback; }
  const v = AdversarialScanSchema.safeParse(parsed);
  return v.success ? v.data : { verdict: 'CONDITIONAL_PASS' as const, concerns: ['Scan malformed'], override_note: null };
}

function mapChecklist(checklist: ChecklistItem[]) {
  const g = (label: string) => checklist.find(c => c.label === label) ?? { result: 'FAIL', detail: 'Not evaluated' };
  return {
    ema_stack_aligned:   { result: g('EMA Stack Aligned').result,   detail: g('EMA Stack Aligned').detail },
    daily_confirms:      { result: g('Daily Confirms').result,       detail: g('Daily Confirms').detail },
    rsi_reset_zone:      { result: g('RSI Reset Zone').result,       detail: g('RSI Reset Zone').detail },
    macd_confirming:     { result: g('MACD Confirming').result,      detail: g('MACD Confirming').detail },
    price_at_key_level:  { result: g('Price at Key Level').result,   detail: g('Price at Key Level').detail },
    rr_valid:            { result: g('R/R Valid').result,            detail: g('R/R Valid').detail },
    session_timing:      { result: g('Session Timing').result,       detail: g('Session Timing').detail },
    eia_window_clear:    { result: g('EIA Window Clear').result,     detail: g('EIA Window Clear').detail },
    vwap_aligned:        { result: g('VWAP Aligned').result,         detail: g('VWAP Aligned').detail },
    htf_structure_clear: { result: g('HTF Structure Clear').result,  detail: g('HTF Structure Clear').detail },
  } as const;
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
    return NextResponse.json({
      received_at: receivedAt, signal, alfred, adversarial,
      journal: { id: journalWrite.id, integrity_hash: journalWrite.integrity_hash, auto_logged: true },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[WEBHOOK] Error:', message);
    return NextResponse.json({ error: 'Signal processing failed', detail: message }, { status: 500 });
  }
}