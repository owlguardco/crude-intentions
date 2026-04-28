/**
 * CRUDE INTENTIONS — Market Context API
 *
 * GET  /api/market-context        → returns current MarketContext (or blank)
 * POST /api/market-context        → merges a ContextUpdate and saves
 *
 * The reset path is a separate file at /api/market-context/reset/route.ts
 * so it can't be hit accidentally with a POST to the main endpoint.
 *
 * Auth: protected by INTERNAL_API_KEY header for writes. Reads are open
 * for now since this is a personal app — tighten later when subscriptions ship.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import {
  readContext,
  writeContext,
  mergeContextUpdate,
  type ContextUpdate,
} from "@/lib/market-memory/context";

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

// ─────────────────────────────────────────────────────────────────────────────
// GET — current context
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const ctx = await readContext(kv);
    return NextResponse.json(ctx);
  } catch (err) {
    console.error("[market-context GET]", err);
    return NextResponse.json(
      { error: "Failed to read market context", detail: String(err) },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — merge a partial update and save
// Body shape: ContextUpdate from @/lib/market-memory/context
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let update: ContextUpdate;
  try {
    update = (await req.json()) as ContextUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const current = await readContext(kv);
    const merged = mergeContextUpdate(current, update);
    await writeContext(kv, merged);
    return NextResponse.json({
      ok: true,
      session_count: merged.session_count,
      last_updated: merged.last_updated,
      current_bias: merged.current_bias,
      bias_strength: merged.bias_strength,
    });
  } catch (err) {
    console.error("[market-context POST]", err);
    return NextResponse.json(
      { error: "Failed to update market context", detail: String(err) },
      { status: 500 }
    );
  }
}
