// CRUDE INTENTIONS — Calibration Engine (Phase 2B)
// Tracks lifetime and bucketed win/expectancy stats so ALFRED can report
// how the rules have actually performed, not just what they promise.

export interface CalibrationEntry {
  id: string;
  direction: 'LONG' | 'SHORT' | 'NO TRADE';
  score: number;
  grade: string;
  confidence_label: string;
  session: string;
  reasoning: string;
  entry_price: number | null;
  stop_loss: number | null;
  contracts: number | null;
  timestamp: string;
  historical?: boolean;
  checklist?: Record<string, { result: 'PASS' | 'FAIL'; detail: string }>;
  supply_context?: {
    cushing_vs_4wk: 'BUILDING' | 'DRAWING' | 'FLAT' | null;
    eia_4wk_trend: 'BUILDS' | 'DRAWS' | 'MIXED' | null;
    rig_count_trend: 'RISING' | 'FALLING' | 'FLAT' | null;
    supply_bias: 'BEARISH' | 'NEUTRAL' | 'BULLISH' | null;
  } | null;
  outcome: {
    status: 'OPEN' | 'WIN' | 'LOSS' | 'SCRATCH' | 'BLOCKED' | 'EXPIRED';
    result: number | null;
    result_dollars: number | null;
    result_r: number | null;
    close_timestamp: string | null;
    close_price: number | null;
    post_mortem: string | null;
    post_mortem_timestamp: string | null;
  };
}

export type FactorKey =
  | 'ema_stack_aligned'
  | 'rsi_reset_zone'
  | 'price_at_key_level'
  | 'session_timing'
  | 'market_bias'
  | 'candle_confirmation'
  | 'volume_profile'
  | 'no_eia_window';

export const FACTOR_KEYS: FactorKey[] = [
  'ema_stack_aligned',
  'rsi_reset_zone',
  'price_at_key_level',
  'session_timing',
  'market_bias',
  'candle_confirmation',
  'volume_profile',
  'no_eia_window',
];

export interface FactorStats {
  trades: number;
  wins: number;
  win_rate: number;
}

export interface FactorBreakdown {
  pass_stats: FactorStats;
  fail_stats: FactorStats;
  edge_pp: number;
  drift_flag: boolean;
}

export interface ConfidenceBucket extends GradeBucket {
  wilson_ci: { low: number; high: number };
}

export interface OverallStats {
  win_rate: number;
  rolling_30: {
    trades: number;
    wins: number;
    win_rate: number;
  };
}

interface GradeBucket {
  trades: number;
  wins: number;
  win_rate: number;
  avg_r: number;
}

interface SessionBucket {
  trades: number;
  wins: number;
  win_rate: number;
}

export type SupplyBiasKey = 'BEARISH' | 'NEUTRAL' | 'BULLISH';

export interface SupplyBiasBucket {
  trades: number;
  wins: number;
  win_rate: number;
  wilson_ci: { low: number; high: number } | null;
}

export interface CalibrationSnapshot {
  snapshot_at: string;
  totals: {
    trades_closed: number;
    historical_closed: number;
    wins: number;
    losses: number;
    scratches: number;
    win_rate: number;
    avg_win_r: number;
    avg_loss_r: number;
    expectancy_r: number;
    profit_factor: number;
  };
  by_grade: Record<string, GradeBucket>;
  by_session: Record<string, SessionBucket>;
  by_confidence: Record<string, ConfidenceBucket>;
  by_factor: Record<FactorKey, FactorBreakdown>;
  by_supply_bias: Record<SupplyBiasKey, SupplyBiasBucket>;
  confidence_tiers_inverted: boolean;
  overall: OverallStats;
}

export interface PredictedAccuracy {
  win_rate_estimate: number;
  confidence_interval: [number, number];
  sample_size: number;
  grade_bucket: string;
  basis: string;
}

export interface SignalContext {
  score: number;
  grade: string;
  confidence_label: string;
  session?: string;
}

export function recalculateCalibration(entries: CalibrationEntry[]): CalibrationSnapshot {
  const closed = entries.filter(
    (e) => e.outcome?.status === 'WIN' || e.outcome?.status === 'LOSS' || e.outcome?.status === 'SCRATCH'
  );

  const wins = closed.filter((e) => e.outcome.status === 'WIN');
  const losses = closed.filter((e) => e.outcome.status === 'LOSS');
  const scratches = closed.filter((e) => e.outcome.status === 'SCRATCH');
  const decisive = [...wins, ...losses];

  const getR = (e: CalibrationEntry): number => e.outcome.result_r ?? 0;

  const win_rate = decisive.length > 0 ? wins.length / decisive.length : 0;

  const avg_win_r =
    wins.length > 0 ? wins.reduce((s, e) => s + getR(e), 0) / wins.length : 0;
  const avg_loss_r =
    losses.length > 0 ? losses.reduce((s, e) => s + getR(e), 0) / losses.length : 0;

  const expectancy_r =
    decisive.length > 0 ? win_rate * avg_win_r + (1 - win_rate) * avg_loss_r : 0;

  const total_win_r = wins.reduce((s, e) => s + Math.abs(getR(e)), 0);
  const total_loss_r = losses.reduce((s, e) => s + Math.abs(getR(e)), 0);
  const profit_factor = total_loss_r > 0 ? total_win_r / total_loss_r : 0;

  // Cohort breakdowns exclude historical (guided-import) entries so the
  // grade/session/factor stats reflect ALFRED-scored trades only. Historical
  // entries still contribute to totals and overall win rate above.
  const cohortClosed = closed.filter((e) => e.historical !== true);

  const by_grade: Record<string, GradeBucket> = {};
  const by_session: Record<string, SessionBucket> = {};
  const by_confidence: Record<string, ConfidenceBucket> = {};

  for (const entry of cohortClosed) {
    const g = entry.grade ?? 'F';
    if (!by_grade[g]) by_grade[g] = { trades: 0, wins: 0, win_rate: 0, avg_r: 0 };
    const prevT = by_grade[g].trades;
    by_grade[g].trades++;
    by_grade[g].avg_r = (by_grade[g].avg_r * prevT + getR(entry)) / by_grade[g].trades;
    if (entry.outcome.status === 'WIN') by_grade[g].wins++;
  }
  for (const g of Object.keys(by_grade)) {
    by_grade[g].win_rate =
      by_grade[g].trades > 0 ? by_grade[g].wins / by_grade[g].trades : 0;
  }

  for (const entry of cohortClosed) {
    const s = entry.session ?? 'UNKNOWN';
    if (!by_session[s]) by_session[s] = { trades: 0, wins: 0, win_rate: 0 };
    by_session[s].trades++;
    if (entry.outcome.status === 'WIN') by_session[s].wins++;
  }
  for (const s of Object.keys(by_session)) {
    by_session[s].win_rate =
      by_session[s].trades > 0 ? by_session[s].wins / by_session[s].trades : 0;
  }

  for (const entry of cohortClosed) {
    const c = entry.confidence_label ?? 'LOW';
    if (!by_confidence[c])
      by_confidence[c] = {
        trades: 0,
        wins: 0,
        win_rate: 0,
        avg_r: 0,
        wilson_ci: { low: 0, high: 0 },
      };
    const prevT = by_confidence[c].trades;
    by_confidence[c].trades++;
    by_confidence[c].avg_r =
      (by_confidence[c].avg_r * prevT + getR(entry)) / by_confidence[c].trades;
    if (entry.outcome.status === 'WIN') by_confidence[c].wins++;
  }
  for (const c of Object.keys(by_confidence)) {
    const bucket = by_confidence[c];
    bucket.win_rate = bucket.trades > 0 ? bucket.wins / bucket.trades : 0;
    bucket.wilson_ci = wilsonCi(bucket.wins, bucket.trades);
  }

  // by_factor — pass vs fail edge breakdown
  const by_factor = {} as Record<FactorKey, FactorBreakdown>;
  for (const key of FACTOR_KEYS) {
    let passT = 0,
      passW = 0,
      failT = 0,
      failW = 0;
    for (const entry of cohortClosed) {
      const item = entry.checklist?.[key];
      const passed = item?.result === 'PASS';
      const isWin = entry.outcome.status === 'WIN';
      if (passed) {
        passT++;
        if (isWin) passW++;
      } else {
        failT++;
        if (isWin) failW++;
      }
    }
    const passRate = passT > 0 ? passW / passT : 0;
    const failRate = failT > 0 ? failW / failT : 0;
    const edge_pp = (passRate - failRate) * 100;
    by_factor[key] = {
      pass_stats: { trades: passT, wins: passW, win_rate: passRate },
      fail_stats: { trades: failT, wins: failW, win_rate: failRate },
      edge_pp,
      drift_flag: Math.abs(edge_pp) < 5,
    };
  }

  // by_supply_bias — win rate split by supply_bias at entry time
  const supplyKeys: SupplyBiasKey[] = ['BEARISH', 'NEUTRAL', 'BULLISH'];
  const by_supply_bias = {} as Record<SupplyBiasKey, SupplyBiasBucket>;
  for (const k of supplyKeys) {
    by_supply_bias[k] = { trades: 0, wins: 0, win_rate: 0, wilson_ci: null };
  }
  for (const entry of cohortClosed) {
    const bias = entry.supply_context?.supply_bias;
    if (bias === 'BEARISH' || bias === 'NEUTRAL' || bias === 'BULLISH') {
      const b = by_supply_bias[bias];
      b.trades++;
      if (entry.outcome.status === 'WIN') b.wins++;
    }
  }
  for (const k of supplyKeys) {
    const b = by_supply_bias[k];
    if (b.trades < 5) {
      b.win_rate = 0;
      b.wilson_ci = null;
    } else {
      b.win_rate = b.wins / b.trades;
      b.wilson_ci = wilsonCi(b.wins, b.trades);
    }
  }

  // confidence_tiers_inverted — HIGH win_rate < LOW win_rate
  const high = by_confidence['HIGH'];
  const low = by_confidence['LOW'];
  const confidence_tiers_inverted =
    !!high && !!low && high.trades > 0 && low.trades > 0 && high.win_rate < low.win_rate;

  // rolling_30 — last 30 closed entries by close_timestamp
  const closedSorted = [...closed].sort((a, b) => {
    const ta = a.outcome.close_timestamp ? Date.parse(a.outcome.close_timestamp) : 0;
    const tb = b.outcome.close_timestamp ? Date.parse(b.outcome.close_timestamp) : 0;
    return tb - ta;
  });
  const last30 = closedSorted.slice(0, 30);
  const last30Decisive = last30.filter(
    (e) => e.outcome.status === 'WIN' || e.outcome.status === 'LOSS'
  );
  const last30Wins = last30Decisive.filter((e) => e.outcome.status === 'WIN').length;
  const rolling_30 = {
    trades: last30Decisive.length,
    wins: last30Wins,
    win_rate: last30Decisive.length > 0 ? (last30Wins / last30Decisive.length) * 100 : 0,
  };

  const overall: OverallStats = {
    win_rate: win_rate * 100,
    rolling_30,
  };

  return {
    snapshot_at: new Date().toISOString(),
    totals: {
      trades_closed: closed.length,
      historical_closed: closed.filter((e) => e.historical === true).length,
      wins: wins.length,
      losses: losses.length,
      scratches: scratches.length,
      win_rate,
      avg_win_r,
      avg_loss_r,
      expectancy_r,
      profit_factor,
    },
    by_grade,
    by_session,
    by_confidence,
    by_factor,
    by_supply_bias,
    confidence_tiers_inverted,
    overall,
  };
}

function wilsonCi(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return {
    low: Math.max(0, center - margin) * 100,
    high: Math.min(1, center + margin) * 100,
  };
}

// Wilson score 95% CI — handles small samples better than naive p ± 1.96*SE
function wilsonInterval(p: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const center = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const margin =
    (z / (1 + (z * z) / n)) *
    Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function getPredictedAccuracy(
  signalContext: SignalContext,
  snapshot: CalibrationSnapshot,
  _closedEntries: CalibrationEntry[]
): PredictedAccuracy {
  const { grade, confidence_label } = signalContext;

  let win_rate_estimate = snapshot.totals.win_rate;
  let sample_size = snapshot.totals.trades_closed;
  let basis = 'overall';

  const gradeBucket = snapshot.by_grade[grade];
  if (gradeBucket && gradeBucket.trades >= 5) {
    win_rate_estimate = gradeBucket.win_rate;
    sample_size = gradeBucket.trades;
    basis = `grade ${grade}`;
  }

  const confBucket = snapshot.by_confidence[confidence_label];
  if (confBucket && confBucket.trades >= 5) {
    win_rate_estimate = confBucket.win_rate;
    sample_size = confBucket.trades;
    basis = `${confidence_label} confidence`;
  }

  const [lower, upper] = wilsonInterval(win_rate_estimate, sample_size);

  return {
    win_rate_estimate,
    confidence_interval: [lower, upper],
    sample_size,
    grade_bucket: grade,
    basis,
  };
}
