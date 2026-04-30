/**
 * CRUDE INTENTIONS — Deterministic Fallback Scorer
 *
 * When the Anthropic API is unreachable, this pure-rules scorer fires
 * so the app still returns a decision. No LLM, no async, no KV — just
 * the v1.8 A+ checklist evaluated against the input payload.
 *
 * The response shape matches the ALFRED route's response so the UI and
 * journal write path require zero changes. The only differences:
 *   - fallback: true             — UI uses this to show a banner
 *   - predicted_accuracy: null   — no calibration in fallback mode
 */

import { scoreToConfidence, type ConfidenceLabel } from '@/lib/alfred/confidence';

// ── Input ──────────────────────────────────────────────────────────────────
export interface FallbackScorerInput {
  direction?: 'LONG' | 'SHORT';
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi: number;
  trigger_volume?: number;
  avg_volume?: number;
  vwap?: number;
  ovx: number;
  dxy: 'rising' | 'falling' | 'flat' | 'neutral';
  fvg_direction: 'bullish' | 'bearish' | 'none';
  fvg_top?: number;
  fvg_bottom?: number;
  session: 'NY_OPEN' | 'NY_AFTERNOON' | 'LONDON' | 'OVERLAP' | 'ASIA' | 'OFF_HOURS';
  weekly_bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  eia_active: boolean;
}

// ── Output ─────────────────────────────────────────────────────────────────
export interface ChecklistItem {
  label: string;
  result: 'PASS' | 'FAIL';
  detail: string;
}

export interface FallbackScorerResult {
  score: number;
  grade: 'A+' | 'A' | 'B+' | 'B' | 'F';
  decision: 'LONG' | 'SHORT' | 'NO TRADE';
  confidence_label: ConfidenceLabel;
  checklist: ChecklistItem[];
  blocked_reasons: string[];
  wait_for: string | null;
  reasoning: string;
  disclaimer: string;
  fallback: true;
  predicted_accuracy: null;
}

// ── Constants ──────────────────────────────────────────────────────────────
const MIN_SCORE_TO_TRADE       = 7;
const COUNTERTREND_MIN_SCORE   = 9;
const OVX_HARD_BLOCK           = 50;
const EMA20_PROXIMITY_PCT      = 0.003; // 0.3%
const FALLBACK_DISCLAIMER =
  'AI scoring unavailable — deterministic fallback used. Treat as a sanity check, not a full ALFRED analysis.';

// ── Public entry point ─────────────────────────────────────────────────────
export function runFallbackScorer(input: FallbackScorerInput): FallbackScorerResult {
  // Resolve trade direction: caller-supplied wins, else fall back to weekly bias.
  // If both are absent/NEUTRAL we still score, but we'll mark as NO TRADE.
  const inferredDirection: 'LONG' | 'SHORT' | null =
    input.direction ?? (input.weekly_bias === 'NEUTRAL' ? null : input.weekly_bias);

  const dir: 'LONG' | 'SHORT' = inferredDirection ?? 'LONG'; // for scoring math; decision gated below

  // ── Hard blocks ─────────────────────────────────────────────────────────
  const blocked: string[] = [];
  if (input.eia_active)            blocked.push('EIA window active');
  if (input.ovx >= OVX_HARD_BLOCK) blocked.push(`OVX ${input.ovx} >= ${OVX_HARD_BLOCK} — extreme volatility`);
  if (input.session === 'ASIA' || input.session === 'OFF_HOURS') {
    blocked.push(`Outside valid session window (${input.session})`);
  }

  // ── Layer 1: Daily/Weekly bias (2 pts) ─────────────────────────────────
  const stackBullish = input.ema20 > input.ema50 && input.ema50 > input.ema200;
  const stackBearish = input.ema20 < input.ema50 && input.ema50 < input.ema200;
  const stackAligned = (dir === 'LONG' && stackBullish) || (dir === 'SHORT' && stackBearish);
  const biasConfirms =
    (input.weekly_bias === 'LONG'  && dir === 'LONG') ||
    (input.weekly_bias === 'SHORT' && dir === 'SHORT');

  // ── Layer 2: 4H momentum (2 pts) ────────────────────────────────────────
  const rsiInZone =
    (dir === 'LONG'  && input.rsi >= 35 && input.rsi <= 55) ||
    (dir === 'SHORT' && input.rsi >= 45 && input.rsi <= 65);
  // Volume confirmation: trigger candle volume vs 20-bar session average.
  // PASS at >= 1.0x, FAIL below 0.85x. The 0.85x-1.0x band is "conditional"
  // — flagged in the detail string but not auto-passed since the deterministic
  // scorer has no nuance to apply beyond the threshold.
  const volumeRatio =
    typeof input.trigger_volume === 'number' && typeof input.avg_volume === 'number' && input.avg_volume > 0
      ? input.trigger_volume / input.avg_volume
      : null;
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1.0;

  // ── Layer 3: Structure (2 pts) ──────────────────────────────────────────
  const fvgDirMatches =
    (dir === 'LONG'  && input.fvg_direction === 'bullish') ||
    (dir === 'SHORT' && input.fvg_direction === 'bearish');
  const insideFvg =
    fvgDirMatches &&
    typeof input.fvg_top === 'number' &&
    typeof input.fvg_bottom === 'number' &&
    input.price >= input.fvg_bottom &&
    input.price <= input.fvg_top;
  const nearEma20 =
    Math.abs(input.price - input.ema20) / input.ema20 <= EMA20_PROXIMITY_PCT;
  const priceAtKeyLevel = insideFvg || (input.fvg_direction === 'none' && nearEma20);
  // R/R can't be derived without stop/target — default pass unless EIA window
  const rrValid = !input.eia_active;

  // ── Layer 4: HTF context (2 pts) ────────────────────────────────────────
  const sessionOk = input.session === 'NY_OPEN' || input.session === 'LONDON' || input.session === 'OVERLAP';
  const eiaClear  = !input.eia_active;

  // ── Layer 5: 15min trigger (2 pts) ──────────────────────────────────────
  const vwapAligned =
    typeof input.vwap === 'number'
      ? (dir === 'LONG' ? input.price > input.vwap : input.price < input.vwap)
      : false;
  const ovxOk = input.ovx < OVX_HARD_BLOCK;

  // ── Build the 10-item checklist (matches ALFRED route's labels exactly) ─
  const checklist: ChecklistItem[] = [
    {
      label: 'EMA Stack Aligned',
      result: stackAligned ? 'PASS' : 'FAIL',
      detail: stackAligned
        ? `EMA stack aligned for ${dir} (20=${input.ema20} 50=${input.ema50} 200=${input.ema200})`
        : `EMA stack not aligned for ${dir}`,
    },
    {
      label: 'Daily Confirms',
      result: biasConfirms ? 'PASS' : 'FAIL',
      detail: biasConfirms
        ? `Weekly bias ${input.weekly_bias} confirms ${dir}`
        : `Weekly bias ${input.weekly_bias} does not confirm ${dir}`,
    },
    {
      label: 'RSI Reset Zone',
      result: rsiInZone ? 'PASS' : 'FAIL',
      detail: rsiInZone
        ? `RSI ${input.rsi} inside reset zone for ${dir}`
        : `RSI ${input.rsi} outside reset zone (${dir === 'LONG' ? '35-55' : '45-65'})`,
    },
    {
      label: 'Volume Confirmed',
      result: volumeConfirmed ? 'PASS' : 'FAIL',
      detail:
        volumeRatio === null
          ? 'Trigger candle / avg volume not provided'
          : volumeConfirmed
          ? `Trigger volume ${volumeRatio.toFixed(2)}x avg — institutional participation confirmed`
          : volumeRatio >= 0.85
          ? `Trigger volume ${volumeRatio.toFixed(2)}x avg — conditional, weak (no auto-pass)`
          : `Trigger volume ${volumeRatio.toFixed(2)}x avg — thin, no institutional footprint`,
    },
    {
      label: 'Price at Key Level',
      result: priceAtKeyLevel ? 'PASS' : 'FAIL',
      detail: insideFvg
        ? `Price ${input.price} inside ${input.fvg_direction} FVG (${input.fvg_bottom}-${input.fvg_top})`
        : nearEma20
          ? `Price ${input.price} within 0.3% of EMA20 ${input.ema20}`
          : `Price ${input.price} not at FVG or EMA20`,
    },
    {
      label: 'R/R Valid',
      result: rrValid ? 'PASS' : 'FAIL',
      detail: rrValid
        ? 'R/R cannot be evaluated in fallback mode — default pass'
        : 'EIA window blocks R/R validity',
    },
    {
      label: 'Session Timing',
      result: sessionOk ? 'PASS' : 'FAIL',
      detail: sessionOk
        ? `Session ${input.session} is a valid window`
        : `Session ${input.session} outside valid window`,
    },
    {
      label: 'EIA Window Clear',
      result: eiaClear ? 'PASS' : 'FAIL',
      detail: eiaClear ? 'No EIA window active' : 'EIA window active — hard block',
    },
    {
      label: 'VWAP Aligned',
      result: vwapAligned ? 'PASS' : 'FAIL',
      detail:
        typeof input.vwap === 'number'
          ? `Price ${input.price} ${dir === 'LONG' ? 'above' : 'below'} VWAP ${input.vwap} = ${vwapAligned ? 'aligned' : 'against trade'}`
          : 'VWAP not provided',
    },
    {
      label: 'HTF Structure Clear',
      result: ovxOk ? 'PASS' : 'FAIL',
      detail: ovxOk
        ? `OVX ${input.ovx} below hard-block threshold`
        : `OVX ${input.ovx} above ${OVX_HARD_BLOCK} — hard block`,
    },
  ];

  const score = checklist.reduce((s, c) => s + (c.result === 'PASS' ? 1 : 0), 0);

  // ── Decision ────────────────────────────────────────────────────────────
  const isCountertrend =
    inferredDirection !== null &&
    input.weekly_bias !== 'NEUTRAL' &&
    inferredDirection !== input.weekly_bias;
  const requiredScore = isCountertrend ? COUNTERTREND_MIN_SCORE : MIN_SCORE_TO_TRADE;

  let decision: 'LONG' | 'SHORT' | 'NO TRADE';
  if (blocked.length > 0)            decision = 'NO TRADE';
  else if (inferredDirection === null) decision = 'NO TRADE';
  else if (score >= requiredScore)   decision = inferredDirection;
  else                               decision = 'NO TRADE';

  const confidence_label = scoreToConfidence(score);
  const grade = scoreToGrade(score);

  // ── Reasoning ───────────────────────────────────────────────────────────
  const reasoning =
    decision === 'NO TRADE'
      ? `[FALLBACK] Score ${score}/10 (${grade}). ${blocked.length > 0 ? 'Blocked: ' + blocked.join('; ') + '. ' : ''}` +
        `Required ${requiredScore}/10 to trade${isCountertrend ? ' (countertrend)' : ''}. ` +
        `Anthropic API unreachable — this is a deterministic fallback, not full ALFRED analysis.`
      : `[FALLBACK] Score ${score}/10 (${grade}) — ${decision} ${isCountertrend ? '(countertrend, 9+ required) ' : ''}` +
        `meets minimum threshold. EMA stack ${stackAligned ? 'aligned' : 'unaligned'}, ` +
        `RSI ${input.rsi} ${rsiInZone ? 'in' : 'outside'} reset zone, ` +
        `${insideFvg ? 'inside FVG' : nearEma20 ? 'near EMA20' : 'no key-level confluence'}. ` +
        `Anthropic API unreachable — this is a deterministic fallback, not full ALFRED analysis.`;

  return {
    score,
    grade,
    decision,
    confidence_label,
    checklist,
    blocked_reasons: blocked,
    wait_for: null,
    reasoning,
    disclaimer: FALLBACK_DISCLAIMER,
    fallback: true,
    predicted_accuracy: null,
  };
}

function scoreToGrade(score: number): 'A+' | 'A' | 'B+' | 'B' | 'F' {
  if (score === 10) return 'A+';
  if (score >= 8)   return 'A';
  if (score === 7)  return 'B+';
  if (score >= 5)   return 'B';
  return 'F';
}
