import Redis from 'ioredis';
import crypto from 'crypto';
import type { JournalWriteInput } from '@/lib/validation/journal-schema';

const redisUrl = process.env.kv_REDIS_URL ?? process.env.KV_REDIS_URL ?? '';
const redisClient = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });

async function getClient() {
  if (redisClient.status === 'wait' || redisClient.status === 'close') await redisClient.connect();
  return redisClient;
}

const JOURNAL_KEY = 'journal:entries';
const SUMMARY_KEY = 'journal:summary';

export interface JournalEntry extends JournalWriteInput {
  id: string; timestamp: string; integrity_hash: string;
  outcome: { status: 'OPEN'|'WIN'|'LOSS'|'SCRATCH'|'BLOCKED'|'EXPIRED'; result: number|null; result_dollars: number|null; result_r: number|null; close_timestamp: string|null; close_price: number|null; post_mortem: string|null; post_mortem_timestamp: string|null; };
}
export interface JournalSummary { total_evaluations: number; trades_taken: number; trades_blocked: number; win: number; loss: number; win_rate_pct: number; last_updated: string; }
export interface JournalData { schema_version: string; decisions: JournalEntry[]; summary: JournalSummary; }

export async function readJournal(): Promise<JournalData> {
  try {
    const r = await getClient();
    const [er, sr] = await Promise.all([r.get(JOURNAL_KEY), r.get(SUMMARY_KEY)]);
    const entries: JournalEntry[] = er ? JSON.parse(er as string) : [];
    const summary: JournalSummary = sr ? JSON.parse(sr as string) : { total_evaluations:0, trades_taken:0, trades_blocked:0, win:0, loss:0, win_rate_pct:0, last_updated:'' };
    return { schema_version: '1.1', decisions: entries, summary };
  } catch { return { schema_version:'1.1', decisions:[], summary:{ total_evaluations:0, trades_taken:0, trades_blocked:0, win:0, loss:0, win_rate_pct:0, last_updated:'' } }; }
}

function generateId(entries: JournalEntry[]): string {
  const today = new Date().toISOString().slice(0,10);
  const n = entries.filter(e => e.id?.startsWith('CI-'+today)).length;
  return 'CI-'+today+'-'+(n+1).toString().padStart(3,'0');
}

export function computeIntegrityHash(id: string, timestamp: string, direction: string, score: number, entry_price: number|null): string {
  return crypto.createHash('sha256').update(id+'|'+timestamp+'|'+direction+'|'+score+'|'+(entry_price??'null')).digest('hex');
}

function recomputeSummary(entries: JournalEntry[]): JournalSummary {
  const wins = entries.filter(e => e.outcome?.status==='WIN');
  const losses = entries.filter(e => e.outcome?.status==='LOSS');
  const closed = wins.length + losses.length;
  return { total_evaluations:entries.length, trades_taken:entries.filter(e=>e.direction!=='NO TRADE').length, trades_blocked:entries.filter(e=>e.direction==='NO TRADE').length, win:wins.length, loss:losses.length, win_rate_pct:closed>0?Math.round((wins.length/closed)*100):0, last_updated:new Date().toISOString() };
}

export interface WriteResult { success: boolean; id: string; integrity_hash: string; entry: JournalEntry; }

export async function writeJournalEntry(input: JournalWriteInput): Promise<WriteResult> {
  const journal = await readJournal();
  const id = generateId(journal.decisions);
  // Honor caller-supplied historical timestamp (e.g. backtest, bulk import).
  // Falls back to wall-clock now when omitted (the common path).
  const timestamp = input.timestamp ?? new Date().toISOString();
  const integrity_hash = computeIntegrityHash(id, timestamp, input.direction, input.score, input.entry_price);
  const entry: JournalEntry = { ...input, id, timestamp, integrity_hash, outcome: { status: input.direction==='NO TRADE'?'BLOCKED':'OPEN', result:null, result_dollars:null, result_r:null, close_timestamp:null, close_price:null, post_mortem:null, post_mortem_timestamp:null } };
  const updated = [...journal.decisions, entry];
  const r = await getClient();
  await Promise.all([r.set(JOURNAL_KEY, JSON.stringify(updated)), r.set(SUMMARY_KEY, JSON.stringify(recomputeSummary(updated)))]);
  return { success:true, id, integrity_hash, entry };
}

export interface OutcomeUpdateInput { status: 'WIN'|'LOSS'|'SCRATCH'|'EXPIRED'; close_price: number; close_timestamp: string; result: number; result_dollars: number; }

export async function updateJournalOutcome(id: string, update: OutcomeUpdateInput): Promise<{ success: boolean; message: string }> {
  const journal = await readJournal();
  const idx = journal.decisions.findIndex(e => e.id===id);
  if (idx===-1) return { success:false, message:'Entry '+id+' not found' };
  journal.decisions[idx].outcome = { ...journal.decisions[idx].outcome, ...update, post_mortem:journal.decisions[idx].outcome?.post_mortem??null, post_mortem_timestamp:journal.decisions[idx].outcome?.post_mortem_timestamp??null };
  const r = await getClient();
  await Promise.all([r.set(JOURNAL_KEY, JSON.stringify(journal.decisions)), r.set(SUMMARY_KEY, JSON.stringify(recomputeSummary(journal.decisions)))]);
  return { success:true, message:'Outcome updated for '+id };
}
