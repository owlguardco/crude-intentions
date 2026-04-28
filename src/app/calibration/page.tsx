"use client";

import { useEffect, useState } from "react";
import {
  FACTOR_KEYS,
  type CalibrationSnapshot,
  type FactorKey,
} from "@/lib/journal/calibration";
import { generateCalibrationNotes } from "@/lib/journal/observer";

const COLORS = {
  bg: "#0a0a0f",
  panel: "#111115",
  border: "#2a2a2e",
  text: "#e8e6e3",
  muted: "#888",
  gold: "#d4a520",
  green: "#22c55e",
  red: "#ef4444",
};

const FONT_MONO = "JetBrains Mono, monospace";
const FONT_SANS = "Inter, sans-serif";

const FACTOR_LABELS: Record<FactorKey, string> = {
  ema_stack_aligned: "EMA Stack",
  rsi_reset_zone: "RSI Reset",
  price_at_key_level: "Key Level",
  session_timing: "Session",
  market_bias: "Mkt Bias",
  candle_confirmation: "Candle Conf",
  volume_profile: "Vol Profile",
  no_eia_window: "No EIA",
};

const TIER_ORDER = ["HIGH", "MEDIUM", "LOW"];

const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtSignedPp = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
const fmtR = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)} R`;

function Card({
  label,
  value,
  subtext,
  valueColor,
}: {
  label: string;
  value: string;
  subtext: string;
  valueColor?: string;
}) {
  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        padding: "18px 20px",
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 9,
          letterSpacing: "2px",
          color: COLORS.muted,
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 28,
          fontWeight: 700,
          color: valueColor ?? COLORS.text,
          marginBottom: 6,
        }}
      >
        {value}
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLORS.muted }}>
        {subtext}
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: "3px",
        color: COLORS.gold,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 9,
  letterSpacing: "2px",
  color: COLORS.muted,
  textAlign: "left",
  padding: "0 14px 10px 0",
  borderBottom: `1px solid ${COLORS.border}`,
};

const tdStyle: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 12,
  color: COLORS.text,
  padding: "11px 14px 11px 0",
  borderBottom: `1px solid ${COLORS.border}40`,
};

export default function CalibrationPage() {
  const [snapshot, setSnapshot] = useState<CalibrationSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const apiKey = process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "";
      const res = await fetch("/api/calibration", {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const json = await res.json();
      setSnapshot(json.snapshot ?? null);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  if (!loaded) return null;

  if (!snapshot) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "60vh",
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "2px",
            color: COLORS.muted,
          }}
        >
          NO CALIBRATION DATA — log and close trades to begin
        </div>
      </div>
    );
  }

  const factorsStrong = FACTOR_KEYS.filter(
    (k) => snapshot.by_factor[k]?.drift_flag === false
  ).length;
  const edgeColor =
    factorsStrong >= 6
      ? COLORS.green
      : factorsStrong >= 4
      ? COLORS.gold
      : COLORS.red;

  const r30 = snapshot.overall.rolling_30;
  const r30Display = r30.trades < 5 ? "—" : fmtPct(r30.win_rate);

  const notes = generateCalibrationNotes(snapshot);
  const tiersInverted = snapshot.confidence_tiers_inverted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Section A — Summary cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        <Card
          label="OVERALL WIN RATE"
          value={fmtPct(snapshot.overall.win_rate)}
          subtext={`${snapshot.totals.trades_closed} trades closed`}
        />
        <Card
          label="LAST 30 TRADES"
          value={r30Display}
          subtext={`${r30.trades} trades`}
        />
        <Card
          label="EDGE HEALTH"
          value={`${factorsStrong} / 8`}
          subtext="factors with strong edge"
          valueColor={edgeColor}
        />
      </div>

      {/* Section B — Confidence tiers */}
      <div
        style={{
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          padding: 20,
        }}
      >
        <SectionHeader>CONFIDENCE CALIBRATION</SectionHeader>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["TIER", "TRADES", "WIN RATE", "95% CI", "AVG R"].map((h) => (
                <th key={h} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIER_ORDER.map((tier) => {
              const bucket = snapshot.by_confidence[tier];
              if (!bucket || bucket.trades === 0) return null;
              const highlight = tiersInverted && tier === "HIGH";
              const rowBg = highlight ? `${COLORS.red}20` : "transparent";
              return (
                <tr key={tier} style={{ background: rowBg }}>
                  <td
                    style={{
                      ...tdStyle,
                      fontWeight: 700,
                      color:
                        tier === "HIGH"
                          ? COLORS.green
                          : tier === "MEDIUM"
                          ? COLORS.gold
                          : COLORS.muted,
                    }}
                  >
                    {tier}
                  </td>
                  <td style={tdStyle}>{bucket.trades}</td>
                  <td style={tdStyle}>{fmtPct(bucket.win_rate * 100)}</td>
                  <td style={tdStyle}>
                    [{fmtPct(bucket.wilson_ci.low)}, {fmtPct(bucket.wilson_ci.high)}]
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color:
                        bucket.avg_r >= 0 ? COLORS.green : COLORS.red,
                    }}
                  >
                    {fmtR(bucket.avg_r)}
                  </td>
                </tr>
              );
            })}
            {TIER_ORDER.every(
              (t) => !snapshot.by_confidence[t] || snapshot.by_confidence[t].trades === 0
            ) && (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    ...tdStyle,
                    color: COLORS.muted,
                    padding: "18px 0",
                  }}
                >
                  No tier data yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Section C — Factor edge breakdown */}
      <div
        style={{
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          padding: 20,
        }}
      >
        <SectionHeader>FACTOR EDGE BREAKDOWN</SectionHeader>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {[
                "FACTOR",
                "PASS TRADES",
                "PASS W%",
                "FAIL TRADES",
                "FAIL W%",
                "EDGE (PP)",
                "STATUS",
              ].map((h) => (
                <th key={h} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FACTOR_KEYS.map((key) => {
              const f = snapshot.by_factor[key];
              if (!f) return null;
              const strong = f.drift_flag === false;
              const statusColor = strong ? COLORS.green : COLORS.gold;
              const edgeColorRow =
                f.edge_pp >= 0 ? COLORS.green : COLORS.red;
              return (
                <tr key={key}>
                  <td style={{ ...tdStyle, color: COLORS.text }}>
                    {FACTOR_LABELS[key]}
                  </td>
                  <td style={tdStyle}>{f.pass_stats.trades}</td>
                  <td style={tdStyle}>
                    {fmtPct(f.pass_stats.win_rate * 100)}
                  </td>
                  <td style={tdStyle}>{f.fail_stats.trades}</td>
                  <td style={tdStyle}>
                    {fmtPct(f.fail_stats.win_rate * 100)}
                  </td>
                  <td style={{ ...tdStyle, color: edgeColorRow }}>
                    {fmtSignedPp(f.edge_pp)}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color: statusColor,
                      fontWeight: 700,
                      letterSpacing: "1px",
                    }}
                  >
                    {strong ? "STRONG" : "WEAK"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Section D — Observer notes */}
      <div
        style={{
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          padding: 20,
        }}
      >
        <SectionHeader>OBSERVER NOTES</SectionHeader>
        {notes.length === 0 ? (
          <div
            style={{
              fontFamily: FONT_SANS,
              fontSize: 12,
              color: COLORS.muted,
              fontStyle: "italic",
              padding: "6px 0",
            }}
          >
            No alerts — system operating within normal parameters
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {notes.map((note, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "8px 10px",
                  background: `${COLORS.gold}10`,
                  border: `1px solid ${COLORS.gold}30`,
                  borderRadius: 4,
                }}
              >
                <span
                  style={{
                    color: COLORS.gold,
                    fontFamily: FONT_MONO,
                    fontSize: 13,
                    flexShrink: 0,
                  }}
                >
                  ⚠
                </span>
                <span
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: 12,
                    color: COLORS.text,
                    lineHeight: 1.55,
                  }}
                >
                  {note}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
