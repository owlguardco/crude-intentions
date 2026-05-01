/**
 * CRUDE INTENTIONS — Conditions Now
 *
 * GET /api/conditions (no auth)
 *
 * Lightweight glanceable readout for the dashboard CONDITIONS NOW tile.
 * Returns 8 booleans (or null when a data source for the condition isn't
 * wired yet) so the widget can render dots without each tab fanning out
 * to the underlying KV keys.
 *
 *   ema_4h           — null (no live 4H EMA source server-side)
 *   ema_15m          — null (no live 15M EMA source server-side)
 *   rsi_reset        — null (no live RSI source server-side)
 *   fvg_present      — derived from market:fvg_scan auto-detected gaps
 *   vwap             — null (no live VWAP source)
 *   ovx_clean        — true when OVX in [20, 35]
 *   session_window   — true when NY-local time is 09:30..11:45
 *   eia_clear        — true when NOT inside Wed 07:30..13:30 ET window
 */

import { NextResponse } from 'next/server';
import { kv } from '@/lib/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OvxCached { price?: number }
interface FvgItem { type: 'BULLISH' | 'BEARISH'; midpoint?: number; top?: number; bottom?: number }
interface FvgSnapshot { bullish?: FvgItem[]; bearish?: FvgItem[] }
interface ClPriceCached { price?: number }

export interface ConditionsResponse {
  ema_4h: boolean | null;
  ema_15m: boolean | null;
  rsi_reset: boolean | null;
  fvg_present: boolean | null;
  vwap: boolean | null;
  ovx_clean: boolean | null;
  session_window: boolean | null;
  eia_clear: boolean | null;
  generated_at: string;
}

function nyLocalParts(now: Date): { hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const wkd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute, weekday: weekdayMap[wkd] ?? 1 };
}

function sessionPass(hour: number, minute: number): boolean {
  const totalMin = hour * 60 + minute;
  return totalMin >= 9 * 60 + 30 && totalMin <= 11 * 60 + 45;
}

function eiaClear(weekday: number, hour: number, minute: number): boolean {
  if (weekday !== 3) return true; // not Wed
  const totalMin = hour * 60 + minute;
  const start = 7 * 60 + 30;
  const end = 13 * 60 + 30;
  return totalMin < start || totalMin > end;
}

export async function GET() {
  const now = new Date();
  const { hour, minute, weekday } = nyLocalParts(now);

  // OVX — read the cached value the price strip already polls.
  let ovxClean: boolean | null = null;
  try {
    const ovx = await kv.get<OvxCached>('ovx:latest');
    if (ovx && typeof ovx.price === 'number' && Number.isFinite(ovx.price)) {
      ovxClean = ovx.price >= 20 && ovx.price <= 35;
    }
  } catch {
    // fall through — leave null
  }

  // FVG presence — auto-scanned 4H FVGs in KV. "Present" = at least one
  // unfilled gap with the current price within $1.50 of its midpoint
  // (loose proximity floor; the structural FVG check on the pre-trade
  // route is much tighter).
  let fvgPresent: boolean | null = null;
  try {
    const [snap, cl] = await Promise.all([
      kv.get<FvgSnapshot>('market:fvg_scan'),
      kv.get<ClPriceCached>('cl-price:latest'),
    ]);
    if (snap) {
      const all: FvgItem[] = [...(snap.bullish ?? []), ...(snap.bearish ?? [])];
      const price = typeof cl?.price === 'number' ? cl.price : null;
      if (price === null) {
        fvgPresent = all.length > 0;
      } else {
        const PROX = 1.5;
        fvgPresent = all.some((f) => {
          const mid = typeof f.midpoint === 'number'
            ? f.midpoint
            : (typeof f.top === 'number' && typeof f.bottom === 'number' ? (f.top + f.bottom) / 2 : null);
          return mid !== null && Math.abs(price - mid) <= PROX;
        });
      }
    }
  } catch {
    // fall through
  }

  const result: ConditionsResponse = {
    ema_4h: null,
    ema_15m: null,
    rsi_reset: null,
    fvg_present: fvgPresent,
    vwap: null,
    ovx_clean: ovxClean,
    session_window: sessionPass(hour, minute),
    eia_clear: eiaClear(weekday, hour, minute),
    generated_at: now.toISOString(),
  };

  return NextResponse.json(result);
}
