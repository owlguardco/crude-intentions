"use client";

import { useState } from "react";

const COLORS = {
  panel: "#1a1a1e",
  panel2: "#111115",
  border: "#2a2a2e",
  text: "#e0e0e0",
  muted: "#666670",
  gold: "#d4a520",
  green: "#22c55e",
  red: "#ef4444",
};

const FONT_MONO = "JetBrains Mono, monospace";

interface DetectedFVG {
  type: "BULLISH" | "BEARISH";
  top: number;
  bottom: number;
  formed_at: string;
  size_ticks: number;
}

interface ScanResponse {
  fvgs: DetectedFVG[];
  saved_count: number;
}

const PLACEHOLDER = `[
  {"high":62.50,"low":62.10,"close":62.30,"timestamp":"2026-04-28T10:00:00Z"},
  {"high":62.80,"low":62.40,"close":62.60,"timestamp":"2026-04-28T10:15:00Z"},
  {"high":63.20,"low":62.90,"close":63.10,"timestamp":"2026-04-28T10:30:00Z"}
]`;

const inputStyle: React.CSSProperties = {
  background: COLORS.panel2,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 4,
  color: COLORS.text,
  fontFamily: FONT_MONO,
  fontSize: 12,
  padding: "8px 12px",
};

function fmtFormed(iso: string): string {
  try {
    const d = new Date(iso);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const date = d.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
    return `${time} ${date}`;
  } catch {
    return iso;
  }
}

export default function FVGScanWidget() {
  const [raw, setRaw] = useState("");
  const [minSize, setMinSize] = useState("5");
  const [autoSave, setAutoSave] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResponse | null>(null);

  async function scan() {
    setError(null);
    setResult(null);
    let candles: unknown;
    try {
      candles = JSON.parse(raw);
    } catch {
      setError("Candle input is not valid JSON");
      return;
    }
    if (!Array.isArray(candles) || candles.length < 3) {
      setError("Need at least 3 candles");
      return;
    }

    const apiKey = process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "";
    const minSizeNum = parseFloat(minSize);
    const body: Record<string, unknown> = { candles, auto_save: autoSave };
    if (!isNaN(minSizeNum) && minSizeNum > 0) body.min_size_ticks = minSizeNum;

    setScanning(true);
    try {
      const res = await fetch("/api/fvg-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Scan failed");
      setResult(json as ScanResponse);
    } catch (e: any) {
      setError(e.message || "Unknown error");
    }
    setScanning(false);
  }

  return (
    <div style={{
      background: COLORS.panel,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 6,
      padding: 22,
    }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "3px",
        color: COLORS.gold, marginBottom: 16,
      }}>FVG SCANNER</div>

      <div style={{ marginBottom: 12 }}>
        <label style={{
          display: "block", fontFamily: FONT_MONO, fontSize: 9,
          letterSpacing: "2px", color: COLORS.muted, marginBottom: 5,
        }}>CANDLES (JSON ARRAY)</label>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={PLACEHOLDER}
          style={{
            ...inputStyle,
            width: "100%",
            height: 120,
            fontSize: 11,
            resize: "vertical",
          }}
        />
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 12,
        alignItems: "end", marginBottom: 14,
      }}>
        <div>
          <label style={{
            display: "block", fontFamily: FONT_MONO, fontSize: 9,
            letterSpacing: "2px", color: COLORS.muted, marginBottom: 5,
          }}>MIN SIZE (TICKS)</label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={minSize}
            onChange={(e) => setMinSize(e.target.value)}
            style={{ ...inputStyle, width: "100%" }}
          />
        </div>

        <label style={{
          display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
          padding: "8px 10px", background: COLORS.panel2,
          border: `1px solid ${COLORS.border}`, borderRadius: 4,
        }}>
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => setAutoSave(e.target.checked)}
          />
          <span style={{
            fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "1px",
            color: autoSave ? COLORS.gold : COLORS.muted,
          }}>AUTO-SAVE TO MARKET MEMORY</span>
        </label>

        <button
          onClick={scan}
          disabled={scanning || !raw.trim()}
          style={{
            padding: "9px 18px",
            background: scanning || !raw.trim() ? COLORS.muted : COLORS.gold,
            border: "none", borderRadius: 4,
            cursor: scanning || !raw.trim() ? "not-allowed" : "pointer",
            fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px",
            fontWeight: 700, color: "#0d0d0f",
          }}
        >{scanning ? "SCANNING..." : "SCAN FOR FVGs"}</button>
      </div>

      {error && (
        <div style={{
          padding: "8px 12px",
          background: `${COLORS.red}15`,
          border: `1px solid ${COLORS.red}40`,
          borderRadius: 4,
          fontFamily: FONT_MONO, fontSize: 11, color: COLORS.red,
          marginBottom: 12,
        }}>{error}</div>
      )}

      {result && (
        <div>
          {result.fvgs.length === 0 ? (
            <div style={{
              fontFamily: FONT_MONO, fontSize: 11, color: COLORS.muted,
              padding: "10px 0",
            }}>No FVGs detected above minimum size</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["TYPE", "TOP", "BOTTOM", "SIZE", "FORMED"].map((h) => (
                    <th key={h} style={{
                      fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px",
                      color: COLORS.muted, textAlign: "left",
                      padding: "0 12px 8px 0",
                      borderBottom: `1px solid ${COLORS.border}`,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.fvgs.map((f, i) => (
                  <tr key={i}>
                    <td style={{
                      fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700,
                      color: f.type === "BULLISH" ? COLORS.green : COLORS.red,
                      padding: "10px 12px 10px 0",
                      borderBottom: `1px solid ${COLORS.border}40`,
                    }}>{f.type}</td>
                    <td style={{
                      fontFamily: FONT_MONO, fontSize: 12, color: COLORS.text,
                      padding: "10px 12px 10px 0",
                      borderBottom: `1px solid ${COLORS.border}40`,
                    }}>{f.top.toFixed(2)}</td>
                    <td style={{
                      fontFamily: FONT_MONO, fontSize: 12, color: COLORS.text,
                      padding: "10px 12px 10px 0",
                      borderBottom: `1px solid ${COLORS.border}40`,
                    }}>{f.bottom.toFixed(2)}</td>
                    <td style={{
                      fontFamily: FONT_MONO, fontSize: 11, color: COLORS.gold,
                      padding: "10px 12px 10px 0",
                      borderBottom: `1px solid ${COLORS.border}40`,
                    }}>{f.size_ticks.toFixed(1)} ticks</td>
                    <td style={{
                      fontFamily: FONT_MONO, fontSize: 10, color: COLORS.muted,
                      padding: "10px 0",
                      borderBottom: `1px solid ${COLORS.border}40`,
                    }}>{fmtFormed(f.formed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {result.saved_count > 0 && (
            <div style={{
              marginTop: 12, padding: "8px 12px",
              background: `${COLORS.green}15`,
              border: `1px solid ${COLORS.green}40`,
              borderRadius: 4,
              fontFamily: FONT_MONO, fontSize: 11, color: COLORS.green,
            }}>✓ {result.saved_count} FVG{result.saved_count === 1 ? "" : "s"} saved to market memory</div>
          )}
        </div>
      )}
    </div>
  );
}
