/**
 * CRUDE INTENTIONS — Geopolitical Headline Flag
 *
 * GET /api/geo-flag (no auth)
 *
 * Polls @realDonaldTrump's Truth Social RSS for crude-relevant keywords in
 * posts under 30 minutes old. Result is cached in KV at `geo:flag:latest`
 * for 90 seconds to absorb concurrent client polls.
 *
 * Silent degradation: any failure returns
 *   { flagged: false, error: 'feed_unavailable', checked_at }
 * with HTTP 200. The caller never sees a non-200 from this route.
 */

import { NextResponse } from 'next/server';
import { kv } from '@/lib/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KV_KEY = 'geo:flag:latest';
const FEED_URL = 'https://truthsocial.com/@realDonaldTrump.rss';
const CACHE_MAX_AGE_MS = 90_000;
const FRESH_WINDOW_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

const KEYWORDS = [
  'crude', 'oil', 'opec', 'iran', 'russia', 'saudi',
  'spr', 'tariff', 'pipeline', 'energy', 'sanctions', 'petroleum',
] as const;

interface GeoFlagResult {
  flagged: boolean;
  matched_at: string | null;
  matched_keyword: string | null;
  post_title: string | null;
  post_url: string | null;
  checked_at: string;
  error?: string;
}

function failResult(): GeoFlagResult {
  return {
    flagged: false,
    matched_at: null,
    matched_keyword: null,
    post_title: null,
    post_url: null,
    checked_at: new Date().toISOString(),
    error: 'feed_unavailable',
  };
}

function clearResult(): GeoFlagResult {
  return {
    flagged: false,
    matched_at: null,
    matched_keyword: null,
    post_title: null,
    post_url: null,
    checked_at: new Date().toISOString(),
  };
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
  description: string;
  pubDate: string;
  link: string;
}

function parseRssItems(xml: string): ParsedItem[] {
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const titleRe = /<title>([\s\S]*?)<\/title>/i;
  const descRe = /<description>([\s\S]*?)<\/description>/i;
  const pubRe = /<pubDate>([\s\S]*?)<\/pubDate>/i;
  const linkRe = /<link>([\s\S]*?)<\/link>/i;

  const items: ParsedItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = titleRe.exec(block)?.[1] ?? '';
    const description = descRe.exec(block)?.[1] ?? '';
    const pubDate = pubRe.exec(block)?.[1] ?? '';
    const link = linkRe.exec(block)?.[1] ?? '';
    items.push({
      title: unwrapCdata(title),
      description: unwrapCdata(description),
      pubDate: pubDate.trim(),
      link: unwrapCdata(link),
    });
  }
  return items;
}

async function fetchFeed(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FEED_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.8)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function evaluate(items: ParsedItem[]): GeoFlagResult {
  const now = Date.now();
  const cutoff = now - FRESH_WINDOW_MS;

  for (const item of items) {
    const ts = Date.parse(item.pubDate);
    if (!Number.isFinite(ts) || ts < cutoff) continue;

    const haystack = (
      stripHtml(item.title) + ' ' + stripHtml(item.description)
    ).toLowerCase();
    const matched = KEYWORDS.find((kw) => haystack.includes(kw));
    if (!matched) continue;

    const titleClean = stripHtml(item.title);
    return {
      flagged: true,
      matched_at: new Date(ts).toISOString(),
      matched_keyword: matched,
      post_title: titleClean.length > 0
        ? (titleClean.length > 200 ? titleClean.slice(0, 197) + '...' : titleClean)
        : null,
      post_url: item.link || null,
      checked_at: new Date().toISOString(),
    };
  }

  return clearResult();
}

export async function GET() {
  // Cache check
  try {
    const cached = await kv.get<GeoFlagResult>(KV_KEY);
    if (cached?.checked_at) {
      const age = Date.now() - Date.parse(cached.checked_at);
      if (Number.isFinite(age) && age < CACHE_MAX_AGE_MS) {
        return NextResponse.json(cached);
      }
    }
  } catch {
    // ignore — fall through to fresh fetch
  }

  const xml = await fetchFeed();
  if (xml == null) {
    const result = failResult();
    try { await kv.set(KV_KEY, result); } catch { /* swallow */ }
    return NextResponse.json(result);
  }

  let result: GeoFlagResult;
  try {
    const items = parseRssItems(xml);
    result = evaluate(items);
  } catch {
    result = failResult();
  }

  try { await kv.set(KV_KEY, result); } catch { /* swallow */ }
  return NextResponse.json(result);
}
