/**
 * CRUDE INTENTIONS — Webhook replay protection
 *
 * checkReplay(signalId) marks an ID as "seen" in KV with a TTL window.
 * Subsequent calls within that window get { seen: true } so the caller
 * can return 409. The first call in a window writes the marker and
 * returns { seen: false }.
 *
 * Get-then-set is non-atomic, so under heavy concurrent load the same
 * ID could briefly slip through twice. Acceptable for our use case --
 * webhook entries are also gated by the strict outcome.status check
 * downstream, so a duplicate signal hitting closeTrade returns 'Already
 * closed' from the close-trade helper itself.
 *
 * Fails OPEN: any KV throw returns { seen: false } so an outage never
 * blocks the legitimate path.
 */

import { kv } from '@/lib/kv';

const DEFAULT_WINDOW_SECONDS = 300;

export interface ReplayResult {
  seen: boolean;
}

export async function checkReplay(
  signalId: string,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Promise<ReplayResult> {
  const key = `replay:${signalId}`;
  try {
    const existing = await kv.get<number>(key);
    if (existing != null) {
      return { seen: true };
    }
    await kv.set(key, Math.floor(Date.now() / 1000), windowSeconds);
    return { seen: false };
  } catch (err) {
    console.error('[REPLAY] kv error, failing open:', err);
    return { seen: false };
  }
}
