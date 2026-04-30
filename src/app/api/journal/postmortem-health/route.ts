/**
 * CRUDE INTENTIONS — Post-Mortem Health Check
 *
 * GET /api/journal/postmortem-health (no auth)
 *
 * Reports whether the env vars firePostMortem() depends on are set.
 * Returns booleans only — never echoes the values themselves so the
 * route stays safe to expose unauthenticated.
 *
 * Curl from Railway / a script to confirm post-mortems will fire after
 * a Vercel env-var change without having to wait for the next close.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
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
