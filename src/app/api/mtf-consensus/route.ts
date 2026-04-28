/**
 * CRUDE INTENTIONS — Multi-Timeframe Consensus
 *
 * POST /api/mtf-consensus
 *
 * Body: { signals: MTFSignal[] (1–3 items) }
 * Auth: requires INTERNAL_API_KEY (x-api-key or Bearer header).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { computeMTFConsensus } from '@/lib/alfred/mtf-consensus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const MTFSignalSchema = z.object({
  timeframe: z.enum(['1H', '4H', 'D']),
  ema_aligned: z.boolean(),
  rsi_value: z.number().finite().min(0).max(100),
  above_vwap: z.boolean().nullable(),
  trend: z.enum(['UP', 'DOWN', 'NEUTRAL']),
});

const BodySchema = z.object({
  signals: z.array(MTFSignalSchema).min(1).max(3),
}).strict();

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get('x-api-key') ?? req.headers.get('authorization');
  if (!header) return false;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
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

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = computeMTFConsensus(parsed.data.signals);
  return NextResponse.json(result);
}
