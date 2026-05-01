/**
 * CRUDE INTENTIONS — Geopolitical Headline Flag (v2)
 *
 * GET /api/geo-flag (no auth)
 *
 * Two-tier keyword scanner over @realDonaldTrump's Truth Social RSS,
 * combined with a CL price-delta-since-post measurement so a post about
 * a court case never trips the flag and a real OPEC headline that's
 * already moving CL trips a HOT chip instead of a generic ACTIVE one.
 *
 * Tier 1 — single-match flag:
 *   crude, oil prices, OPEC, SPR, "strategic reserve", sanctions, Iran,
 *   "drill baby drill", gasoline prices, pipeline, refinery, petroleum,
 *   Venezuela, "energy production", tariff (only with oil/energy/crude).
 *
 * Tier 2 — requires 2+ words from this set together:
 *   energy, Russia, Saudi, drill, LNG, barrels, supply, production, export.
 *
 * Chip states:
 *   CLEAR  — no match in the 30-min freshness window
 *   ACTIVE — match, |Δ since post| ≤ $0.40 (or delta unknown)
 *   HOT    — match AND |Δ since post| > $0.40 (soft pause signal)
 *
 * Cache key `geo:flag:latest` (90s) preserved. Old cached payloads from
 * the v1 schema are detected by the absence of `chip_state` and skipped.
 *
 * Silent degradation: any failure returns the CLEAR shape with
 * `error: 'feed_unavailable'` and HTTP 200. The route never throws.
 */

import { NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import type { GeoFlagResult, GeoChipState } from '@/types/geo-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KV_KEY = 'geo:flag:latest';
const FEED_URL = 'https://truthsocial.com/@realDonaldTrump.rss';
const CACHE_MAX_AGE_MS = 90_000;
const FRESH_WINDOW_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const HOT_THRESHOLD_USD = 0.40;
const HISTORY_MATCH_WINDOW_SEC = 5 * 60;

// Multi-word keywords go alongside single-word ones — `.includes(kw)` works
// on both. Phrases use spaces; case-insensitive match (haystack is lowered).
const TIER1_DIRECT = [
  'crude',
  'oil prices',
  'opec',
  'spr',
  'strategic reserve',
  'sanctions',
  'iran',
  'drill baby drill',
  'gasoline prices',
  'pipeline',
  'refinery',
  'petroleum',
  'venezuela',
  'energy production',
] as const;

const TIER1_TARIFF_REQUIRES = ['oil', 'energy', 'crude'] as const;

const TIER2 = [
  'energy', 'russia', 'saudi', 'drill', 'lng',
  'barrels', 'supply', 'production', 'export',
] as const;

interface PriceHistoryEntry { ts: number; price: number }
interface ClPriceCached { price?: number }

interface ParsedItem {
  title: string;
  description: string;
  pubDate: string;
  link: string;
}

function unwrapCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
    items.push({
      title:       unwrapCdata(titleRe.exec(block)?.[1] ?? ''),
      description: unwrapCdata(descRe.exec(block)?.[1] ?? ''),
      pubDate:     (pubRe.exec(block)?.[1] ?? '').trim(),
      link:        unwrapCdata(linkRe.exec(block)?.[1] ?? ''),
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
        'User-Agent': 'Mozilla/5.0 (compatible; CrudeIntentions/1.9)',
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

interface KeywordHit { keyword: string; tier: 1 | 2 }

function findMatch(haystackLc: string): KeywordHit | null {
  for (const kw of TIER1_DIRECT) {
    if (haystackLc.includes(kw)) return { keyword: kw, tier: 1 };
  }
  if (haystackLc.includes('tariff') && TIER1_TARIFF_REQUIRES.some((x) => haystackLc.includes(x))) {
    return { keyword: 'tariff', tier: 1 };
  }
  const tier2Hits = TIER2.filter((kw) => haystackLc.includes(kw));
  if (tier2Hits.length >= 2) {
    return { keyword: tier2Hits.slice(0, 2).join('+'), tier: 2 };
  }
  return null;
}

async function getPriceDelta(postMs: number): Promise<{ delta: number; known: boolean }> {
  try {
    const cl = await kv.get<ClPriceCached>('cl-price:latest');
    const current = typeof cl?.price === 'number' && Number.isFinite(cl.price) ? cl.price : null;
    if (current === null) return { delta: 0, known: false };

    const history = await kv.get<PriceHistoryEntry[]>('cl:price:history');
    if (!history || history.length === 0) return { delta: 0, known: false };

    const postSec = Math.floor(postMs / 1000);
    let bestEntry: PriceHistoryEntry | null = null;
    let bestDiff = Infinity;
    for (const h of history) {
      if (typeof h?.ts !== 'number' || typeof h?.price !== 'number') continue;
      const d = Math.abs(h.ts - postSec);
      if (d < bestDiff) {
        bestDiff = d;
        bestEntry = h;
      }
    }
    if (!bestEntry || bestDiff > HISTORY_MATCH_WINDOW_SEC) {
      return { delta: 0, known: false };
    }
    return { delta: current - bestEntry.price, known: true };
  } catch {
    return { delta: 0, known: false };
  }
}

function chipStateFor(flagged: boolean, deltaUsd: number, known: boolean): GeoChipState {
  if (!flagged) return 'CLEAR';
  if (known && Math.abs(deltaUsd) > HOT_THRESHOLD_USD) return 'HOT';
  return 'ACTIVE';
}

function clearResult(): GeoFlagResult {
  return {
    flagged: false,
    matched_at: null,
    matched_keyword: null,
    post_title: null,
    post_url: null,
    source: null,
    checked_at: new Date().toISOString(),
    chip_state: 'CLEAR',
    price_delta_since_post: 0,
    price_delta_known: false,
  };
}

function failResult(): GeoFlagResult {
  return { ...clearResult(), error: 'feed_unavailable' };
}

async function evaluate(items: ParsedItem[]): Promise<GeoFlagResult> {
  const now = Date.now();
  const cutoff = now - FRESH_WINDOW_MS;

  for (const item of items) {
    const ts = Date.parse(item.pubDate);
    if (!Number.isFinite(ts) || ts < cutoff) continue;

    const haystackLc = (
      stripHtml(item.title) + ' ' + stripHtml(item.description)
    ).toLowerCase();
    const hit = findMatch(haystackLc);
    if (!hit) continue;

    const { delta, known } = await getPriceDelta(ts);
    const titleClean = stripHtml(item.title);
    const post_title = titleClean.length > 0
      ? (titleClean.length > 200 ? titleClean.slice(0, 197) + '...' : titleClean)
      : null;

    return {
      flagged: true,
      matched_at: new Date(ts).toISOString(),
      matched_keyword: hit.keyword,
      post_title,
      post_url: item.link || null,
      source: 'truth_social',
      checked_at: new Date().toISOString(),
      chip_state: chipStateFor(true, delta, known),
      price_delta_since_post: Math.round(delta * 100) / 100,
      price_delta_known: known,
    };
  }

  return clearResult();
}

export async function GET() {
  // Cache check — old v1 payloads (no chip_state) are skipped so we don't
  // serve stale CLEAR/ACTIVE info from before the v2 deploy.
  try {
    const cached = await kv.get<GeoFlagResult>(KV_KEY);
    if (cached?.checked_at && cached.chip_state) {
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
    result = await evaluate(items);
  } catch {
    result = failResult();
  }

  try { await kv.set(KV_KEY, result); } catch { /* swallow */ }
  return NextResponse.json(result);
}
