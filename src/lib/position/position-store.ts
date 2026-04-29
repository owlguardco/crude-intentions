// CRUDE INTENTIONS — Virtual Position Store (Phase 2E)
// Single live position kept at KV key `position:current`. The journal
// remains the authoritative ledger; this store is for in-flight state only.

import { kv } from '@/lib/kv';

export interface VirtualPosition {
  id: string;
  direction: 'LONG' | 'SHORT';
  entry_price: number;
  contracts: number;
  stop_loss: number | null;
  target: number | null;
  tp1_price: number | null;
  signal_id: string | null;
  opened_at: string;
  session: string;
  alfred_score: number | null;
  alfred_confidence: string | null;
  notes: string | null;
  status: 'OPEN';
}

const KEY = 'position:current';

export async function getPosition(): Promise<VirtualPosition | null> {
  return (await kv.get<VirtualPosition>(KEY)) ?? null;
}

export async function openPosition(
  data: Omit<VirtualPosition, 'id' | 'opened_at' | 'status'>
): Promise<VirtualPosition> {
  const position: VirtualPosition = {
    id: crypto.randomUUID(),
    opened_at: new Date().toISOString(),
    status: 'OPEN',
    ...data,
  };
  await kv.set(KEY, position);
  return position;
}

export async function closePosition(): Promise<void> {
  await kv.del(KEY);
}

export async function updatePosition(
  patch: Partial<Pick<VirtualPosition, 'stop_loss' | 'target' | 'tp1_price' | 'signal_id' | 'notes'>>
): Promise<VirtualPosition | null> {
  const current = await getPosition();
  if (!current) return null;
  const updated: VirtualPosition = { ...current, ...patch };
  await kv.set(KEY, updated);
  return updated;
}
