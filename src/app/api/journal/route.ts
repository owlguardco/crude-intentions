import { NextRequest, NextResponse } from 'next/server';
import { JournalWriteSchema } from '@/lib/validation/journal-schema';
import { readJournal, writeJournalEntry, updateJournalOutcome, type JournalEntry } from '@/lib/journal/writer';
import { OutcomeUpdateSchema } from '@/lib/validation/journal-schema';
import { kv } from '@/lib/kv';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// ─── GET /api/journal ─────────────────────────────────────────────────────────
// Returns full journal: decisions array + summary stats.
export async function GET() {
  try {
    const journal = await readJournal();
    return NextResponse.json(journal);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[JOURNAL] Read error:', message);
    return NextResponse.json(
      { error: 'Could not read journal. Check data/safety_check_log.json for formatting errors.' },
      { status: 500 }
    );
  }
}

// ─── POST /api/journal ────────────────────────────────────────────────────────
// Appends a new decision entry. Validates with Zod before writing.
// Returns the written entry with its ID and integrity hash.
export async function POST(req: NextRequest) {
  try {
    // ── Request size guard (10KB max) ──────────────────────────────────────
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 10 * 1024) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    const body = await req.json();

    // ── Zod validation ────────────────────────────────────────────────────
    const parsed = JournalWriteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid journal entry', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // ── Write to disk ─────────────────────────────────────────────────────
    const result = await writeJournalEntry(parsed.data);

    return NextResponse.json(
      {
        success: true,
        id: result.id,
        integrity_hash: result.integrity_hash,
        entry: result.entry,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[JOURNAL] Write error:', message);
    return NextResponse.json({ error: 'Failed to write journal entry' }, { status: 500 });
  }
}

// ─── PATCH /api/journal ───────────────────────────────────────────────────────
// Updates the outcome of an existing entry after trade closes.
// Body: { id: string, outcome: OutcomeUpdateInput }
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, outcome } = body;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid entry id' }, { status: 400 });
    }

    const parsed = OutcomeUpdateSchema.safeParse(outcome);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid outcome data', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await updateJournalOutcome(id, parsed.data);

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: result.message });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[JOURNAL] Outcome update error:', message);
    return NextResponse.json({ error: 'Failed to update outcome' }, { status: 500 });
  }
}

// ─── DELETE /api/journal?filter=historical ───────────────────────────────────
// Wipes all entries where historical === true && backtest_source === true,
// then clears calibration:latest and calibration:history so the next close
// produces a clean snapshot. Use this to re-import the backtest with the
// correct historical timestamps after the timestamp-override fix.
//
// Auth: x-api-key header (INTERNAL_API_KEY).
// Returns: { deleted, remaining }.
export async function DELETE(req: NextRequest) {
  if (!INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'INTERNAL_API_KEY not configured' }, { status: 500 });
  }
  const auth = req.headers.get('x-api-key');
  if (auth !== INTERNAL_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const filter = req.nextUrl.searchParams.get('filter');
  if (filter !== 'historical') {
    return NextResponse.json(
      { error: "Unsupported filter — only ?filter=historical is recognized" },
      { status: 400 },
    );
  }

  try {
    const entries = (await kv.get<JournalEntry[]>('journal:entries')) ?? [];
    const before = entries.length;
    const remainingEntries = entries.filter(
      (e) => !(e.historical === true && e.backtest_source === true),
    );
    const deleted = before - remainingEntries.length;

    await kv.set('journal:entries', remainingEntries);
    await kv.del('calibration:latest');
    await kv.del('calibration:history');

    console.log(`[JOURNAL] DELETE filter=historical: deleted=${deleted} remaining=${remainingEntries.length}`);

    return NextResponse.json({ deleted, remaining: remainingEntries.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[JOURNAL] Delete error:', message);
    return NextResponse.json({ error: 'Failed to delete entries', detail: message }, { status: 500 });
  }
}
