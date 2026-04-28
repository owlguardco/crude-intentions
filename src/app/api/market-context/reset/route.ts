/**
 * CRUDE INTENTIONS — Market Context Reset
 *
 * POST /api/market-context/reset
 *
 * Resets the persisted MarketContext back to a blank slate. Used when:
 *   - Weekly bias rolls over and you want a clean start
 *   - You suspect the context has drifted from reality
 *   - You're debugging and want a known-clean state
 *
 * Auth: requires INTERNAL_API_KEY. This is destructive.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { blankContext, writeContext } from "@/lib/market-memory/context";

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

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const blank = blankContext();
    await writeContext(kv, blank);
    return NextResponse.json({
      ok: true,
      reset_at: blank.last_updated,
      message: "Market context reset to blank state",
    });
  } catch (err) {
    console.error("[market-context RESET]", err);
    return NextResponse.json(
      { error: "Failed to reset market context", detail: String(err) },
      { status: 500 }
    );
  }
}
