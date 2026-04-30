"use client";

import { useState, useEffect } from "react";

interface SupplyContextValue {
  cushing_vs_4wk: 'BUILDING' | 'DRAWING' | 'FLAT' | null;
  eia_4wk_trend: 'BUILDS' | 'DRAWS' | 'MIXED' | null;
  rig_count_trend: 'RISING' | 'FALLING' | 'FLAT' | null;
  supply_bias: 'BEARISH' | 'NEUTRAL' | 'BULLISH' | null;
}

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
  confidence_label?: "CONVICTION" | "HIGH" | "MEDIUM" | "LOW";
  checklist: Array<{ label: string; result: "PASS" | "FAIL"; detail: string }>;
  blocked_reasons: string[];
  wait_for: string | null;
  reasoning: string;
  disclaimer: string;
  fallback?: boolean;
  mtf_consensus?: MTFConsensusOut;
  predicted_accuracy?: unknown;
  stop_price?: number | null;
  tp1_price?: number | null;
  tp2_price?: number | null;
  entry_alignment?: {
    score: 0 | 1 | 2 | 3;
    label: "ALIGNED" | "MIXED" | "CONFLICTED";
    breakdown: string[];
  };
}

type EmaStackChoice = "BULLISH" | "BEARISH" | "MIXED";

interface ComputedLevels {
  stop_price: number | null;
  tp1_price: number | null;
  tp2_price: number | null;
}

function computeLevels(
  direction: "LONG" | "SHORT" | "NO TRADE",
  entry: number | null,
  stop: number | null,
): ComputedLevels {
  if (entry == null || stop == null || direction === "NO TRADE") {
    return { stop_price: null, tp1_price: null, tp2_price: null };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  if (direction === "LONG") {
    const risk = entry - stop;
    if (risk <= 0) return { stop_price: null, tp1_price: null, tp2_price: null };
    return {
      stop_price: round2(stop),
      tp1_price: round2(entry + 2 * risk),
      tp2_price: round2(entry + 4 * risk),
    };
  }
  const risk = stop - entry;
  if (risk <= 0) return { stop_price: null, tp1_price: null, tp2_price: null };
  return {
    stop_price: round2(stop),
    tp1_price: round2(entry - 2 * risk),
    tp2_price: round2(entry - 4 * risk),
  };
}

const SESSION_MAP: Record<string, string> = {
  "NY Open": "NY_OPEN",
  "NY Afternoon": "NY_AFTERNOON",
  "London": "LONDON",
  "Overlap": "OVERLAP",
  "Asia": "ASIA",
  "Off-hours": "OFF_HOURS",
};

type ChecklistResult = "PASS" | "FAIL" | "CONDITIONAL" | "N/A";

function mapChecklistToJournal(
  cl: Array<{ label: string; result: ChecklistResult; detail: string }>,
) {
  const get = (label: string) =>
    cl.find((c) => c.label === label) ?? { result: "FAIL" as ChecklistResult, detail: "Not evaluated" };
  // Items 1-10 use binary PASS/FAIL only; coerce anything else to FAIL.
  const bin = (r: ChecklistResult): "PASS" | "FAIL" => (r === "PASS" ? "PASS" : "FAIL");
  return {
    ema_stack_aligned:   { result: bin(get("EMA Stack Aligned").result),   detail: get("EMA Stack Aligned").detail   },
    daily_confirms:      { result: bin(get("Daily Confirms").result),      detail: get("Daily Confirms").detail      },
    rsi_reset_zone:      { result: bin(get("RSI Reset Zone").result),      detail: get("RSI Reset Zone").detail      },
    volume_confirmed:    { result: bin(get("Volume Confirmed").result),    detail: get("Volume Confirmed").detail    },
    price_at_key_level:  { result: bin(get("Price at Key Level").result),  detail: get("Price at Key Level").detail  },
    rr_valid:            { result: bin(get("R/R Valid").result),           detail: get("R/R Valid").detail           },
    session_timing:      { result: bin(get("Session Timing").result),      detail: get("Session Timing").detail      },
    eia_window_clear:    { result: bin(get("EIA Window Clear").result),    detail: get("EIA Window Clear").detail    },
    vwap_aligned:        { result: bin(get("VWAP Aligned").result),        detail: get("VWAP Aligned").detail        },
    htf_structure_clear: { result: bin(get("HTF Structure Clear").result), detail: get("HTF Structure Clear").detail },
    // Layer 6 (v1.9) — pass through 4-state.
    overnight_range_position: { result: get("Overnight Range Position").result, detail: get("Overnight Range Position").detail },
    ovx_regime:               { result: get("OVX Regime Clean").result,         detail: get("OVX Regime Clean").detail },
  };
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
    rsi: "", triggerVolume: "", avgVolume: "", ovx: "",
    asiaHigh: "", asiaLow: "",
    dxy: "Declining", fvg: "Bullish",
    fvgTop: "", fvgBottom: "", fvgAge: "",
    session: "NY Open",
    stopPrice: "",
    htf_ema_stack: "" as "" | EmaStackChoice,
    setup_ema_stack: "" as "" | EmaStackChoice,
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const [logged, setLogged] = useState(false);
  const [logToast, setLogToast] = useState<string | null>(null);
  const [supplyContext, setSupplyContext] = useState<SupplyContextValue | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // GET = cached read of market:context.supply_context (no EIA fetch).
        // The fresh fetch is POST /api/supply-context, fired from settings.
        const res = await fetch("/api/supply-context", {
          method: "GET",
          headers: { "x-api-key": process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "" },
        });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (json.supply_context) setSupplyContext(json.supply_context as SupplyContextValue);
      } catch {
        // silent
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
    setLogged(false);
    try {
      const mtf_signals = buildMtfSignals();
      const cleanForm: Record<string, unknown> = { ...form };
      if (!form.htf_ema_stack)   delete cleanForm.htf_ema_stack;
      if (!form.setup_ema_stack) delete cleanForm.setup_ema_stack;
      const body = mtf_signals ? { ...cleanForm, mtf_signals } : cleanForm;
      const res = await fetch("/api/analyze-setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "",
        },
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

  async function logSetup() {
    if (!result || logging || logged) return;
    if (result.decision === "NO TRADE") return;
    setLogging(true);
    try {
      const session = SESSION_MAP[form.session] ?? "NY_OPEN";
      const grade = result.grade as "A+" | "A" | "B+" | "B" | "F";
      const confidence_label = (result.confidence_label ?? "MEDIUM") as
        "CONVICTION" | "HIGH" | "MEDIUM" | "LOW";
      const entry_price = form.price ? parseFloat(form.price) : null;
      const stopRaw = form.stopPrice ? parseFloat(form.stopPrice) : null;
      const stopParsed = stopRaw != null && Number.isFinite(stopRaw) ? stopRaw : null;
      const computed = computeLevels(result.decision, entry_price, stopParsed);
      const score = Math.max(0, Math.min(12, Math.round(result.score)));
      const reasoning = (result.reasoning ?? "").trim().length >= 10
        ? result.reasoning
        : "Logged from pre-trade analysis.";

      const stop_price = computed.stop_price ?? result.stop_price ?? null;
      const tp1_price  = computed.tp1_price  ?? result.tp1_price  ?? null;
      const tp2_price  = computed.tp2_price  ?? result.tp2_price  ?? null;

      const payload = {
        rules_version: "1.9",
        session,
        direction: result.decision,
        source: "MANUAL" as const,
        score,
        grade,
        confidence_label,
        entry_price,
        stop_loss: stop_price,
        take_profit_1: tp1_price,
        take_profit_2: tp2_price,
        contracts: null,
        risk_dollars: null,
        checklist: mapChecklistToJournal(result.checklist ?? []),
        blocked_reasons: result.blocked_reasons ?? [],
        wait_for: result.wait_for ?? null,
        reasoning,
        market_context_snapshot: {
          price: parseFloat(form.price) || 0,
          ema20: parseFloat(form.ema20) || 0,
          ema50: parseFloat(form.ema50) || 0,
          ema200: parseFloat(form.ema200) || 0,
          rsi: parseFloat(form.rsi) || 0,
          ovx: parseFloat(form.ovx) || 0,
          dxy: form.dxy,
        },
        stop_price,
        tp1_price,
        tp2_price,
        supply_context: supplyContext,
      };

      const res = await fetch("/api/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data?.details?.fieldErrors
          ? Object.keys(data.details.fieldErrors).join(", ")
          : data?.error ?? "Log failed";
        setLogToast(`✗ ${detail}`);
      } else {
        setLogged(true);
        setLogToast(`✓ Logged ${data.id ?? "entry"}`);
      }
    } catch (e: any) {
      setLogToast(`✗ ${e?.message ?? "Network error"}`);
    } finally {
      setLogging(false);
      setTimeout(() => setLogToast(null), 4000);
    }
  }

  const decisionColor = result?.decision === "LONG" ? "#22c55e" : result?.decision === "SHORT" ? "#ef4444" : "#d4a520";
  const logDisabled =
    !result || logging || logged || result.decision === "NO TRADE";

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
            ["triggerVolume", "TRIGGER CANDLE VOL"],
            ["avgVolume", "AVG VOL (20-BAR)"],
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

          <div>
            <label style={labelStyle}>STOP PRICE</label>
            <input
              style={inputStyle}
              type="number"
              step="0.01"
              value={form.stopPrice}
              onChange={(e) => set("stopPrice", e.target.value)}
              placeholder="optional"
            />
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

        {/* ── SESSION CONTEXT ── */}
        <div style={{ borderTop: "1px solid #2a2a2e", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670", marginBottom: 12 }}>
            SESSION CONTEXT
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>ASIA SESSION HIGH</label>
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                value={form.asiaHigh}
                onChange={(e) => set("asiaHigh", e.target.value)}
                placeholder="—"
              />
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8, color: "#666670", marginTop: 4 }}>Overnight Asia high</div>
            </div>
            <div>
              <label style={labelStyle}>ASIA SESSION LOW</label>
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                value={form.asiaLow}
                onChange={(e) => set("asiaLow", e.target.value)}
                placeholder="—"
              />
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8, color: "#666670", marginTop: 4 }}>Overnight Asia low</div>
            </div>
          </div>
        </div>

        {/* ── ENTRY ALIGNMENT (OPTIONAL) ── */}
        <div style={{ borderTop: "1px solid #2a2a2e", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670", marginBottom: 12 }}>
            ENTRY ALIGNMENT (OPTIONAL)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>HTF EMA STACK (4H)</label>
              <select
                style={inputStyle as any}
                value={form.htf_ema_stack}
                onChange={(e) => set("htf_ema_stack", e.target.value)}
              >
                <option value="">—</option>
                <option value="BULLISH">BULLISH</option>
                <option value="BEARISH">BEARISH</option>
                <option value="MIXED">MIXED</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>SETUP EMA STACK (15m)</label>
              <select
                style={inputStyle as any}
                value={form.setup_ema_stack}
                onChange={(e) => set("setup_ema_stack", e.target.value)}
              >
                <option value="">—</option>
                <option value="BULLISH">BULLISH</option>
                <option value="BEARISH">BEARISH</option>
                <option value="MIXED">MIXED</option>
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
            {/* Entry Alignment panel */}
            {result.entry_alignment && (() => {
              const ea = result.entry_alignment;
              const c = ea.label === "ALIGNED" ? "#22c55e"
                : ea.label === "MIXED" ? "#d4a520"
                : "#ef4444";
              return (
                <div style={{
                  marginBottom: 14, padding: 14,
                  background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4,
                  borderLeft: `3px solid ${c}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 9,
                      letterSpacing: "3px", color: "#666670",
                    }}>ENTRY ALIGNMENT</span>
                    <span style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 10,
                      letterSpacing: "2px", padding: "2px 7px", borderRadius: 3,
                      color: c, background: `${c}18`,
                      border: `1px solid ${c}40`, fontWeight: 700,
                    }}>{ea.label}</span>
                    <span style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 11,
                      color: "#e0e0e0", fontWeight: 700, marginLeft: "auto",
                    }}>{ea.score} / 3</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {ea.breakdown.map((line, i) => (
                      <div key={i} style={{
                        fontFamily: "JetBrains Mono, monospace", fontSize: 10,
                        color: "#888", lineHeight: 1.55,
                      }}>· {line}</div>
                    ))}
                  </div>
                </div>
              );
            })()}

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

            {/* Computed levels — shown when stop is provided and decision is directional */}
            {(() => {
              if (result.decision === "NO TRADE") return null;
              const entry = form.price ? parseFloat(form.price) : null;
              const stop = form.stopPrice ? parseFloat(form.stopPrice) : null;
              const stopValid = stop != null && Number.isFinite(stop);
              if (!stopValid) return null;
              const lvl = computeLevels(result.decision, entry, stop);
              if (lvl.tp1_price == null || lvl.tp2_price == null) {
                return (
                  <div style={{ marginBottom: 12, padding: "10px 12px", background: "#111115", border: "1px solid #ef444430", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#ef4444", letterSpacing: "1px" }}>
                    ⚠ STOP IS ON THE WRONG SIDE OF ENTRY — TP LEVELS UNAVAILABLE
                  </div>
                );
              }
              return (
                <div style={{ marginBottom: 12, padding: 12, background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4 }}>
                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#d4a520", marginBottom: 10 }}>
                    COMPUTED LEVELS
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                    {[
                      ["STOP", `$${lvl.stop_price?.toFixed(2)}`, "#ef4444"],
                      ["TP1 (2R)", `$${lvl.tp1_price.toFixed(2)}`, "#22c55e"],
                      ["TP2 (4R)", `$${lvl.tp2_price.toFixed(2)}`, "#22c55e"],
                    ].map(([label, value, color]) => (
                      <div key={label}>
                        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8, letterSpacing: "2px", color: "#666670", marginBottom: 4 }}>{label}</div>
                        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 14, fontWeight: 700, color }}>{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <button
              onClick={logSetup}
              disabled={logDisabled}
              title={
                result.decision === "NO TRADE"
                  ? "Cannot log a NO TRADE setup"
                  : logged
                  ? "Already logged"
                  : "Write this setup to the journal"
              }
              style={{
                padding: "9px 18px",
                background: logged ? "#22c55e18" : "transparent",
                border: `1px solid ${logDisabled ? "#2a2a2e" : logged ? "#22c55e" : "#d4a520"}`,
                borderRadius: 4,
                cursor: logDisabled ? "not-allowed" : "pointer",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                letterSpacing: "2px",
                color: logDisabled ? "#444450" : logged ? "#22c55e" : "#d4a520",
                opacity: logging ? 0.6 : 1,
              }}
            >
              {logging ? "LOGGING..." : logged ? "✓ LOGGED" : "LOG THIS SETUP"}
            </button>
          </div>
        )}

        {/* SUPPLY CONTEXT card */}
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid #2a2a2e" }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#d4a520", marginBottom: 12 }}>
            SUPPLY CONTEXT
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {(() => {
              const sc = supplyContext;
              const biasColor = sc?.supply_bias === "BEARISH" ? "#ef4444"
                : sc?.supply_bias === "BULLISH" ? "#22c55e"
                : "#888";
              const cells: Array<[string, string, string]> = [
                ["CUSHING",     sc?.cushing_vs_4wk ?? "—",  "#e0e0e0"],
                ["EIA 4WK",     sc?.eia_4wk_trend ?? "—",   "#e0e0e0"],
                ["RIG COUNT",   sc?.rig_count_trend ?? "—", "#888"],
                ["SUPPLY BIAS", sc?.supply_bias ?? "—",     biasColor],
              ];
              return cells.map(([label, value, color]) => (
                <div key={label} style={{ background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4, padding: "10px 12px" }}>
                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8, letterSpacing: "2px", color: "#666670", marginBottom: 4 }}>{label}</div>
                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, fontWeight: 700, color }}>{value}</div>
                </div>
              ));
            })()}
          </div>
        </div>
      </div>

      {logToast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1000, padding: "10px 16px", background: "#1a1a1e", border: `1px solid ${logToast.startsWith("✓") ? "#22c55e" : "#ef4444"}`, borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", letterSpacing: "1px", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
          {logToast}
        </div>
      )}
    </div>
  );
}
