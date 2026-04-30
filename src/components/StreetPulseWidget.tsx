"use client";

/**
 * STREET PULSE — crude-relevant headline sentiment readout for the dashboard.
 *
 * NOTE: This component is structurally complete but currently driven by the
 * stub at /api/street-pulse, which returns NEUTRAL / 0 samples until the
 * real sentiment source is wired. When the upstream returns real data, no
 * changes to this component are required.
 */

import { useEffect, useState } from "react";

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

function colorFor(s: Sentiment): string {
  if (s === "BULLISH") return C.green;
  if (s === "BEARISH") return C.red;
  return C.muted;
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

export default function StreetPulseWidget() {
  const [pulse, setPulse] = useState<StreetPulse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/street-pulse", { cache: "no-store" });
        if (cancelled || !res.ok) return;
        const json = (await res.json()) as StreetPulse;
        setPulse(json);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!loaded) {
    return (
      <div
        style={{
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 120,
        }}
      >
        <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "3px", color: C.dim }}>
          LOADING PULSE...
        </span>
      </div>
    );
  }

  const labelColor = pulse ? colorFor(pulse.label) : C.muted;
  const scorePct = pulse ? Math.max(0, Math.min(100, (pulse.score + 100) / 2)) : 50;
  const empty = !pulse || pulse.samples === 0;

  return (
    <div
      style={{
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: 20,
        borderTop: `3px solid ${labelColor}`,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 9,
          letterSpacing: "3px",
          color: C.muted,
          marginBottom: 14,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>STREET PULSE</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
          {pulse?.updated_at && (
            <span style={{ fontSize: 8, letterSpacing: "1px", color: C.dim }}>
              {fmtTimeAgo(pulse.updated_at)}
            </span>
          )}
        </span>
      </div>

      {/* Headline label + score */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 20,
            fontWeight: 700,
            color: empty ? C.muted : labelColor,
            letterSpacing: "2px",
          }}
        >
          {empty ? "AWAITING DATA" : pulse!.label}
        </div>
        {!empty && (
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.muted, marginTop: 4 }}>
            score {pulse!.score >= 0 ? "+" : ""}
            {pulse!.score} · {pulse!.samples} sample{pulse!.samples === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Sentiment bar -100..+100 */}
      {!empty && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              position: "relative",
              height: 6,
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 3,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: `${scorePct}%`,
                background: labelColor,
                transition: "width 0.4s ease",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: -2,
                bottom: -2,
                left: "50%",
                width: 1,
                background: C.border,
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: FONT_MONO,
              fontSize: 8,
              letterSpacing: "1px",
              color: C.dim,
              marginTop: 4,
            }}
          >
            <span>BEAR</span>
            <span>NEUTRAL</span>
            <span>BULL</span>
          </div>
        </div>
      )}

      {/* Headlines */}
      {empty ? (
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
          No headlines yet — sentiment source not wired
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pulse!.headlines.slice(0, 4).map((h, i) => {
            const c = colorFor(h.sentiment);
            return (
              <div
                key={i}
                style={{
                  padding: "8px 10px",
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
                    lineHeight: 1.4,
                    marginBottom: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {h.title}
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
                  <span style={{ color: C.muted }}>{h.source}</span>
                  <span style={{ color: c, fontWeight: 700 }}>
                    {h.sentiment} · {fmtTimeAgo(h.published_at)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
