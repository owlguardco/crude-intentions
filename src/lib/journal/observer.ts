// CRUDE INTENTIONS — Calibration Observer (Phase 2B)
// Manages the rolling calibration history window.

import type { CalibrationSnapshot } from './calibration';

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
