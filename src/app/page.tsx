"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;
    const apiKey = process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "";
    const headers = { "x-api-key": apiKey };

    const loadAll = async () => {
      try {
        const [calRes, condRes, pulseRes, supRes, geoRes, ovxRes, hRes] = await Promise.all([
          fetch("/api/calibration", { headers, cache: "no-store" }),
          fetch("/api/conditions", { cache: "no-store" }),
          fetch("/api/street-pulse", { cache: "no-store" }),
          fetch("/api/supply-context", { headers, cache: "no-store" }),
          fetch("/api/geo-flag", { cache: "no-store" }),
          fetch("/api/ovx", { cache: "no-store" }),
          fetch("/api/health", { cache: "no-store" }),
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
      gridTemplateRows: "180px 280px 160px",
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
    </div>
  );
}
