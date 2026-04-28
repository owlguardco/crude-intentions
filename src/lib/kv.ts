/**
 * CRUDE INTENTIONS — Shared KV adapter
 *
 * Wraps ioredis behind the KvStore interface that market-memory.ts expects
 * (and that the journal writer can also adopt).
 *
 * If src/lib/journal/writer.ts already inlines `new Redis(process.env.kv_REDIS_URL)`
 * directly, you can either:
 *   (a) leave writer.ts alone and just use this adapter in the new market-context
 *       routes, OR
 *   (b) refactor writer.ts to import { kv } from "@/lib/kv" — same client,
 *       one connection per cold start.
 *
 * Vercel serverless connection note: ioredis works in Vercel as long as we
 * reuse the connection across invocations. We attach the client to globalThis
 * so HMR in dev and warm-start invocations in prod don't open a new socket
 * each time.
 */

import Redis from "ioredis";

const REDIS_URL = process.env.kv_REDIS_URL;

if (!REDIS_URL) {
  // Don't throw at import time — that breaks `next build` when env vars
  // aren't injected. Throw lazily when something actually tries to use it.
  console.warn("[kv] kv_REDIS_URL is not set. KV operations will fail at runtime.");
}

declare global {
  // eslint-disable-next-line no-var
  var __ci_redis: Redis | undefined;
}

function getClient(): Redis {
  if (!REDIS_URL) {
    throw new Error("kv_REDIS_URL is not configured");
  }
  if (!globalThis.__ci_redis) {
    globalThis.__ci_redis = new Redis(REDIS_URL, {
      // Recommended for serverless — fail fast instead of hanging
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: false,
    });
  }
  return globalThis.__ci_redis;
}

/**
 * KvStore-compatible adapter. Values are JSON-serialised on the way in
 * and parsed on the way out, so callers work with typed objects directly.
 */
export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const raw = await getClient().get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Legacy / non-JSON value — return as-is cast
      return raw as unknown as T;
    }
  },

  async set<T>(key: string, value: T): Promise<"OK"> {
    const serialised = typeof value === "string" ? value : JSON.stringify(value);
    return getClient().set(key, serialised);
  },

  async del(key: string): Promise<number> {
    return getClient().del(key);
  },
};

export type Kv = typeof kv;
