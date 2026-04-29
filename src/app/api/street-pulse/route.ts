/**
 * CRUDE INTENTIONS — Street Pulse Sentiment Stub
 *
 * GET /api/street-pulse (no auth)
 *
 * STUB: returns a NEUTRAL / zero-sample response until the real sentiment
 * source is wired. The widget renders an "AWAITING DATA" empty state when
 * `samples === 0`. To activate, replace the body of this handler with a
 * real aggregator (Reuters/Bloomberg crude-tagged headlines + sentiment
 * scoring) that returns the same shape.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface StreetPulseHeadline {
  title: string;
  source: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  published_at: string;
}

export interface StreetPulseResponse {
  score: number; // -100 .. +100
  label: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  samples: number;
  headlines: StreetPulseHeadline[];
  updated_at: string;
}

export async function GET() {
  const payload: StreetPulseResponse = {
    score: 0,
    label: 'NEUTRAL',
    samples: 0,
    headlines: [],
    updated_at: new Date().toISOString(),
  };
  return NextResponse.json(payload);
}
