/**
 * CRUDE INTENTIONS — Trade Idea by id
 *
 * PATCH  /api/market-context/idea/[id]   — update status
 * DELETE /api/market-context/idea/[id]   — remove from active_trade_ideas
 *
 * Auth: requires INTERNAL_API_KEY.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { safeEq } from "@/lib/auth/safe-compare";
import {
  readContext,
  writeContext,
  type IdeaStatus,
  type TradeIdea,
} from "@/lib/market-memory/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const VALID_STATUSES: IdeaStatus[] = ["WATCHING", "READY", "TRIGGERED", "INVALIDATED"];

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get("x-api-key") ?? req.headers.get("authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return safeEq(token, INTERNAL_API_KEY);
}

interface PatchIdeaBody {
  status?: IdeaStatus;
  notes?: string;
  entry_price?: number | null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  let body: PatchIdeaBody;
  try {
    body = (await req.json()) as PatchIdeaBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const ctx = await readContext(kv);
    const idx = ctx.active_trade_ideas.findIndex((i) => i.id === id);
    if (idx === -1) {
      return NextResponse.json({ error: "Idea not found" }, { status: 404 });
    }

    const updated: TradeIdea = {
      ...ctx.active_trade_ideas[idx],
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      ...(body.entry_price !== undefined ? { entry_price: body.entry_price } : {}),
      last_updated: new Date().toISOString(),
    };
    const next = {
      ...ctx,
      active_trade_ideas: ctx.active_trade_ideas.map((i, idx2) =>
        idx2 === idx ? updated : i
      ),
    };
    await writeContext(kv, next);

    return NextResponse.json({ ok: true, idea: updated });
  } catch (err) {
    console.error("[idea PATCH]", err);
    return NextResponse.json(
      { error: "Failed to update idea" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const ctx = await readContext(kv);
    const exists = ctx.active_trade_ideas.some((i) => i.id === id);
    if (!exists) {
      return NextResponse.json({ error: "Idea not found" }, { status: 404 });
    }

    const next = {
      ...ctx,
      active_trade_ideas: ctx.active_trade_ideas.filter((i) => i.id !== id),
    };
    await writeContext(kv, next);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[idea DELETE]", err);
    return NextResponse.json(
      { error: "Failed to delete idea" },
      { status: 500 }
    );
  }
}
