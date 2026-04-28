import Redis from 'ioredis';

const redisUrl = process.env.kv_REDIS_URL ?? process.env.KV_REDIS_URL ?? '';

const redisClient = new Redis(redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

async function getClient(): Promise<Redis> {
  if (redisClient.status === 'wait' || redisClient.status === 'close') {
    await redisClient.connect();
  }
  return redisClient;
}

export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const r = await getClient();
    const raw = await r.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    const r = await getClient();
    const serialised = typeof value === 'string' ? value : JSON.stringify(value);
    await r.set(key, serialised);
  },

  async del(key: string): Promise<void> {
    const r = await getClient();
    await r.del(key);
  },
};

export type Kv = typeof kv;