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
  fvg_age_bars?: number;
  session: 'NY_OPEN' | 'NY_AFTERNOON' | 'LONDON' | 'OVERLAP' | 'ASIA' | 'OFF_HOURS';
  weekly_bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  eia_active: boolean;
  // v1.9 Layer 6 inputs — optional (N/A when absent).
  asia_high?: number;
  asia_low?: number;
}

// ── Output ─────────────────────────────────────────────────────────────────
export interface ChecklistItem {
  label: string;
  // v1.9: items 11-12 widen to 4-state. Items 1-10 still emit PASS/FAIL only.
  result: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'N/A';
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
const MIN_SCORE_TO_TRADE       = 9;   // v1.9: 12-point system, min 9/12
const COUNTERTREND_MIN_SCORE   = 11;  // v1.9: countertrend keeps a +2 differential
const OVX_HARD_BLOCK           = 50;
const OVX_REGIME_LOW           = 20;
const OVX_REGIME_PASS_HIGH     = 35;
const OVX_REGIME_CONDITIONAL_HIGH = 50;
const OVERNIGHT_RANGE_PROXIMITY = 0.15;
const EMA20_PROXIMITY_PCT      = 0.003; // 0.3% — legacy, not used for item 5

// Layer 3 / item 5 (price_at_key_level) — FVG is the required structural condition.
// EMA20 / round-level / large-gap appear only as quality boosters in the detail string.
const FVG_PASS_PROXIMITY        = 0.10; // price within $0.10 of relevant edge OR inside the gap
const FVG_CONDITIONAL_PROXIMITY = 0.20; // approaching — emitted as FAIL with "approaching" note
const FVG_FAIL_PROXIMITY        = 0.30; // farther than this = no FVG context at all
const FVG_MAX_AGE_BARS          = 75;
const FVG_FRESH_AGE_BARS        = 25;
const FVG_EMA20_CONFLUENCE      = 0.15;
const FVG_ROUND_LEVEL_BAND      = 0.10;
const FVG_LARGE_GAP_SIZE        = 0.30;
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
  // v1.9 FVG-required: item 5 (price_at_key_level) only PASSes when an
  // unfilled, fresh-enough 4H FVG exists AND price is inside the gap or
  // within $0.10 of the relevant edge. EMA20 / round level proximity and
  // gap freshness/size become quality boosters — surfaced in the detail
  // string but never standalone pass conditions.
  const fvgDirMatches =
    (dir === 'LONG'  && input.fvg_direction === 'bullish') ||
    (dir === 'SHORT' && input.fvg_direction === 'bearish');
  const fvgTop = input.fvg_top;
  const fvgBottom = input.fvg_bottom;
  const fvgAge = input.fvg_age_bars;
  const haveFvg =
    fvgDirMatches && typeof fvgTop === 'number' && typeof fvgBottom === 'number';
  const fvgUnmitigated =
    haveFvg && typeof fvgAge === 'number' ? fvgAge < FVG_MAX_AGE_BARS : haveFvg;
  // Midpoint-breached check: for a bullish FVG, price below the midpoint
  // means buyers already overran the gap; mirror for bearish.
  const fvgMidpoint = haveFvg ? ((fvgTop! + fvgBottom!) / 2) : null;
  const fvgMidpointBreached =
    haveFvg && fvgMidpoint !== null
      ? (dir === 'LONG' ? input.price < fvgMidpoint : input.price > fvgMidpoint) &&
        !(input.price >= fvgBottom! && input.price <= fvgTop!)
      : false;
  const insideFvg =
    haveFvg && input.price >= fvgBottom! && input.price <= fvgTop!;
  // Distance from the relevant edge (top for longs, bottom for shorts).
  const fvgEdgeDistance = haveFvg
    ? dir === 'LONG'
      ? Math.abs(input.price - fvgTop!)
      : Math.abs(input.price - fvgBottom!)
    : Infinity;
  const fvgWithinPass =
    haveFvg && fvgUnmitigated && !fvgMidpointBreached &&
    (insideFvg || fvgEdgeDistance <= FVG_PASS_PROXIMITY);
  const fvgWithinConditional =
    haveFvg && fvgUnmitigated && !fvgMidpointBreached &&
    !fvgWithinPass &&
    fvgEdgeDistance <= FVG_CONDITIONAL_PROXIMITY;
  const priceAtKeyLevel = fvgWithinPass;
  // Quality boosters — detail-only, do not change PASS/FAIL.
  const ema20Confluence =
    haveFvg && Math.abs(input.price - input.ema20) <= FVG_EMA20_CONFLUENCE;
  const nearestRoundDollar = Math.round(input.price);
  const roundLevelConfluence =
    haveFvg && Math.abs(input.price - nearestRoundDollar) <= FVG_ROUND_LEVEL_BAND;
  const freshGap =
    haveFvg && typeof fvgAge === 'number' && fvgAge < FVG_FRESH_AGE_BARS;
  const largeGap =
    haveFvg && (fvgTop! - fvgBottom!) > FVG_LARGE_GAP_SIZE;
  const qualityBoosters: string[] = [];
  if (ema20Confluence)     qualityBoosters.push('EMA20 confluence');
  if (roundLevelConfluence) qualityBoosters.push('round level confluence');
  if (freshGap)            qualityBoosters.push('fresh gap');
  if (largeGap)            qualityBoosters.push('large gap');
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
      detail: (() => {
        if (!haveFvg) {
          return `No matching ${dir === 'LONG' ? 'bullish' : 'bearish'} 4H FVG provided — FVG required for Layer 2 structural entry`;
        }
        if (!fvgUnmitigated) {
          return `4H FVG (${fvgBottom}-${fvgTop}) is ${fvgAge} bars old — over ${FVG_MAX_AGE_BARS} bar staleness limit`;
        }
        if (fvgMidpointBreached) {
          return `Price ${input.price} traded through ${input.fvg_direction} FVG midpoint (${fvgMidpoint?.toFixed(2)}) — gap mitigated`;
        }
        const boosters = qualityBoosters.length ? ` [${qualityBoosters.join(', ')}]` : '';
        if (insideFvg) {
          return `Price ${input.price} inside ${input.fvg_direction} FVG (${fvgBottom}-${fvgTop})${boosters}`;
        }
        if (fvgWithinPass) {
          return `Price ${input.price} within ${FVG_PASS_PROXIMITY} of ${input.fvg_direction} FVG edge (${dir === 'LONG' ? `top ${fvgTop}` : `bottom ${fvgBottom}`})${boosters}`;
        }
        if (fvgWithinConditional) {
          return `Price ${input.price} within ${FVG_CONDITIONAL_PROXIMITY} of FVG edge — approaching but not yet at structural entry${boosters}`;
        }
        if (fvgEdgeDistance <= FVG_FAIL_PROXIMITY) {
          return `Price ${input.price} ${fvgEdgeDistance.toFixed(2)} from FVG edge — outside ${FVG_PASS_PROXIMITY} pass band`;
        }
        return `Price ${input.price} more than ${FVG_FAIL_PROXIMITY} from nearest FVG edge — no structural FVG entry`;
      })(),
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
    // ── Layer 6 (v1.9): Session Context (2 pts) ─────────────────────────────
    (() => {
      // Overnight range position
      const ah = input.asia_high;
      const al = input.asia_low;
      if (typeof ah !== 'number' || typeof al !== 'number') {
        return {
          label: 'Overnight Range Position',
          result: 'N/A' as const,
          detail: 'Asia session high/low not provided',
        };
      }
      if (dir === 'LONG') {
        if (input.price > ah) {
          return {
            label: 'Overnight Range Position',
            result: 'PASS' as const,
            detail: `Price ${input.price} above Asia high ${ah} — range breakout confirmed`,
          };
        }
        if (input.price >= ah - OVERNIGHT_RANGE_PROXIMITY) {
          return {
            label: 'Overnight Range Position',
            result: 'CONDITIONAL' as const,
            detail: `Price ${input.price} within ${OVERNIGHT_RANGE_PROXIMITY} of Asia high ${ah} — approaching breakout, reduce conviction`,
          };
        }
        return {
          label: 'Overnight Range Position',
          result: 'FAIL' as const,
          detail: `Price ${input.price} buried in Asia range (${al}-${ah})`,
        };
      }
      // SHORT
      if (input.price < al) {
        return {
          label: 'Overnight Range Position',
          result: 'PASS' as const,
          detail: `Price ${input.price} below Asia low ${al} — range breakdown confirmed`,
        };
      }
      if (input.price <= al + OVERNIGHT_RANGE_PROXIMITY) {
        return {
          label: 'Overnight Range Position',
          result: 'CONDITIONAL' as const,
          detail: `Price ${input.price} within ${OVERNIGHT_RANGE_PROXIMITY} of Asia low ${al} — approaching breakdown, reduce conviction`,
        };
      }
      return {
        label: 'Overnight Range Position',
        result: 'FAIL' as const,
        detail: `Price ${input.price} buried in Asia range (${al}-${ah})`,
      };
    })(),
    (() => {
      // OVX regime
      const o = input.ovx;
      if (o >= OVX_REGIME_LOW && o <= OVX_REGIME_PASS_HIGH) {
        return {
          label: 'OVX Regime Clean',
          result: 'PASS' as const,
          detail: `OVX ${o} in clean regime (${OVX_REGIME_LOW}-${OVX_REGIME_PASS_HIGH})`,
        };
      }
      if (o > OVX_REGIME_PASS_HIGH && o <= OVX_REGIME_CONDITIONAL_HIGH) {
        return {
          label: 'OVX Regime Clean',
          result: 'CONDITIONAL' as const,
          detail: `OVX ${o} elevated (${OVX_REGIME_PASS_HIGH}-${OVX_REGIME_CONDITIONAL_HIGH}) — size down`,
        };
      }
      return {
        label: 'OVX Regime Clean',
        result: 'FAIL' as const,
        detail:
          o > OVX_REGIME_CONDITIONAL_HIGH
            ? `OVX ${o} above ${OVX_REGIME_CONDITIONAL_HIGH} — hard-block territory`
            : `OVX ${o} below ${OVX_REGIME_LOW} — choppy low-vol regime`,
      };
    })(),
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
      ? `[FALLBACK] Score ${score}/12 (${grade}). ${blocked.length > 0 ? 'Blocked: ' + blocked.join('; ') + '. ' : ''}` +
        `Required ${requiredScore}/12 to trade${isCountertrend ? ' (countertrend)' : ''}. ` +
        `Anthropic API unreachable — this is a deterministic fallback, not full ALFRED analysis.`
      : `[FALLBACK] Score ${score}/12 (${grade}) — ${decision} ${isCountertrend ? '(countertrend, 11+ required) ' : ''}` +
        `meets minimum threshold. EMA stack ${stackAligned ? 'aligned' : 'unaligned'}, ` +
        `RSI ${input.rsi} ${rsiInZone ? 'in' : 'outside'} reset zone, ` +
        `${insideFvg ? 'inside FVG' : fvgWithinPass ? 'at FVG edge' : 'no FVG structural entry'}. ` +
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
  // v1.9: 12-point system per spec.
  if (score === 12) return 'A+';
  if (score >= 10)  return 'A';
  if (score === 9)  return 'B+';
  if (score >= 7)   return 'B';
  return 'F';
}
