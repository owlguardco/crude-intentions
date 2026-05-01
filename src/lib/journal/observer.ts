// CRUDE INTENTIONS — Calibration Observer (Phase 2B)
// Manages the rolling calibration history window.

import type { CalibrationEntry, CalibrationSnapshot } from './calibration';

const MAX_HISTORY = 90;

export function pruneHistory(history: CalibrationSnapshot[]): CalibrationSnapshot[] {
  if (history.length <= MAX_HISTORY) return history;
  return history.slice(-MAX_HISTORY);
}

export function generateCalibrationNotes(snap: CalibrationSnapshot): string[] {
  const notes: string[] = [];

  if (snap.overall.win_rate < 40) {
    notes.push('Overall win rate below 40% — review entry criteria');
  }

  if (snap.confidence_tiers_inverted) {
    notes.push('High confidence trades underperforming low — recalibrate scoring');
  }

  for (const [key, factor] of Object.entries(snap.by_factor)) {
    if (factor.drift_flag) {
      notes.push(`Factor '${key}' shows weak edge (<5pp) — monitor or remove from checklist`);
    }
  }

  const r30 = snap.overall.rolling_30;
  if (r30.trades >= 10 && r30.win_rate > snap.overall.win_rate + 10) {
    notes.push('Last 30 trades outperforming overall — positive momentum');
  }
  if (r30.trades >= 10 && r30.win_rate < snap.overall.win_rate - 10) {
    notes.push('Last 30 trades underperforming overall — review recent conditions');
  }

  return notes;
}

// ── Suggested rule changes (display-only) ──────────────────────────────────
// Pure heuristic over the calibration snapshot. NEVER writes to rules.json
// or any other persisted state — these are observations the trader can
// review and act on (or not). Surfaced in the Calibration tab on the
// journal page under "OBSERVER SUGGESTIONS" with a disclaimer that
// rules.json is human-edited only.
//
// Trigger criteria for any cohort suggestion:
//   • cohort.trades >= MIN_N (8) — small samples produce noise, not signal
//   • cohort underperforms baseline by > EDGE_THRESHOLD_PP (15pp)
// For factor suggestions, "underperforms" means edge_pp < -15 (factor PASS
// rows lose more than FAIL rows by a meaningful margin).

export interface SuggestedRuleChange {
  factor: string;
  observation: string;
  suggested_change: string;
  evidence: string;
}

const SUGGEST_MIN_N = 8;
const SUGGEST_EDGE_PP = 15;

function fmtPctInt(p: number): string {
  return `${Math.round(p)}%`;
}

export function generateSuggestedRuleChanges(
  snapshot: CalibrationSnapshot,
  _entries: CalibrationEntry[] = [],
): SuggestedRuleChange[] {
  const out: SuggestedRuleChange[] = [];
  const baselinePct = snapshot.overall?.win_rate ?? 0; // already 0-100
  const totalClosed = snapshot.totals?.trades_closed ?? 0;

  // by_supply_bias — flag any (BEARISH/NEUTRAL/BULLISH) bucket where the
  // win rate trails the overall by >15pp on >=8 trades.
  const supplyKeys: Array<'BEARISH' | 'NEUTRAL' | 'BULLISH'> = ['BEARISH', 'NEUTRAL', 'BULLISH'];
  for (const k of supplyKeys) {
    const b = snapshot.by_supply_bias?.[k];
    if (!b || b.trades < SUGGEST_MIN_N) continue;
    const bucketPct = b.win_rate * 100;
    const drop = baselinePct - bucketPct;
    if (drop <= SUGGEST_EDGE_PP) continue;
    const losses = b.trades - b.wins;
    out.push({
      factor: 'supply_bias',
      observation: `${k} cohort ${fmtPctInt(bucketPct)} WR over n=${b.trades}`,
      suggested_change: `Consider adding supply_bias === '${k}' as a soft block — bucket trails baseline by ${Math.round(drop)}pp`,
      evidence: `by_supply_bias.${k}: ${b.wins}W/${losses}L vs baseline ${fmtPctInt(baselinePct)} over ${totalClosed} trades`,
    });
  }

  // by_session — same threshold, surfaces sessions that consistently lose.
  for (const [s, b] of Object.entries(snapshot.by_session ?? {})) {
    if (b.trades < SUGGEST_MIN_N) continue;
    const bucketPct = b.win_rate * 100;
    const drop = baselinePct - bucketPct;
    if (drop <= SUGGEST_EDGE_PP) continue;
    const losses = b.trades - b.wins;
    out.push({
      factor: 'session_timing',
      observation: `${s.replace('_', ' ')} session ${fmtPctInt(bucketPct)} WR over n=${b.trades}`,
      suggested_change: `Consider tightening session_timing rule — ${s.replace('_', ' ')} bucket trails baseline by ${Math.round(drop)}pp`,
      evidence: `by_session.${s}: ${b.wins}W/${losses}L vs baseline ${fmtPctInt(baselinePct)}`,
    });
  }

  // by_confidence — flag a confidence tier whose win rate undercuts the
  // baseline. Common cause: ALFRED is over-confidently scoring losing
  // setups, which would be a signal to raise minimum_to_trade.
  for (const [tier, b] of Object.entries(snapshot.by_confidence ?? {})) {
    if (b.trades < SUGGEST_MIN_N) continue;
    const bucketPct = b.win_rate * 100;
    const drop = baselinePct - bucketPct;
    if (drop <= SUGGEST_EDGE_PP) continue;
    const losses = b.trades - b.wins;
    out.push({
      factor: 'confidence_tier',
      observation: `${tier} tier ${fmtPctInt(bucketPct)} WR over n=${b.trades}`,
      suggested_change: `Consider raising minimum_to_trade — ${tier} confidence is underperforming baseline by ${Math.round(drop)}pp`,
      evidence: `by_confidence.${tier}: ${b.wins}W/${losses}L vs baseline ${fmtPctInt(baselinePct)}`,
    });
  }

  // by_factor — flag a factor where PASS rows lose more often than FAIL
  // rows by >15pp. edge_pp is already (passRate - failRate) * 100, so a
  // value < -15 means the factor is actively hurting when it's PASS.
  for (const [factorKey, fb] of Object.entries(snapshot.by_factor ?? {})) {
    if (fb.pass_stats.trades < SUGGEST_MIN_N) continue;
    if (fb.edge_pp >= -SUGGEST_EDGE_PP) continue;
    const passPct = fb.pass_stats.win_rate * 100;
    const failPct = fb.fail_stats.win_rate * 100;
    out.push({
      factor: factorKey,
      observation: `Factor "${factorKey}" PASS rows ${fmtPctInt(passPct)} WR over n=${fb.pass_stats.trades}, FAIL rows ${fmtPctInt(failPct)} WR over n=${fb.fail_stats.trades}`,
      suggested_change: `Consider removing "${factorKey}" from the A+ checklist — factor PASS is underperforming FAIL by ${Math.round(Math.abs(fb.edge_pp))}pp`,
      evidence: `by_factor.${factorKey}: edge_pp ${fb.edge_pp.toFixed(1)}, pass ${fb.pass_stats.wins}W/${fb.pass_stats.trades}T, fail ${fb.fail_stats.wins}W/${fb.fail_stats.trades}T`,
    });
  }

  return out;
}
