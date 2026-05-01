/**
 * CRUDE INTENTIONS — Street Pulse RSS Sentiment Aggregator
 *
 * GET /api/street-pulse (no auth)
 *
 * Fetches four crude-relevant RSS feeds in parallel, scores each headline
 * with a small bullish/bearish keyword bag, aggregates across the last 4
 * hours, and returns:
 *
 *   { score, state, sources, cachedAt,
 *     label, samples, headlines, updated_at, stale? }
 *
 * `state` is a 5-state ladder (BEAR / LEANING_BEAR / NEUTRAL /
 * LEANING_BULL / BULL) derived from the composite `score`. `sources` is
 * a per-feed breakdown (label / ok / score / detail). The legacy
 * `label`, `samples`, `headlines`, `updated_at`, and `stale` fields
 * remain for back-compat with StreetPulseWidget — both shapes are
 * served from the same payload so consumers can migrate at their
 * own pace.
 *
 * Cached in KV at `street:pulse:latest` for 10 minutes — feed providers
 * don't want hammering and the dashboard polls every 5 minutes.
 *
 * Silent degradation: when every feed fails, returns 200 with an empty
 * pulse plus `error: 'feed_unavailable'`. Never throws.
 */

import { NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KV_KEY = 'street:pulse:latest';
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const FRESH_WINDOW_MS = 4 * 60 * 60 * 1000;
const SCORE_CLAMP = 100;

const FEEDS: Array<{ url: string; source: string }> = [
  {
    url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=CL%3DF&region=US&lang=en-US',
    source: 'Yahoo Finance',
  },
  {
    url: 'https://finance.yahoo.com/rss/headline?s=CL=F',
    source: 'Yahoo Finance (alt)',
  },
  {
    url: 'https://feeds.reuters.com/reuters/businessNews',
    source: 'Reuters',
  },
  {
    url: 'https://www.investing.com/rss/news_14.rss',
    source: 'Investing.com',
  },
];

const STALE_FALLBACK_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h

const BULLISH_KEYWORDS = [
  'rally', 'surge', 'rise', 'bullish', 'opec cut', 'draw', 'deficit', 'supply drop',
] as const;

const BEARISH_KEYWORDS = [
  'fall', 'drop', 'crash', 'bearish', 'build', 'surplus', 'oversupply', 'tariff', 'inventory rise',
] as const;

export type Sentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type StreetPulseState =
  | 'BEAR' | 'LEANING_BEAR' | 'NEUTRAL' | 'LEANING_BULL' | 'BULL';

export interface SourceResult {
  label: string;
  ok: boolean;
  score: number;
  detail: string;
}

export interface StreetPulseHeadline {
  title: string;
  source: string;
  sentiment: Sentiment;
  published_at: string;
}

export interface StreetPulseResponse {
  // v3 shape
  score: number;
  state: StreetPulseState;
  sources: SourceResult[];
  cachedAt: string;
  // back-compat shape (consumed by StreetPulseWidget)
  label: Sentiment;
  samples: number;
  headlines: StreetPulseHeadline[];
  updated_at: string;
  error?: string;
  stale?: boolean;
}

interface CachedPulse extends StreetPulseResponse {
  cached_at: string;
}

function unwrapCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface ParsedItem {
  title: string;
  pubDate: string;
  source: string;
}

function parseItems(xml: string, source: string): ParsedItem[] {
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const titleRe = /<title>([\s\S]*?)<\/title>/i;
  const pubRe = /<pubDate>([\s\S]*?)<\/pubDate>/i;

  const out: ParsedItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const rawTitle = titleRe.exec(block)?.[1] ?? '';
    const rawPub = pubRe.exec(block)?.[1] ?? '';
    const title = stripHtml(unwrapCdata(rawTitle));
    if (!title) continue;
    out.push({ title, pubDate: rawPub.trim(), source });
  }
  return out;
}

async function fetchFeed(url: string, source: string): Promise<ParsedItem[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.9)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseItems(xml, source);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function scoreHeadline(title: string): number {
  const lower = title.toLowerCase();
  let score = 0;
  for (const kw of BULLISH_KEYWORDS) {
    if (lower.includes(kw)) score += 1;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (lower.includes(kw)) score -= 1;
  }
  return score;
}

function sentimentOf(score: number): Sentiment {
  if (score > 0) return 'BULLISH';
  if (score < 0) return 'BEARISH';
  return 'NEUTRAL';
}

function scoreToState(score: number): StreetPulseState {
  if (score <= -40) return 'BEAR';
  if (score <= -10) return 'LEANING_BEAR';
  if (score < 10)   return 'NEUTRAL';
  if (score < 40)   return 'LEANING_BULL';
  return 'BULL';
}

function emptyPulse(error?: string): StreetPulseResponse {
  const now = new Date().toISOString();
  return {
    score: 0,
    state: 'NEUTRAL',
    sources: FEEDS.map<SourceResult>((f) => ({
      label: f.source,
      ok: false,
      score: 0,
      detail: 'No data',
    })),
    cachedAt: now,
    label: 'NEUTRAL',
    samples: 0,
    headlines: [],
    updated_at: now,
    ...(error ? { error } : {}),
  };
}

export async function GET() {
  const rl = await checkRateLimit('street-pulse:read', 20, 60);
  const rlHeaders = rateLimitHeaders(rl);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: rlHeaders });
  }
  // Cache check
  try {
    const cached = await kv.get<CachedPulse>(KV_KEY);
    if (cached?.cached_at) {
      const age = Date.now() - Date.parse(cached.cached_at);
      if (Number.isFinite(age) && age < CACHE_MAX_AGE_MS) {
        const { cached_at: _drop, ...payload } = cached;
        return NextResponse.json(payload);
      }
    }
  } catch {
    // fall through to fresh fetch
  }

  const settled = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f.url, f.source)));
  const cutoff = Date.now() - FRESH_WINDOW_MS;

  type Scored = ParsedItem & { ts: number; subscore: number };
  const sources: SourceResult[] = [];
  const allScored: Scored[] = [];
  let liveFeeds = 0;

  for (let i = 0; i < FEEDS.length; i++) {
    const feed = FEEDS[i];
    const r = settled[i];
    const items = r.status === 'fulfilled' ? r.value : [];
    if (items.length > 0) liveFeeds++;

    const fresh: Scored[] = [];
    for (const item of items) {
      const ts = Date.parse(item.pubDate);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      fresh.push({ ...item, ts, subscore: scoreHeadline(item.title) });
    }
    fresh.sort((a, b) => b.ts - a.ts);
    allScored.push(...fresh);

    const feedScore = fresh.reduce((s, x) => s + x.subscore, 0);
    const ok = items.length > 0;
    let detail: string;
    if (!ok) {
      detail = 'Feed offline';
    } else if (fresh.length === 0) {
      detail = 'No items in last 4h';
    } else {
      const top = fresh[0].title;
      const truncated = top.length > 80 ? `${top.slice(0, 77)}...` : top;
      const skew = feedScore > 0 ? 'bullish' : feedScore < 0 ? 'bearish' : 'flat';
      detail = `${fresh.length} item${fresh.length === 1 ? '' : 's'} · ${skew} skew · top: ${truncated}`;
    }
    sources.push({ label: feed.source, ok, score: feedScore, detail });
  }

  if (liveFeeds === 0) {
    // Stale cache fallback — if we still have a payload from the last
    // successful fetch under 2 hours old, return it flagged stale rather
    // than an empty feed_unavailable response. The dashboard prefers
    // 90-minute-old sentiment to no sentiment.
    try {
      const stale = await kv.get<CachedPulse>(KV_KEY);
      if (stale?.cached_at) {
        const age = Date.now() - Date.parse(stale.cached_at);
        if (
          Number.isFinite(age) &&
          age < STALE_FALLBACK_MAX_AGE_MS &&
          !stale.error &&
          stale.samples > 0
        ) {
          const { cached_at: _drop, error: _drop2, ...payload } = stale;
          return NextResponse.json({ ...payload, stale: true });
        }
      }
    } catch {
      // fall through to feed_unavailable
    }

    const result = emptyPulse('feed_unavailable');
    try {
      await kv.set(KV_KEY, { ...result, cached_at: new Date().toISOString() });
    } catch {
      /* swallow */
    }
    return NextResponse.json(result);
  }

  const aggregate = allScored.reduce((s, x) => s + x.subscore, 0);
  const score = Math.max(-SCORE_CLAMP, Math.min(SCORE_CLAMP, aggregate));
  const state = scoreToState(score);
  const label: Sentiment =
    score > 10 ? 'BULLISH' : score < -10 ? 'BEARISH' : 'NEUTRAL';

  const top = [...allScored]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 4)
    .map<StreetPulseHeadline>((x) => ({
      title: x.title.length > 200 ? x.title.slice(0, 197) + '...' : x.title,
      source: x.source,
      sentiment: sentimentOf(x.subscore),
      published_at: new Date(x.ts).toISOString(),
    }));

  const now = new Date().toISOString();
  const result: StreetPulseResponse = {
    score,
    state,
    sources,
    cachedAt: now,
    label,
    samples: allScored.length,
    headlines: top,
    updated_at: now,
  };

  try {
    await kv.set(KV_KEY, { ...result, cached_at: now });
  } catch {
    /* swallow */
  }

  return NextResponse.json(result);
}
