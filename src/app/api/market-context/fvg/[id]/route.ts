/**
 * CRUDE INTENTIONS — FVG by id
 *
 * PATCH  /api/market-context/fvg/[id]   — update status (or other fields)
 * DELETE /api/market-context/fvg/[id]   — remove from active_fvgs
 *
 * Auth: requires INTERNAL_API_KEY.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import {
  readContext,
  writeContext,
  type ActiveFvg,
  type FvgStatus,
} from "@/lib/market-memory/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const VALID_STATUSES: FvgStatus[] = ["unfilled", "partially_filled", "filled"];

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get("x-api-key") ?? req.headers.get("authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
}

interface PatchFvgBody {
  status?: FvgStatus;
  age_bars?: number;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: PatchFvgBody;
  try {
    body = (await req.json()) as PatchFvgBody;
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
    const idx = ctx.active_fvgs.findIndex((f) => f.id === params.id);
    if (idx === -1) {
      return NextResponse.json({ error: "FVG not found" }, { status: 404 });
    }

    const updated: ActiveFvg = {
      ...ctx.active_fvgs[idx],
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(typeof body.age_bars === "number" ? { age_bars: body.age_bars } : {}),
    };
    const next = {
      ...ctx,
      active_fvgs: ctx.active_fvgs.map((f, i) => (i === idx ? updated : f)),
    };
    await writeContext(kv, next);

    return NextResponse.json({ ok: true, fvg: updated });
  } catch (err) {
    console.error("[fvg PATCH]", err);
    return NextResponse.json(
      { error: "Failed to update FVG", detail: String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const ctx = await readContext(kv);
    const exists = ctx.active_fvgs.some((f) => f.id === params.id);
    if (!exists) {
      return NextResponse.json({ error: "FVG not found" }, { status: 404 });
    }

    const next = {
      ...ctx,
      active_fvgs: ctx.active_fvgs.filter((f) => f.id !== params.id),
    };
    await writeContext(kv, next);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[fvg DELETE]", err);
    return NextResponse.json(
      { error: "Failed to delete FVG", detail: String(err) },
      { status: 500 }
    );
  }
}
