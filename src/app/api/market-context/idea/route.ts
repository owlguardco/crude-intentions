/**
 * CRUDE INTENTIONS — Trade Idea Add
 *
 * POST /api/market-context/idea
 *
 * Appends a new TradeIdea to the persisted context. Server fills in id,
 * created_at, last_updated, and defaults status to WATCHING.
 *
 * Auth: requires INTERNAL_API_KEY.
 */

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import {
  readContext,
  writeContext,
  type TradeIdea,
} from "@/lib/market-memory/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const MAX_ACTIVE_IDEAS = 5;

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get("x-api-key") ?? req.headers.get("authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
}

interface AddIdeaBody {
  direction?: "LONG" | "SHORT";
  entry_zone?: string;
  entry_price?: number | null;
  target?: number;
  stop?: number;
  notes?: string;
}

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: AddIdeaBody;
  try {
    body = (await req.json()) as AddIdeaBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.direction !== "LONG" && body.direction !== "SHORT") {
    return NextResponse.json(
      { error: "direction must be 'LONG' or 'SHORT'" },
      { status: 400 }
    );
  }
  if (typeof body.entry_zone !== "string" || !body.entry_zone.trim()) {
    return NextResponse.json(
      { error: "entry_zone is required" },
      { status: 400 }
    );
  }
  if (typeof body.target !== "number" || typeof body.stop !== "number") {
    return NextResponse.json(
      { error: "target and stop must be numbers" },
      { status: 400 }
    );
  }
  if (body.direction === "LONG" && body.target <= body.stop) {
    return NextResponse.json(
      { error: "LONG: target must be greater than stop" },
      { status: 400 }
    );
  }
  if (body.direction === "SHORT" && body.target >= body.stop) {
    return NextResponse.json(
      { error: "SHORT: target must be less than stop" },
      { status: 400 }
    );
  }

  try {
    const ctx = await readContext(kv);

    const liveCount = ctx.active_trade_ideas.filter(
      (i) => i.status === "WATCHING" || i.status === "READY"
    ).length;
    if (liveCount >= MAX_ACTIVE_IDEAS) {
      return NextResponse.json(
        { error: `Active idea limit reached (${MAX_ACTIVE_IDEAS}). Remove one first.` },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const newIdea: TradeIdea = {
      id: randomUUID(),
      direction: body.direction,
      status: "WATCHING",
      entry_zone: body.entry_zone.trim(),
      entry_price: typeof body.entry_price === "number" ? body.entry_price : null,
      target: body.target,
      stop: body.stop,
      notes: typeof body.notes === "string" ? body.notes : "",
      created_at: now,
      last_updated: now,
    };

    const next = {
      ...ctx,
      active_trade_ideas: [...ctx.active_trade_ideas, newIdea],
    };
    await writeContext(kv, next);

    return NextResponse.json({ ok: true, idea: newIdea });
  } catch (err) {
    console.error("[idea POST]", err);
    return NextResponse.json(
      { error: "Failed to add trade idea", detail: String(err) },
      { status: 500 }
    );
  }
}
