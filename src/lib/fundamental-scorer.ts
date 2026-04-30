/**
 * fundamental-scorer.ts
 * Crude Intentions — Quantitative Fundamental Layer
 *
 * Adapted from energyfuturesexecution (carry_rolldown.py + alpha_signals.py)
 * Calibrated for CL 4H directional trading on Apex — not institutional MM.
 *
 * Two exports:
 *   computeCarryRegime()  — annualized roll yield → regime classification → confluence delta
 *   computeAlphaScore()   — 5-factor composite → normalized [-1, +1] → ALFRED label
 *
 * Both are pure math. Zero LLM calls. Zero side effects.
 * Feed their output into the ALFRED prompt before the LLM runs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CARRY REGIME
// ─────────────────────────────────────────────────────────────────────────────

export interface CarryInput {
  /** Front-month (M1) CL settlement price — e.g. 62.40 */
  m1Price: number;
  /** ~3-month deferred (M4) CL settlement price — e.g. 63.80 */
  m4Price: number;
  /** Trade direction being evaluated */
  direction: "LONG" | "SHORT";
}

export type CarryRegime =
  | "STEEP_BACKWARDATION"
  | "MODERATE_BACKWARDATION"
  | "FLAT"
  | "MODERATE_CONTANGO"
  | "STEEP_CONTANGO";

export interface CarryResult {
  /** Annualized roll yield. Positive = backwardation, negative = contango */
  annualizedRollYield: number;
  /** Human-readable roll yield as percentage string, e.g. "+4.2%" */
  rollYieldPct: string;
  /** Regime classification */
  regime: CarryRegime;
  /**
   * Confluence point delta for the A+ checklist.
   * Steep backwardation = +1 for longs.
   * Steep contango = -2 for longs (inverted for shorts).
   */
  confluenceDelta: number;
  /** 25% size reduction flag — triggered on steep contango for longs */
  sizeReductionFlag: boolean;
  /** One-line human summary for ALFRED prompt injection */
  summary: string;
}

/**
 * Compute carry regime from M1/M4 prices.
 *
 * Formula (from energyfuturesexecution carry_rolldown.py):
 *   annualized_roll_yield = -(M4 - M1) / M1 × (12 / 3)
 *
 * Positive = backwardation (near > far = carry earner for longs)
 * Negative = contango (near < far = carry cost for longs)
 */
export function computeCarryRegime(input: CarryInput): CarryResult {
  const { m1Price, m4Price, direction } = input;

  // Core calculation — 4 as the denominator because M4 is ~3 months out
  const raw = -(m4Price - m1Price) / m1Price;
  const annualizedRollYield = raw * 4; // annualize: × (12/3)
  const pct = annualizedRollYield * 100;

  // Regime thresholds (from market_selection_summary.md v1.8)
  let regime: CarryRegime;
  if (pct > 10) regime = "STEEP_BACKWARDATION";
  else if (pct >= 3) regime = "MODERATE_BACKWARDATION";
  else if (pct > -3) regime = "FLAT";
  else if (pct >= -10) regime = "MODERATE_CONTANGO";
  else regime = "STEEP_CONTANGO";

  // Confluence delta — direction-aware
  // For longs: backwardation = tailwind (+), contango = headwind (-)
  // For shorts: invert (contango = tailwind for shorts)
  const longDelta =
    regime === "STEEP_BACKWARDATION" ? 1
    : regime === "MODERATE_BACKWARDATION" ? 0
    : regime === "FLAT" ? 0
    : regime === "MODERATE_CONTANGO" ? -1
    : -2; // STEEP_CONTANGO

  const confluenceDelta = direction === "LONG" ? longDelta : -longDelta;

  // Size reduction flag: steep contango hurts longs, steep backwardation hurts shorts
  const sizeReductionFlag =
    (direction === "LONG" && regime === "STEEP_CONTANGO") ||
    (direction === "SHORT" && regime === "STEEP_BACKWARDATION");

  // Human summary for prompt injection
  const sign = pct >= 0 ? "+" : "";
  const rollYieldPct = `${sign}${pct.toFixed(1)}%`;
  const regimeLabel = regime.replace(/_/g, " ").toLowerCase();

  let summary = `Carry: ${rollYieldPct} annualized roll yield — ${regimeLabel}.`;
  if (confluenceDelta > 0) summary += ` Tailwind for ${direction} (carry confirms tightness).`;
  else if (confluenceDelta < 0) summary += ` Headwind for ${direction}${sizeReductionFlag ? " — reduce size 25%" : ""}.`;
  else summary += " Carry neutral — technical setup carries full weight.";

  return {
    annualizedRollYield,
    rollYieldPct,
    regime,
    confluenceDelta,
    sizeReductionFlag,
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSITE ALPHA SCORER
// ─────────────────────────────────────────────────────────────────────────────

export interface AlphaInput {
  // ── Term structure signal ──
  /** Front-month price (M1) */
  m1Price: number;
  /** Deferred price (M4) */
  m4Price: number;

  // ── Inventory z-score signal ──
  /**
   * EIA inventory z-score — already computed upstream.
   * Formula: (current - 5yr_seasonal_avg) / ((5yr_high - 5yr_low) / 4)
   * Pass null if not available this week.
   */
  inventoryZScore: number | null;

  // ── Seasonal signal ──
  /**
   * Current calendar month (1–12).
   * Used to look up crude oil seasonal pattern.
   */
  month: number;

  // ── Momentum signal ──
  /**
   * Price momentum over lookback window — normalized to price.
   * Simplest version: (current_price - price_N_bars_ago) / price_N_bars_ago
   * Use 20-bar 4H lookback (= ~5 trading days).
   * Pass null if unavailable.
   */
  momentum20: number | null;

  // ── Crack spread signal ──
  /**
   * 3-2-1 crack spread in $/bbl.
   * Formula: (2 × RBOB_per_bbl + 1 × HO_per_bbl - 3 × CL) / 3
   * Convert RBOB and HO from cents/gallon: price_cents × 42 / 100
   * Pass null if unavailable.
   */
  crackSpread321: number | null;

  /** Trade direction being scored */
  direction: "LONG" | "SHORT";
}

export interface AlphaSignalBreakdown {
  termStructure: number;   // [-1, +1]
  inventory: number;       // [-1, +1] or 0 if null
  seasonal: number;        // [-1, +1]
  momentum: number;        // [-1, +1] or 0 if null
  crackSpread: number;     // [-1, +1] or 0 if null
}

export type AlphaLabel = "STRONG_BULL" | "BULL" | "NEUTRAL" | "BEAR" | "STRONG_BEAR";

export interface AlphaResult {
  /** Composite score — weighted sum, normalized to [-1, +1] */
  composite: number;
  /** Signal breakdown — each factor [-1, +1] */
  signals: AlphaSignalBreakdown;
  /** Human label */
  label: AlphaLabel;
  /**
   * Confluence adjustment for the A+ checklist.
   * Strong bull/bear = ±1. Neutral = 0. Conflicted signals = note only.
   */
  confluenceDelta: number;
  /** One-line summary for ALFRED prompt injection */
  summary: string;
  /** Which signals are active (non-null inputs) */
  activeSignalCount: number;
}

/**
 * CL seasonal bias by month.
 * Positive = historically bullish (demand season), negative = historically bearish.
 * Based on: summer driving demand (May–Aug), winter heating (Dec–Feb), weak shoulders (Mar–Apr, Sep–Oct).
 * Values are rough directional weights, not precise historical returns.
 */
const SEASONAL_WEIGHTS: Record<number, number> = {
  1:  0.3,   // Jan — winter heating tail, refinery maintenance starts
  2:  0.2,   // Feb — late winter demand
  3: -0.2,   // Mar — spring shoulder, weakest period
  4: -0.3,   // Apr — shoulder, refinery turnarounds, weakest month
  5:  0.3,   // May — summer driving demand begins
  6:  0.5,   // Jun — summer peak demand
  7:  0.4,   // Jul — peak summer
  8:  0.1,   // Aug — late summer, demand starts fading
  9: -0.2,   // Sep — post-summer shoulder
  10: -0.1,  // Oct — transition
  11:  0.2,  // Nov — heating season ramp
  12:  0.4,  // Dec — winter heating peak
};

/**
 * Crack spread thresholds ($/bbl) — from market_selection_summary.md v1.8
 */
const CRACK_STRONG_BULL = 30;  // above = strong refinery demand
const CRACK_NEUTRAL_LOW = 15;  // 15–30 = normal
const CRACK_WEAK = 10;         // below 15 = weak margins (bear)
                               // below 10 = demand destruction (strong bear)

/**
 * Signal weights — tuned for 4H directional CL trading.
 * Inventory and term structure are primary (they measure the same thing: tightness).
 * Seasonal and crack spread are secondary confirming factors.
 * Momentum is tertiary — trend-following confirmation only.
 */
const WEIGHTS = {
  termStructure: 0.30,
  inventory:     0.30,
  seasonal:      0.15,
  momentum:      0.10,
  crackSpread:   0.15,
};

/**
 * Clamp a value to [-1, +1].
 */
function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/**
 * Compute composite alpha score from 5 signal families.
 * Each signal normalized to [-1, +1] before weighting.
 * Missing signals (null inputs) use weight-0 fallback — composite
 * re-normalized against active signal weight sum.
 */
export function computeAlphaScore(input: AlphaInput): AlphaResult {
  const { m1Price, m4Price, inventoryZScore, month, momentum20, crackSpread321, direction } = input;

  // ── 1. Term structure signal ──
  // Front-deferred spread normalized by front price
  // Backwardation (M1 > M4) = positive = bullish signal
  const tsBullNorm = clamp((m1Price - m4Price) / m1Price * 10); // ×10 to scale small pct moves to [-1,+1]
  const termStructure = tsBullNorm;

  // ── 2. Inventory z-score signal ──
  // Low z-score = tight inventory = bullish. Inverted and clamped.
  // z < -2 → +1, z > +2 → -1, linear interpolation between
  let inventory = 0;
  if (inventoryZScore !== null) {
    inventory = clamp(-inventoryZScore / 2);
  }

  // ── 3. Seasonal signal ──
  const seasonal = clamp(SEASONAL_WEIGHTS[month] ?? 0);

  // ── 4. Momentum signal ──
  // Price return over 20-bar 4H lookback — already a fraction
  // Scale: ±5% move → ±1 (divide by 0.05)
  let momentum = 0;
  if (momentum20 !== null) {
    momentum = clamp(momentum20 / 0.05);
  }

  // ── 5. Crack spread signal ──
  let crackSpread = 0;
  if (crackSpread321 !== null) {
    if (crackSpread321 > CRACK_STRONG_BULL)      crackSpread = 1.0;
    else if (crackSpread321 >= CRACK_NEUTRAL_LOW) crackSpread = clamp((crackSpread321 - CRACK_NEUTRAL_LOW) / (CRACK_STRONG_BULL - CRACK_NEUTRAL_LOW));
    else if (crackSpread321 >= CRACK_WEAK)        crackSpread = -0.5;
    else                                          crackSpread = -1.0;
  }

  // ── Weighted composite ──
  // Re-normalize by active weight sum so missing signals don't drag score toward 0
  let weightSum = WEIGHTS.termStructure; // term structure always active
  let rawComposite = termStructure * WEIGHTS.termStructure;

  if (inventoryZScore !== null) {
    rawComposite += inventory * WEIGHTS.inventory;
    weightSum += WEIGHTS.inventory;
  }
  rawComposite += seasonal * WEIGHTS.seasonal;
  weightSum += WEIGHTS.seasonal;

  if (momentum20 !== null) {
    rawComposite += momentum * WEIGHTS.momentum;
    weightSum += WEIGHTS.momentum;
  }
  if (crackSpread321 !== null) {
    rawComposite += crackSpread * WEIGHTS.crackSpread;
    weightSum += WEIGHTS.crackSpread;
  }

  const composite = clamp(rawComposite / weightSum);

  // ── Label ──
  let label: AlphaLabel;
  if (composite > 0.5)       label = "STRONG_BULL";
  else if (composite > 0.15) label = "BULL";
  else if (composite > -0.15) label = "NEUTRAL";
  else if (composite > -0.5) label = "BEAR";
  else                       label = "STRONG_BEAR";

  // ── Confluence delta — direction-aware ──
  const bullishForDirection = direction === "LONG";
  let confluenceDelta = 0;
  if (label === "STRONG_BULL") confluenceDelta = bullishForDirection ? 1 : -1;
  else if (label === "STRONG_BEAR") confluenceDelta = bullishForDirection ? -1 : 1;
  // BULL / BEAR / NEUTRAL = 0 (note only, doesn't add/subtract from score)

  // ── Active signal count ──
  const activeSignalCount =
    1 + // term structure always active
    (inventoryZScore !== null ? 1 : 0) +
    1 + // seasonal always active
    (momentum20 !== null ? 1 : 0) +
    (crackSpread321 !== null ? 1 : 0);

  // ── Summary string ──
  const pct = (composite * 100).toFixed(0);
  const sign = composite >= 0 ? "+" : "";
  const labelStr = label.replace(/_/g, " ").toLowerCase();
  const signalStr = `${activeSignalCount}/5 signals active`;
  let summary = `Alpha: ${sign}${pct}% composite (${labelStr}) — ${signalStr}.`;
  if (confluenceDelta > 0) summary += ` Fundamental confirms ${direction}.`;
  else if (confluenceDelta < 0) summary += ` Fundamental conflicts with ${direction} — raise the bar.`;
  else summary += " Fundamental neutral — technical setup carries full weight.";

  return {
    composite,
    signals: { termStructure, inventory, seasonal, momentum, crackSpread },
    label,
    confluenceDelta,
    summary,
    activeSignalCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED REGIME SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

export interface FundamentalContext {
  carry: CarryResult;
  alpha: AlphaResult;
  /**
   * Net confluence delta — carry + alpha combined.
   * Passed into ALFRED prompt. ALFRED applies it to the checklist score.
   */
  netConfluenceDelta: number;
  /**
   * Combined regime read — mirrors the Combined Carry + Z-Score table
   * from market_selection_summary.md
   */
  regimeRead: string;
  /** Full prompt block for injection into ALFRED system prompt */
  promptBlock: string;
}

/**
 * Run both scorers and produce a single context object for ALFRED injection.
 */
export function buildFundamentalContext(
  carryInput: CarryInput,
  alphaInput: AlphaInput
): FundamentalContext {
  const carry = computeCarryRegime(carryInput);
  const alpha = computeAlphaScore(alphaInput);

  const netConfluenceDelta = carry.confluenceDelta + alpha.confluenceDelta;

  // Combined regime read — simplified from the 3×3 table in market_selection_summary.md
  let regimeRead: string;
  const carryBull = carry.confluenceDelta > 0;
  const carryBear = carry.confluenceDelta < 0;
  const alphaBull = alpha.label === "STRONG_BULL" || alpha.label === "BULL";
  const alphaBear = alpha.label === "STRONG_BEAR" || alpha.label === "BEAR";

  if (carryBull && alphaBull)       regimeRead = "STRONG BULL — carry and alpha both confirm tightness";
  else if (carryBull && alphaBear)  regimeRead = "CONFLICTED — carry bullish but alpha bearish";
  else if (carryBull)               regimeRead = "MILD BULL — carry tailwind, alpha neutral";
  else if (carryBear && alphaBear)  regimeRead = "STRONG BEAR — carry and alpha both confirm glut";
  else if (carryBear && alphaBull)  regimeRead = "CONFLICTED — carry bearish but alpha bullish";
  else if (carryBear)               regimeRead = "MILD BEAR — carry headwind, alpha neutral";
  else if (alphaBull)               regimeRead = "MILD BULL — alpha confirms demand, carry flat";
  else if (alphaBear)               regimeRead = "MILD BEAR — alpha signals glut, carry flat";
  else                              regimeRead = "NEUTRAL — technical setup carries full weight";

  // Prompt block — injected before ALFRED's checklist scoring
  const sizeNote = carry.sizeReductionFlag
    ? "\n⚠️  SIZE REDUCTION: Reduce position size 25% regardless of A+ score."
    : "";

  const promptBlock = `
=== QUANTITATIVE FUNDAMENTAL LAYER (pre-computed, no LLM) ===
${carry.summary}
${alpha.summary}
Regime Read: ${regimeRead}
Net Confluence Delta: ${netConfluenceDelta > 0 ? "+" : ""}${netConfluenceDelta} (apply to final score: positive = adds points toward trade, negative = raises the bar)${sizeNote}

Signal Breakdown:
  Term Structure: ${(alpha.signals.termStructure * 100).toFixed(0)}%
  Inventory Z-Score: ${alpha.signals.inventory !== 0 ? (alpha.signals.inventory * 100).toFixed(0) + "%" : "N/A (not provided)"}
  Seasonal (month ${alphaInput.month}): ${(alpha.signals.seasonal * 100).toFixed(0)}%
  Momentum 20-bar: ${alpha.signals.momentum !== 0 ? (alpha.signals.momentum * 100).toFixed(0) + "%" : "N/A (not provided)"}
  Crack Spread 3-2-1: ${alpha.signals.crackSpread !== 0 ? (alpha.signals.crackSpread * 100).toFixed(0) + "%" : "N/A (not provided)"}
=================================================================
`.trim();

  return { carry, alpha, netConfluenceDelta, regimeRead, promptBlock };
}
