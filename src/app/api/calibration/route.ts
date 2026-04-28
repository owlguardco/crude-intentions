/**
 * CRUDE INTENTIONS — Calibration Read API
 *
 * GET /api/calibration
 *
 * Returns the latest calibration snapshot and rolling history. Read-only.
 *
 * Auth: requires INTERNAL_API_KEY (x-api-key or Bearer header).
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import type { CalibrationSnapshot } from "@/lib/journal/calibration";

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

  return NextResponse.json({
    snapshot: snapshot ?? null,
    history: history ?? [],
  });
}
