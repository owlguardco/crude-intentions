"use client";

import { useState, useEffect } from "react";

function getEIA() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilWed);
  next.setHours(10, 30, 0, 0);
  const diff = next.getTime() - now.getTime();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return {
    days, hours, mins,
    isActive: diff < 10800000 && diff > 0,
    isNear: diff < 86400000,
  };
}

export default function EIAPage() {
  const [eia, setEia] = useState(getEIA());
  const [form, setForm] = useState({ actual: "", expected: "", cushing: "", gasoline: "", distillates: "", refinery: "" });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setEia(getEIA()), 10000);
    return () => clearInterval(interval);
  }, []);

  const countdownColor = eia.isActive ? "#ef4444" : eia.isNear ? "#d4a520" : "#e0e0e0";
  const countdownStr = eia.isActive ? "ACTIVE NOW" : eia.days > 0
    ? `${eia.days}d ${eia.hours}h ${eia.mins}m`
    : `${eia.hours}h ${eia.mins}m`;

  async function analyze() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/eia-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }

  return (
    <div style={{ maxWidth: 800, display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Countdown */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 28, textAlign: "center" }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#666670", marginBottom: 14 }}>NEXT EIA REPORT</div>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 52, fontWeight: 700, letterSpacing: "4px", color: countdownColor, marginBottom: 8 }}>
          {countdownStr}
        </div>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#666670" }}>
          WEDNESDAY · 10:30 AM ET · CRUDE OIL INVENTORIES (EIA)
        </div>
        {eia.isActive && (
          <div style={{ marginTop: 16, padding: "10px 20px", background: "#ef444415", border: "1px solid #ef444430", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#ef4444" }}>
            ⚠ EIA WINDOW ACTIVE — AVOID NEW CL ENTRIES UNTIL 13:30 ET
          </div>
        )}
        {eia.isNear && !eia.isActive && (
          <div style={{ marginTop: 16, padding: "10px 20px", background: "#d4a52015", border: "1px solid #d4a52030", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#d4a520" }}>
            EIA REPORT WITHIN 24 HOURS — REDUCE POSITION SIZE
          </div>
        )}
      </div>

      {/* Analysis Form */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 22 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#d4a520", marginBottom: 18 }}>POST-EIA ANALYSIS</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {[
            ["actual", "ACTUAL (MB)"],
            ["expected", "EXPECTED (MB)"],
            ["cushing", "CUSHING (MB)"],
            ["gasoline", "GASOLINE (MB)"],
            ["distillates", "DISTILLATES (MB)"],
            ["refinery", "REFINERY UTIL %"],
          ].map(([key, label]) => (
            <div key={key}>
              <label style={{ display: "block", fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#666670", marginBottom: 5 }}>{label}</label>
              <input
                type="number"
                value={form[key as keyof typeof form]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                placeholder="—"
                style={{ background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4, color: "#e0e0e0", fontFamily: "JetBrains Mono, monospace", fontSize: 13, padding: "8px 12px", width: "100%" }}
              />
            </div>
          ))}
        </div>
        <button
          onClick={analyze}
          disabled={loading || !form.actual}
          style={{
            width: "100%", padding: "11px 0",
            background: loading || !form.actual ? "#666670" : "#d4a520",
            border: "none", borderRadius: 4, cursor: loading || !form.actual ? "not-allowed" : "pointer",
            fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "2px", fontWeight: 700, color: "#0d0d0f",
          }}
        >
          {loading ? "ANALYZING..." : "ANALYZE EIA REPORT →"}
        </button>
      </div>

      {/* Output */}
      {(result || error) && (
        <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 22 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "3px", color: "#d4a520", marginBottom: 16 }}>EIA ANALYSIS OUTPUT</div>
          {error && <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#ef4444" }}>{error}</div>}
          {result && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid #2a2a2e" }}>
                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 26, fontWeight: 700, color: result.bias === "LONG" ? "#22c55e" : result.bias === "SHORT" ? "#ef4444" : "#d4a520" }}>
                  {result.bias}
                </span>
                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#666670" }}>
                  {result.trade_action}
                </span>
              </div>
              {result.analysis && <div style={{ fontSize: 12, color: "#888", lineHeight: 1.65, marginBottom: 12 }}>{result.analysis}</div>}
              {result.confidence && (
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#d4a520", marginBottom: 12 }}>
                  CONFIDENCE: {result.confidence}
                </div>
              )}
              <div style={{ padding: "8px 12px", background: "#111115", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#444450", lineHeight: 1.6 }}>
                {result.disclaimer || "This is AI-generated analysis for research purposes only. You are responsible for all trading decisions."}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
