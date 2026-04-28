/**
 * CRUDE INTENTIONS — Virtual Position API (Phase 2E)
 *
 * GET    /api/position  → { position }
 * POST   /api/position  → open a new position (409 if one exists)
 * PATCH  /api/position  → update stop_loss / target / notes
 * DELETE /api/position  → close (delete) the current position
 *
 * Auth: requires INTERNAL_API_KEY (x-api-key or Bearer header).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  closePosition,
  getPosition,
  openPosition,
  updatePosition,
} from '@/lib/position/position-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get('x-api-key') ?? req.headers.get('authorization');
  if (!header) return false;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
}

const OpenSchema = z.object({
  direction: z.enum(['LONG', 'SHORT']),
  entry_price: z.number().finite().min(10).max(500),
  contracts: z.number().int().min(1).max(10),
  stop_loss: z.number().finite().min(10).max(500).nullable().optional(),
  target: z.number().finite().min(10).max(500).nullable().optional(),
  session: z.string(),
  alfred_score: z.number().nullable().optional(),
  alfred_confidence: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
}).strict();

const PatchSchema = z.object({
  stop_loss: z.number().finite().min(10).max(500).nullable().optional(),
  target: z.number().finite().min(10).max(500).nullable().optional(),
  notes: z.string().nullable().optional(),
}).strict();

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const position = await getPosition();
  return NextResponse.json({ position });
}

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = OpenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await getPosition();
  if (existing) {
    return NextResponse.json({ error: 'Position already open' }, { status: 409 });
  }

  const data = {
    direction: parsed.data.direction,
    entry_price: parsed.data.entry_price,
    contracts: parsed.data.contracts,
    stop_loss: parsed.data.stop_loss ?? null,
    target: parsed.data.target ?? null,
    session: parsed.data.session,
    alfred_score: parsed.data.alfred_score ?? null,
    alfred_confidence: parsed.data.alfred_confidence ?? null,
    notes: parsed.data.notes ?? null,
  };

  const position = await openPosition(data);
  return NextResponse.json({ position });
}

export async function PATCH(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const position = await updatePosition(parsed.data);
  if (!position) {
    return NextResponse.json({ error: 'No position open' }, { status: 404 });
  }
  return NextResponse.json({ position });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  await closePosition();
  return NextResponse.json({ ok: true });
}
