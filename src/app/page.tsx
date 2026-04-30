"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import logData from "@/data/safety_check_log.json";
import weeklyBias from "@/data/weekly_bias.json";
import MarketMemoryWidget from "@/components/MarketMemoryWidget";
import StreetPulseWidget from "@/components/StreetPulseWidget";

interface WeeklyBriefData {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
  rationale: string;
  invalidation: string | null;
  key_levels: { resistance: number[]; support: number[] };
  macro_inputs: { dxy: number | null; vix: number | null; ovx: number | null; xle: number | null };
  generated_at: string;
}

function fmtBriefTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      timeZone: "America/New_York",
    }) + " ET";
  } catch { return iso; }
}

function WeeklyBriefWidget() {
  const [brief, setBrief] = useState<WeeklyBriefData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/cron/weekly-brief", { cache: "no-store" });
        if (cancelled || !res.ok) { setLoaded(true); return; }
        const json = await res.json();
        if (json && json.weekly_bias) setBrief(json.weekly_bias as WeeklyBriefData);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Empty state — borderless one-liner before first brief lands
  if (loaded && !brief) {
    return (
      <div style={{ padding: "8px 0", fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670" }}>
        WEEKLY BRIEF · PENDING — runs Sunday 20:00 UTC
      </div>
    );
  }
  if (!brief) return null;

  const dirColor = brief.direction === "LONG" ? "#22c55e" : brief.direction === "SHORT" ? "#ef4444" : "#888";
  const macroChip = (label: string, value: number | null, fmt = (v: number) => v.toFixed(1)) => {
    const display = value == null ? "—" : fmt(value);
    return (
      <span style={{
        fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px",
        padding: "3px 8px", borderRadius: 3,
        color: value == null ? "#444450" : "#888",
        background: "#11111580", border: "1px solid #2a2a2e",
      }}>
        {label} {display}
      </span>
    );
  };

  return (
    <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#d4a520" }}>
          WEEKLY BRIEF
        </div>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px", color: "#666670" }}>
          {fmtBriefTime(brief.generated_at)}
        </div>
      </div>

      {/* Direction + strength */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{
          fontFamily: "JetBrains Mono, monospace", fontSize: 12, fontWeight: 700, letterSpacing: "2px",
          padding: "3px 10px", borderRadius: 3, color: dirColor,
          background: `${dirColor}18`, border: `1px solid ${dirColor}40`,
        }}>{brief.direction}</span>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "1px", color: "#888" }}>
          {brief.strength}
        </span>
      </div>

      {/* Rationale */}
      {brief.rationale && (
        <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: "#888", lineHeight: 1.55, marginBottom: 12 }}>
          {brief.rationale}
        </div>
      )}

      {/* Invalidation */}
      {brief.invalidation && (
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "1px", color: "#ef4444", marginBottom: 12 }}>
          ✗ INVALIDATED IF: <span style={{ fontFamily: "Inter, sans-serif", letterSpacing: 0 }}>{brief.invalidation}</span>
        </div>
      )}

      {/* Key levels */}
      {(brief.key_levels.resistance.length > 0 || brief.key_levels.support.length > 0) && (
        <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
          {brief.key_levels.resistance.length > 0 && (
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#ef4444", letterSpacing: "1px" }}>
              RESISTANCE: <span style={{ color: "#888" }}>{brief.key_levels.resistance.join(", ")}</span>
            </span>
          )}
          {brief.key_levels.support.length > 0 && (
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#22c55e", letterSpacing: "1px" }}>
              SUPPORT: <span style={{ color: "#888" }}>{brief.key_levels.support.join(", ")}</span>
            </span>
          )}
        </div>
      )}

      {/* Macro inputs */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {macroChip("DXY", brief.macro_inputs.dxy)}
        {macroChip("VIX", brief.macro_inputs.vix)}
        {macroChip("OVX", brief.macro_inputs.ovx)}
        {macroChip("XLE", brief.macro_inputs.xle, (v) => v.toFixed(2))}
      </div>
    </div>
  );
}

const CHECKLIST_ITEMS = [
  "EMA Stack Aligned",
  "Daily Trend Confirms",
  "RSI in Reset Zone",
  "MACD Confirming",
  "Price at Key Level",
  "R/R ≥ 2:1",
  "Session Timing",
  "EIA Window Clear",
];

function OutcomeBadge({ status, result }: { status: string; result?: string | null }) {
  const key = result || status;
  const map: Record<string, [string, string]> = {
    WIN: ["#22c55e", "#22c55e18"],
    LOSS: ["#ef4444", "#ef444418"],
    OPEN: ["#d4a520", "#d4a52018"],
    BLOCKED: ["#666670", "#66667018"],
  };
  const [c, bg] = map[key] || ["#666670", "transparent"];
  return (
    <span style={{
      fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "1px",
      padding: "2px 7px", borderRadius: 3, color: c, background: bg, border: `1px solid ${c}40`,
    }}>{key}</span>
  );
}

function GradeBadge({ grade }: { grade: string }) {
  const colors: Record<string, string> = { "A+": "#22c55e", A: "#86efac", B: "#d4a520", F: "#ef4444" };
  const c = colors[grade] || "#666670";
  return (
    <span style={{
      fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700,
      padding: "2px 7px", borderRadius: 3, color: c, background: `${c}18`, border: `1px solid ${c}40`,
    }}>{grade}</span>
  );
}

export default function DashboardPage() {
  const decisions = (logData as any).decisions || [];
  const bias = weeklyBias as any;
  const biasColor = bias.direction === "LONG" ? "#22c55e" : bias.direction === "SHORT" ? "#ef4444" : "#d4a520";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Top row: Bias + Score + Mini signals + Market Memory */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>

        {/* Weekly Bias */}
        <div style={{
          background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6,
          padding: 20, borderTop: `3px solid ${biasColor}`,
        }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670", marginBottom: 14 }}>WEEKLY BIAS</div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 34, fontWeight: 700, letterSpacing: "4px", color: biasColor }}>
            {bias.direction}
          </div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#666670", marginTop: 6 }}>
            {bias.strength} CONVICTION
          </div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#444450", marginTop: 10 }}>
            Sunday macro brief · {new Date(bias.last_updated).toLocaleDateString()}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: "#666670", lineHeight: 1.6 }}>
            {bias.rationale}
          </div>
        </div>

        {/* A+ Checklist */}
        <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670", marginBottom: 14 }}>A+ CHECKLIST</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 28, fontWeight: 700, color: "#e0e0e0" }}>8/8</span>
            <GradeBadge grade="A+" />
          </div>
          {CHECKLIST_ITEMS.map((item) => (
            <div key={item} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: "#888" }}>{item}</span>
              <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#22c55e", letterSpacing: "1px" }}>PASS</span>
            </div>
          ))}
          <Link href="/pre-trade" style={{
            display: "block", marginTop: 14, padding: "9px 0", borderRadius: 4,
            background: "#d4a520", color: "#0d0d0f", textAlign: "center",
            fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px",
            fontWeight: 700, textDecoration: "none",
          }}>
            RUN FULL ANALYSIS →
          </Link>
        </div>

        {/* Market Memory Widget */}
        <MarketMemoryWidget />

        {/* Recent Signals Mini */}
        <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670", marginBottom: 14 }}>RECENT SIGNALS</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["TIME", "DIR", "SCORE", "STATUS"].map((h) => (
                  <th key={h} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#666670", textAlign: "left", padding: "0 8px 10px 0", borderBottom: "1px solid #2a2a2e" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {decisions.slice(0, 5).map((d: any) => (
                <tr key={d.id}>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#666670", padding: "9px 8px 9px 0", borderBottom: "1px solid #2a2a2e18" }}>
                    {new Date(d.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td style={{
                    fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700,
                    color: d.decision === "LONG" ? "#22c55e" : d.decision === "SHORT" ? "#ef4444" : "#d4a520",
                    padding: "9px 8px 9px 0", borderBottom: "1px solid #2a2a2e18",
                  }}>{d.decision === "NO TRADE" ? "SKIP" : d.decision}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", padding: "9px 8px 9px 0", borderBottom: "1px solid #2a2a2e18" }}>{d.aplus_checklist?.score ?? "—"}/8</td>
                  <td style={{ padding: "9px 0", borderBottom: "1px solid #2a2a2e18" }}>
                    <OutcomeBadge status={d.outcome?.status} result={d.outcome?.result} />
                  </td>
                </tr>
              ))}
              {decisions.length === 0 && (
                <tr><td colSpan={4} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#444450", padding: "20px 0" }}>NO EVALUATIONS YET</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Weekly Brief — Sunday cron output, full-width */}
      <WeeklyBriefWidget />

      {/* Street Pulse — sentiment readout below the market-memory row */}
      <StreetPulseWidget />

      {/* Full evaluations table */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#d4a520" }}>ALL EVALUATIONS</div>
          <Link href="/journal" style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#666670", textDecoration: "none" }}>
            VIEW JOURNAL →
          </Link>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["ID", "DATE", "SESSION", "DIRECTION", "GRADE", "ENTRY", "STOP", "TARGET", "OUTCOME"].map((h) => (
                <th key={h} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#666670", textAlign: "left", padding: "0 12px 10px 0", borderBottom: "1px solid #2a2a2e" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decisions.map((d: any) => (
              <tr key={d.id}>
                <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#444450", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.id}</td>
                <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                  {new Date(d.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.session?.replace("_", " ")}</td>
                <td style={{
                  fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700,
                  color: d.decision === "LONG" ? "#22c55e" : d.decision === "SHORT" ? "#ef4444" : "#d4a520",
                  padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20",
                }}>{d.decision}</td>
                <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                  <GradeBadge grade={d.aplus_checklist?.grade ?? "—"} />
                </td>
                <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.entry_price ? `$${d.entry_price}` : "—"}</td>
                <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.stop_loss ? `$${d.stop_loss}` : "—"}</td>
                <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.take_profit_1 ? `$${d.take_profit_1}` : "—"}</td>
                <td style={{ padding: "11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                  <OutcomeBadge status={d.outcome?.status} result={d.outcome?.result} />
                </td>
              </tr>
            ))}
            {decisions.length === 0 && (
              <tr><td colSpan={9} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#444450", padding: "24px 0" }}>NO EVALUATIONS LOGGED YET — RUN YOUR FIRST PRE-TRADE ANALYSIS</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
