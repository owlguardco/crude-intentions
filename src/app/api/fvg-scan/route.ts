/**
 * CRUDE INTENTIONS — FVG Auto-Scan (Phase 2F)
 *
 * POST /api/fvg-scan
 *
 * Body: { candles: Candle[] (>=3), min_size_ticks?: number, auto_save?: boolean }
 * Auth: requires INTERNAL_API_KEY (x-api-key or Bearer header).
 *
 * If auto_save is true, the detected FVGs (up to 5) are appended to the
 * persisted market context using the same shape as
 * POST /api/market-context/fvg.
 */

import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { kv } from '@/lib/kv';
import { detectFVGs } from '@/lib/alfred/fvg-detector';
import {
  readContext,
  writeContext,
  type ActiveFvg,
} from '@/lib/market-memory/context';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const MAX_ACTIVE_FVGS = 10;
const MAX_AUTO_SAVE = 5;

const BodySchema = z.object({
  candles: z.array(z.object({
    high: z.number().finite().min(10).max(500),
    low: z.number().finite().min(10).max(500),
    close: z.number().finite().min(10).max(500),
    timestamp: z.string(),
  })).min(3).max(500),
  min_size_ticks: z.number().positive().optional(),
  auto_save: z.boolean().optional().default(false),
}).strict();

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get('x-api-key') ?? req.headers.get('authorization');
  if (!header) return false;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return safeEq(token, INTERNAL_API_KEY);
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

  const fvgs = detectFVGs(parsed.data.candles, parsed.data.min_size_ticks);

  let saved_count = 0;
  if (parsed.data.auto_save && fvgs.length > 0) {
    try {
      const ctx = await readContext(kv);
      const room = MAX_ACTIVE_FVGS - ctx.active_fvgs.length;
      const slots = Math.max(0, Math.min(MAX_AUTO_SAVE, room));
      if (slots > 0) {
        const toSave: ActiveFvg[] = fvgs.slice(0, slots).map((d) => ({
          id: randomUUID(),
          direction: d.type === 'BULLISH' ? 'bullish' : 'bearish',
          top: d.top,
          bottom: d.bottom,
          age_bars: 0,
          status: 'unfilled',
          timeframe: '15min',
          quality: 'medium',
          created_at: d.formed_at,
        }));

        const next = { ...ctx, active_fvgs: [...ctx.active_fvgs, ...toSave] };
        await writeContext(kv, next);
        saved_count = toSave.length;
      }
    } catch (err) {
      console.error('[fvg-scan auto-save]', err);
    }
  }

  return NextResponse.json({ fvgs, saved_count });
}
