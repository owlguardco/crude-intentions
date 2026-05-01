"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import logData from "@/data/safety_check_log.json";
import weeklyBias from "@/data/weekly_bias.json";

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

// ── Shared types ───────────────────────────────────────────────────────────

interface CalibrationSnapshot {
  totals?: { trades_closed?: number; historical_closed?: number };
  overall?: { win_rate?: number };
}

interface ConditionsResponse {
  ema_4h: boolean | null;
  ema_15m: boolean | null;
  rsi_reset: boolean | null;
  fvg_present: boolean | null;
  vwap: boolean | null;
  ovx_clean: boolean | null;
  session_window: boolean | null;
  eia_clear: boolean | null;
  generated_at: string;
}

interface OvxResponse { price?: number }

type Sentiment = "BULLISH" | "BEARISH" | "NEUTRAL";
type StateKey = "BEAR" | "LEANING_BEAR" | "NEUTRAL" | "LEANING_BULL" | "BULL";

interface SourceResult { label: string; ok: boolean; score: number; detail: string }

interface StreetPulse {
  score: number;
  state?: StateKey;
  sources?: SourceResult[];
  label?: Sentiment;
  samples?: number;
  updated_at?: string;
}

interface SupplyContext {
  cushing_vs_4wk: "BUILDING" | "DRAWING" | "FLAT" | null;
  eia_4wk_trend: "BUILDS" | "DRAWS" | "MIXED" | null;
  rig_count_trend: "RISING" | "FALLING" | "FLAT" | null;
  supply_bias: "BEARISH" | "NEUTRAL" | "BULLISH" | null;
}

interface GeoFlag {
  flagged: boolean;
  matched_at: string | null;
  matched_keyword: string | null;
  post_title: string | null;
  post_url: string | null;
  checked_at: string;
  error?: string;
}

interface RecentSignal {
  id: string;
  timestamp: string;
  decision: "LONG" | "SHORT" | "NO TRADE";
  aplus_checklist?: { score?: number; grade?: string };
  outcome?: { status?: string; result?: string | null };
}

// ── State helpers ──────────────────────────────────────────────────────────

function scoreToState(score: number): StateKey {
  if (score <= -40) return "BEAR";
  if (score <= -10) return "LEANING_BEAR";
  if (score < 10)   return "NEUTRAL";
  if (score < 40)   return "LEANING_BULL";
  return "BULL";
}

const SENTIMENT_META: Record<StateKey, { label: string; pos: number; color: string; segment: number }> = {
  BEAR:         { label: "BEAR",         pos: 10, color: C.red,    segment: 0 },
  LEANING_BEAR: { label: "LEAN BEAR",    pos: 30, color: C.red,    segment: 1 },
  NEUTRAL:      { label: "NEUTRAL",      pos: 50, color: C.muted,  segment: 2 },
  LEANING_BULL: { label: "LEAN BULL",    pos: 70, color: C.green,  segment: 3 },
  BULL:         { label: "BULL",         pos: 90, color: C.green,  segment: 4 },
};

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
  } catch { return ""; }
}

// ── Card shell ─────────────────────────────────────────────────────────────

interface WidgetProps {
  title: string;
  borderColor?: string;
  onClick?: () => void;
  children: React.ReactNode;
}

function Widget({ title, borderColor = C.divider, onClick, children }: WidgetProps) {
  return (
    <div
      onClick={onClick}
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderTop: `2px solid ${borderColor}`,
        borderRadius: 4,
        padding: 16,
        cursor: onClick ? "pointer" : "default",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div style={{
        fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "3px",
        color: C.muted, marginBottom: 10,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span>{title}</span>
        {onClick && <span style={{ color: C.dim, fontSize: 11 }}>↗</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}

// ── Row 1 widgets ──────────────────────────────────────────────────────────

function WeeklyBiasWidget() {
  const bias = weeklyBias as { direction: "LONG" | "SHORT" | "NEUTRAL"; strength: string; last_updated: string };
  const color = bias.direction === "LONG" ? C.green : bias.direction === "SHORT" ? C.red : C.amber;
  return (
    <Widget title="WEEKLY BIAS" borderColor={color}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 30, fontWeight: 700, letterSpacing: "3px",
        color, lineHeight: 1, marginBottom: 8,
      }}>
        {bias.direction}
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.muted, marginBottom: "auto" }}>
        {bias.strength} CONVICTION
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.dim, marginTop: 12, letterSpacing: "1px" }}>
        SUNDAY · {new Date(bias.last_updated).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
      </div>
    </Widget>
  );
}

interface AlfredWidgetProps {
  snapshot: CalibrationSnapshot | null;
  apiOnline: boolean | null;
}

function AlfredWidget({ snapshot, apiOnline }: AlfredWidgetProps) {
  const trades = snapshot?.totals?.trades_closed ?? 0;
  const winRate = snapshot?.overall?.win_rate ?? 0;
  const dotColor = apiOnline === true ? C.green : apiOnline === false ? C.red : C.amber;
  const labelColor = apiOnline === true ? C.green : apiOnline === false ? C.red : C.amber;
  return (
    <Widget title="ALFRED" borderColor={dotColor}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span
          aria-hidden
          style={{
            width: 10, height: 10, borderRadius: "50%", background: dotColor,
            animation: apiOnline === true ? "alfred-pulse 2s ease-in-out infinite" : "none",
            boxShadow: `0 0 6px ${dotColor}`,
          }}
        />
        <span style={{
          fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, letterSpacing: "2px",
          color: labelColor,
        }}>
          {apiOnline === true ? "ONLINE" : apiOnline === false ? "OFFLINE" : "CHECKING"}
        </span>
      </div>
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "1px", color: C.muted }}>SESSIONS</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.text }}>{trades}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "1px", color: C.muted }}>WIN RATE</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.text }}>
            {trades > 0 ? `${winRate.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>
      <style>{`@keyframes alfred-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(1.18); } }`}</style>
    </Widget>
  );
}

interface OvxWidgetProps { ovx: number | null }

function OvxWidget({ ovx }: OvxWidgetProps) {
  const zone =
    ovx == null      ? { label: "—", color: C.dim }
    : ovx < 20       ? { label: "DEAD",     color: C.muted }
    : ovx <= 35      ? { label: "CLEAN",    color: C.green }
    : ovx <= 50      ? { label: "ELEVATED", color: C.amber }
    :                  { label: "CHAOS",    color: C.red };
  // Meter: 0..70 mapped to 0..100% width
  const maxScale = 70;
  const fillPct = ovx == null ? 0 : Math.max(0, Math.min(100, (ovx / maxScale) * 100));
  return (
    <Widget title="OVX" borderColor={zone.color}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 30, fontWeight: 700,
        color: zone.color, letterSpacing: "2px", lineHeight: 1, marginBottom: 8,
      }}>
        {ovx == null ? "—" : ovx.toFixed(1)}
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.muted, marginBottom: 14 }}>
        ZONE · <span style={{ color: zone.color, fontWeight: 700 }}>{zone.label}</span>
      </div>
      <div style={{ marginTop: "auto" }}>
        <div style={{
          position: "relative", height: 6,
          background: C.bg, border: `1px solid ${C.divider}`, borderRadius: 3, overflow: "hidden",
        }}>
          {/* zone segments — green up to 50%, amber to 71%, red beyond */}
          <div style={{ position: "absolute", inset: 0, display: "flex" }}>
            <div style={{ width: `${(35 / maxScale) * 100}%`, background: `${C.green}30` }} />
            <div style={{ width: `${(15 / maxScale) * 100}%`, background: `${C.amber}30` }} />
            <div style={{ flex: 1, background: `${C.red}30` }} />
          </div>
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: 0,
            width: `${fillPct}%`, background: zone.color,
            transition: "width 0.4s ease",
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "1px", color: C.dim, marginTop: 4 }}>
          <span>0</span>
          <span>35</span>
          <span>50</span>
          <span>70+</span>
        </div>
      </div>
    </Widget>
  );
}

interface Phase3WidgetProps { snapshot: CalibrationSnapshot | null }

function Phase3Widget({ snapshot }: Phase3WidgetProps) {
  const total = snapshot?.totals?.trades_closed ?? 0;
  const historical = snapshot?.totals?.historical_closed ?? 0;
  const live = Math.max(0, total - historical);
  const TARGET = 20;
  const winRate = snapshot?.overall?.win_rate ?? 0;
  const cleared = live >= TARGET && winRate > 55;
  const fillPct = Math.min(100, (live / TARGET) * 100);
  const barColor = cleared ? C.green : C.amber;
  // 5 conditions: 20 trades, win rate, sharpe, sim, apex
  const passCount = (live >= TARGET ? 1 : 0) + (live >= TARGET && winRate > 55 ? 1 : 0);
  const pending = 5 - passCount;
  return (
    <Widget title="PHASE 3 GATE" borderColor={cleared ? C.green : C.amber}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 26, fontWeight: 700, color: C.text, letterSpacing: "2px" }}>
          {live}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: C.muted, letterSpacing: "1px" }}>
          / {TARGET}
        </span>
      </div>
      <div style={{
        position: "relative", height: 6,
        background: C.bg, border: `1px solid ${C.divider}`, borderRadius: 3, overflow: "hidden",
        marginBottom: 12,
      }}>
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: 0,
          width: `${fillPct}%`, background: barColor,
          transition: "width 0.4s ease",
        }} />
      </div>
      <div style={{ marginTop: "auto", fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: cleared ? C.green : C.amber, fontWeight: 700 }}>
        {cleared ? "✓ GATE CLEAR" : `${pending} CONDITIONS PENDING`}
      </div>
    </Widget>
  );
}

// ── Row 2 widgets ──────────────────────────────────────────────────────────

interface ConditionsWidgetProps { conditions: ConditionsResponse | null }

function ConditionsWidget({ conditions }: ConditionsWidgetProps) {
  const rows: Array<{ label: string; value: boolean | null }> = [
    { label: "4H EMA STACK",   value: conditions?.ema_4h ?? null },
    { label: "15M EMA STACK",  value: conditions?.ema_15m ?? null },
    { label: "RSI RESET",      value: conditions?.rsi_reset ?? null },
    { label: "FVG PRESENT",    value: conditions?.fvg_present ?? null },
    { label: "VWAP ALIGNED",   value: conditions?.vwap ?? null },
    { label: "OVX CLEAN",      value: conditions?.ovx_clean ?? null },
    { label: "SESSION WINDOW", value: conditions?.session_window ?? null },
    { label: "EIA CLEAR",      value: conditions?.eia_clear ?? null },
  ];
  return (
    <Widget title="CONDITIONS NOW">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 18px", flex: 1 }}>
        {rows.map((r) => {
          const dotColor = r.value === true ? C.green : r.value === false ? C.red : C.dim;
          const valueColor = r.value === true ? C.green : r.value === false ? C.red : C.dim;
          return (
            <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%", background: dotColor,
                boxShadow: r.value !== null ? `0 0 4px ${dotColor}80` : "none",
                flexShrink: 0,
              }} />
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.text, letterSpacing: "1px", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {r.label}
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "1px", color: valueColor, fontWeight: 700 }}>
                {r.value === true ? "PASS" : r.value === false ? "FAIL" : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </Widget>
  );
}

interface RecentSignalsWidgetProps { signals: RecentSignal[] }

function RecentSignalsWidget({ signals }: RecentSignalsWidgetProps) {
  const rows = signals.slice(0, 3);
  return (
    <Widget title="RECENT SIGNALS">
      {rows.length === 0 ? (
        <div style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.dim,
        }}>
          NO SIGNALS YET
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((d) => {
            const dirColor = d.decision === "LONG" ? C.green : d.decision === "SHORT" ? C.red : C.amber;
            const status = d.outcome?.status ?? "OPEN";
            const result = d.outcome?.result ?? null;
            const statusKey = result ?? status;
            const statusColor =
              statusKey === "WIN" ? C.green :
              statusKey === "LOSS" ? C.red :
              statusKey === "OPEN" ? C.amber :
              C.muted;
            const grade = d.aplus_checklist?.grade ?? "—";
            const gradeColor =
              grade === "A+" ? C.green :
              grade === "A"  ? "#86efac" :
              grade === "B+" ? C.amber :
              grade === "B"  ? C.amber :
              C.red;
            return (
              <div key={d.id} style={{
                display: "grid",
                gridTemplateColumns: "60px 60px 1fr auto",
                gap: 10, alignItems: "center",
                padding: "10px 12px",
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
              }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.muted }}>
                  {new Date(d.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700,
                  letterSpacing: "1px", color: dirColor,
                }}>
                  {d.decision === "NO TRADE" ? "SKIP" : d.decision}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 10, fontWeight: 700,
                  letterSpacing: "1px", color: gradeColor,
                  padding: "2px 6px", borderRadius: 3,
                  background: `${gradeColor}18`, border: `1px solid ${gradeColor}40`,
                  justifySelf: "start",
                }}>
                  {grade}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 9, fontWeight: 700,
                  letterSpacing: "1px", color: statusColor,
                  padding: "2px 6px", borderRadius: 3,
                  background: `${statusColor}18`, border: `1px solid ${statusColor}40`,
                }}>
                  {String(statusKey).toUpperCase()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Widget>
  );
}

// ── Row 3 widgets ──────────────────────────────────────────────────────────

interface SentimentWidgetProps { pulse: StreetPulse | null; onClick: () => void }

function SentimentWidget({ pulse, onClick }: SentimentWidgetProps) {
  const stateKey: StateKey = pulse ? (pulse.state ?? scoreToState(pulse.score)) : "NEUTRAL";
  const meta = SENTIMENT_META[stateKey];
  const score = pulse?.score ?? 0;
  const samples = pulse?.samples ?? 0;
  return (
    <Widget title="SENTIMENT" borderColor={meta.color} onClick={onClick}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, letterSpacing: "3px",
        color: meta.color, lineHeight: 1, marginBottom: 12,
      }}>
        {meta.label}
      </div>

      {/* track */}
      <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2, height: 10, marginBottom: 6 }}>
        {[0, 1, 2, 3, 4].map((i) => {
          const isActive = i === meta.segment;
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
          position: "absolute", top: -3, left: `calc(${meta.pos}% - 5px)`,
          width: 10, height: 10, background: meta.color,
          border: `1px solid ${C.bg}`, transform: "rotate(45deg)",
          boxShadow: `0 0 6px ${meta.color}80`,
          transition: "left 0.4s ease",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "1px", color: C.dim, marginBottom: 10 }}>
        <span>BEAR</span>
        <span>BULL</span>
      </div>

      <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "1px", color: C.muted }}>
        score {score >= 0 ? "+" : ""}{score} · {samples} sample{samples === 1 ? "" : "s"}
      </div>
    </Widget>
  );
}

interface SupplyWidgetProps { supply: SupplyContext | null }

function SupplyWidget({ supply }: SupplyWidgetProps) {
  const rows: Array<{ label: string; value: string; color: string }> = supply ? [
    {
      label: "CUSHING",
      value: supply.cushing_vs_4wk ?? "—",
      color: supply.cushing_vs_4wk === "DRAWING" ? C.green : supply.cushing_vs_4wk === "BUILDING" ? C.red : supply.cushing_vs_4wk === "FLAT" ? C.muted : C.dim,
    },
    {
      label: "EIA 4WK",
      value: supply.eia_4wk_trend ?? "—",
      color: supply.eia_4wk_trend === "DRAWS" ? C.green : supply.eia_4wk_trend === "BUILDS" ? C.red : supply.eia_4wk_trend === "MIXED" ? C.amber : C.dim,
    },
    {
      label: "RIG COUNT",
      value: supply.rig_count_trend ?? "—",
      color: supply.rig_count_trend === "FALLING" ? C.green : supply.rig_count_trend === "RISING" ? C.red : supply.rig_count_trend === "FLAT" ? C.muted : C.dim,
    },
    {
      label: "BIAS",
      value: supply.supply_bias ?? "—",
      color: supply.supply_bias === "BULLISH" ? C.green : supply.supply_bias === "BEARISH" ? C.red : supply.supply_bias === "NEUTRAL" ? C.muted : C.dim,
    },
  ] : [];
  return (
    <Widget title="SUPPLY CONTEXT">
      {rows.length === 0 ? (
        <div style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.dim,
        }}>
          AWAITING DATA
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((r) => (
            <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.muted }}>
                {r.label}
              </span>
              <span style={{
                fontFamily: FONT_MONO, fontSize: 10, fontWeight: 700, letterSpacing: "1px",
                color: r.color,
                padding: "2px 7px", borderRadius: 3,
                background: `${r.color}18`, border: `1px solid ${r.color}40`,
              }}>
                {r.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </Widget>
  );
}

interface GeoWidgetProps { geo: GeoFlag | null; onClick: () => void }

function GeoWidget({ geo, onClick }: GeoWidgetProps) {
  const active =
    geo?.flagged === true && !geo.error && geo.matched_at &&
    (Date.now() - new Date(geo.matched_at).getTime()) / 60000 <= 30;
  const color = active ? C.amber : C.green;
  const label = active ? "ALERT" : "CLEAR";
  return (
    <Widget title="GEO FLAG" borderColor={color} onClick={onClick}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span
          aria-hidden
          style={{
            width: 10, height: 10, borderRadius: "50%", background: color,
            animation: active ? "geo-pulse 1.5s ease-in-out infinite" : "none",
            boxShadow: `0 0 6px ${color}`,
          }}
        />
        <span style={{
          fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, letterSpacing: "3px",
          color, lineHeight: 1,
        }}>
          {label}
        </span>
      </div>
      {active && geo?.matched_keyword && (
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "1px", color: C.amber, marginBottom: 4 }}>
          ⚡ {geo.matched_keyword.toUpperCase()} · <span style={{ color: C.muted }}>{fmtTimeAgo(geo.matched_at)}</span>
        </div>
      )}
      <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.dim }}>
        TRUTH SOCIAL · @realDonaldTrump
      </div>
      <style>{`@keyframes geo-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } }`}</style>
    </Widget>
  );
}

// ── Row 4 widgets ──────────────────────────────────────────────────────────

interface WeeklyBriefSnippet {
  direction?: "LONG" | "SHORT" | "NEUTRAL";
  rationale?: string;
}

interface MarketContextResponse {
  current_bias?: "LONG" | "SHORT" | "NEUTRAL";
  bias_strength?: "STRONG" | "MODERATE" | "WEAK";
  last_updated?: string;
  weekly_bias?: WeeklyBriefSnippet | null;
  supply_context?: { supply_bias?: "BEARISH" | "NEUTRAL" | "BULLISH" | null } | null;
}

interface MarketMemoryWidgetProps { ctx: MarketContextResponse | null }

function MarketMemoryWidget({ ctx }: MarketMemoryWidgetProps) {
  const dir = ctx?.current_bias ?? null;
  const dirColor = dir === "LONG" ? C.green : dir === "SHORT" ? C.red : dir === "NEUTRAL" ? C.amber : C.dim;
  const wb = ctx?.weekly_bias;
  const supplyBias = ctx?.supply_context?.supply_bias ?? null;
  const supplyColor =
    supplyBias === "BULLISH" ? C.green :
    supplyBias === "BEARISH" ? C.red :
    supplyBias === "NEUTRAL" ? C.muted : C.dim;
  const empty = !ctx || !dir;
  return (
    <Widget title="MARKET MEMORY" borderColor={dirColor}>
      {empty ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.dim }}>
          NO CONTEXT YET
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 22, fontWeight: 700, letterSpacing: "2px", color: dirColor, lineHeight: 1 }}>
              {dir}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>
              {ctx?.bias_strength ?? "—"}
            </span>
          </div>
          {wb?.rationale && (
            <div style={{
              fontFamily: FONT_MONO, fontSize: 9, color: C.muted, letterSpacing: "0.5px",
              lineHeight: 1.45, marginBottom: 8,
              overflow: "hidden", textOverflow: "ellipsis",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            }}>
              {wb.rationale}
            </div>
          )}
          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
            {supplyBias && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>SUPPLY</span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 9, fontWeight: 700, letterSpacing: "1px",
                  color: supplyColor,
                  padding: "2px 6px", borderRadius: 3,
                  background: `${supplyColor}18`, border: `1px solid ${supplyColor}40`,
                }}>{supplyBias}</span>
              </div>
            )}
            {ctx?.last_updated && (
              <div style={{ fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "1px", color: C.dim }}>
                UPDATED {fmtTimeAgo(ctx.last_updated) || "—"}
              </div>
            )}
          </div>
        </>
      )}
    </Widget>
  );
}

interface OpenPosition {
  direction: "LONG" | "SHORT";
  entry_price: number;
  contracts: number;
  stop_loss?: number | null;
  target?: number | null;
  tp1_price?: number | null;
  opened_at?: string;
}

interface PositionTrackerWidgetProps {
  position: OpenPosition | null;
  clPrice: number | null;
}

function PositionTrackerWidget({ position, clPrice }: PositionTrackerWidgetProps) {
  if (!position) {
    return (
      <Widget title="POSITION">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 22, fontWeight: 700, letterSpacing: "3px", color: C.dim }}>
            FLAT
          </span>
        </div>
      </Widget>
    );
  }
  const dirColor = position.direction === "LONG" ? C.green : C.red;
  const isLong = position.direction === "LONG";
  const ticks = clPrice != null ? (isLong ? (clPrice - position.entry_price) : (position.entry_price - clPrice)) * 100 : null;
  const dollars = ticks != null ? ticks * 10 * (position.contracts ?? 1) : null;
  const riskTicks = position.stop_loss != null
    ? Math.abs((position.entry_price - position.stop_loss) / 0.01)
    : 0;
  const rMultiple = ticks != null && riskTicks > 0 ? ticks / riskTicks : null;
  const pnlColor = dollars == null ? C.dim : dollars > 0 ? C.green : dollars < 0 ? C.red : C.muted;
  return (
    <Widget title="POSITION" borderColor={dirColor}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, letterSpacing: "2px", color: dirColor, lineHeight: 1 }}>
          {position.direction}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.text }}>
          @ {position.entry_price.toFixed(2)}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.muted, letterSpacing: "1px", marginLeft: "auto" }}>
          {position.contracts}× CL
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: pnlColor, lineHeight: 1 }}>
          {dollars == null ? "—" : `${dollars >= 0 ? "+" : ""}$${dollars.toFixed(0)}`}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: pnlColor, letterSpacing: "1px" }}>
          {rMultiple == null ? "" : `${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R`}
        </span>
      </div>
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>STOP</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.red }}>
            {position.stop_loss != null ? position.stop_loss.toFixed(2) : "—"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>TP1</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.green }}>
            {position.tp1_price != null ? position.tp1_price.toFixed(2) : position.target != null ? position.target.toFixed(2) : "—"}
          </span>
        </div>
      </div>
    </Widget>
  );
}

interface JournalEntryRow {
  id: string;
  timestamp?: string;
  direction?: "LONG" | "SHORT" | "NO TRADE";
  grade?: string;
  score?: number;
  historical?: boolean;
  backtest_source?: boolean;
  outcome?: {
    status?: string;
    result?: number | null;          // ticks
    result_r?: number | null;        // R-multiple
    result_dollars?: number | null;
    close_timestamp?: string | null;
  };
}

interface RecentEvaluationsWidgetProps { entries: JournalEntryRow[] }

function RecentEvaluationsWidget({ entries }: RecentEvaluationsWidgetProps) {
  // Historical (backtest-imported) entries all carry grade='F' from the
  // backtest_engine.py stamp — surfacing them in "RECENT" buried any
  // real ALFRED-graded entry behind 146 synthetic Fs. Filter to live
  // only here.
  const liveOnly = entries.filter((e) => e.historical !== true);
  // Diagnostic — surfaces the actual grade field value of the first
  // entry on load so a "everything is F" symptom can be checked
  // against the underlying data without round-tripping the API.
  if (typeof window !== "undefined" && liveOnly[0]) {
    // eslint-disable-next-line no-console
    console.debug("[RecentEvaluations] first live entry grade=", liveOnly[0].grade, "score=", liveOnly[0].score);
  }
  const rows = liveOnly.slice(0, 5);
  return (
    <Widget title="RECENT EVALUATIONS">
      {rows.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.dim }}>
          NO ENTRIES
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {rows.map((d) => {
              const dir = d.direction ?? "—";
              const dirColor = dir === "LONG" ? C.green : dir === "SHORT" ? C.red : C.amber;
              const grade = d.grade ?? "—";
              const gradeColor =
                grade === "A+" ? C.green :
                grade === "A"  ? "#86efac" :
                grade === "B+" ? C.amber :
                grade === "B"  ? C.amber :
                grade === "F"  ? C.red :
                C.muted;
              const status = d.outcome?.status ?? "OPEN";
              const rMult = typeof d.outcome?.result_r === "number" ? d.outcome.result_r : null;
              // Right-hand badge: prefer R-multiple when the trade has
              // closed and we have a valid number; fall back to the status
              // text (OPEN / WIN / LOSS / SCRATCH).
              const isClosed = status === "WIN" || status === "LOSS" || status === "SCRATCH";
              const showR = isClosed && rMult !== null && Number.isFinite(rMult);
              const sLabel = showR
                ? `${rMult >= 0 ? "+" : ""}${rMult.toFixed(1)}r`
                : status.toUpperCase();
              const sColor = showR
                ? rMult > 0 ? C.green : rMult < 0 ? C.red : C.muted
                : status === "WIN" ? C.green
                : status === "LOSS" ? C.red
                : status === "OPEN" ? C.amber
                : status === "SCRATCH" ? C.muted
                : C.muted;
              return (
                <div key={d.id} style={{
                  display: "grid",
                  gridTemplateColumns: "70px 50px 30px 1fr",
                  gap: 8, alignItems: "center",
                  padding: "5px 8px",
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  borderRadius: 3,
                }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.muted }}>
                    {d.timestamp
                      ? new Date(d.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                      : "—"}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: dirColor }}>
                    {dir === "NO TRADE" ? "SKIP" : dir}
                  </span>
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: 9, fontWeight: 700, letterSpacing: "1px",
                    color: gradeColor,
                    padding: "1px 5px", borderRadius: 2,
                    background: `${gradeColor}18`, border: `1px solid ${gradeColor}40`,
                    textAlign: "center",
                  }}>
                    {grade}
                  </span>
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: 9, fontWeight: 700, letterSpacing: "1px",
                    color: sColor,
                    padding: "1px 5px", borderRadius: 2,
                    background: `${sColor}18`, border: `1px solid ${sColor}40`,
                    justifySelf: "end",
                  }}>
                    {sLabel}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: "auto", paddingTop: 6, display: "flex", justifyContent: "flex-end" }}>
            <Link href="/journal" style={{
              fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px",
              color: C.muted, textDecoration: "none",
            }}>
              VIEW ALL →
            </Link>
          </div>
        </>
      )}
    </Widget>
  );
}

// ── Row 5 widgets ──────────────────────────────────────────────────────────

interface ApexGateWidgetProps { entries: JournalEntryRow[] }

const APEX_DAILY_LOSS_LIMIT = 1500;
const APEX_MAX_DRAWDOWN = 2500;
const APEX_TARGET = 1500;

function ApexGateWidget({ entries }: ApexGateWidgetProps) {
  // Live-only — historical (backtest-imported) entries are excluded across
  // all three Apex metrics because the eval account only cares about real
  // capital risk. The 146 imported synthetic trades carry historical:true
  // and were inflating drawdown to ~$288k before this filter was in place.
  const liveEntries = entries.filter((e) => e.historical !== true);

  // Today's local-date P&L from live entries closed today.
  const todayLocal = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  let todayPnL = 0;
  let todayClosedCount = 0;
  let drawdown = 0;
  let lossStreak = 0;
  let counting = true;

  for (const e of liveEntries) {
    const status = e.outcome?.status;
    const dollars = typeof e.outcome?.result_dollars === "number" ? e.outcome.result_dollars : 0;
    const closeIso = e.outcome?.close_timestamp ?? null;
    const closeDayLocal = closeIso ? new Date(closeIso).toLocaleDateString("en-CA") : null;
    if (closeDayLocal === todayLocal && (status === "WIN" || status === "LOSS" || status === "SCRATCH")) {
      todayPnL += dollars;
      todayClosedCount++;
    }
    // Drawdown — count LOSS-status entries only (matches the spec; a
    // SCRATCH that booked a tiny negative no longer counts toward DD).
    if (status === "LOSS" && dollars < 0) {
      drawdown += Math.abs(dollars);
    }
    if (counting) {
      if (status === "LOSS") lossStreak++;
      else if (status === "WIN" || status === "SCRATCH") counting = false;
    }
  }

  const dailyLossUsed = Math.max(0, -todayPnL);
  const dailyLossPct = (dailyLossUsed / APEX_DAILY_LOSS_LIMIT) * 100;
  const drawdownPct = (drawdown / APEX_MAX_DRAWDOWN) * 100;
  const breached = dailyLossUsed >= APEX_DAILY_LOSS_LIMIT || drawdown >= APEX_MAX_DRAWDOWN;
  const warn = !breached && (dailyLossPct >= 80 || drawdownPct >= 80);
  const borderColor = breached ? C.red : warn ? C.amber : C.green;

  const rows: Array<{ label: string; value: string; color: string }> = [
    {
      label: "DAILY LOSS",
      value: `$${dailyLossUsed.toFixed(0)} / $${APEX_DAILY_LOSS_LIMIT}`,
      color: dailyLossUsed >= APEX_DAILY_LOSS_LIMIT ? C.red : dailyLossPct >= 80 ? C.amber : C.text,
    },
    {
      label: "DRAWDOWN",
      value: `$${drawdown.toFixed(0)} / $${APEX_MAX_DRAWDOWN}`,
      color: drawdown >= APEX_MAX_DRAWDOWN ? C.red : drawdownPct >= 80 ? C.amber : C.text,
    },
    {
      label: "TARGET",
      value: `$${APEX_TARGET}`,
      color: C.muted,
    },
    {
      label: "LOSS STREAK",
      value: lossStreak === 0 ? "0" : `${lossStreak}`,
      color: lossStreak >= 3 ? C.red : lossStreak >= 2 ? C.amber : C.text,
    },
  ];

  return (
    <Widget title="APEX GATE" borderColor={borderColor}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, letterSpacing: "2px",
          color: borderColor,
        }}>
          {breached ? "BREACHED" : warn ? "WARN" : "CLEAR"}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.muted, letterSpacing: "1px" }}>
          EVAL · {todayClosedCount} TRADES TODAY
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>
              {r.label}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: r.color, letterSpacing: "1px" }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </Widget>
  );
}

interface CalibrationSnapshotWidgetProps { snapshot: CalibrationSnapshot | null }

interface CalibrationSnapshotExtended extends CalibrationSnapshot {
  totals?: {
    trades_closed?: number;
    historical_closed?: number;
    win_rate?: number;
    avg_win_r?: number;
    avg_loss_r?: number;
    expectancy_r?: number;
  };
  by_grade?: Record<string, { trades?: number; win_rate?: number }>;
}

function CalibrationSnapshotWidget({ snapshot }: CalibrationSnapshotWidgetProps) {
  const snap = snapshot as CalibrationSnapshotExtended | null;
  const trades = snap?.totals?.trades_closed ?? 0;
  // overall.win_rate is stored 0–100
  const winRate = snap?.overall?.win_rate ?? 0;
  const avgWinR = snap?.totals?.avg_win_r;
  const avgLossR = snap?.totals?.avg_loss_r;
  const expR = snap?.totals?.expectancy_r;
  const minTrades = 5;

  // Best / worst grade cohort by win_rate (only buckets with >= 3 trades)
  let best: { label: string; rate: number } | null = null;
  let worst: { label: string; rate: number } | null = null;
  if (snap?.by_grade) {
    for (const [g, b] of Object.entries(snap.by_grade)) {
      const t = b.trades ?? 0;
      const r = (b.win_rate ?? 0) * 100;
      if (t < 3) continue;
      if (best === null || r > best.rate) best = { label: g, rate: r };
      if (worst === null || r < worst.rate) worst = { label: g, rate: r };
    }
  }

  const borderColor =
    trades < minTrades ? C.dim :
    winRate > 55 ? C.green :
    winRate >= 45 ? C.amber :
    C.red;

  if (trades < minTrades) {
    return (
      <Widget title="CALIBRATION" borderColor={borderColor}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "2px", color: C.dim }}>
            INSUFFICIENT DATA
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted, letterSpacing: "1px" }}>
            {trades} / 20 TRADES
          </span>
        </div>
      </Widget>
    );
  }

  const fmtR = (v: number | undefined): string =>
    typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}r` : "—";

  return (
    <Widget title="CALIBRATION" borderColor={borderColor}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 22, fontWeight: 700, color: borderColor, letterSpacing: "2px", lineHeight: 1 }}>
          {winRate.toFixed(0)}%
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.muted, letterSpacing: "1px" }}>
          {trades} TRADES
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>AVG WIN</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.green }}>{fmtR(avgWinR)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>AVG LOSS</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.red }}>{fmtR(avgLossR)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>EXPECTANCY</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: typeof expR === "number" && expR > 0 ? C.green : C.red }}>
            {fmtR(expR)}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px", color: C.muted }}>BEST · WORST</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.text }}>
            {best ? `${best.label} ${best.rate.toFixed(0)}%` : "—"}
            <span style={{ color: C.dim }}> · </span>
            {worst ? `${worst.label} ${worst.rate.toFixed(0)}%` : "—"}
          </span>
        </div>
      </div>
    </Widget>
  );
}

interface WeeklyBriefData {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
  rationale: string;
  invalidation: string | null;
  key_levels?: { resistance: number[]; support: number[] };
  macro_inputs: { dxy: number | null; vix: number | null; ovx: number | null; xle: number | null };
  generated_at: string;
}

interface WeeklyBriefLiveWidgetProps { brief: WeeklyBriefData | null }

function WeeklyBriefLiveWidget({ brief }: WeeklyBriefLiveWidgetProps) {
  if (!brief) {
    return (
      <Widget title="WEEKLY BRIEF">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: C.dim, textAlign: "center" }}>
            NO BRIEF YET<br />
            <span style={{ fontSize: 9, color: C.muted, letterSpacing: "1px" }}>RUNS SUNDAY 8PM ET</span>
          </span>
        </div>
      </Widget>
    );
  }
  const dirColor =
    brief.direction === "LONG"  ? C.green :
    brief.direction === "SHORT" ? C.red :
    C.amber;
  const macros: Array<[string, number | null, (n: number) => string]> = [
    ["DXY", brief.macro_inputs.dxy, (n) => n.toFixed(1)],
    ["VIX", brief.macro_inputs.vix, (n) => n.toFixed(1)],
    ["OVX", brief.macro_inputs.ovx, (n) => n.toFixed(1)],
    ["XLE", brief.macro_inputs.xle, (n) => n.toFixed(2)],
  ];
  return (
    <Widget title="WEEKLY BRIEF" borderColor={dirColor}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: dirColor, letterSpacing: "2px", lineHeight: 1 }}>
          {brief.direction}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.muted, letterSpacing: "2px" }}>
          {brief.strength}
        </span>
      </div>
      {brief.rationale && (
        <div style={{
          fontFamily: FONT_MONO, fontSize: 9, color: C.muted, letterSpacing: "0.5px",
          lineHeight: 1.45, marginBottom: 8,
          overflow: "hidden", textOverflow: "ellipsis",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          {brief.rationale}
        </div>
      )}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: "auto" }}>
        {macros.map(([label, value, fmt]) => (
          <span key={label} style={{
            fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "1px",
            padding: "2px 6px", borderRadius: 3,
            color: value == null ? C.dim : C.text,
            background: C.bg, border: `1px solid ${C.border}`,
          }}>
            <span style={{ color: C.muted, marginRight: 4 }}>{label}</span>
            {value == null ? "—" : fmt(value)}
          </span>
        ))}
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "1px", color: C.dim, marginTop: 6 }}>
        LAST RUN {fmtTimeAgo(brief.generated_at) || "—"}
      </div>
    </Widget>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<CalibrationSnapshot | null>(null);
  const [conditions, setConditions] = useState<ConditionsResponse | null>(null);
  const [pulse, setPulse] = useState<StreetPulse | null>(null);
  const [supply, setSupply] = useState<SupplyContext | null>(null);
  const [geo, setGeo] = useState<GeoFlag | null>(null);
  const [ovx, setOvx] = useState<number | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [marketCtx, setMarketCtx] = useState<MarketContextResponse | null>(null);
  const [position, setPosition] = useState<OpenPosition | null>(null);
  const [clPrice, setClPrice] = useState<number | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryRow[]>([]);
  const [weeklyBriefLive, setWeeklyBriefLive] = useState<WeeklyBriefData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apiKey = process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "";
    const headers = { "x-api-key": apiKey };

    const loadAll = async () => {
      try {
        const [
          calRes, condRes, pulseRes, supRes, geoRes, ovxRes, hRes,
          ctxRes, posRes, clRes, jRes, wbRes,
        ] = await Promise.all([
          fetch("/api/calibration", { headers, cache: "no-store" }),
          fetch("/api/conditions", { cache: "no-store" }),
          fetch("/api/street-pulse", { cache: "no-store" }),
          fetch("/api/supply-context", { headers, cache: "no-store" }),
          fetch("/api/geo-flag", { cache: "no-store" }),
          fetch("/api/ovx", { cache: "no-store" }),
          fetch("/api/health", { cache: "no-store" }),
          fetch("/api/market-context", { cache: "no-store" }),
          fetch("/api/position", { headers, cache: "no-store" }),
          fetch("/api/cl-price", { cache: "no-store" }),
          fetch("/api/journal", { headers, cache: "no-store" }),
          fetch("/api/cron/weekly-brief", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (calRes.ok) {
          const j = await calRes.json();
          setSnapshot(j?.snapshot ?? null);
        }
        if (condRes.ok) setConditions(await condRes.json() as ConditionsResponse);
        if (pulseRes.ok) setPulse(await pulseRes.json() as StreetPulse);
        if (supRes.ok) {
          const j = await supRes.json();
          setSupply(j?.supply_context ?? null);
        }
        if (geoRes.ok) setGeo(await geoRes.json() as GeoFlag);
        if (ovxRes.ok) {
          const j = await ovxRes.json() as OvxResponse;
          if (typeof j.price === "number") setOvx(j.price);
        }
        setApiOnline(hRes.ok);
        if (ctxRes.ok) setMarketCtx(await ctxRes.json() as MarketContextResponse);
        if (posRes.ok) {
          const j = await posRes.json() as { position?: OpenPosition | null };
          setPosition(j?.position ?? null);
        }
        if (clRes.ok) {
          const j = await clRes.json() as { price?: number };
          if (typeof j.price === "number") setClPrice(j.price);
        }
        if (jRes.ok) {
          const j = await jRes.json() as { decisions?: JournalEntryRow[] };
          // Most recent first — readJournal returns chronological order
          const list = (j?.decisions ?? []).slice().reverse();
          setJournalEntries(list);
        }
        if (wbRes.ok) {
          const j = await wbRes.json() as { weekly_bias?: WeeklyBriefData | null };
          setWeeklyBriefLive(j?.weekly_bias ?? null);
        }
      } catch {
        if (!cancelled) setApiOnline(false);
      }
    };

    void loadAll();
    const t = setInterval(() => void loadAll(), 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const decisions = ((logData as { decisions?: RecentSignal[] }).decisions ?? []) as RecentSignal[];

  const goNews = () => router.push("/news");

  return (
    <div style={{
      display: "grid",
      gridTemplateRows: "180px 280px 160px 200px 200px",
      gap: 12,
      height: "100%",
      minHeight: 0,
    }}>
      {/* ROW 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, minHeight: 0 }}>
        <WeeklyBiasWidget />
        <AlfredWidget snapshot={snapshot} apiOnline={apiOnline} />
        <OvxWidget ovx={ovx} />
        <Phase3Widget snapshot={snapshot} />
      </div>

      {/* ROW 2 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, minHeight: 0 }}>
        <ConditionsWidget conditions={conditions} />
        <RecentSignalsWidget signals={decisions} />
      </div>

      {/* ROW 3 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, minHeight: 0 }}>
        <SentimentWidget pulse={pulse} onClick={goNews} />
        <SupplyWidget supply={supply} />
        <GeoWidget geo={geo} onClick={goNews} />
      </div>

      {/* ROW 4 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, minHeight: 0 }}>
        <MarketMemoryWidget ctx={marketCtx} />
        <PositionTrackerWidget position={position} clPrice={clPrice} />
        <RecentEvaluationsWidget entries={journalEntries} />
      </div>

      {/* ROW 5 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, minHeight: 0 }}>
        <ApexGateWidget entries={journalEntries} />
        <CalibrationSnapshotWidget snapshot={snapshot} />
        <WeeklyBriefLiveWidget brief={weeklyBriefLive} />
      </div>
    </div>
  );
}
