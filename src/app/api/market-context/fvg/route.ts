/**
 * CRUDE INTENTIONS — FVG Add
 *
 * POST /api/market-context/fvg
 *
 * Appends a new ActiveFvg to the persisted context. The server fills in
 * id (UUID) and created_at; the client sends the descriptive fields.
 *
 * Auth: requires INTERNAL_API_KEY.
 */

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import {
  readContext,
  writeContext,
  type ActiveFvg,
  type FvgQuality,
  type FvgStatus,
  type FvgTimeframe,
} from "@/lib/market-memory/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const MAX_ACTIVE_FVGS = 10;

const VALID_TIMEFRAMES: FvgTimeframe[] = ["4H", "1H", "15min"];
const VALID_QUALITIES: FvgQuality[]   = ["high", "medium", "low"];
const VALID_STATUSES:  FvgStatus[]    = ["unfilled", "partially_filled", "filled"];

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get("x-api-key") ?? req.headers.get("authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
}

interface AddFvgBody {
  direction?: "bullish" | "bearish";
  top?: number;
  bottom?: number;
  timeframe?: FvgTimeframe;
  quality?: FvgQuality;
  status?: FvgStatus;
  age_bars?: number;
}

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: AddFvgBody;
  try {
    body = (await req.json()) as AddFvgBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.direction !== "bullish" && body.direction !== "bearish") {
    return NextResponse.json(
      { error: "direction must be 'bullish' or 'bearish'" },
      { status: 400 }
    );
  }
  if (typeof body.top !== "number" || typeof body.bottom !== "number") {
    return NextResponse.json(
      { error: "top and bottom must be numbers" },
      { status: 400 }
    );
  }
  if (body.top <= body.bottom) {
    return NextResponse.json(
      { error: "top must be greater than bottom" },
      { status: 400 }
    );
  }
  if (!body.timeframe || !VALID_TIMEFRAMES.includes(body.timeframe)) {
    return NextResponse.json(
      { error: `timeframe must be one of ${VALID_TIMEFRAMES.join(", ")}` },
      { status: 400 }
    );
  }
  if (!body.quality || !VALID_QUALITIES.includes(body.quality)) {
    return NextResponse.json(
      { error: `quality must be one of ${VALID_QUALITIES.join(", ")}` },
      { status: 400 }
    );
  }
  const status: FvgStatus =
    body.status && VALID_STATUSES.includes(body.status) ? body.status : "unfilled";
  const ageBars = typeof body.age_bars === "number" ? body.age_bars : 0;

  try {
    const ctx = await readContext(kv);

    if (ctx.active_fvgs.length >= MAX_ACTIVE_FVGS) {
      return NextResponse.json(
        { error: `Active FVG limit reached (${MAX_ACTIVE_FVGS}). Remove one first.` },
        { status: 409 }
      );
    }

    const newFvg: ActiveFvg = {
      id: randomUUID(),
      direction: body.direction,
      top: body.top,
      bottom: body.bottom,
      age_bars: ageBars,
      status,
      timeframe: body.timeframe,
      quality: body.quality,
      created_at: new Date().toISOString(),
    };

    const next = { ...ctx, active_fvgs: [...ctx.active_fvgs, newFvg] };
    await writeContext(kv, next);

    return NextResponse.json({ ok: true, fvg: newFvg });
  } catch (err) {
    console.error("[fvg POST]", err);
    return NextResponse.json(
      { error: "Failed to add FVG", detail: String(err) },
      { status: 500 }
    );
  }
}
