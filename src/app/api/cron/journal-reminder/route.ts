/**
 * CRUDE INTENTIONS — Daily Journal Reminder Cron
 *
 * GET /api/cron/journal-reminder
 *   Auth: Authorization: Bearer ${CRON_SECRET} (Vercel cron default)
 *         or x-cron-secret: ${CRON_SECRET}
 *
 * Schedule: Monday–Friday 23:00 UTC (= 7 PM ET / 6 PM ET during DST shifts).
 * Configured in vercel.json.
 *
 * Logic:
 *   - Read journal:entries from KV
 *   - Match today's UTC date against entry.timestamp.slice(0,10) or entry.date
 *   - If at least one match exists → do nothing (return skipped:true)
 *   - If no match → POST a reminder to DISCORD_JOURNAL_WEBHOOK_URL
 *
 * Env:
 *   CRON_SECRET                 (required) — auth
 *   DISCORD_JOURNAL_WEBHOOK_URL (required for delivery) — Discord channel webhook
 */

import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import { safeEq } from '@/lib/auth/safe-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CRON_SECRET = process.env.CRON_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_JOURNAL_WEBHOOK_URL;

const REMINDER_MESSAGE =
  '⚠️ No journal entry logged today. If no trade was taken, log a NO TRADE session at crude-intentions.vercel.app/journal';

interface StoredEntry {
  id?: string;
  timestamp?: string;
  date?: string;
  type?: string;
}

function isAuthorised(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get('authorization');
  if (auth && auth.startsWith('Bearer ') && safeEq(auth.slice(7), CRON_SECRET)) return true;
  const direct = req.headers.get('x-cron-secret');
  if (direct && safeEq(direct, CRON_SECRET)) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const entries = (await kv.get<StoredEntry[]>('journal:entries')) ?? [];

  const hasEntryToday = entries.some((e) => {
    const tsDay = typeof e.timestamp === 'string' ? e.timestamp.slice(0, 10) : '';
    const dateField = typeof e.date === 'string' ? e.date : '';
    return tsDay === today || dateField === today;
  });

  if (hasEntryToday) {
    return NextResponse.json({ ok: true, skipped: true, date: today, reason: 'entry_exists' });
  }

  if (!DISCORD_WEBHOOK_URL) {
    console.error('[journal-reminder] DISCORD_JOURNAL_WEBHOOK_URL not set — cannot deliver reminder');
    return NextResponse.json(
      { ok: false, skipped: false, date: today, reason: 'webhook_not_configured' },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: REMINDER_MESSAGE }),
    });
    if (!res.ok) {
      console.error('[journal-reminder] Discord webhook returned', res.status);
      return NextResponse.json(
        { ok: false, skipped: false, date: today, reason: 'webhook_failed', status: res.status },
        { status: 502 },
      );
    }
  } catch (err) {
    console.error('[journal-reminder] Discord webhook threw:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, skipped: false, date: today, reason: 'webhook_threw' },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, skipped: false, date: today, sent: true });
}
