"use client";

import { useEffect, useState, useCallback } from "react";
import type { GeoFlagResult as GeoFlag } from "@/types/geo-flag";

const C = {
  bg: "#0d0d0f",
  card: "#111115",
  border: "#1a1a1e",
  divider: "#2a2a2e",
  text: "#e0e0e0",
  muted: "#666670",
  dim: "#444450",
  amber: "#d4a520",
  green: "#22c55e",
  red: "#ef4444",
};

const FONT_MONO = "JetBrains Mono, monospace";
const FONT_SANS = "Inter, sans-serif";

type Sentiment = "BULLISH" | "BEARISH" | "NEUTRAL";
type StateKey = "BEAR" | "LEANING_BEAR" | "NEUTRAL" | "LEANING_BULL" | "BULL";

interface Headline {
  title: string;
  source: string;
  sentiment: Sentiment;
  published_at: string;
}

interface SourceResult {
  label: string;
  ok: boolean;
  score: number;
  detail: string;
}

interface StreetPulseResponse {
  score: number;
  state?: StateKey;
  sources?: SourceResult[];
  cachedAt?: string;
  label?: Sentiment;
  samples?: number;
  headlines?: Headline[];
  updated_at?: string;
  stale?: boolean;
}


interface StateMeta {
  label: string;
  pos: number;
  color: string;
  segment: number;
}

const STATES: Record<StateKey, StateMeta> = {
  BEAR:         { label: "BEAR",         pos: 10, color: C.red,    segment: 0 },
  LEANING_BEAR: { label: "LEANING BEAR", pos: 30, color: C.red,    segment: 1 },
  NEUTRAL:      { label: "NEUTRAL",      pos: 50, color: C.muted,  segment: 2 },
  LEANING_BULL: { label: "LEANING BULL", pos: 70, color: C.green,  segment: 3 },
  BULL:         { label: "BULL",         pos: 90, color: C.green,  segment: 4 },
};

function scoreToState(score: number): StateKey {
  if (score <= -40) return "BEAR";
  if (score <= -10) return "LEANING_BEAR";
  if (score < 10)   return "NEUTRAL";
  if (score < 40)   return "LEANING_BULL";
  return "BULL";
}

function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    const m = Math.floor(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch {
    return "";
  }
}

type Filter = "ALL" | "BULLISH" | "BEARISH" | "GEO" | "NEUTRAL";

export default function NewsPage() {
  const [pulse, setPulse] = useState<StreetPulseResponse | null>(null);
  const [geo, setGeo] = useState<GeoFlag | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, gRes] = await Promise.all([
        fetch("/api/street-pulse?refresh=1", { cache: "no-store" }),
        fetch("/api/geo-flag", { cache: "no-store" }),
      ]);
      if (pRes.ok) setPulse(await pRes.json() as StreetPulseResponse);
      if (gRes.ok) setGeo(await gRes.json() as GeoFlag);
    } catch {
      // hold last good values
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const stateKey: StateKey = pulse ? (pulse.state ?? scoreToState(pulse.score)) : "NEUTRAL";
  const state = STATES[stateKey];
  const headlines = pulse?.headlines ?? [];
  const sources = pulse?.sources ?? [];
  const samples = pulse?.samples ?? headlines.length;
  const score = pulse?.score ?? 0;

  // ACTIVE or HOT both render the geo banner; CLEAR / errored does not.
  const geoActive = geo?.chip_state === "ACTIVE" || geo?.chip_state === "HOT";

  const filtered = headlines.filter((h) => {
    if (filter === "ALL") return true;
    if (filter === "GEO") return false; // geo headlines come from /api/geo-flag, not street-pulse
    return h.sentiment === filter;
  });

  // When filter is GEO and there's an active geo alert, render its single
  // post as a synthetic headline; otherwise empty
  const showGeoHeadline = filter === "GEO" && geoActive && geo?.post_title;

  return (
    <div style={{ display: "flex", gap: 16, padding: 0, alignItems: "flex-start" }}>
      {/* LEFT — sentiment summary + sources list */}
      <aside style={{ width: 200, display: "flex", flexDirection: "column", gap: 12, flexShrink: 0 }}>
        {/* Sentiment score card */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 4,
          borderTop: `2px solid ${state.color}`,
          padding: 14,
        }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "3px", color: C.muted, marginBottom: 12 }}>
            SENTIMENT
          </div>
          <div style={{
            fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, letterSpacing: "2px",
            color: state.color, marginBottom: 12, lineHeight: 1.1,
          }}>
            {state.label}
          </div>

          {/* 5-segment track + diamond */}
          <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2, height: 10, marginBottom: 6 }}>
            {[0, 1, 2, 3, 4].map((i) => {
              const isActive = i === state.segment;
              const segColor = i <= 1 ? C.red : i === 2 ? C.muted : C.green;
              return (
                <div key={i} style={{
                  background: isActive ? segColor : C.bg,
                  border: `1px solid ${isActive ? segColor : C.divider}`,
                  borderRadius: 2,
                  opacity: isActive ? 1 : 0.5,
                }} />
              );
            })}
            <div aria-hidden style={{
              position: "absolute", top: -3, left: `calc(${state.pos}% - 5px)`,
              width: 10, height: 10, background: state.color,
              border: `1px solid ${C.bg}`, transform: "rotate(45deg)",
              boxShadow: `0 0 6px ${state.color}80`,
              transition: "left 0.4s ease",
            }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "1px", color: C.dim, marginBottom: 12 }}>
            <span>BEAR</span>
            <span>BULL</span>
          </div>

          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted, letterSpacing: "1px" }}>
            score {score >= 0 ? "+" : ""}{score}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted, letterSpacing: "1px", marginTop: 3 }}>
            {samples} sample{samples === 1 ? "" : "s"}
          </div>
        </div>

        {/* Sources pills */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 4,
          padding: 14,
        }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "3px", color: C.muted, marginBottom: 12 }}>
            SOURCES
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sources.length === 0 && (
              <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.dim, letterSpacing: "1px" }}>
                No data
              </span>
            )}
            {sources.map((s, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "5px 8px",
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: s.ok ? C.green : C.red, flexShrink: 0,
                }} />
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 10,
                  color: s.ok ? C.text : C.muted,
                  flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {s.label}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 8,
                  letterSpacing: "1px",
                  color: s.ok ? C.green : C.red,
                }}>
                  {s.ok ? "LIVE" : "OFF"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* RIGHT — geo banner (when active) + filters + headline list */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {/* Geo alert banner */}
        {geoActive && geo?.post_title && (
          <div style={{
            background: "rgba(212,165,32,0.10)",
            border: `1px solid ${C.amber}40`,
            borderRadius: 4,
            padding: "12px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <span style={{
              width: 9, height: 9, borderRadius: "50%", background: C.amber, flexShrink: 0,
              animation: "news-pulse 1.5s ease-in-out infinite",
            }} />
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.amber, marginBottom: 4 }}>
                ⚡ GEOPOLITICAL ALERT · {geo.matched_keyword?.toUpperCase()} · {fmtTimeAgo(geo.matched_at)}
              </div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 12, color: C.text, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {geo.post_title}
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div style={{ display: "flex", gap: 6 }}>
          {(["ALL", "BULLISH", "BEARISH", "GEO", "NEUTRAL"] as const).map((f) => {
            const active = filter === f;
            const c =
              f === "BULLISH" ? C.green :
              f === "BEARISH" ? C.red :
              f === "GEO"     ? C.amber :
              f === "NEUTRAL" ? C.muted :
              C.text;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: "6px 12px",
                  background: active ? `${c}18` : "transparent",
                  border: `1px solid ${active ? c : C.divider}`,
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px",
                  color: active ? c : C.muted,
                }}
              >
                {f}
              </button>
            );
          })}
        </div>

        {/* Headlines */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {showGeoHeadline ? (
            <HeadlineCard
              source="Truth Social"
              published_at={geo?.matched_at ?? ""}
              sentiment="GEO"
              title={geo?.post_title ?? ""}
            />
          ) : null}

          {filter !== "GEO" && filtered.length === 0 && !loading && (
            <div style={{
              fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "1px",
              color: C.dim, padding: "20px 0", textAlign: "center",
              border: `1px solid ${C.border}`, borderRadius: 4,
            }}>
              No headlines match this filter
            </div>
          )}

          {filter === "GEO" && !showGeoHeadline && (
            <div style={{
              fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "1px",
              color: C.dim, padding: "20px 0", textAlign: "center",
              border: `1px solid ${C.border}`, borderRadius: 4,
            }}>
              No active geopolitical alerts
            </div>
          )}

          {filter !== "GEO" && filtered.map((h, i) => (
            <HeadlineCard
              key={i}
              source={h.source}
              published_at={h.published_at}
              sentiment={h.sentiment}
              title={h.title}
            />
          ))}
        </div>

        {loading && headlines.length === 0 && (
          <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.dim, padding: "20px 0", textAlign: "center" }}>
            LOADING…
          </div>
        )}
      </main>

      <style>{`@keyframes news-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } }`}</style>
    </div>
  );
}

interface HeadlineCardProps {
  source: string;
  published_at: string;
  sentiment: Sentiment | "GEO";
  title: string;
}

function HeadlineCard({ source, published_at, sentiment, title }: HeadlineCardProps) {
  const c =
    sentiment === "BULLISH" ? C.green :
    sentiment === "BEARISH" ? C.red :
    sentiment === "GEO"     ? C.amber :
    C.dim;
  return (
    <div style={{
      background: C.card,
      border: `1px solid ${C.border}`,
      borderLeft: `2px solid ${c}`,
      borderRadius: 3,
      padding: "12px 14px",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "1px",
        marginBottom: 8,
      }}>
        <span style={{ color: C.muted }}>
          {source} · {fmtTimeAgo(published_at)}
        </span>
        <span style={{ color: c, fontWeight: 700 }}>
          {sentiment}
        </span>
      </div>
      <div style={{
        fontFamily: FONT_SANS, fontSize: 13, color: C.text, lineHeight: 1.45,
        overflow: "hidden", textOverflow: "ellipsis",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      }}>
        {title}
      </div>
    </div>
  );
}
