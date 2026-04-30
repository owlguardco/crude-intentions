/**
 * CRUDE INTENTIONS — Observer Notes Read API
 *
 * GET /api/journal/observer
 *
 * Auth: x-api-key (INTERNAL_API_KEY).
 *
 * Reads calibration:latest from KV and runs generateCalibrationNotes()
 * against it. Returns:
 *   { note: string[] }                    — notes derived from the snapshot
 *   { note: null, reason: 'no_calibration_data' }  — KV empty, no snapshot yet
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import type { CalibrationSnapshot } from "@/lib/journal/calibration";
import { generateCalibrationNotes } from "@/lib/journal/observer";
import { safeEq } from "@/lib/auth/safe-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get("x-api-key") ?? req.headers.get("authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return safeEq(token, INTERNAL_API_KEY);
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const snapshot = await kv.get<CalibrationSnapshot>("calibration:latest");
  if (!snapshot) {
    return NextResponse.json({ note: null, reason: "no_calibration_data" });
  }

  const note = generateCalibrationNotes(snapshot);
  return NextResponse.json({ note });
}
