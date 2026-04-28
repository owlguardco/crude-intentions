import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import type { JournalWriteInput } from '@/lib/validation/journal-schema';

// ─── Redis client ─────────────────────────────────────────────────────────────
// Uses kv_REDIS_URL from env (set by Vercel Redis integration)
const redis = new Redis({
  url: process.env.kv_REDIS_URL ?? process.env.KV_REDIS_URL ?? '',
  token: '', // Upstash token not needed for Redis URL auth — handled in URL
});

const JOURNAL_KEY     = 'journal:entries';
const SUMMARY_KEY     = 'journal:summary';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface JournalEntry extends JournalWriteInput {
  id:             string;
  timestamp:      string;
  integrity_hash: string;
  outcome: {
    status:                'OPEN' | 'WIN' | 'LOSS' | 'SCRATCH' | 'BLOCKED' | 'EXPIRED';
    result:                number | null;
    result_dollars:        number | null;
    close_timestamp:       string | null;
    close_price:           number | null;
    post_mortem:           string | null;
    post_mortem_timestamp: string | null;
  };
}

export interface JournalSummary {
  total_evaluations: number;
  trades_taken:      number;
  trades_blocked:    number;
  win:               number;
  loss:              number;
  win_rate_pct:      number;
  last_updated:      string;
}

export interface JournalData {
  schema_version: string;
  decisions:      JournalEntry[];
  summary:        JournalSummary;
}

// ─── Read journal ─────────────────────────────────────────────────────────────
export async function readJournal(): Promise<JournalData> {
  try {
    const [entries, summary] = await Promise.all([
      redis.get<JournalEntry[]>(JOURNAL_KEY),
      redis.get<JournalSummary>(SUMMARY_KEY),
    ]);
    return {
      schema_version: '1.1',
      decisions:      entries ?? [],
      summary:        summary ?? {
        total_evaluations: 0, trades_taken: 0, trades_blocked: 0,
        win: 0, loss: 0, win_rate_pct: 0, last_updated: '',
      },
    };
  } catch {
    return {
      schema_version: '1.1',
      decisions: [],
      summary: { total_evaluations: 0, trades_taken: 0, trades_blocked: 0, win: 0, loss: 0, win_rate_pct: 0, last_updated: '' },
    };
  }
}

// ─── Generate entry ID ────────────────────────────────────────────────────────
function generateId(entries: JournalEntry[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const n = entries.filter(e => e.id?.startsWith(`CI-${today}`)).length;
  return `CI-${today}-${(n + 1).toString().padStart(3, '0')}`;
}

// ─── SHA-256 integrity hash ───────────────────────────────────────────────────
export function computeIntegrityHash(
  id: string, timestamp: string, direction: string,
  score: number, entry_price: number | null
): string {
  const payload = `${id}|${timestamp}|${direction}|${score}|${entry_price ?? 'null'}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ─── Recompute summary ────────────────────────────────────────────────────────
function recomputeSummary(entries: JournalEntry[]): JournalSummary {
  const taken   = entries.filter(e => e.direction !== 'NO TRADE');
  const blocked = entries.filter(e => e.direction === 'NO TRADE');
  const wins    = entries.filter(e => e.outcome?.status === 'WIN');
  const losses  = entries.filter(e => e.outcome?.status === 'LOSS');
  const closed  = wins.length + losses.length;
  return {
    total_evaluations: entries.length,
    trades_taken:      taken.length,
    trades_blocked:    blocked.length,
    win:               wins.length,
    loss:              losses.length,
    win_rate_pct:      closed > 0 ? Math.round((wins.length / closed) * 100) : 0,
    last_updated:      new Date().toISOString(),
  };
}

// ─── Write journal entry ──────────────────────────────────────────────────────
export interface WriteResult {
  success:        boolean;
  id:             string;
  integrity_hash: string;
  entry:          JournalEntry;
}

export async function writeJournalEntry(input: JournalWriteInput): Promise<WriteResult> {
  const journal   = await readJournal();
  const id        = generateId(journal.decisions);
  const timestamp = new Date().toISOString();
  const integrity_hash = computeIntegrityHash(id, timestamp, input.direction, input.score, input.entry_price);

  const entry: JournalEntry = {
    ...input,
    id,
    timestamp,
    integrity_hash,
    outcome: {
      status:                input.direction === 'NO TRADE' ? 'BLOCKED' : 'OPEN',
      result:                null,
      result_dollars:        null,
      close_timestamp:       null,
      close_price:           null,
      post_mortem:           null,
      post_mortem_timestamp: null,
    },
  };

  const updatedEntries = [...journal.decisions, entry];
  const updatedSummary = recomputeSummary(updatedEntries);

  await Promise.all([
    redis.set(JOURNAL_KEY, updatedEntries),
    redis.set(SUMMARY_KEY, updatedSummary),
  ]);

  return { success: true, id, integrity_hash, entry };
}

// ─── Update outcome ───────────────────────────────────────────────────────────
export interface OutcomeUpdateInput {
  status:          'WIN' | 'LOSS' | 'SCRATCH' | 'EXPIRED';
  close_price:     number;
  close_timestamp: string;
  result:          number;
  result_dollars:  number;
}

export async function updateJournalOutcome(
  id: string,
  update: OutcomeUpdateInput
): Promise<{ success: boolean; message: string }> {
  const journal = await readJournal();
  const idx = journal.decisions.findIndex(e => e.id === id);

  if (idx === -1) return { success: false, message: `Entry ${id} not found` };

  journal.decisions[idx].outcome = {
    ...journal.decisions[idx].outcome,
    ...update,
    post_mortem:           journal.decisions[idx].outcome?.post_mortem ?? null,
    post_mortem_timestamp: journal.decisions[idx].outcome?.post_mortem_timestamp ?? null,
  };

  const updatedSummary = recomputeSummary(journal.decisions);

  await Promise.all([
    redis.set(JOURNAL_KEY, journal.decisions),
    redis.set(SUMMARY_KEY, updatedSummary),
  ]);

  return { success: true, message: `Outcome updated for ${id}` };
}
