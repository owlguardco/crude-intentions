/**
 * CRUDE INTENTIONS — Bulk Journal Import
 *
 * POST /api/journal/import
 *   Auth: x-api-key header (INTERNAL_API_KEY)
 *   Body: { trades: JournalWriteInput[] }   1..50
 *
 * For each trade:
 *   - Defaults source='IMPORT' and paper_trading=true unless caller set them
 *   - writeJournalEntry() to create the entry
 *   - If outcome.status is WIN/LOSS/SCRATCH, call closeTrade() so calibration
 *     updates on each closed entry. Sequential, no Promise.all.
 *
 * Returns { imported, skipped, errors: [{ index, message }] }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { JournalWriteSchema } from '@/lib/validation/journal-schema';
import { writeJournalEntry } from '@/lib/journal/writer';
import { closeTrade, type CloseStatus } from '@/lib/journal/close-trade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const BodySchema = z.object({
  trades: z.array(z.unknown()).min(1).max(50),
}).strict();

interface ImportError { index: number; message: string; }

function isAuthorised(req: NextRequest): boolean {
  if (!INTERNAL_API_KEY) return false;
  const header = req.headers.get('x-api-key') ?? req.headers.get('authorization');
  if (!header) return false;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === INTERNAL_API_KEY;
}

function applyImportDefaults(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  return {
    ...obj,
    source: obj.source ?? 'IMPORT',
    paper_trading: obj.paper_trading ?? true,
  };
}

function mapOutcomeStatus(s: unknown): CloseStatus | null {
  if (s === 'WIN' || s === 'LOSS' || s === 'SCRATCH') return s;
  return null;
}

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  const trades = parsed.data.trades;
  const errors: ImportError[] = [];
  let imported = 0;

  for (let i = 0; i < trades.length; i++) {
    const withDefaults = applyImportDefaults(trades[i]);

    const entryParse = JournalWriteSchema.safeParse(withDefaults);
    if (!entryParse.success) {
      const flat = entryParse.error.flatten();
      const fieldErrs = Object.entries(flat.fieldErrors)
        .map(([k, v]) => `${k}: ${(v ?? []).join(', ')}`)
        .join(' | ');
      errors.push({ index: i, message: fieldErrs || 'Validation failed' });
      continue;
    }

    let writtenId: string;
    try {
      const result = await writeJournalEntry(entryParse.data);
      writtenId = result.id;
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Write failed';
      errors.push({ index: i, message });
      continue;
    }

    // Close path — only when caller explicitly supplied a closed outcome
    const rawObj = (trades[i] && typeof trades[i] === 'object'
      ? (trades[i] as Record<string, unknown>)
      : {});
    const rawOutcome =
      rawObj.outcome && typeof rawObj.outcome === 'object'
        ? (rawObj.outcome as Record<string, unknown>)
        : null;
    const status = mapOutcomeStatus(rawOutcome?.status);

    if (status) {
      const ticksRaw = typeof rawOutcome?.result === 'number' ? rawOutcome.result : 0;
      const entryPrice =
        typeof entryParse.data.entry_price === 'number' ? entryParse.data.entry_price : null;
      let closePrice: number;
      if (typeof rawOutcome?.close_price === 'number') {
        closePrice = rawOutcome.close_price;
      } else if (entryPrice != null) {
        const isLong = entryParse.data.direction === 'LONG';
        closePrice = isLong
          ? entryPrice + ticksRaw / 100
          : entryPrice - ticksRaw / 100;
      } else {
        // Cannot synthesize a close price; skip the close step.
        errors.push({
          index: i,
          message: 'Imported but could not close (no entry_price)',
        });
        continue;
      }

      try {
        const closeRes = await closeTrade({
          id: writtenId,
          close_price: closePrice,
          forced_status: status,
          forced_ticks: ticksRaw,
        });
        if (!closeRes.ok) {
          errors.push({
            index: i,
            message: `Imported but close failed: ${closeRes.error ?? 'unknown'}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Close threw';
        errors.push({ index: i, message: `Imported but close failed: ${message}` });
      }
    }
  }

  const skipped = trades.length - imported;
  return NextResponse.json({ imported, skipped, errors });
}
