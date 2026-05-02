/**
 * CRUDE INTENTIONS — Geopolitical Headline Flag (v3 — multi-source)
 *
 * GET /api/geo-flag (no auth)
 *
 * Two-tier keyword scanner across three feeds in parallel, combined with
 * a CL price-delta-since-post measurement so a non-CL post never trips
 * the flag and a real OPEC headline that's already moving CL trips a
 * HOT chip instead of a generic ACTIVE one.
 *
 * Feeds:
 *   - Truth Social   @realDonaldTrump
 *   - Reuters        feeds.reuters.com/reuters/businessNews
 *   - OPEC newsroom  www.opec.org/opec_web/en/press_room/rss.htm
 *
 * Tier 1 — single-match flag:
 *   crude, oil prices, OPEC, SPR, "strategic reserve", sanctions, Iran,
 *   "drill baby drill", gasoline prices, pipeline, refinery, petroleum,
 *   Venezuela, "energy production", tariff (only with oil/energy/crude).
 *
 * Tier 2 — requires 2+ words from this set together:
 *   energy, Russia, Saudi, drill, LNG, barrels, supply, production, export.
 *
 * Chip states (highest severity wins across sources):
 *   CLEAR  — no match in the 30-min freshness window
 *   ACTIVE — match, |Δ since post| ≤ $0.40 (or delta unknown)
 *   HOT    — match AND |Δ since post| > $0.40 (soft pause signal)
 *
 * Aggregation:
 *   Each feed is fetched in parallel via Promise.allSettled. A failure
 *   degrades silently — that source just doesn't appear in the live-source
 *   label. Each successful feed runs the same per-source evaluation; the
 *   highest-severity match wins (HOT > ACTIVE), tie-broken by most-recent
 *   matched_at. response.source is a dot-joined label of all feeds that
 *   returned data this poll, regardless of whether they matched.
 *
 * Cache key `geo:flag:latest` (90s) preserved. Old payloads from earlier
 * schemas are detected by the absence of `chip_state` and skipped.
 */

import { NextResponse } from 'next/server';
import { kv } from '@/lib/kv';
import type { GeoFlagResult, GeoChipState } from '@/types/geo-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KV_KEY = 'geo:flag:latest';
const CACHE_MAX_AGE_MS = 90_000;
const FRESH_WINDOW_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const HOT_THRESHOLD_USD = 0.40;
const HISTORY_MATCH_WINDOW_SEC = 5 * 60;

interface FeedSource {
  id: 'truth_social' | 'reuters' | 'opec';
  label: string;
  url: string;
}

const FEEDS: FeedSource[] = [
  { id: 'truth_social', label: 'Truth Social', url: 'https://truthsocial.com/@realDonaldTrump.rss' },
  { id: 'reuters',      label: 'Reuters',      url: 'https://feeds.reuters.com/reuters/businessNews' },
  { id: 'opec',         label: 'OPEC',         url: 'https://www.opec.org/opec_web/en/press_room/rss.htm' },
];

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

async function fetchFeedXml(url: string): Promise<string | null> {
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

interface PriceContext { current: number | null; history: PriceHistoryEntry[] }

async function loadPriceContext(): Promise<PriceContext> {
  try {
    const [cl, history] = await Promise.all([
      kv.get<ClPriceCached>('cl-price:latest'),
      kv.get<PriceHistoryEntry[]>('cl:price:history'),
    ]);
    const current = typeof cl?.price === 'number' && Number.isFinite(cl.price) ? cl.price : null;
    return { current, history: Array.isArray(history) ? history : [] };
  } catch {
    return { current: null, history: [] };
  }
}

function priceDeltaFor(postMs: number, ctx: PriceContext): { delta: number; known: boolean } {
  if (ctx.current === null || ctx.history.length === 0) return { delta: 0, known: false };
  const postSec = Math.floor(postMs / 1000);
  let bestEntry: PriceHistoryEntry | null = null;
  let bestDiff = Infinity;
  for (const h of ctx.history) {
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
  return { delta: ctx.current - bestEntry.price, known: true };
}

function chipStateFor(flagged: boolean, deltaUsd: number, known: boolean): GeoChipState {
  if (!flagged) return 'CLEAR';
  if (known && Math.abs(deltaUsd) > HOT_THRESHOLD_USD) return 'HOT';
  return 'ACTIVE';
}

function severity(state: GeoChipState): number {
  return state === 'HOT' ? 2 : state === 'ACTIVE' ? 1 : 0;
}

interface MatchCandidate {
  source_id: FeedSource['id'];
  source_label: string;
  matched_at_ms: number;
  matched_at_iso: string;
  matched_keyword: string;
  post_title: string | null;
  post_url: string | null;
  delta: number;
  delta_known: boolean;
  chip_state: GeoChipState;
}

/** Scan one source's parsed items for the first fresh keyword match. */
function evaluateSource(
  source: FeedSource,
  items: ParsedItem[],
  priceCtx: PriceContext,
): MatchCandidate | null {
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

    const { delta, known } = priceDeltaFor(ts, priceCtx);
    const titleClean = stripHtml(item.title);
    const post_title = titleClean.length > 0
      ? (titleClean.length > 200 ? titleClean.slice(0, 197) + '...' : titleClean)
      : null;

    return {
      source_id: source.id,
      source_label: source.label,
      matched_at_ms: ts,
      matched_at_iso: new Date(ts).toISOString(),
      matched_keyword: hit.keyword,
      post_title,
      post_url: item.link || null,
      delta,
      delta_known: known,
      chip_state: chipStateFor(true, delta, known),
    };
  }
  return null;
}

function clearResult(sourceLabel: string | null): GeoFlagResult {
  return {
    flagged: false,
    matched_at: null,
    matched_keyword: null,
    post_title: null,
    post_url: null,
    source: sourceLabel,
    checked_at: new Date().toISOString(),
    chip_state: 'CLEAR',
    price_delta_since_post: 0,
    price_delta_known: false,
  };
}

function failResult(): GeoFlagResult {
  return { ...clearResult(null), error: 'feed_unavailable' };
}

/** Promise.allSettled wrapper that returns null for any failure. */
async function fetchAndParse(source: FeedSource): Promise<ParsedItem[] | null> {
  const xml = await fetchFeedXml(source.url);
  if (xml === null) return null;
  try {
    return parseRssItems(xml);
  } catch {
    return null;
  }
}

export async function GET() {
  // Cache check — old payloads (no chip_state) are skipped so we don't
  // serve stale data from before the multi-source rollout.
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

  // Run all three feeds in parallel. allSettled keeps any failure from
  // blocking the other two — the source list naturally collapses to
  // whichever feeds returned data.
  const settled = await Promise.allSettled(FEEDS.map((f) => fetchAndParse(f)));

  const liveSources: FeedSource[] = [];
  const perSourceItems: Array<{ source: FeedSource; items: ParsedItem[] }> = [];
  for (let i = 0; i < FEEDS.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled' || r.value === null) continue;
    liveSources.push(FEEDS[i]);
    perSourceItems.push({ source: FEEDS[i], items: r.value });
  }

  if (liveSources.length === 0) {
    const result = failResult();
    try { await kv.set(KV_KEY, result); } catch { /* swallow */ }
    return NextResponse.json(result);
  }

  const sourceLabel = liveSources.map((s) => s.label).join(' · ');

  // One KV round-trip for price context, shared across per-source matches.
  const priceCtx = await loadPriceContext();

  const candidates: MatchCandidate[] = [];
  for (const { source, items } of perSourceItems) {
    const c = evaluateSource(source, items, priceCtx);
    if (c) candidates.push(c);
  }

  if (candidates.length === 0) {
    const result = clearResult(sourceLabel);
    try { await kv.set(KV_KEY, result); } catch { /* swallow */ }
    return NextResponse.json(result);
  }

  // Highest severity wins; tie-broken by most recent matched_at.
  candidates.sort((a, b) => {
    const s = severity(b.chip_state) - severity(a.chip_state);
    if (s !== 0) return s;
    return b.matched_at_ms - a.matched_at_ms;
  });
  const winner = candidates[0];

  const result: GeoFlagResult = {
    flagged: true,
    matched_at: winner.matched_at_iso,
    matched_keyword: winner.matched_keyword,
    post_title: winner.post_title,
    post_url: winner.post_url,
    source: sourceLabel,
    checked_at: new Date().toISOString(),
    chip_state: winner.chip_state,
    price_delta_since_post: Math.round(winner.delta * 100) / 100,
    price_delta_known: winner.delta_known,
  };

  try { await kv.set(KV_KEY, result); } catch { /* swallow */ }
  return NextResponse.json(result);
}
