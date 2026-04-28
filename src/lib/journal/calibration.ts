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

export interface CalibrationSnapshot {
  snapshot_at: string;
  totals: {
    trades_closed: number;
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
  by_confidence: Record<string, GradeBucket>;
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

  const by_grade: Record<string, GradeBucket> = {};
  const by_session: Record<string, SessionBucket> = {};
  const by_confidence: Record<string, GradeBucket> = {};

  for (const entry of closed) {
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

  for (const entry of closed) {
    const s = entry.session ?? 'UNKNOWN';
    if (!by_session[s]) by_session[s] = { trades: 0, wins: 0, win_rate: 0 };
    by_session[s].trades++;
    if (entry.outcome.status === 'WIN') by_session[s].wins++;
  }
  for (const s of Object.keys(by_session)) {
    by_session[s].win_rate =
      by_session[s].trades > 0 ? by_session[s].wins / by_session[s].trades : 0;
  }

  for (const entry of closed) {
    const c = entry.confidence_label ?? 'LOW';
    if (!by_confidence[c]) by_confidence[c] = { trades: 0, wins: 0, win_rate: 0, avg_r: 0 };
    const prevT = by_confidence[c].trades;
    by_confidence[c].trades++;
    by_confidence[c].avg_r =
      (by_confidence[c].avg_r * prevT + getR(entry)) / by_confidence[c].trades;
    if (entry.outcome.status === 'WIN') by_confidence[c].wins++;
  }
  for (const c of Object.keys(by_confidence)) {
    by_confidence[c].win_rate =
      by_confidence[c].trades > 0 ? by_confidence[c].wins / by_confidence[c].trades : 0;
  }

  return {
    snapshot_at: new Date().toISOString(),
    totals: {
      trades_closed: closed.length,
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
