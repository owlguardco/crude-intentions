// CRUDE INTENTIONS — Calibration Observer (Phase 2B)
// Manages the rolling calibration history window.

import type { CalibrationSnapshot } from './calibration';

const MAX_HISTORY = 90;

export function pruneHistory(history: CalibrationSnapshot[]): CalibrationSnapshot[] {
  if (history.length <= MAX_HISTORY) return history;
  return history.slice(-MAX_HISTORY);
}
