/**
 * CRUDE INTENTIONS — Calibration Seed (one-time bootstrap)
 *
 * POST /api/journal/calibration-seed
 *
 * Auth: x-api-key (INTERNAL_API_KEY).
 *
 * Reads journal:entries from KV, runs recalculateCalibration() against
 * the full set, writes the result to calibration:latest, and appends
 * the snapshot to calibration:history (pruned). Same write pattern as
 * the outcome PATCH path — this endpoint exists only to bootstrap
 * calibration KV when entries were imported via /api/journal/import or
 * /api/journal/backtest without ever flowing through outcome PATCH
 * (which is where calibration normally recomputes).
 *
 * Idempotent. Safe to call multiple times.
 */

import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import {
  recalculateCalibration,
  type CalibrationEntry,
  type CalibrationSnapshot,
} from '@/lib/journal/calibration';
import { pruneHistory } from '@/lib/journal/observer';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

export async function POST(req: NextRequest) {
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY not configured' }, { status: 500 });
  }
  const auth = req.headers.get('x-api-key');
  if (!auth || !safeEq(auth, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const entries = (await kv.get<CalibrationEntry[]>('journal:entries')) ?? [];
  const snapshot = recalculateCalibration(entries);
  await kv.set('calibration:latest', snapshot);

  const history = (await kv.get<CalibrationSnapshot[]>('calibration:history')) ?? [];
  await kv.set('calibration:history', pruneHistory([...history, snapshot]));

  return NextResponse.json({ ok: true, trades: entries.length, snapshot });
}
