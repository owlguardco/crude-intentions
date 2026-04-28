"use client";

import { useState } from "react";

type MTFTimeframe = "1H" | "4H" | "D";
type MTFTrend = "UP" | "DOWN" | "NEUTRAL";
type MTFVwap = "ABOVE" | "BELOW" | "UNKNOWN";

interface MTFConsensusOut {
  score: number;
  label: "ALIGNED" | "MIXED" | "CONFLICTED";
  aligned_count: number;
  total_tfs: number;
  dominant_trend: MTFTrend;
  breakdown: Record<MTFTimeframe, { agrees: boolean; weight: number }>;
}

interface AnalysisResult {
  score: number;
  grade: string;
  decision: "LONG" | "SHORT" | "NO TRADE";
  checklist: Array<{ label: string; result: "PASS" | "FAIL"; detail: string }>;
  blocked_reasons: string[];
  wait_for: string | null;
  reasoning: string;
  disclaimer: string;
  fallback?: boolean;
  mtf_consensus?: MTFConsensusOut;
}

interface MTFRowState {
  trend: MTFTrend;
  ema_aligned: "YES" | "NO";
  rsi: string;
  vwap: MTFVwap;
}

const TF_LABELS: Record<MTFTimeframe, string> = {
  D: "DAILY",
  "4H": "4H",
  "1H": "1H",
};

const TF_ORDER: MTFTimeframe[] = ["D", "4H", "1H"];

function recordAlfredStatus(fallback: boolean) {
  if (typeof window === "undefined") return;
  const now = String(Date.now());
  if (fallback) localStorage.setItem("alfred:lastFallbackAt", now);
  else          localStorage.setItem("alfred:lastSuccessAt", now);
  // Notify the layout listener in this same tab (storage event only fires across tabs)
  window.dispatchEvent(new Event("alfred:status-changed"));
}

const inputStyle = {
  background: "#111115",
  border: "1px solid #2a2a2e",
  borderRadius: 4,
  color: "#e0e0e0",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 13,
  padding: "8px 12px",
  width: "100%",
};

const labelStyle = {
  display: "block",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 9,
  letterSpacing: "2px",
  color: "#666670",
  marginBottom: 5,
};

function GradeBadge({ grade }: { grade: string }) {
  const colors: Record<string, string> = { "A+": "#22c55e", A: "#86efac", B: "#d4a520", F: "#ef4444" };
  const c = colors[grade] || "#666670";
  return (
    <span style={{
      fontFamily: "JetBrains Mono, monospace", fontSize: 12, fontWeight: 700,
      padding: "3px 8px", borderRadius: 3, color: c, background: `${c}18`, border: `1px solid ${c}40`,
    }}>{grade}</span>
  );
}

export default function PreTradePage() {
  const [form, setForm] = useState({
    price: "", ema20: "", ema50: "", ema200: "",
    rsi: "", macd: "", ovx: "",
    dxy: "Declining", fvg: "Bullish",
    fvgTop: "", fvgBottom: "", fvgAge: "",
    session: "NY Open",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mtfOpen, setMtfOpen] = useState(false);
  const [mtfRows, setMtfRows] = useState<Record<MTFTimeframe, MTFRowState>>({
    D:    { trend: "NEUTRAL", ema_aligned: "NO", rsi: "", vwap: "UNKNOWN" },
    "4H": { trend: "NEUTRAL", ema_aligned: "NO", rsi: "", vwap: "UNKNOWN" },
    "1H": { trend: "NEUTRAL", ema_aligned: "NO", rsi: "", vwap: "UNKNOWN" },
  });

  function set(key: string, val: string) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  function setMtf(tf: MTFTimeframe, key: keyof MTFRowState, val: string) {
    setMtfRows((rows) => ({ ...rows, [tf]: { ...rows[tf], [key]: val } }));
  }

  function buildMtfSignals() {
    if (!mtfOpen) return null;
    const signals = TF_ORDER
      .map((tf) => {
        const r = mtfRows[tf];
        return {
          timeframe: tf,
          ema_aligned: r.ema_aligned === "YES",
          rsi_value: r.rsi === "" ? 50 : Math.max(0, Math.min(100, parseFloat(r.rsi) || 50)),
          above_vwap:
            r.vwap === "ABOVE" ? true : r.vwap === "BELOW" ? false : null,
          trend: r.trend,
        };
      });
    const hasNonNeutral = signals.some((s) => s.trend !== "NEUTRAL");
    return hasNonNeutral ? signals : null;
  }

  async function analyze() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const mtf_signals = buildMtfSignals();
      const body = mtf_signals ? { ...form, mtf_signals } : { ...form };
      const res = await fetch("/api/analyze-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setResult(data);
      recordAlfredStatus(Boolean(data.fallback));
    } catch (e: any) {
      setError(e.message || "Unknown error");
    }
    setLoading(false);
  }

  const decisionColor = result?.decision === "LONG" ? "#22c55e" : result?.decision === "SHORT" ? "#ef4444" : "#d4a520";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

      {/* ── INPUT ── */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 22 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#d4a520", marginBottom: 18 }}>SETUP INPUTS</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {[
            ["price", "PRICE"],
            ["ema20", "EMA 20"],
            ["ema50", "EMA 50"],
            ["ema200", "EMA 200"],
            ["rsi", "RSI 14 (0–100)"],
            ["macd", "MACD HIST"],
            ["ovx", "OVX"],
          ].map(([key, label]) => (
            <div key={key}>
              <label style={labelStyle}>{label}</label>
              <input
                style={inputStyle}
                type="number"
                value={form[key as keyof typeof form]}
                onChange={(e) => set(key, e.target.value)}
                placeholder="—"
              />
            </div>
          ))}

          <div>
            <label style={labelStyle}>DXY TREND</label>
            <select style={inputStyle as any} value={form.dxy} onChange={(e) => set("dxy", e.target.value)}>
              <option>Rising</option>
              <option>Declining</option>
              <option>Neutral</option>
            </select>
          </div>
        </div>

        <div style={{ borderTop: "1px solid #2a2a2e", paddingTop: 16 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670", marginBottom: 12 }}>FVG DATA</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>FVG DIRECTION</label>
              <select style={inputStyle as any} value={form.fvg} onChange={(e) => set("fvg", e.target.value)}>
                <option>Bullish</option>
                <option>Bearish</option>
                <option>None</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>FVG AGE (BARS)</label>
              <input style={inputStyle} type="number" value={form.fvgAge} onChange={(e) => set("fvgAge", e.target.value)} placeholder="—" />
            </div>
            <div>
              <label style={labelStyle}>FVG TOP</label>
              <input style={inputStyle} type="number" value={form.fvgTop} onChange={(e) => set("fvgTop", e.target.value)} placeholder="—" />
            </div>
            <div>
              <label style={labelStyle}>FVG BOTTOM</label>
              <input style={inputStyle} type="number" value={form.fvgBottom} onChange={(e) => set("fvgBottom", e.target.value)} placeholder="—" />
            </div>
            <div>
              <label style={labelStyle}>SESSION</label>
              <select style={inputStyle as any} value={form.session} onChange={(e) => set("session", e.target.value)}>
                <option>NY Open</option>
                <option>London</option>
                <option>Asia</option>
                <option>Off-hours</option>
              </select>
            </div>
          </div>
        </div>

        {/* ── MULTI-TF SIGNALS (OPTIONAL) ── */}
        <div style={{ borderTop: "1px solid #2a2a2e", marginTop: 16, paddingTop: 14 }}>
          <button
            type="button"
            onClick={() => setMtfOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              background: "transparent", border: "none", cursor: "pointer",
              padding: 0, marginBottom: mtfOpen ? 12 : 0,
              fontFamily: "JetBrains Mono, monospace", fontSize: 9,
              letterSpacing: "3px", color: "#666670",
            }}
          >
            <span>{mtfOpen ? "▾" : "▸"}</span>
            MULTI-TF SIGNALS (OPTIONAL)
          </button>

          {mtfOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {TF_ORDER.map((tf) => {
                const row = mtfRows[tf];
                return (
                  <div
                    key={tf}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "60px 1fr 1fr 1fr 1fr",
                      gap: 8,
                      alignItems: "center",
                      padding: "8px 10px",
                      background: "#111115",
                      border: "1px solid #2a2a2e",
                      borderRadius: 4,
                    }}
                  >
                    <span style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 11,
                      letterSpacing: "2px", color: "#d4a520", fontWeight: 700,
                    }}>{TF_LABELS[tf]}</span>

                    <select
                      style={inputStyle as any}
                      value={row.trend}
                      onChange={(e) => setMtf(tf, "trend", e.target.value)}
                    >
                      <option value="NEUTRAL">NEUTRAL</option>
                      <option value="UP">UP</option>
                      <option value="DOWN">DOWN</option>
                    </select>

                    <select
                      style={inputStyle as any}
                      value={row.ema_aligned}
                      onChange={(e) => setMtf(tf, "ema_aligned", e.target.value)}
                    >
                      <option value="NO">EMA: NO</option>
                      <option value="YES">EMA: YES</option>
                    </select>

                    <input
                      style={inputStyle}
                      type="number"
                      min={0}
                      max={100}
                      value={row.rsi}
                      onChange={(e) => setMtf(tf, "rsi", e.target.value)}
                      placeholder="RSI"
                    />

                    <select
                      style={inputStyle as any}
                      value={row.vwap}
                      onChange={(e) => setMtf(tf, "vwap", e.target.value)}
                    >
                      <option value="UNKNOWN">VWAP: ?</option>
                      <option value="ABOVE">ABOVE</option>
                      <option value="BELOW">BELOW</option>
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={analyze}
          disabled={loading || !form.price}
          style={{
            marginTop: 20, width: "100%", padding: "11px 0",
            background: loading || !form.price ? "#666670" : "#d4a520",
            border: "none", borderRadius: 4, cursor: loading || !form.price ? "not-allowed" : "pointer",
            fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "2px",
            fontWeight: 700, color: "#0d0d0f",
          }}
        >
          {loading ? "ANALYZING..." : "ANALYZE SETUP →"}
        </button>
      </div>

      {/* ── OUTPUT ── */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 22 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#d4a520", marginBottom: 18 }}>ANALYSIS OUTPUT</div>

        {!result && !error && !loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 320, fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "3px", color: "#444450" }}>
            AWAITING INPUT
          </div>
        )}

        {loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 320, fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "3px", color: "#d4a520" }}>
            RUNNING ANALYSIS...
          </div>
        )}

        {error && (
          <div style={{ padding: 14, background: "#ef444415", border: "1px solid #ef444430", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#ef4444" }}>
            {error}
          </div>
        )}

        {result && (
          <div>
            {/* Fallback banner — ALFRED API unreachable, deterministic scorer was used */}
            {result.fallback && (
              <div style={{
                marginBottom: 14,
                padding: "10px 12px",
                background: "rgba(212,165,32,0.10)",
                border: "1px solid rgba(212,165,32,0.45)",
                borderRadius: 4,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "#d4a520",
                lineHeight: 1.55,
              }}>
                <div style={{ fontWeight: 700, letterSpacing: "2px", marginBottom: 4, fontSize: 10 }}>
                  ⚠ FALLBACK MODE — ALFRED OFFLINE
                </div>
                <div style={{ color: "#888", fontSize: 10 }}>
                  Anthropic API unreachable. Score and decision below come from the deterministic
                  rules engine, not full ALFRED analysis. Treat as a sanity check.
                </div>
              </div>
            )}
            {/* MTF Consensus panel */}
            {result.mtf_consensus && (() => {
              const m = result.mtf_consensus;
              const labelColor =
                m.label === "ALIGNED" ? "#22c55e"
                : m.label === "MIXED" ? "#d4a520"
                : "#ef4444";
              return (
                <div style={{
                  marginBottom: 14, padding: 14,
                  background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 9,
                      letterSpacing: "3px", color: "#666670",
                    }}>MULTI-TF CONSENSUS</span>
                    <span style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 10,
                      letterSpacing: "2px", padding: "2px 7px", borderRadius: 3,
                      color: labelColor, background: `${labelColor}18`,
                      border: `1px solid ${labelColor}40`, fontWeight: 700,
                    }}>{m.label}</span>
                  </div>

                  {/* Score bar */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <div style={{
                      flex: 1, height: 8, background: "#2a2a2e",
                      borderRadius: 4, overflow: "hidden",
                    }}>
                      <div style={{
                        width: `${m.score}%`, height: "100%",
                        background: "#d4a520", transition: "width 0.3s ease",
                      }} />
                    </div>
                    <span style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 11,
                      color: "#e0e0e0", fontWeight: 700, minWidth: 64, textAlign: "right",
                    }}>{m.score} / 100</span>
                  </div>

                  {/* Breakdown pills */}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {(Object.keys(m.breakdown) as MTFTimeframe[])
                      .sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b))
                      .map((tf) => {
                        const b = m.breakdown[tf];
                        const c = b.agrees ? "#d4a520" : "#888";
                        return (
                          <span key={tf} style={{
                            fontFamily: "JetBrains Mono, monospace", fontSize: 10,
                            letterSpacing: "1px", padding: "3px 9px", borderRadius: 3,
                            color: c, border: `1px solid ${b.agrees ? c : "#2a2a2e"}`,
                            fontWeight: 700,
                          }}>{TF_LABELS[tf]}</span>
                        );
                      })}
                  </div>
                </div>
              );
            })()}

            {/* Decision header */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, paddingBottom: 16, borderBottom: "1px solid #2a2a2e" }}>
              <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 32, fontWeight: 700, letterSpacing: "3px", color: decisionColor }}>
                {result.decision}
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 15, color: "#e0e0e0" }}>{result.score}/8</span>
                <GradeBadge grade={result.grade} />
              </div>
            </div>

            {/* Checklist */}
            <div style={{ marginBottom: 14 }}>
              {result.checklist?.map((item, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0" }}>{item.label}</span>
                    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "1px", color: item.result === "PASS" ? "#22c55e" : "#ef4444", flexShrink: 0 }}>
                      {item.result}
                    </span>
                  </div>
                  {item.detail && (
                    <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#666670", marginTop: 2 }}>{item.detail}</div>
                  )}
                </div>
              ))}
            </div>

            {/* Blocked reasons */}
            {result.blocked_reasons?.length > 0 && (
              <div style={{ marginBottom: 12, padding: 12, background: "#ef444410", border: "1px solid #ef444430", borderRadius: 4 }}>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#ef4444", marginBottom: 8 }}>BLOCKED BECAUSE:</div>
                {result.blocked_reasons.map((r, i) => (
                  <div key={i} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#888", marginBottom: 4 }}>· {r}</div>
                ))}
              </div>
            )}

            {/* Wait for */}
            {result.wait_for && (
              <div style={{ marginBottom: 12, padding: 10, background: "#d4a52010", border: "1px solid #d4a52030", borderRadius: 4 }}>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#d4a520", marginBottom: 6 }}>WAIT FOR:</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#888" }}>{result.wait_for}</div>
              </div>
            )}

            {/* Reasoning */}
            {result.reasoning && (
              <div style={{ fontSize: 12, color: "#888", lineHeight: 1.65, marginBottom: 12, paddingTop: 12, borderTop: "1px solid #2a2a2e" }}>
                {result.reasoning}
              </div>
            )}

            {/* Disclaimer */}
            <div style={{ padding: "8px 12px", background: "#111115", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#444450", lineHeight: 1.6, marginBottom: 12 }}>
              {result.disclaimer}
            </div>

            <button style={{
              padding: "9px 18px", background: "transparent",
              border: "1px solid #2a2a2e", borderRadius: 4, cursor: "pointer",
              fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px", color: "#666670",
            }}>
              LOG THIS SETUP
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
