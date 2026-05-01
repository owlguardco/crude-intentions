"use client";

/**
 * STREET PULSE — v3 UI
 *
 * 5-state ladder (BEAR / LEANING_BEAR / NEUTRAL / LEANING_BULL / BULL)
 * derived from the composite -100..+100 score returned by /api/street-pulse.
 *
 * The API aggregates four crude-relevant RSS feeds (Yahoo×2, Reuters,
 * Investing.com) server-side; the widget never hits Stocktwits/Google
 * Trends from the browser because of CORS. When the route adds more
 * sentiment surfaces, the score-to-state mapping handles them
 * automatically.
 */

import { useEffect, useState, useCallback } from "react";

const C = {
  bg: "#1a1a1e",
  panel: "#111115",
  border: "#2a2a2e",
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

interface StreetPulse {
  score: number;
  label: Sentiment;
  samples: number;
  headlines: Headline[];
  updated_at: string;
  stale?: boolean;
}

interface StateMeta {
  label: string;
  pos: number;       // 0..100 — diamond marker x position on the track
  color: string;
  segment: number;   // 0..4 — which segment is "active"
  verdict: string;
}

const STATES: Record<StateKey, StateMeta> = {
  BEAR:         { label: "BEAR",         pos: 10, color: C.red,    segment: 0, verdict: "BEARISH" },
  LEANING_BEAR: { label: "LEANING BEAR", pos: 30, color: C.red,    segment: 1, verdict: "LEANING BEAR" },
  NEUTRAL:      { label: "NEUTRAL",      pos: 50, color: C.muted,  segment: 2, verdict: "NEUTRAL" },
  LEANING_BULL: { label: "LEANING BULL", pos: 70, color: C.green,  segment: 3, verdict: "LEANING BULL" },
  BULL:         { label: "BULL",         pos: 90, color: C.green,  segment: 4, verdict: "BULLISH" },
};

interface SourceRow {
  ok: boolean;
  score: number;
  label: string;
  detail: string;
}

function toStateKey(score: number): StateKey {
  if (score <= -40) return "BEAR";
  if (score <= -10) return "LEANING_BEAR";
  if (score < 10)   return "NEUTRAL";
  if (score < 40)   return "LEANING_BULL";
  return "BULL";
}

function fmtTimeAgo(iso: string): string {
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

function buildSources(pulse: StreetPulse): SourceRow[] {
  // Each top-4 headline becomes a source row. score per row encodes the
  // headline's sentiment (-1/0/+1) so the row badge color matches the
  // composite verdict logic.
  return pulse.headlines.slice(0, 4).map<SourceRow>((h) => {
    const s = h.sentiment === "BULLISH" ? 1 : h.sentiment === "BEARISH" ? -1 : 0;
    return {
      ok: true,
      score: s,
      label: h.sentiment,
      detail: h.title,
    };
  });
}

interface TrackProps {
  state: StateMeta;
  loading: boolean;
}

function Track({ state, loading }: TrackProps) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          position: "relative",
          height: 14,
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 2,
        }}
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const isActive = i === state.segment;
          const segColor =
            i === 0 || i === 1 ? C.red :
            i === 2 ? C.muted :
            C.green;
          return (
            <div
              key={i}
              style={{
                background: isActive ? segColor : C.panel,
                border: `1px solid ${isActive ? segColor : C.border}`,
                borderRadius: 2,
                opacity: isActive ? 1 : 0.55,
                position: "relative",
                overflow: "hidden",
              }}
            >
              {loading && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: `linear-gradient(90deg, transparent 0%, ${C.border}80 50%, transparent 100%)`,
                    animation: "sp-shimmer 1.4s infinite",
                  }}
                />
              )}
            </div>
          );
        })}
        {/* Diamond marker */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: -4,
            left: `calc(${state.pos}% - 6px)`,
            width: 12,
            height: 12,
            background: state.color,
            border: `1px solid ${C.bg}`,
            transform: "rotate(45deg)",
            transition: "left 0.5s ease",
            boxShadow: `0 0 8px ${state.color}80`,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: FONT_MONO,
          fontSize: 8,
          letterSpacing: "2px",
          color: C.dim,
          marginTop: 6,
        }}
      >
        <span>BEAR ◄</span>
        <span>► BULL</span>
      </div>
      <style>{`@keyframes sp-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }`}</style>
    </div>
  );
}

export default function StreetPulseWidget() {
  const [pulse, setPulse] = useState<StreetPulse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/street-pulse?refresh=1", { cache: "no-store" });
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const json = (await res.json()) as StreetPulse;
      setPulse(json);
    } catch {
      // hold last good value
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const empty = !pulse || pulse.samples === 0;
  const stateKey: StateKey = pulse ? toStateKey(pulse.score) : "NEUTRAL";
  const state = STATES[stateKey];
  const sources = pulse ? buildSources(pulse) : [];

  return (
    <div
      style={{
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: 20,
        borderTop: `3px solid ${state.color}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: FONT_MONO,
            fontSize: 9,
            letterSpacing: "3px",
            color: C.muted,
          }}
        >
          <span
            aria-label="live indicator"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: loading ? C.amber : C.green,
              boxShadow: `0 0 6px ${loading ? C.amber : C.green}`,
              animation: loading ? "sp-blink 1s infinite" : "none",
            }}
          />
          STREET PULSE
          {pulse?.stale && (
            <span
              title="All feeds unreachable — showing last successful fetch"
              style={{
                fontFamily: FONT_MONO,
                fontSize: 8,
                letterSpacing: "1px",
                padding: "2px 5px",
                borderRadius: 3,
                color: C.muted,
                background: "#2a2a2e40",
                border: `1px solid ${C.border}`,
              }}
            >
              CACHED
            </span>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {pulse?.updated_at && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "1px", color: C.dim }}>
              {fmtTimeAgo(pulse.updated_at)}
            </span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            title="Refresh now"
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 3,
              padding: "2px 7px",
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: loading ? C.dim : C.muted,
              cursor: loading ? "not-allowed" : "pointer",
              lineHeight: 1,
            }}
          >
            ↻
          </button>
        </span>
      </div>

      {/* Verdict */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "3px",
            color: empty ? C.muted : state.color,
            lineHeight: 1.1,
          }}
        >
          {!loaded ? "LOADING..." : empty ? "AWAITING DATA" : state.verdict}
        </div>
        {!empty && pulse && (
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted, marginTop: 6, letterSpacing: "1px" }}>
            score {pulse.score >= 0 ? "+" : ""}{pulse.score} · {pulse.samples} sample{pulse.samples === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Track */}
      <Track state={state} loading={loading || !loaded} />

      {/* Expand/collapse trigger */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          marginTop: 14,
          width: "100%",
          background: "transparent",
          border: `1px solid ${C.border}`,
          borderRadius: 3,
          padding: "7px 0",
          fontFamily: FONT_MONO,
          fontSize: 9,
          letterSpacing: "3px",
          color: C.muted,
          cursor: "pointer",
        }}
      >
        {expanded ? "LESS ▲" : "MORE ▼"}
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {sources.length === 0 ? (
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 9,
                letterSpacing: "1px",
                color: C.dim,
                padding: "10px 0",
                textAlign: "center",
              }}
            >
              No headlines yet — feeds returned empty
            </div>
          ) : (
            sources.map((s, i) => {
              const c =
                s.label === "BULLISH" ? C.green :
                s.label === "BEARISH" ? C.red :
                C.muted;
              const original = pulse?.headlines[i];
              return (
                <div
                  key={i}
                  style={{
                    padding: "9px 12px",
                    background: C.panel,
                    border: `1px solid ${C.border}`,
                    borderLeft: `2px solid ${c}`,
                    borderRadius: 3,
                  }}
                >
                  <div
                    style={{
                      fontFamily: FONT_SANS,
                      fontSize: 12,
                      color: C.text,
                      lineHeight: 1.45,
                      marginBottom: 5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {s.detail}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontFamily: FONT_MONO,
                      fontSize: 8,
                      letterSpacing: "1px",
                    }}
                  >
                    <span style={{ color: C.muted }}>
                      {original?.source ?? "—"}
                      {!s.ok && <span style={{ color: C.red, marginLeft: 6 }}>· OFFLINE</span>}
                    </span>
                    <span style={{ color: c, fontWeight: 700 }}>
                      {s.label}
                      {original?.published_at && ` · ${fmtTimeAgo(original.published_at)}`}
                    </span>
                  </div>
                </div>
              );
            })
          )}

          {/* Caveat block */}
          <div
            style={{
              marginTop: 4,
              padding: "10px 12px",
              background: "#2a2a2e30",
              border: `1px solid ${C.border}`,
              borderRadius: 3,
              fontFamily: FONT_MONO,
              fontSize: 9,
              lineHeight: 1.55,
              color: C.muted,
              letterSpacing: "0.5px",
            }}
          >
            STREET IS RIGHT ~15% OF THE TIME. Use this as a contra-indicator when
            extremes line up against your setup, not as primary signal. Sentiment
            from headlines lags price by hours; treat the verdict as crowd-mood
            colour, not a directional cue.
          </div>
        </div>
      )}

      <style>{`@keyframes sp-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
    </div>
  );
}
