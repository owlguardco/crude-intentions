/**
 * CRUDE INTENTIONS — Observer Notes Read API
 *
 * GET /api/journal/observer
 *
 * Reads calibration:latest + calibration:history from KV and returns the
 * generateCalibrationNotes() output along with the snapshot it was derived from.
 * Read-only.
 *
 * Auth: requires INTERNAL_API_KEY (x-api-key or Bearer header).
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import type { CalibrationSnapshot } from "@/lib/journal/calibration";
import { generateCalibrationNotes } from "@/lib/journal/observer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get("x-api-key") ?? req.headers.get("authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [snapshot, history] = await Promise.all([
    kv.get<CalibrationSnapshot>("calibration:latest"),
    kv.get<CalibrationSnapshot[]>("calibration:history"),
  ]);

  const notes = snapshot ? generateCalibrationNotes(snapshot) : [];

  return NextResponse.json({
    snapshot: snapshot ?? null,
    notes,
    history_count: history?.length ?? 0,
  });
}
