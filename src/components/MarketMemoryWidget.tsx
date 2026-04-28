"use client";

import { useState, useEffect } from "react";

const mono = { fontFamily: "JetBrains Mono, monospace" } as const;

const C = {
  bg: "#1a1a1e",
  border: "#2a2a2e",
  text: "#e0e0e0",
  muted: "#666670",
  dim: "#444450",
  amber: "#d4a520",
  green: "#22c55e",
  red: "#ef4444",
  panel: "#111115",
};

interface RecentTrade {
  outcome: "WIN" | "LOSS" | "SCRATCH";
}

interface ActiveFvg {
  direction: "bullish" | "bearish";
  status: string;
}

interface MarketCtx {
  current_bias: "LONG" | "SHORT" | "NEUTRAL";
  bias_strength: "STRONG" | "MODERATE" | "WEAK";
  session_count: number;
  context_age_warning: boolean;
  recent_closed_trades: RecentTrade[];
  active_fvgs: ActiveFvg[];
  last_updated: string;
}

const STALE_HOURS_UI = 24;

function isStaleClient(iso: string): boolean {
  try {
    return (Date.now() - new Date(iso).getTime()) / 3600000 >= STALE_HOURS_UI;
  } catch {
    return false;
  }
}

function biasColor(bias: string): string {
  if (bias === "LONG") return C.green;
  if (bias === "SHORT") return C.red;
  return C.amber;
}

export default function MarketMemoryWidget() {
  const [ctx, setCtx] = useState<MarketCtx | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);

  async function loadCtx() {
    try {
      const res = await fetch("/api/market-context");
      if (res.ok) setCtx(await res.json());
    } catch {
      // silently ignore — widget degrades gracefully
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCtx();
  }, []);

  async function handleReset() {
    if (!confirm("Reset ALFRED market memory to blank? This cannot be undone.")) return;
    setResetting(true);
    try {
      const apiKey = process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "";
      await fetch("/api/market-context/reset", {
        method: "POST",
        headers: { "x-api-key": apiKey },
      });
      await loadCtx();
    } catch {
      // silently ignore
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
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
        <span style={{ ...mono, fontSize: 9, letterSpacing: "3px", color: C.dim }}>
          LOADING MEMORY...
        </span>
      </div>
    );
  }

  if (!ctx) {
    return (
      <div
        style={{
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: 20,
        }}
      >
        <div style={{ ...mono, fontSize: 9, letterSpacing: "3px", color: C.dim }}>
          MARKET MEMORY UNAVAILABLE
        </div>
      </div>
    );
  }

  const totalTrades = ctx.recent_closed_trades.length;
  const winCount = ctx.recent_closed_trades.filter((t) => t.outcome === "WIN").length;
  const winRatePct =
    totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(0) + "%" : "—";

  const liveFvg = ctx.active_fvgs.find((f) => f.status !== "filled");

  return (
    <div
      style={{
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: 20,
        borderTop: `3px solid ${biasColor(ctx.current_bias)}`,
      }}
    >
      <div
        style={{
          ...mono,
          fontSize: 9,
          letterSpacing: "3px",
          color: C.muted,
          marginBottom: 14,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>ALFRED MEMORY</span>
        {(ctx.context_age_warning || isStaleClient(ctx.last_updated)) && (
          <span
            style={{
              ...mono,
              fontSize: 8,
              letterSpacing: "1px",
              padding: "2px 6px",
              borderRadius: 3,
              background: `${C.amber}18`,
              color: C.amber,
              border: `1px solid ${C.amber}40`,
            }}
          >
            STALE
          </span>
        )}
      </div>

      {/* Bias row */}
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            ...mono,
            fontSize: 20,
            fontWeight: 700,
            color: biasColor(ctx.current_bias),
            letterSpacing: "2px",
          }}
        >
          {ctx.current_bias}{" "}
          <span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>
            · {ctx.bias_strength}
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div>
          <div
            style={{
              ...mono,
              fontSize: 8,
              letterSpacing: "2px",
              color: C.dim,
              marginBottom: 3,
            }}
          >
            SESSIONS
          </div>
          <div style={{ ...mono, fontSize: 13, color: C.text }}>
            {ctx.session_count}
          </div>
        </div>

        <div>
          <div
            style={{
              ...mono,
              fontSize: 8,
              letterSpacing: "2px",
              color: C.dim,
              marginBottom: 3,
            }}
          >
            RECENT WIN RATE
          </div>
          <div
            style={{
              ...mono,
              fontSize: 13,
              color:
                totalTrades === 0
                  ? C.muted
                  : winCount / totalTrades >= 0.5
                  ? C.green
                  : C.red,
            }}
          >
            {winRatePct}
            {totalTrades > 0 && (
              <span style={{ fontSize: 10, color: C.dim }}>
                {" "}
                ({totalTrades})
              </span>
            )}
          </div>
        </div>

        {liveFvg && (
          <div style={{ gridColumn: "1 / -1" }}>
            <div
              style={{
                ...mono,
                fontSize: 8,
                letterSpacing: "2px",
                color: C.dim,
                marginBottom: 3,
              }}
            >
              ACTIVE FVG
            </div>
            <div
              style={{
                ...mono,
                fontSize: 12,
                color:
                  liveFvg.direction === "bullish" ? C.green : C.red,
              }}
            >
              {liveFvg.direction.toUpperCase()}
            </div>
          </div>
        )}
      </div>

      {/* Reset button */}
      <button
        onClick={handleReset}
        disabled={resetting}
        style={{
          ...mono,
          width: "100%",
          padding: "7px 0",
          borderRadius: 4,
          border: `1px solid ${C.border}`,
          background: "transparent",
          color: C.muted,
          fontSize: 9,
          letterSpacing: "2px",
          cursor: resetting ? "not-allowed" : "pointer",
          opacity: resetting ? 0.6 : 1,
        }}
      >
        {resetting ? "RESETTING..." : "RESET CONTEXT"}
      </button>
    </div>
  );
}
