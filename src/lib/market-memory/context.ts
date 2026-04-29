/**
 * CRUDE INTENTIONS — Market Memory (Phase 2C)
 *
 * Solves ALFRED's goldfish problem. Without this, every ALFRED analysis
 * starts from zero — no knowledge of what was said last session, no
 * awareness of the current bias, no memory of which levels are active.
 *
 * This module has three responsibilities:
 *
 * 1. READ  — load the current market context from KV for prompt injection
 * 2. WRITE — update the context after each ALFRED analysis session
 * 3. BUILD — construct the market memory section of the ALFRED system prompt
 *
 * The always-on backtesting connection:
 * After a trade closes, updateContextFromOutcome() is called alongside
 * the calibration recalc. It marks that trade idea as TRIGGERED + outcome,
 * updates the "recent closed trades" section, and lets ALFRED's next
 * analysis see "the last 3 trades in this regime were: X, Y, Z with
 * outcomes W1, W2, L1." That is live performance feedback inside the
 * prompt, not a frozen model.
 *
 * Drop in at: src/lib/market-memory/context.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Schema — matches CRUDE_INTENTIONS_DATA_CONTRACTS.md section 4 exactly
// with additions for the recent-closed-trades backtesting layer
// ─────────────────────────────────────────────────────────────────────────────

export type BiasDirection   = "LONG" | "SHORT" | "NEUTRAL";
export type BiasStrength    = "STRONG" | "MODERATE" | "WEAK";
export type FvgStatus       = "unfilled" | "partially_filled" | "filled";
export type FvgTimeframe    = "4H" | "1H" | "15min";
export type FvgQuality      = "high" | "medium" | "low";
export type EmaAlignment    = "BULLISH" | "BEARISH" | "MIXED";
export type IdeaStatus      = "WATCHING" | "READY" | "TRIGGERED" | "INVALIDATED";

export interface ActiveFvg {
  id: string;
  direction: "bullish" | "bearish";
  top: number;
  bottom: number;
  age_bars: number;
  status: FvgStatus;
  timeframe: FvgTimeframe;
  quality: FvgQuality;
  created_at: string;
}

export interface TradeIdea {
  id: string;
  direction: "LONG" | "SHORT";
  status: IdeaStatus;
  entry_zone: string;
  entry_price: number | null;
  target: number;
  stop: number;
  notes: string;
  created_at: string;
  last_updated: string;
}

// Recent closed trades — the live backtesting layer inside the prompt.
// ALFRED sees the last N closed trades before it writes its analysis,
// which means its output reflects what the rules have actually been
// producing, not just what they promise to produce.
export interface RecentClosedTrade {
  id: string;
  direction: "LONG" | "SHORT";
  outcome: "WIN" | "LOSS" | "SCRATCH";
  result_r: number;
  score: number;
  confidence_label: string;
  session: string;
  close_timestamp: string;
  key_factors: string;    // 1-line summary of what drove the result
}

export interface MarketContext {
  schema_version: "1.1";
  last_updated: string;
  last_bar: string;
  session_count: number;

  current_bias: BiasDirection;
  bias_strength: BiasStrength;
  bias_set_at: string;
  invalidation_notes: string | null;

  key_levels: {
    resistance: number[];
    support: number[];
    notes: string | null;
  };

  active_fvgs: ActiveFvg[];

  ema_stack: {
    ema20: number;
    ema50: number;
    ema200: number;
    alignment: EmaAlignment;
  };

  oscillators: {
    rsi_4h: number;
    rsi_1h: number | null;
    macd_histogram: number | null;
  };

  macro_backdrop: string;

  active_trade_ideas: TradeIdea[];

  // New in v1.1 — the always-on backtesting layer
  recent_closed_trades: RecentClosedTrade[];
  recent_win_rate: number | null;    // win rate across recent_closed_trades
  recent_expectancy_r: number | null;

  context_age_warning: boolean;

  // New in v1.2 — supply context derived from EIA
  supply_context?: SupplyContext | null;
}

export type CushingTrend = 'BUILDING' | 'DRAWING' | 'FLAT';
export type EiaWeeklyTrend = 'BUILDS' | 'DRAWS' | 'MIXED';
export type RigCountTrend = 'RISING' | 'FALLING' | 'FLAT';
export type SupplyBias = 'BEARISH' | 'NEUTRAL' | 'BULLISH';

export interface SupplyContext {
  cushing_vs_4wk: CushingTrend | null;
  eia_4wk_trend: EiaWeeklyTrend | null;
  rig_count_trend: RigCountTrend | null;
  supply_bias: SupplyBias | null;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const KV_KEY = "market:context";
const MAX_ACTIVE_FVGS = 10;
const MAX_ACTIVE_IDEAS = 5;
const MAX_RECENT_TRADES = 10;   // how many closed trades to keep in context
const STALE_HOURS = 48;

// ─────────────────────────────────────────────────────────────────────────────
// Blank context — used on first run or after manual reset
// ─────────────────────────────────────────────────────────────────────────────

export function blankContext(): MarketContext {
  return {
    schema_version: "1.1",
    last_updated: new Date().toISOString(),
    last_bar: "",
    session_count: 0,
    current_bias: "NEUTRAL",
    bias_strength: "WEAK",
    bias_set_at: new Date().toISOString(),
    invalidation_notes: null,
    key_levels: { resistance: [], support: [], notes: null },
    active_fvgs: [],
    ema_stack: { ema20: 0, ema50: 0, ema200: 0, alignment: "MIXED" },
    oscillators: { rsi_4h: 50, rsi_1h: null, macd_histogram: null },
    macro_backdrop: "",
    active_trade_ideas: [],
    recent_closed_trades: [],
    recent_win_rate: null,
    recent_expectancy_r: null,
    context_age_warning: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KV read/write helpers
// These are thin wrappers so the rest of the module doesn't import kv
// directly — makes mocking trivial in tests.
// ─────────────────────────────────────────────────────────────────────────────

export type KvStore = {
  get: <T>(key: string) => Promise<T | null>;
  set: <T>(key: string, value: T) => Promise<unknown>;
};

export async function readContext(kv: KvStore): Promise<MarketContext> {
  const raw = await kv.get<MarketContext>(KV_KEY);
  if (!raw) return blankContext();

  // Staleness flag: set true if last_updated > STALE_HOURS ago
  const ageHours = (Date.now() - new Date(raw.last_updated).getTime()) / 3600000;
  return { ...raw, context_age_warning: ageHours > STALE_HOURS };
}

export async function writeContext(kv: KvStore, ctx: MarketContext): Promise<void> {
  const toWrite: MarketContext = {
    ...ctx,
    last_updated: new Date().toISOString(),
    context_age_warning: false,
  };
  await kv.set(KV_KEY, toWrite);
}

// ─────────────────────────────────────────────────────────────────────────────
// Update after ALFRED analysis — called from analyze-setup route
// ALFRED's response includes a partial update object; we merge it in.
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextUpdate {
  bias?: BiasDirection;
  bias_strength?: BiasStrength;
  invalidation_notes?: string | null;
  last_bar?: string;
  key_levels?: { resistance?: number[]; support?: number[]; notes?: string | null };
  active_fvgs?: ActiveFvg[];
  ema_stack?: Partial<MarketContext["ema_stack"]>;
  oscillators?: Partial<MarketContext["oscillators"]>;
  macro_backdrop?: string;
  trade_idea_update?: Partial<TradeIdea> & { id: string };
  new_trade_idea?: Omit<TradeIdea, "id" | "created_at" | "last_updated">;
}

export function mergeContextUpdate(current: MarketContext, update: ContextUpdate): MarketContext {
  let ctx = { ...current, session_count: current.session_count + 1 };

  if (update.bias !== undefined) {
    ctx.current_bias = update.bias;
    ctx.bias_set_at = new Date().toISOString();
  }
  if (update.bias_strength !== undefined) ctx.bias_strength = update.bias_strength;
  if (update.invalidation_notes !== undefined) ctx.invalidation_notes = update.invalidation_notes;
  if (update.last_bar !== undefined) ctx.last_bar = update.last_bar;
  if (update.macro_backdrop !== undefined) ctx.macro_backdrop = update.macro_backdrop;

  if (update.key_levels) {
    ctx.key_levels = {
      resistance: update.key_levels.resistance ?? ctx.key_levels.resistance,
      support:    update.key_levels.support    ?? ctx.key_levels.support,
      notes:      update.key_levels.notes      ?? ctx.key_levels.notes,
    };
  }

  if (update.ema_stack) {
    ctx.ema_stack = { ...ctx.ema_stack, ...update.ema_stack };
    ctx.ema_stack.alignment = deriveAlignment(ctx.ema_stack);
  }

  if (update.oscillators) {
    ctx.oscillators = { ...ctx.oscillators, ...update.oscillators };
  }

  // FVG merge: replace the array and enforce max
  if (update.active_fvgs !== undefined) {
    ctx.active_fvgs = pruneActiveFvgs(update.active_fvgs);
  }

  // Trade idea update
  if (update.trade_idea_update) {
    const u = update.trade_idea_update;
    ctx.active_trade_ideas = ctx.active_trade_ideas.map((idea) =>
      idea.id === u.id ? { ...idea, ...u, last_updated: new Date().toISOString() } : idea
    );
  }

  // New trade idea
  if (update.new_trade_idea) {
    const newIdea: TradeIdea = {
      ...update.new_trade_idea,
      id: `IDEA-${Date.now()}`,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    };
    ctx.active_trade_ideas = pruneActiveIdeas([...ctx.active_trade_ideas, newIdea]);
  }

  // Purge invalidated ideas older than 48 hours
  ctx.active_trade_ideas = ctx.active_trade_ideas.filter((idea) => {
    if (idea.status !== "INVALIDATED") return true;
    const ageHours = (Date.now() - new Date(idea.last_updated).getTime()) / 3600000;
    return ageHours < 48;
  });

  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update after outcome logged — the live backtesting connection.
// Called from the outcome write path alongside calibration recalc.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClosedTradeForContext {
  id: string;
  direction: "LONG" | "SHORT";
  outcome: "WIN" | "LOSS" | "SCRATCH";
  result_r: number;
  score: number;
  confidence_label: string;
  session: string;
  close_timestamp: string;
  reasoning: string;  // ALFRED's original reasoning — summarized for key_factors
}

export function updateContextFromOutcome(
  ctx: MarketContext,
  closed: ClosedTradeForContext
): MarketContext {
  // Mark any matching trade idea as TRIGGERED
  const updatedIdeas = ctx.active_trade_ideas.map((idea) =>
    idea.status === "WATCHING" || idea.status === "READY"
      ? { ...idea, status: "TRIGGERED" as IdeaStatus, last_updated: new Date().toISOString() }
      : idea
  );

  // Prepend to recent closed trades, keep last MAX_RECENT_TRADES
  const keyFactors = summarizeReasoningForContext(closed.reasoning);
  const newTrade: RecentClosedTrade = {
    id: closed.id,
    direction: closed.direction,
    outcome: closed.outcome,
    result_r: closed.result_r,
    score: closed.score,
    confidence_label: closed.confidence_label,
    session: closed.session,
    close_timestamp: closed.close_timestamp,
    key_factors: keyFactors,
  };

  const updated = [newTrade, ...ctx.recent_closed_trades].slice(0, MAX_RECENT_TRADES);

  // Recompute rolling stats on the in-context window
  const { winRate, expectancy } = computeRecentStats(updated);

  return {
    ...ctx,
    active_trade_ideas: updatedIdeas,
    recent_closed_trades: updated,
    recent_win_rate: winRate,
    recent_expectancy_r: expectancy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder — the section injected at the top of every ALFRED system
// prompt. Structured but readable. ALFRED doesn't need to parse this —
// it's written as a briefing, not as JSON.
// ─────────────────────────────────────────────────────────────────────────────

export function buildMarketMemoryPromptSection(ctx: MarketContext): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("MARKET MEMORY — PERSISTENT CONTEXT FROM PRIOR SESSIONS");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  if (ctx.context_age_warning) {
    const ageHours = Math.round(
      (Date.now() - new Date(ctx.last_updated).getTime()) / 3600000
    );
    lines.push(
      `⚠ CONTEXT IS ${ageHours}h OLD. Treat as background reference only. Prioritize data in the current analysis request over any stale context below.`
    );
    lines.push("");
  }

  // Bias
  lines.push(`CURRENT BIAS: ${ctx.current_bias} (${ctx.bias_strength})`);
  lines.push(`Set at: ${fmtTime(ctx.bias_set_at)}`);
  if (ctx.invalidation_notes) {
    lines.push(`Invalidation: ${ctx.invalidation_notes}`);
  }
  lines.push("");

  // Macro
  if (ctx.macro_backdrop) {
    lines.push(`MACRO: ${ctx.macro_backdrop}`);
    lines.push("");
  }

  // EMA stack
  if (ctx.ema_stack.ema20 > 0) {
    lines.push(
      `EMA STACK: ${ctx.ema_stack.alignment} | 20=${ctx.ema_stack.ema20} 50=${ctx.ema_stack.ema50} 200=${ctx.ema_stack.ema200}`
    );
    lines.push(`RSI 4H: ${ctx.oscillators.rsi_4h}`);
    if (ctx.oscillators.macd_histogram !== null) {
      lines.push(`MACD Hist: ${ctx.oscillators.macd_histogram}`);
    }
    lines.push("");
  }

  // Key levels
  if (ctx.key_levels.resistance.length > 0 || ctx.key_levels.support.length > 0) {
    lines.push("KEY LEVELS:");
    if (ctx.key_levels.resistance.length > 0) {
      lines.push(`  Resistance: ${ctx.key_levels.resistance.sort((a, b) => a - b).join(", ")}`);
    }
    if (ctx.key_levels.support.length > 0) {
      lines.push(`  Support: ${ctx.key_levels.support.sort((a, b) => b - a).join(", ")}`);
    }
    if (ctx.key_levels.notes) {
      lines.push(`  Notes: ${ctx.key_levels.notes}`);
    }
    lines.push("");
  }

  // Active FVGs
  const liveFvgs = ctx.active_fvgs.filter((f) => f.status !== "filled");
  if (liveFvgs.length > 0) {
    lines.push("ACTIVE FVGs (unfilled/partial):");
    for (const fvg of liveFvgs) {
      lines.push(
        `  ${fvg.direction.toUpperCase()} | ${fvg.bottom}–${fvg.top} | ${fvg.timeframe} | age ${fvg.age_bars} bars | ${fvg.quality} quality`
      );
    }
    lines.push("");
  }

  // Active trade ideas
  const activeIdeas = ctx.active_trade_ideas.filter(
    (i) => i.status === "WATCHING" || i.status === "READY"
  );
  if (activeIdeas.length > 0) {
    lines.push("ACTIVE TRADE IDEAS:");
    for (const idea of activeIdeas) {
      lines.push(
        `  [${idea.status}] ${idea.direction} | Zone: ${idea.entry_zone} | Stop: ${idea.stop} | Target: ${idea.target}`
      );
      if (idea.notes) lines.push(`    ${idea.notes}`);
    }
    lines.push("");
  }

  // ── The live backtesting section ──────────────────────────────────────────
  // This is the "always on" part. ALFRED sees the last N closed trades
  // with their outcomes before writing any analysis. This grounds the
  // output in what the rules have actually been producing, not just
  // what they promise to produce.
  if (ctx.recent_closed_trades.length > 0) {
    lines.push("RECENT CLOSED TRADES (live performance context):");

    if (ctx.recent_win_rate !== null) {
      const pct = (ctx.recent_win_rate * 100).toFixed(0);
      const exp = ctx.recent_expectancy_r !== null
        ? ` | Expectancy ${ctx.recent_expectancy_r >= 0 ? "+" : ""}${ctx.recent_expectancy_r.toFixed(2)}R`
        : "";
      lines.push(
        `  Last ${ctx.recent_closed_trades.length} trades: ${pct}% win rate${exp}`
      );
    }

    lines.push("");
    for (const t of ctx.recent_closed_trades) {
      const rStr = `${t.result_r >= 0 ? "+" : ""}${t.result_r.toFixed(2)}R`;
      const outcomeStr = t.outcome === "WIN" ? "WIN" : t.outcome === "LOSS" ? "LOSS" : "SCR";
      lines.push(
        `  ${fmtDate(t.close_timestamp)} | ${t.direction} | ${outcomeStr} ${rStr} | Score ${t.score} ${t.confidence_label} | ${t.session}`
      );
      if (t.key_factors) {
        lines.push(`    ${t.key_factors}`);
      }
    }
    lines.push("");
    lines.push(
      "When the recent win rate diverges significantly from the lifetime calibration " +
      "(shown in the predicted accuracy card), weight your analysis accordingly. " +
      "A losing streak in similar setups is data, not noise."
    );
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("END MARKET MEMORY — current analysis inputs follow below");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function deriveAlignment(stack: MarketContext["ema_stack"]): EmaAlignment {
  if (stack.ema20 === 0) return "MIXED";
  if (stack.ema20 > stack.ema50 && stack.ema50 > stack.ema200) return "BULLISH";
  if (stack.ema20 < stack.ema50 && stack.ema50 < stack.ema200) return "BEARISH";
  return "MIXED";
}

function pruneActiveFvgs(fvgs: ActiveFvg[]): ActiveFvg[] {
  if (fvgs.length <= MAX_ACTIVE_FVGS) return fvgs;
  // Remove filled first, then lowest quality, then oldest
  const priority = (f: ActiveFvg) =>
    f.status === "filled" ? 0 : f.quality === "low" ? 1 : f.quality === "medium" ? 2 : 3;
  return [...fvgs].sort((a, b) => priority(b) - priority(a)).slice(0, MAX_ACTIVE_FVGS);
}

function pruneActiveIdeas(ideas: TradeIdea[]): TradeIdea[] {
  if (ideas.length <= MAX_ACTIVE_IDEAS) return ideas;
  // Remove INVALIDATED first, then TRIGGERED, then oldest WATCHING
  const priority = (i: TradeIdea) =>
    i.status === "INVALIDATED" ? 0 : i.status === "TRIGGERED" ? 1 : 2;
  return [...ideas].sort((a, b) => priority(b) - priority(a)).slice(0, MAX_ACTIVE_IDEAS);
}

function computeRecentStats(
  trades: RecentClosedTrade[]
): { winRate: number | null; expectancy: number | null } {
  const decisive = trades.filter((t) => t.outcome === "WIN" || t.outcome === "LOSS");
  if (decisive.length === 0) return { winRate: null, expectancy: null };

  const wins = decisive.filter((t) => t.outcome === "WIN");
  const losses = decisive.filter((t) => t.outcome === "LOSS");
  const winRate = wins.length / decisive.length;

  const avgWinR =
    wins.length > 0
      ? wins.reduce((s, t) => s + t.result_r, 0) / wins.length
      : 0;
  const avgLossR =
    losses.length > 0
      ? losses.reduce((s, t) => s + t.result_r, 0) / losses.length
      : 0;

  const expectancy = winRate * avgWinR + (1 - winRate) * avgLossR;
  return { winRate, expectancy };
}

/**
 * Compress the full ALFRED reasoning string into a single-line
 * key-factors summary for the context log. Takes the first sentence
 * that mentions a factor (EMA, RSI, FVG, VWAP, session, etc.) and
 * truncates to 80 chars. Pure string manipulation — no LLM call.
 */
function summarizeReasoningForContext(reasoning: string): string {
  const factorKeywords = ["EMA", "RSI", "FVG", "VWAP", "HTF", "session", "OVX", "MACD", "DXY"];
  const sentences = reasoning.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);

  for (const sentence of sentences) {
    if (factorKeywords.some((kw) => sentence.includes(kw))) {
      return sentence.length > 80 ? sentence.slice(0, 77) + "..." : sentence;
    }
  }

  // Fallback: first sentence
  const first = sentences[0] ?? reasoning;
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
      timeZone: "America/New_York",
    }) + " ET";
  } catch {
    return iso;
  }
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", timeZone: "America/New_York",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
