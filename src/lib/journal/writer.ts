import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { JournalWriteInput } from '@/lib/validation/journal-schema';

// ─── File path ────────────────────────────────────────────────────────────────
const JOURNAL_FILE = path.join(process.cwd(), 'src', 'data', 'safety_check_log.json');

// ─── Types ────────────────────────────────────────────────────────────────────
export interface JournalEntry extends JournalWriteInput {
  id:              string;
  timestamp:       string;
  integrity_hash:  string;
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

interface JournalFile {
  schema_version: string;
  decisions: JournalEntry[];
  summary: {
    total_evaluations: number;
    trades_taken:      number;
    trades_blocked:    number;
    win:               number;
    loss:              number;
    win_rate_pct:      number;
    last_updated:      string;
  };
}

// ─── Read journal from disk ───────────────────────────────────────────────────
export function readJournal(): JournalFile {
  if (!fs.existsSync(JOURNAL_FILE)) {
    return {
      schema_version: '1.1',
      decisions: [],
      summary: {
        total_evaluations: 0,
        trades_taken: 0,
        trades_blocked: 0,
        win: 0,
        loss: 0,
        win_rate_pct: 0,
        last_updated: '',
      },
    };
  }

  const raw = fs.readFileSync(JOURNAL_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as JournalFile;

  // Migrate v1.0 → v1.1 on read if needed
  if (!parsed.schema_version || parsed.schema_version === '1.0') {
    parsed.schema_version = '1.1';
  }

  return parsed;
}

// ─── Generate entry ID: CI-YYYY-MM-DD-NNN ────────────────────────────────────
function generateId(journal: JournalFile): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const todayEntries = journal.decisions.filter(
    (d) => d.id && d.id.startsWith(`CI-${today}`)
  );
  const seq = (todayEntries.length + 1).toString().padStart(3, '0');
  return `CI-${today}-${seq}`;
}

// ─── SHA-256 integrity hash ───────────────────────────────────────────────────
// Hash input: id + timestamp + direction + score + entry_price (or "null")
export function computeIntegrityHash(
  id: string,
  timestamp: string,
  direction: string,
  score: number,
  entry_price: number | null
): string {
  const payload = `${id}|${timestamp}|${direction}|${score}|${entry_price ?? 'null'}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ─── Recompute summary stats from decisions array ────────────────────────────
function recomputeSummary(decisions: JournalEntry[]): JournalFile['summary'] {
  const real = decisions.filter((d) => !('_comment' in d));
  const taken  = real.filter((d) => d.direction !== 'NO TRADE');
  const blocked = real.filter((d) => d.direction === 'NO TRADE');
  const wins   = real.filter((d) => d.outcome?.status === 'WIN');
  const losses = real.filter((d) => d.outcome?.status === 'LOSS');
  const closed = wins.length + losses.length;

  return {
    total_evaluations: real.length,
    trades_taken:      taken.length,
    trades_blocked:    blocked.length,
    win:               wins.length,
    loss:              losses.length,
    win_rate_pct:      closed > 0 ? Math.round((wins.length / closed) * 100) : 0,
    last_updated:      new Date().toISOString(),
  };
}

// ─── Main write function ──────────────────────────────────────────────────────
export interface WriteResult {
  success: boolean;
  id:      string;
  integrity_hash: string;
  entry:   JournalEntry;
}

export function writeJournalEntry(input: JournalWriteInput): WriteResult {
  const journal = readJournal();
  const id        = generateId(journal);
  const timestamp = new Date().toISOString();
  const integrity_hash = computeIntegrityHash(
    id,
    timestamp,
    input.direction,
    input.score,
    input.entry_price
  );

  const entry: JournalEntry = {
    ...input,
    id,
    timestamp,
    integrity_hash,
    // Outcome always starts OPEN on creation
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

  // Remove any example entries (entries with _comment) on first real write
  const cleanDecisions = journal.decisions.filter((d) => !('_comment' in d));
  cleanDecisions.push(entry);

  const updated: JournalFile = {
    schema_version: '1.1',
    decisions:      cleanDecisions,
    summary:        recomputeSummary(cleanDecisions),
  };

  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(updated, null, 2), 'utf-8');

  return { success: true, id, integrity_hash, entry };
}

// ─── Update outcome for a closed trade ───────────────────────────────────────
export interface OutcomeUpdateInput {
  status:          'WIN' | 'LOSS' | 'SCRATCH' | 'EXPIRED';
  close_price:     number;
  close_timestamp: string;
  result:          number;   // ticks
  result_dollars:  number;
}

export function updateJournalOutcome(
  id: string,
  update: OutcomeUpdateInput
): { success: boolean; message: string } {
  const journal = readJournal();
  const idx = journal.decisions.findIndex((d) => d.id === id);

  if (idx === -1) {
    return { success: false, message: `Entry ${id} not found` };
  }

  journal.decisions[idx].outcome = {
    ...journal.decisions[idx].outcome,
    status:          update.status,
    close_price:     update.close_price,
    close_timestamp: update.close_timestamp,
    result:          update.result,
    result_dollars:  update.result_dollars,
    // post_mortem is written separately by Prompt 10
    post_mortem:           journal.decisions[idx].outcome?.post_mortem ?? null,
    post_mortem_timestamp: journal.decisions[idx].outcome?.post_mortem_timestamp ?? null,
  };

  const updated: JournalFile = {
    ...journal,
    summary: recomputeSummary(journal.decisions),
  };

  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return { success: true, message: `Outcome updated for ${id}` };
}
