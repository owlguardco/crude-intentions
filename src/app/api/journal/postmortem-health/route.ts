/**
 * CRUDE INTENTIONS — Post-Mortem Health Check
 *
 * GET /api/journal/postmortem-health
 *
 * Reports whether the env vars firePostMortem() depends on are set.
 * Returns booleans only — never echoes the values themselves.
 *
 * Auth: x-api-key (INTERNAL_API_KEY). The Railway health check stamps
 * the key on every poll. F-21 (2026-04-30 audit) closed the prior
 * unauthenticated info-disclosure surface.
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

export async function GET(req: NextRequest) {
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY not configured' }, { status: 500 });
  }
  const auth = req.headers.get('x-api-key');
  if (!auth || !safeEq(auth, INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const vercel_app_url_set = !!process.env.VERCEL_APP_URL;
  const internal_api_key_set = !!process.env.INTERNAL_API_KEY;
  const anthropic_api_key_set = !!process.env.ANTHROPIC_API_KEY;
  const healthy = vercel_app_url_set && internal_api_key_set && anthropic_api_key_set;

  return NextResponse.json({
    vercel_app_url_set,
    internal_api_key_set,
    anthropic_api_key_set,
    healthy,
  });
}
