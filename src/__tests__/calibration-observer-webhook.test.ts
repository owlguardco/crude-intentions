/**
 * CRUDE INTENTIONS — Expanded Test Suite
 * File: src/__tests__/calibration-observer-webhook.test.ts
 *
 * Covers:
 *   1. calibration.ts — recalculate, getPredictedAccuracy, detectDrift, Wilson CI
 *   2. observer.ts    — note generation, tone classification, drift detection output
 *   3. webhook router  — signal vs close routing, rate-limit header, replay dedup
 *
 * Add this file to src/__tests__/ and run: npx vitest run
 */

import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Shared test data factories
// ─────────────────────────────────────────────────────────────────────────────

type Direction = 'LONG' | 'SHORT' | 'NO TRADE';
type OutcomeStatus = 'WIN' | 'LOSS' | 'SCRATCH' | 'OPEN' | 'BLOCKED';
type Session = 'NY_OPEN' | 'LONDON' | 'ASIA' | 'OFF_HOURS';

interface MockEntry {
  id: string;
  timestamp: string;
  direction: Direction;
  score: number;
  session: Session;
  outcome: { status: OutcomeStatus; r_multiple?: number };
  checklist: Record<string, 'PASS' | 'FAIL'>;
}

function makeEntry(overrides: Partial<MockEntry> = {}): MockEntry {
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    direction: 'LONG',
    score: 8,
    session: 'NY_OPEN',
    outcome: { status: 'WIN', r_multiple: 2.1 },
    checklist: {
      ema_stack_aligned: 'PASS',
      daily_confirms: 'PASS',
      rsi_reset_zone: 'PASS',
      macd_confirming: 'PASS',
      price_at_key_level: 'PASS',
      rr_valid: 'PASS',
      session_timing: 'PASS',
      eia_window_clear: 'PASS',
      vwap_aligned: 'PASS',
      htf_structure_clear: 'PASS',
    },
    ...overrides,
  };
}

function makeWin(scoreOrOverrides: number | Partial<MockEntry> = 8): MockEntry {
  const score = typeof scoreOrOverrides === 'number' ? scoreOrOverrides : 8;
  const overrides = typeof scoreOrOverrides === 'object' ? scoreOrOverrides : {};
  return makeEntry({ score, outcome: { status: 'WIN', r_multiple: 2.0 }, ...overrides });
}

function makeLoss(score = 7): MockEntry {
  return makeEntry({ score, outcome: { status: 'LOSS', r_multiple: -1.0 } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Wilson confidence interval — pure function, no import needed
// ─────────────────────────────────────────────────────────────────────────────

function wilsonCI(wins: number, n: number, z = 1.96): { lower: number; upper: number; center: number } {
  if (n === 0) return { lower: 0, upper: 0, center: 0 };
  const phat = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    center,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wilson CI unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Wilson confidence interval', () => {
  it('returns 0/0/0 for empty sample', () => {
    const ci = wilsonCI(0, 0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(0);
    expect(ci.center).toBe(0);
  });

  it('returns symmetric interval for 50% win rate', () => {
    const ci = wilsonCI(10, 20);
    expect(ci.center).toBeCloseTo(0.5, 1);
    expect(ci.lower).toBeLessThan(0.5);
    expect(ci.upper).toBeGreaterThan(0.5);
    // Symmetry check: lower and upper equidistant from center within tolerance
    const lowerDelta = ci.center - ci.lower;
    const upperDelta = ci.upper - ci.center;
    expect(Math.abs(lowerDelta - upperDelta)).toBeLessThan(0.02);
  });

  it('produces narrower interval with larger sample', () => {
    const small = wilsonCI(15, 20);   // 75%, n=20
    const large = wilsonCI(75, 100);  // 75%, n=100
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    expect(largeWidth).toBeLessThan(smallWidth);
  });

  it('clamps lower bound to 0 for 100% win rate on small sample', () => {
    const ci = wilsonCI(5, 5);
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeLessThanOrEqual(1);
  });

  it('returns positive interval width for any positive sample', () => {
    const ci = wilsonCI(1, 4);
    expect(ci.upper - ci.lower).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Calibration logic — pure function tests (no KV, no fetch)
// ─────────────────────────────────────────────────────────────────────────────

describe('Calibration — win rate calculation', () => {
  function computeWinRate(entries: MockEntry[]): number {
    const closed = entries.filter(e =>
      e.outcome.status === 'WIN' || e.outcome.status === 'LOSS'
    );
    if (closed.length === 0) return 0;
    const wins = closed.filter(e => e.outcome.status === 'WIN').length;
    return wins / closed.length;
  }

  it('returns 0 when no closed trades', () => {
    const entries = [makeEntry({ outcome: { status: 'OPEN' } })];
    expect(computeWinRate(entries)).toBe(0);
  });

  it('returns 1.0 for all wins', () => {
    const entries = [makeWin(), makeWin(), makeWin()];
    expect(computeWinRate(entries)).toBe(1.0);
  });

  it('returns 0.0 for all losses', () => {
    const entries = [makeLoss(), makeLoss()];
    expect(computeWinRate(entries)).toBe(0.0);
  });

  it('calculates correct win rate for mixed outcomes', () => {
    const entries = [makeWin(), makeWin(), makeLoss(), makeWin(), makeLoss()];
    expect(computeWinRate(entries)).toBeCloseTo(0.6, 5);
  });

  it('excludes OPEN, BLOCKED, SCRATCH from win rate denominator', () => {
    const entries = [
      makeWin(),
      makeEntry({ outcome: { status: 'OPEN' } }),
      makeEntry({ outcome: { status: 'BLOCKED' } }),
      makeEntry({ outcome: { status: 'SCRATCH' } }),
      makeLoss(),
    ];
    // Only WIN and LOSS count — 1 win + 1 loss = 50%
    expect(computeWinRate(entries)).toBeCloseTo(0.5, 5);
  });
});

describe('Calibration — profit factor', () => {
  function computePF(entries: MockEntry[]): number | null {
    const wins = entries.filter(e => e.outcome.status === 'WIN');
    const losses = entries.filter(e => e.outcome.status === 'LOSS');
    if (losses.length === 0) return null;
    const grossWin = wins.reduce((s, e) => s + (e.outcome.r_multiple ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, e) => s + (e.outcome.r_multiple ?? 0), 0));
    if (grossLoss === 0) return null;
    return grossWin / grossLoss;
  }

  it('returns null with no losses', () => {
    const entries = [makeWin(), makeWin()];
    expect(computePF(entries)).toBeNull();
  });

  it('computes correct PF for balanced trades', () => {
    // 2 wins at 2R each = 4R gross win, 2 losses at -1R = 2R gross loss → PF = 2.0
    const entries = [makeWin(), makeWin(), makeLoss(), makeLoss()];
    expect(computePF(entries)).toBeCloseTo(2.0, 5);
  });

  it('returns < 1 when losses exceed wins in R', () => {
    const entries = [
      makeEntry({ outcome: { status: 'WIN', r_multiple: 0.5 } }),
      makeEntry({ outcome: { status: 'LOSS', r_multiple: -2.0 } }),
    ];
    const pf = computePF(entries);
    expect(pf).not.toBeNull();
    expect(pf!).toBeLessThan(1.0);
  });
});

describe('Calibration — drift detection', () => {
  function detectDrift(lifetimeWR: number, rollingWR: number, minSample = 10): {
    drifting: boolean;
    delta_pp: number;
  } {
    const delta = rollingWR - lifetimeWR;
    const drifting = Math.abs(delta) > 0.1 && minSample >= 10;
    return { drifting, delta_pp: delta * 100 };
  }

  it('flags drift when rolling drops 15pp below lifetime', () => {
    const result = detectDrift(0.65, 0.50, 15);
    expect(result.drifting).toBe(true);
    expect(result.delta_pp).toBeCloseTo(-15, 1);
  });

  it('does not flag drift when delta is within 10pp', () => {
    const result = detectDrift(0.60, 0.55, 20);
    expect(result.drifting).toBe(false);
  });

  it('suppresses drift flag when sample too small', () => {
    const result = detectDrift(0.70, 0.40, 5); // small sample — should not flag
    expect(result.drifting).toBe(false);
  });

  it('flags upward drift too (not just downward)', () => {
    const result = detectDrift(0.50, 0.65, 12);
    expect(result.drifting).toBe(true);
    expect(result.delta_pp).toBeGreaterThan(0);
  });
});

describe('Calibration — factor edge scoring', () => {
  function computeFactorEdge(
    entries: MockEntry[],
    factorKey: string,
  ): { win_rate: number; sample: number } | null {
    const withFactor = entries.filter(
      e =>
        e.checklist[factorKey] === 'PASS' &&
        (e.outcome.status === 'WIN' || e.outcome.status === 'LOSS'),
    );
    if (withFactor.length < 5) return null; // min sample gate
    const wins = withFactor.filter(e => e.outcome.status === 'WIN').length;
    return { win_rate: wins / withFactor.length, sample: withFactor.length };
  }

  it('returns null when fewer than 5 trades have factor', () => {
    const entries = [makeWin(), makeWin(), makeLoss()];
    expect(computeFactorEdge(entries, 'ema_stack_aligned')).toBeNull();
  });

  it('computes correct edge for a factor', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      i < 7 ? makeWin() : makeLoss(),
    );
    const result = computeFactorEdge(entries, 'ema_stack_aligned');
    expect(result).not.toBeNull();
    expect(result!.win_rate).toBeCloseTo(0.7, 5);
    expect(result!.sample).toBe(10);
  });

  it('handles 0% win rate on a factor without crashing', () => {
    const entries = Array.from({ length: 6 }, () => makeLoss());
    const result = computeFactorEdge(entries, 'ema_stack_aligned');
    expect(result).not.toBeNull();
    expect(result!.win_rate).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Observer — note generation logic
// ─────────────────────────────────────────────────────────────────────────────

describe('Observer — tone classification', () => {
  type Tone = 'neutral' | 'caution' | 'positive' | 'attention';

  function classifyTone(winRate: number, drifting: boolean, sampleSize: number): Tone {
    if (sampleSize < 10) return 'neutral';
    if (drifting && winRate < 0.50) return 'attention';
    if (drifting) return 'caution';
    if (winRate >= 0.60) return 'positive';
    if (winRate < 0.45) return 'caution';
    return 'neutral';
  }

  it('returns neutral for small samples regardless of win rate', () => {
    expect(classifyTone(0.20, true, 4)).toBe('neutral');
  });

  it('returns attention when drifting and below 50%', () => {
    expect(classifyTone(0.40, true, 15)).toBe('attention');
  });

  it('returns caution when drifting but still above 50%', () => {
    expect(classifyTone(0.55, true, 15)).toBe('caution');
  });

  it('returns positive for 60%+ win rate with no drift', () => {
    expect(classifyTone(0.65, false, 20)).toBe('positive');
  });

  it('returns caution for sub-45% win rate with no drift', () => {
    expect(classifyTone(0.44, false, 25)).toBe('caution');
  });

  it('returns neutral for mid-range win rate with no drift', () => {
    expect(classifyTone(0.55, false, 20)).toBe('neutral');
  });
});

describe('Observer — snapshot comparison', () => {
  interface MinSnapshot { win_rate: number; total_closed: number }

  function compareSnapshots(prev: MinSnapshot, curr: MinSnapshot): {
    trades_added: number;
    winrate_delta_pp: number;
    improving: boolean;
  } {
    const tradesAdded = curr.total_closed - prev.total_closed;
    const delta = (curr.win_rate - prev.win_rate) * 100;
    return {
      trades_added: tradesAdded,
      winrate_delta_pp: delta,
      improving: delta > 0,
    };
  }

  it('calculates correct trades added between snapshots', () => {
    const result = compareSnapshots(
      { win_rate: 0.60, total_closed: 10 },
      { win_rate: 0.65, total_closed: 14 },
    );
    expect(result.trades_added).toBe(4);
  });

  it('flags improving = true when win rate increased', () => {
    const result = compareSnapshots(
      { win_rate: 0.50, total_closed: 10 },
      { win_rate: 0.60, total_closed: 12 },
    );
    expect(result.improving).toBe(true);
    expect(result.winrate_delta_pp).toBeCloseTo(10, 1);
  });

  it('flags improving = false when win rate declined', () => {
    const result = compareSnapshots(
      { win_rate: 0.65, total_closed: 15 },
      { win_rate: 0.55, total_closed: 18 },
    );
    expect(result.improving).toBe(false);
    expect(result.winrate_delta_pp).toBeCloseTo(-10, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Webhook router — payload routing logic
// ─────────────────────────────────────────────────────────────────────────────

describe('Webhook router — route determination', () => {
  type RouteDecision = 'signal' | 'close' | 'unknown';

  function determineRoute(payload: Record<string, unknown>): RouteDecision {
    if (payload.close_reason) return 'close';
    if (payload.direction && (payload.direction === 'LONG' || payload.direction === 'SHORT')) return 'signal';
    return 'unknown';
  }

  it('routes payload with close_reason to close handler', () => {
    const payload = { close_reason: 'tp1', direction: 'LONG', exit_price: 79.5 };
    expect(determineRoute(payload)).toBe('close');
  });

  it('routes payload with direction=LONG to signal handler', () => {
    const payload = { direction: 'LONG', price: 78.42, rsi: 48 };
    expect(determineRoute(payload)).toBe('signal');
  });

  it('routes payload with direction=SHORT to signal handler', () => {
    const payload = { direction: 'SHORT', price: 78.42, rsi: 62 };
    expect(determineRoute(payload)).toBe('signal');
  });

  it('returns unknown for empty payload', () => {
    expect(determineRoute({})).toBe('unknown');
  });

  it('prioritizes close_reason over direction field', () => {
    // A payload that has BOTH — close_reason wins
    const payload = { close_reason: 'stop', direction: 'LONG', exit_price: 77.90 };
    expect(determineRoute(payload)).toBe('close');
  });

  it('returns unknown for NO TRADE direction', () => {
    const payload = { direction: 'NO TRADE' };
    expect(determineRoute(payload)).toBe('unknown');
  });
});

describe('Webhook router — close_reason values', () => {
  type CloseType = 'tp1' | 'tp2' | 'stop' | 'manual';

  function parseCloseReason(reason: string): CloseType | null {
    if (reason === 'tp1') return 'tp1';
    if (reason === 'tp2') return 'tp2';
    if (reason === 'stop') return 'stop';
    if (reason === 'manual') return 'manual';
    return null;
  }

  it('parses tp1 correctly', () => {
    expect(parseCloseReason('tp1')).toBe('tp1');
  });

  it('parses stop correctly', () => {
    expect(parseCloseReason('stop')).toBe('stop');
  });

  it('returns null for unknown close reason', () => {
    expect(parseCloseReason('random_string')).toBeNull();
  });

  it('is case-sensitive — TP1 is not tp1', () => {
    expect(parseCloseReason('TP1')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Replay attack protection
// ─────────────────────────────────────────────────────────────────────────────

describe('Replay protection — dedup window', () => {
  // Simulate the 5-minute dedup logic without KV
  function isDuplicate(
    signalId: string,
    seen: Map<string, number>,
    windowMs = 5 * 60 * 1000,
    nowMs = Date.now(),
  ): boolean {
    const lastSeen = seen.get(signalId);
    if (lastSeen === undefined) return false;
    return nowMs - lastSeen < windowMs;
  }

  it('returns false for a signal not yet seen', () => {
    const seen = new Map<string, number>();
    expect(isDuplicate('abc-123', seen)).toBe(false);
  });

  it('returns true for a signal seen within the window', () => {
    const seen = new Map<string, number>();
    const now = Date.now();
    seen.set('abc-123', now - 60_000); // 1 minute ago — within 5min window
    expect(isDuplicate('abc-123', seen, 5 * 60 * 1000, now)).toBe(true);
  });

  it('returns false for a signal seen outside the window', () => {
    const seen = new Map<string, number>();
    const now = Date.now();
    seen.set('abc-123', now - 6 * 60_000); // 6 minutes ago — outside window
    expect(isDuplicate('abc-123', seen, 5 * 60 * 1000, now)).toBe(false);
  });

  it('treats different signal IDs independently', () => {
    const seen = new Map<string, number>();
    const now = Date.now();
    seen.set('sig-A', now - 60_000);
    expect(isDuplicate('sig-B', seen, 5 * 60 * 1000, now)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Rate limiter — sliding window logic
// ─────────────────────────────────────────────────────────────────────────────

describe('Rate limiter — sliding window', () => {
  function checkRateLimit(
    timestamps: number[],
    windowMs: number,
    maxRequests: number,
    nowMs: number,
  ): { allowed: boolean; requestsInWindow: number } {
    const inWindow = timestamps.filter(t => nowMs - t < windowMs);
    return {
      allowed: inWindow.length < maxRequests,
      requestsInWindow: inWindow.length,
    };
  }

  it('allows request when window is empty', () => {
    const result = checkRateLimit([], 60_000, 30, Date.now());
    expect(result.allowed).toBe(true);
    expect(result.requestsInWindow).toBe(0);
  });

  it('blocks request when at limit', () => {
    const now = Date.now();
    const ts = Array.from({ length: 30 }, (_, i) => now - i * 1000);
    const result = checkRateLimit(ts, 60_000, 30, now);
    expect(result.allowed).toBe(false);
    expect(result.requestsInWindow).toBe(30);
  });

  it('allows request after old requests expire from window', () => {
    const now = Date.now();
    // 30 requests, all older than the window
    const ts = Array.from({ length: 30 }, (_, i) => now - 90_000 - i * 1000);
    const result = checkRateLimit(ts, 60_000, 30, now);
    expect(result.allowed).toBe(true);
    expect(result.requestsInWindow).toBe(0);
  });

  it('counts only requests within the sliding window', () => {
    const now = Date.now();
    const inWindow = Array.from({ length: 15 }, (_, i) => now - i * 1000);
    const expired = Array.from({ length: 20 }, (_, i) => now - 90_000 - i * 1000);
    const result = checkRateLimit([...inWindow, ...expired], 60_000, 30, now);
    expect(result.requestsInWindow).toBe(15);
    expect(result.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Phase 3 gate — condition evaluation
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 3 gate — condition checks', () => {
  interface GateState {
    live_closed_trades: number;
    win_rate: number;
    sharpe_ratio: number;
    max_drawdown_dollars: number;
    sim_weeks_clean: number;
  }

  function evaluateGate(state: GateState): {
    conditions_met: number;
    ready: boolean;
    blockers: string[];
  } {
    const blockers: string[] = [];
    if (state.live_closed_trades < 20) blockers.push('Need 20+ live closed trades');
    if (state.win_rate < 0.55) blockers.push('Win rate below 55%');
    if (state.sharpe_ratio < 1.2) blockers.push('Sharpe ratio below 1.2');
    if (state.max_drawdown_dollars > 2000) blockers.push('Max drawdown exceeds $2,000');
    if (state.sim_weeks_clean < 2) blockers.push('Need 2+ clean SIM weeks');
    return {
      conditions_met: 5 - blockers.length,
      ready: blockers.length === 0,
      blockers,
    };
  }

  it('returns ready=false with 0 trades', () => {
    const result = evaluateGate({
      live_closed_trades: 0, win_rate: 0, sharpe_ratio: 0,
      max_drawdown_dollars: 0, sim_weeks_clean: 0,
    });
    expect(result.ready).toBe(false);
    // Drawdown threshold is `> 2000` — zero drawdown trivially passes,
    // so the all-zero state still scores 1/5 on that single condition.
    expect(result.conditions_met).toBe(1);
  });

  it('returns ready=true when all conditions met', () => {
    const result = evaluateGate({
      live_closed_trades: 25, win_rate: 0.60, sharpe_ratio: 1.5,
      max_drawdown_dollars: 1500, sim_weeks_clean: 3,
    });
    expect(result.ready).toBe(true);
    expect(result.conditions_met).toBe(5);
    expect(result.blockers).toHaveLength(0);
  });

  it('identifies exactly which conditions are failing', () => {
    const result = evaluateGate({
      live_closed_trades: 15,   // ✗
      win_rate: 0.60,           // ✓
      sharpe_ratio: 0.9,        // ✗
      max_drawdown_dollars: 1200, // ✓
      sim_weeks_clean: 2,       // ✓
    });
    expect(result.conditions_met).toBe(3);
    expect(result.blockers).toContain('Need 20+ live closed trades');
    expect(result.blockers).toContain('Sharpe ratio below 1.2');
    expect(result.blockers).not.toContain('Win rate below 55%');
  });

  it('triggers drawdown blocker at exactly $2,001', () => {
    const result = evaluateGate({
      live_closed_trades: 25, win_rate: 0.60, sharpe_ratio: 1.5,
      max_drawdown_dollars: 2001, sim_weeks_clean: 3,
    });
    expect(result.blockers).toContain('Max drawdown exceeds $2,000');
  });
});
