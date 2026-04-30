"use client";

import { useState, useEffect } from "react";
import LogOutcomeModal, { type TradeEntry } from "@/components/journal/LogOutcomeModal";
import {
  FACTOR_KEYS,
  type CalibrationSnapshot,
  type FactorKey,
} from "@/lib/journal/calibration";

const FACTOR_LABELS: Record<FactorKey, string> = {
  ema_stack_aligned: "EMA Stack",
  daily_confirms: "Daily Confirms",
  rsi_reset_zone: "RSI Reset",
  volume_confirmed: "Volume",
  price_at_key_level: "FVG Entry",
  rr_valid: "R/R",
  session_timing: "Session",
  eia_window_clear: "EIA Clear",
  vwap_aligned: "VWAP",
  htf_structure_clear: "HTF Clear",
  overnight_range_position: "Overnight Rng",
  ovx_regime: "OVX Regime",
};

const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtSignedPp = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
const fmtR = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;

function RBadge({ r }: { r: number | null | undefined }) {
  if (r == null || !Number.isFinite(r)) return null;
  const color =
    r >= 2 ? "#22c55e"
    : r >= 1 ? "#d4a520"
    : r >= 0 ? "#666670"
    : "#ef4444";
  const sign = r >= 0 ? "+" : "";
  return (
    <span
      title={`R-multiple ${sign}${r.toFixed(2)}`}
      style={{
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "1px",
        padding: "2px 7px",
        borderRadius: 3,
        color,
        background: `${color}18`,
        border: `1px solid ${color}40`,
      }}
    >
      {sign}{r.toFixed(1)}R
    </span>
  );
}

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
    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "1px", padding: "2px 7px", borderRadius: 3, color: c, background: bg, border: `1px solid ${c}40` }}>
      {key}
    </span>
  );
}

function GradeBadge({ grade }: { grade: string }) {
  const colors: Record<string, string> = { "A+": "#22c55e", A: "#86efac", B: "#d4a520", F: "#ef4444" };
  const c = colors[grade] || "#666670";
  return (
    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 3, color: c, background: `${c}18`, border: `1px solid ${c}40` }}>
      {grade}
    </span>
  );
}

const FILTER_TABS = ["ALL", "LONG", "SHORT", "NO TRADE", "WIN", "LOSS", "OPEN"];

export default function JournalPage() {
  const [mode, setMode] = useState<"JOURNAL" | "CALIBRATION">("JOURNAL");
  const [filter, setFilter] = useState("ALL");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedPostmortem, setExpandedPostmortem] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [lastCount, setLastCount] = useState(0);
  const [live, setLive] = useState(false);
  const [openOutcomeModal, setOpenOutcomeModal] = useState<TradeEntry | null>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [backtestToast, setBacktestToast] = useState<string | null>(null);
  const [calSnapshot, setCalSnapshot] = useState<CalibrationSnapshot | null>(null);
  const [calNotes, setCalNotes] = useState<string[]>([]);
  const [calLoaded, setCalLoaded] = useState(false);
  const [postmortemRunning, setPostmortemRunning] = useState<string | null>(null);
  const [postmortemError, setPostmortemError] = useState<string | null>(null);

  // Import modal state
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<"RAW" | "GUIDED">("GUIDED");
  const [importRaw, setImportRaw] = useState("");
  const [importValidated, setImportValidated] = useState<{ ok: boolean; count: number; message: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importToast, setImportToast] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  type GuidedResult = "WIN" | "LOSS" | "SCRATCH";
  interface GuidedRow {
    date: string;
    direction: "LONG" | "SHORT";
    entry: string;
    stop: string;
    result: GuidedResult;
    result_r: string;
  }
  const blankGuidedRow = (): GuidedRow => ({
    date: new Date().toISOString().slice(0, 10),
    direction: "LONG",
    entry: "",
    stop: "",
    result: "WIN",
    result_r: "",
  });
  const [guidedRows, setGuidedRows] = useState<GuidedRow[]>([blankGuidedRow()]);
  const MAX_GUIDED_ROWS = 20;

  function setGuidedField<K extends keyof GuidedRow>(idx: number, key: K, val: GuidedRow[K]) {
    setGuidedRows((rows) => rows.map((r, i) => (i === idx ? { ...r, [key]: val } : r)));
    setImportValidated(null);
    setImportError(null);
  }

  function isRowComplete(r: GuidedRow): boolean {
    const e = parseFloat(r.entry);
    const s = parseFloat(r.stop);
    if (!Number.isFinite(e) || !Number.isFinite(s)) return false;
    if (e <= 0 || s <= 0) return false;
    if (!r.date) return false;
    if (r.direction === "LONG" && s >= e) return false;
    if (r.direction === "SHORT" && s <= e) return false;
    return true;
  }

  function buildGuidedTrades(): unknown[] {
    const placeholderChecklist = (() => {
      const binaryKeys = [
        "ema_stack_aligned", "daily_confirms", "rsi_reset_zone", "volume_confirmed",
        "price_at_key_level", "rr_valid", "session_timing", "eia_window_clear",
        "vwap_aligned", "htf_structure_clear",
      ] as const;
      const out: Record<string, { result: "FAIL" | "N/A"; detail: string }> = {};
      for (const k of binaryKeys) out[k] = { result: "FAIL", detail: "Imported via guided wizard - not evaluated" };
      // FVG structural entry — Layer 2 Point 2. Reframed in v1.9 to require
      // an unfilled 4H FVG; EMA20 + round level become quality boosters only.
      out.price_at_key_level = {
        result: "FAIL",
        detail: "FVG structural entry — unfilled 4H FVG, price inside or within 0.10 of edge (not evaluated in guided import)",
      };
      out.overnight_range_position = { result: "N/A", detail: "Not evaluated in guided import" };
      out.ovx_regime = { result: "N/A", detail: "Not evaluated in guided import" };
      return out;
    })();

    return guidedRows.filter(isRowComplete).map((r) => {
      const entry = parseFloat(r.entry);
      const stop = parseFloat(r.stop);
      const isLong = r.direction === "LONG";
      const riskTicks = Math.abs((entry - stop) / 0.01);
      const userR = parseFloat(r.result_r);
      const r_value = Number.isFinite(userR)
        ? userR
        : r.result === "WIN" ? 1
        : r.result === "LOSS" ? -1
        : 0;
      const ticks = r.result === "SCRATCH" ? 0 : Math.round(r_value * riskTicks * 10) / 10;
      const closePrice = isLong ? entry + ticks / 100 : entry - ticks / 100;
      const timestamp = new Date(`${r.date}T14:30:00.000Z`).toISOString();

      return {
        rules_version: "1.9",
        session: "NY_OPEN",
        direction: r.direction,
        score: 5,
        grade: "B",
        confidence_label: "MEDIUM",
        entry_price: entry,
        stop_loss: stop,
        take_profit_1: null,
        take_profit_2: null,
        contracts: 1,
        risk_dollars: null,
        checklist: placeholderChecklist,
        blocked_reasons: [],
        wait_for: null,
        reasoning: "Imported via guided wizard - historical trade backfill.",
        market_context_snapshot: {
          price: entry, ema20: entry, ema50: entry, ema200: entry,
          rsi: 50, ovx: 30, dxy: "neutral",
        },
        paper_trading: false,
        historical: true,
        alfred_fallback: false,
        postmortem: null,
        backtest_source: false,
        timestamp,
        outcome: {
          status: r.result,
          result: ticks,
          close_price: Math.round(closePrice * 100) / 100,
          close_timestamp: timestamp,
        },
      };
    });
  }

  function validateImport() {
    setImportError(null);
    if (importTab === "GUIDED") {
      const trades = buildGuidedTrades();
      const total = guidedRows.length;
      if (trades.length === 0) {
        setImportValidated({ ok: false, count: 0, message: "✗ No complete rows yet" });
        return;
      }
      if (trades.length > 50) {
        setImportValidated({ ok: false, count: trades.length, message: `✗ ${trades.length} rows (max 50 per import)` });
        return;
      }
      const skipped = total - trades.length;
      const suffix = skipped > 0 ? ` (${skipped} incomplete row${skipped === 1 ? "" : "s"} will be skipped)` : "";
      setImportValidated({ ok: true, count: trades.length, message: `✓ ${trades.length} valid trade${trades.length === 1 ? "" : "s"} ready to import${suffix}` });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(importRaw);
    } catch {
      setImportValidated({ ok: false, count: 0, message: "✗ Invalid JSON" });
      return;
    }
    if (!Array.isArray(parsed)) {
      setImportValidated({ ok: false, count: 0, message: "✗ Expected JSON array" });
      return;
    }
    if (parsed.length === 0) {
      setImportValidated({ ok: false, count: 0, message: "✗ Array is empty" });
      return;
    }
    if (parsed.length > 50) {
      setImportValidated({ ok: false, count: parsed.length, message: `✗ ${parsed.length} trades (max 50 per import)` });
      return;
    }
    setImportValidated({ ok: true, count: parsed.length, message: `✓ ${parsed.length} valid trades ready to import` });
  }

  async function runImport() {
    if (!importValidated?.ok || importing) return;
    let trades: unknown;
    if (importTab === "GUIDED") {
      trades = buildGuidedTrades();
    } else {
      try { trades = JSON.parse(importRaw); } catch { setImportError("Invalid JSON"); return; }
    }
    setImporting(true);
    setImportError(null);
    try {
      const res = await fetch("/api/journal/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "",
        },
        body: JSON.stringify({ trades }),
      });
      const json = await res.json();
      if (!res.ok) {
        setImportError(json?.error ?? "Import failed");
        return;
      }
      setImportToast(`✓ ${json.imported} imported, ${json.skipped} skipped`);
      setImportOpen(false);
      setImportRaw("");
      setGuidedRows([blankGuidedRow()]);
      setImportValidated(null);
      await loadJournal();
    } catch (err: any) {
      setImportError(err?.message ?? "Network error");
    } finally {
      setImporting(false);
      setTimeout(() => setImportToast(null), 4000);
    }
  }

  const loadJournal = async (silent = false) => {
    try {
      const res = await fetch('/api/journal');
      const json = await res.json();
      const d = json.decisions || [];
      if (silent && d.length > lastCount) setLastCount(d.length);
      setDecisions(d);
      setLive(true);
    } catch {}
  };

  useEffect(() => {
    loadJournal();
    const t = setInterval(() => loadJournal(true), 15000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCount]);

  const loadCalibration = async () => {
    try {
      const apiKey = process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "";
      const headers = { "x-api-key": apiKey };
      const [snapRes, obsRes] = await Promise.all([
        fetch("/api/calibration", { headers }),
        fetch("/api/journal/observer", { headers }),
      ]);
      if (snapRes.ok) {
        const snapJson = await snapRes.json();
        setCalSnapshot(snapJson.snapshot ?? null);
      } else {
        setCalSnapshot(null);
      }
      if (obsRes.ok) {
        const obsJson = await obsRes.json();
        setCalNotes(Array.isArray(obsJson.note) ? obsJson.note : []);
      } else {
        setCalNotes([]);
      }
    } catch {
      // hold last good values
    } finally {
      setCalLoaded(true);
    }
  };

  useEffect(() => {
    if (mode !== "CALIBRATION") return;
    loadCalibration();
    const t = setInterval(loadCalibration, 30000);
    return () => clearInterval(t);
  }, [mode]);

  const backtestableCount = decisions.filter(
    (d: any) => d.outcome?.status === 'OPEN' && d.tp1_price != null && d.stop_price != null,
  ).length;

  async function runBacktest() {
    if (backtesting || backtestableCount === 0) return;
    setBacktesting(true);
    try {
      const res = await fetch('/api/journal/backtest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? '',
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        setBacktestToast(`✗ ${json.error ?? 'Backtest failed'}`);
      } else {
        const wins = (json.results ?? []).filter((r: any) => r.outcome === 'WIN').length;
        const losses = (json.results ?? []).filter((r: any) => r.outcome === 'LOSS').length;
        setBacktestToast(`✓ ${json.resolved} resolved — ${wins} wins, ${losses} losses`);
      }
      await loadJournal();
    } catch (err: any) {
      setBacktestToast(`✗ ${err?.message ?? 'Network error'}`);
    } finally {
      setBacktesting(false);
      setTimeout(() => setBacktestToast(null), 4000);
    }
  }

  async function handleSaveOutcome(id: string, payload: object) {
    const res = await fetch(`/api/journal/${id}/outcome`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? '',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({} as { error?: string }));
      throw new Error(j?.error ?? `Save failed (HTTP ${res.status})`);
    }
    setOpenOutcomeModal(null);
    await loadJournal();
  }

  async function runPostmortem(id: string) {
    if (postmortemRunning) return;
    setPostmortemRunning(id);
    setPostmortemError(null);
    try {
      const res = await fetch(`/api/journal/${id}/postmortem`, {
        method: 'POST',
        headers: { 'x-api-key': process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? '' },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j?.error ?? `Post-mortem failed (HTTP ${res.status})`);
      }
      await loadJournal();
      setExpandedPostmortem(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setPostmortemError(`✗ ${msg}`);
      setTimeout(() => setPostmortemError(null), 4000);
    } finally {
      setPostmortemRunning(null);
    }
  }

  const total = decisions.length;
  const taken = decisions.filter((d: any) => d.direction !== "NO TRADE").length;
  const blocked = decisions.filter((d: any) => d.direction === "NO TRADE").length;
  const wins = decisions.filter((d: any) => d.outcome?.status === "WIN").length;
  const winRate = taken > 0 ? ((wins / taken) * 100).toFixed(0) + "%" : "—";
  const avgScore = total > 0
    ? (decisions.reduce((a: number, d: any) => a + (d.score ?? 0), 0) / total).toFixed(1)
    : "—";

  const filtered = decisions.filter((d: any) => {
    if (filter === "ALL") return true;
    if (filter === "WIN") return d.outcome?.status === "WIN";
    if (filter === "LOSS") return d.outcome?.status === "LOSS";
    if (filter === "OPEN") return d.outcome?.status === "OPEN";
    return d.direction === filter;
  }).slice().reverse();

  const modeBtn = (m: "JOURNAL" | "CALIBRATION") => ({
    padding: "6px 14px",
    background: mode === m ? "#d4a520" : "transparent",
    border: `1px solid ${mode === m ? "#d4a520" : "#2a2a2e"}`,
    borderRadius: 4,
    cursor: "pointer",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 10,
    letterSpacing: "2px",
    color: mode === m ? "#0d0d0f" : "#888",
    fontWeight: mode === m ? 700 : 400,
  } as const);

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => setMode("JOURNAL")} style={modeBtn("JOURNAL")}>JOURNAL</button>
        <button onClick={() => setMode("CALIBRATION")} style={modeBtn("CALIBRATION")}>CALIBRATION</button>
      </div>

      {mode === "CALIBRATION" ? (
        <CalibrationPanel snapshot={calSnapshot} notes={calNotes} loaded={calLoaded} />
      ) : (
        <JournalView
          decisions={decisions}
          filtered={filtered}
          filter={filter}
          setFilter={setFilter}
          live={live}
          total={total}
          taken={taken}
          blocked={blocked}
          winRate={winRate}
          avgScore={avgScore}
          expanded={expanded}
          setExpanded={setExpanded}
          expandedPostmortem={expandedPostmortem}
          setExpandedPostmortem={setExpandedPostmortem}
          setOpenOutcomeModal={setOpenOutcomeModal}
          backtesting={backtesting}
          backtestableCount={backtestableCount}
          runBacktest={runBacktest}
          openImport={() => setImportOpen(true)}
          runPostmortem={runPostmortem}
          postmortemRunning={postmortemRunning}
        />
      )}
    </div>

    {openOutcomeModal && (
      <LogOutcomeModal
        trade={openOutcomeModal}
        onClose={() => setOpenOutcomeModal(null)}
        onSave={handleSaveOutcome}
      />
    )}
    {backtestToast && (
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1000, padding: "10px 16px", background: "#1a1a1e", border: "1px solid #d4a520", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", letterSpacing: "1px", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
        {backtestToast}
      </div>
    )}
    {importToast && (
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1000, padding: "10px 16px", background: "#1a1a1e", border: "1px solid #22c55e", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", letterSpacing: "1px", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
        {importToast}
      </div>
    )}
    {postmortemError && (
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1000, padding: "10px 16px", background: "#1a1a1e", border: "1px solid #ef4444", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", letterSpacing: "1px", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
        {postmortemError}
      </div>
    )}
    {importOpen && (
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={(e) => { if (e.target === e.currentTarget) setImportOpen(false); }}
      >
        <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 24, width: 640, maxWidth: "calc(100vw - 32px)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "3px", color: "#d4a520" }}>BULK IMPORT</div>
            <button
              onClick={() => setImportOpen(false)}
              style={{ background: "transparent", border: "none", color: "#666670", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}
            >×</button>
          </div>

          {/* Tab toggle */}
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {(["GUIDED", "RAW"] as const).map((t) => {
              const active = importTab === t;
              return (
                <button
                  key={t}
                  onClick={() => { setImportTab(t); setImportValidated(null); setImportError(null); }}
                  style={{
                    padding: "5px 12px",
                    background: active ? "#d4a520" : "transparent",
                    border: `1px solid ${active ? "#d4a520" : "#2a2a2e"}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px",
                    color: active ? "#0d0d0f" : "#888",
                    fontWeight: active ? 700 : 400,
                  }}
                >{t === "GUIDED" ? "GUIDED IMPORT" : "RAW JSON"}</button>
              );
            })}
          </div>

          {importTab === "RAW" && (
            <textarea
              value={importRaw}
              onChange={(e) => { setImportRaw(e.target.value); setImportValidated(null); setImportError(null); }}
              placeholder="Paste JSON array of trade objects. Each object follows the journal entry schema. Minimum fields: direction, session, score, grade, source."
              style={{
                width: "100%", minHeight: 220, resize: "vertical",
                background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4,
                color: "#e0e0e0", fontFamily: "JetBrains Mono, monospace", fontSize: 11,
                padding: "10px 12px", outline: "none", boxSizing: "border-box",
                lineHeight: 1.5,
              }}
            />
          )}

          {importTab === "GUIDED" && (
            <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid #2a2a2e", borderRadius: 4, padding: 10, background: "#111115" }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "120px 90px 90px 90px 90px 70px 28px",
                gap: 6, marginBottom: 6,
              }}>
                {["DATE", "DIR", "ENTRY", "STOP", "RESULT", "R", ""].map((h) => (
                  <span key={h} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8, letterSpacing: "2px", color: "#666670" }}>{h}</span>
                ))}
              </div>
              {guidedRows.map((row, i) => {
                const complete = isRowComplete(row);
                const inputBase: React.CSSProperties = {
                  background: "#1a1a1e",
                  border: `1px solid ${complete ? "#2a2a2e" : "#3a2a2e"}`,
                  borderRadius: 3,
                  color: "#e0e0e0",
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  padding: "5px 7px",
                  outline: "none",
                  width: "100%", boxSizing: "border-box",
                };
                return (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "120px 90px 90px 90px 90px 70px 28px",
                      gap: 6, marginBottom: 6, alignItems: "center",
                    }}
                  >
                    <input
                      type="date"
                      value={row.date}
                      onChange={(e) => setGuidedField(i, "date", e.target.value)}
                      style={inputBase}
                    />
                    <select
                      value={row.direction}
                      onChange={(e) => setGuidedField(i, "direction", e.target.value as GuidedRow["direction"])}
                      style={{ ...inputBase, color: row.direction === "LONG" ? "#22c55e" : "#ef4444", fontWeight: 700 }}
                    >
                      <option value="LONG">LONG</option>
                      <option value="SHORT">SHORT</option>
                    </select>
                    <input
                      type="number" step="0.01"
                      placeholder="78.50"
                      value={row.entry}
                      onChange={(e) => setGuidedField(i, "entry", e.target.value)}
                      style={inputBase}
                    />
                    <input
                      type="number" step="0.01"
                      placeholder="78.00"
                      value={row.stop}
                      onChange={(e) => setGuidedField(i, "stop", e.target.value)}
                      style={inputBase}
                    />
                    <select
                      value={row.result}
                      onChange={(e) => setGuidedField(i, "result", e.target.value as GuidedResult)}
                      style={{
                        ...inputBase,
                        color: row.result === "WIN" ? "#22c55e" : row.result === "LOSS" ? "#ef4444" : "#d4a520",
                        fontWeight: 700,
                      }}
                    >
                      <option value="WIN">WIN</option>
                      <option value="LOSS">LOSS</option>
                      <option value="SCRATCH">SCR</option>
                    </select>
                    <input
                      type="number" step="0.1"
                      placeholder={row.result === "WIN" ? "1.0" : row.result === "LOSS" ? "-1.0" : "0"}
                      value={row.result_r}
                      onChange={(e) => setGuidedField(i, "result_r", e.target.value)}
                      style={inputBase}
                    />
                    <button
                      onClick={() => {
                        setGuidedRows((rows) => rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows);
                        setImportValidated(null);
                      }}
                      disabled={guidedRows.length <= 1}
                      title={guidedRows.length <= 1 ? "At least one row required" : "Remove row"}
                      style={{
                        background: "transparent", border: "1px solid #2a2a2e", borderRadius: 3,
                        cursor: guidedRows.length <= 1 ? "not-allowed" : "pointer",
                        color: "#666670", fontSize: 14, lineHeight: 1, padding: "3px 0",
                      }}
                    >×</button>
                  </div>
                );
              })}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <button
                  onClick={() => {
                    setGuidedRows((rows) => rows.length < MAX_GUIDED_ROWS ? [...rows, blankGuidedRow()] : rows);
                    setImportValidated(null);
                  }}
                  disabled={guidedRows.length >= MAX_GUIDED_ROWS}
                  style={{
                    padding: "5px 12px", background: "transparent",
                    border: `1px solid ${guidedRows.length >= MAX_GUIDED_ROWS ? "#2a2a2e" : "#d4a520"}`,
                    borderRadius: 3,
                    cursor: guidedRows.length >= MAX_GUIDED_ROWS ? "not-allowed" : "pointer",
                    fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px",
                    color: guidedRows.length >= MAX_GUIDED_ROWS ? "#444450" : "#d4a520",
                  }}
                >+ ADD ROW</button>
                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px", color: "#666670" }}>
                  {guidedRows.length} / {MAX_GUIDED_ROWS} rows
                </span>
              </div>
            </div>
          )}

          {importValidated && (
            <div style={{
              marginTop: 10, fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "1px",
              color: importValidated.ok ? "#d4a520" : "#ef4444",
            }}>
              {importValidated.message}
            </div>
          )}
          {importError && (
            <div style={{ marginTop: 10, fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "1px", color: "#ef4444" }}>
              ✗ {importError}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              onClick={validateImport}
              disabled={(importTab === "RAW" ? !importRaw.trim() : guidedRows.length === 0) || importing}
              style={{
                padding: "9px 16px", flex: 1,
                background: "transparent", border: "1px solid #2a2a2e", borderRadius: 4,
                cursor: ((importTab === "RAW" ? !importRaw.trim() : guidedRows.length === 0) || importing) ? "not-allowed" : "pointer",
                fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px",
                color: "#888", fontWeight: 700,
              }}
            >VALIDATE</button>
            <button
              onClick={runImport}
              disabled={!importValidated?.ok || importing}
              style={{
                padding: "9px 16px", flex: 1,
                background: !importValidated?.ok || importing ? "#2a2a2e" : "#d4a520",
                border: "none", borderRadius: 4,
                cursor: !importValidated?.ok || importing ? "not-allowed" : "pointer",
                fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px",
                color: !importValidated?.ok || importing ? "#666670" : "#0d0d0f",
                fontWeight: 700,
              }}
            >{importing ? "IMPORTING..." : "IMPORT"}</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

interface JournalViewProps {
  decisions: any[];
  filtered: any[];
  filter: string;
  setFilter: (f: string) => void;
  live: boolean;
  total: number;
  taken: number;
  blocked: number;
  winRate: string;
  avgScore: string;
  expanded: string | null;
  setExpanded: (v: string | null) => void;
  expandedPostmortem: string | null;
  setExpandedPostmortem: (v: string | null) => void;
  setOpenOutcomeModal: (t: TradeEntry | null) => void;
  backtesting: boolean;
  backtestableCount: number;
  runBacktest: () => void;
  openImport: () => void;
  runPostmortem: (id: string) => Promise<void>;
  postmortemRunning: string | null;
}

function JournalView({
  filtered, filter, setFilter, live, total, taken, blocked, winRate, avgScore,
  expanded, setExpanded, expandedPostmortem, setExpandedPostmortem,
  setOpenOutcomeModal, backtesting, backtestableCount, runBacktest, openImport,
  runPostmortem, postmortemRunning,
}: JournalViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        {[
          ["EVALUATIONS", total],
          ["TRADES TAKEN", taken],
          ["BLOCKED", blocked],
          ["WIN RATE", winRate],
          ["AVG SCORE", avgScore],
        ].map(([label, val]) => (
          <div key={label as string} style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: "14px 16px", textAlign: "center" }}>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8, letterSpacing: "2px", color: "#666670", marginBottom: 6 }}>{label}</div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 22, fontWeight: 700, color: "#e0e0e0" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {FILTER_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                style={{
                  padding: "5px 10px", borderRadius: 3, cursor: "pointer",
                  background: filter === tab ? "#d4a520" : "transparent",
                  border: `1px solid ${filter === tab ? "#d4a520" : "#2a2a2e"}`,
                  fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px",
                  color: filter === tab ? "#0d0d0f" : "#666670",
                  fontWeight: filter === tab ? 700 : 400,
                }}
              >{tab}</button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {live && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#22c55e", fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: 2 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
                LIVE
              </div>
            )}
            <button
              onClick={runBacktest}
              disabled={backtesting || backtestableCount === 0}
              title={backtestableCount === 0 ? 'No OPEN entries with TP1 set' : `Backtest ${backtestableCount} OPEN entries against Yahoo Finance`}
              style={{
                padding: "6px 14px", background: "transparent",
                border: `1px solid ${backtestableCount === 0 ? "#2a2a2e" : "#d4a520"}`,
                borderRadius: 4,
                cursor: backtesting || backtestableCount === 0 ? "not-allowed" : "pointer",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9, letterSpacing: "2px",
                color: backtestableCount === 0 ? "#444450" : "#d4a520",
                opacity: backtesting ? 0.6 : 1,
              }}
            >
              {backtesting ? "BACKTESTING..." : `BACKTEST OPEN${backtestableCount > 0 ? ` (${backtestableCount})` : ""}`}
            </button>
            <button
              onClick={openImport}
              style={{
                padding: "6px 14px", background: "transparent", border: "1px solid #d4a520",
                borderRadius: 4, cursor: "pointer", fontFamily: "JetBrains Mono, monospace",
                fontSize: 9, letterSpacing: "2px", color: "#d4a520",
              }}
            >IMPORT</button>
            <button style={{
              padding: "6px 14px", background: "transparent", border: "1px solid #2a2a2e",
              borderRadius: 4, cursor: "pointer", fontFamily: "JetBrains Mono, monospace",
              fontSize: 9, letterSpacing: "2px", color: "#666670",
            }}>EXPORT CSV</button>
          </div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["ID", "DATE", "SESSION", "DIRECTION", "GRADE", "ENTRY", "STOP", "TARGET", "SOURCE", "ADVERSARIAL", "OUTCOME"].map((h) => (
                <th key={h} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#666670", textAlign: "left", padding: "0 12px 10px 0", borderBottom: "1px solid #2a2a2e" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((d: any) => (
              <>
                <tr
                  key={d.id}
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                  style={{
                    cursor: "pointer",
                    background: d.outcome?.status === "WIN" ? "#22c55e08" : d.outcome?.status === "LOSS" ? "#ef444408" : "transparent",
                  }}
                >
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#444450", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.id}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                    {new Date(d.historical && d.outcome?.close_timestamp ? d.outcome.close_timestamp : d.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.session?.replace("_", " ")}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700, color: d.direction === "LONG" ? "#22c55e" : d.direction === "SHORT" ? "#ef4444" : "#d4a520", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.direction}</td>
                  <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}><GradeBadge grade={d.grade ?? "—"} /></td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.entry_price ? `$${d.entry_price}` : "—"}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.stop_loss ? `$${d.stop_loss}` : (d.outcome?.status === 'OPEN' && d.stop_price ? `$${d.stop_price}` : "—")}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.take_profit_1 ? `$${d.take_profit_1}` : (d.outcome?.status === 'OPEN' && d.tp1_price ? `$${d.tp1_price}` : "—")}</td>
                  <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: 1, color: d.source === "WEBHOOK" ? "#60a5fa" : "#555" }}>{d.source ?? "MANUAL"}</span>
                      {d.historical && (
                        <span title="Imported via guided wizard — excluded from calibration cohorts" style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px", padding: "2px 5px", borderRadius: 3, color: "#888", background: "#2a2a2e40", border: "1px solid #2a2a2e" }}>
                          HIST
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: d.adversarial_verdict === "PASS" ? "#22c55e" : d.adversarial_verdict === "CONDITIONAL_PASS" ? "#d4a520" : d.adversarial_verdict === "SKIP" ? "#ef4444" : "#555" }}>
                      {d.adversarial_verdict?.replace("_", " ") ?? "—"}
                    </span>
                  </td>
                  <td style={{ padding: "11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {d.outcome?.status === 'OPEN' ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); setOpenOutcomeModal(d as TradeEntry); }}
                          style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px", padding: "3px 8px", borderRadius: 3, cursor: "pointer", background: "transparent", border: "1px solid #d4a520", color: "#d4a520" }}
                        >LOG OUTCOME</button>
                      ) : (
                        <>
                          <OutcomeBadge status={d.outcome?.status} />
                          <RBadge r={d.outcome?.result_r} />
                          {d.backtest_source && (
                            <span title="Resolved via Yahoo Finance backtest" style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px", padding: "2px 5px", borderRadius: 3, color: "#888", background: "#2a2a2e40", border: "1px solid #2a2a2e" }}>
                              BT
                            </span>
                          )}
                        </>
                      )}
                      {d.postmortem && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setExpandedPostmortem(expandedPostmortem === d.id ? null : d.id); }}
                          title="Toggle post-mortem"
                          style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "1px", padding: "3px 6px", borderRadius: 3, cursor: "pointer", background: "transparent", border: "1px solid #2a2a2e", color: "#888" }}
                        >{expandedPostmortem === d.id ? "▾ PM" : "▸ PM"}</button>
                      )}
                    </div>
                  </td>
                </tr>

                {/* Post-mortem row */}
                {expandedPostmortem === d.id && d.postmortem && (
                  <tr key={`${d.id}-postmortem`}>
                    <td colSpan={11} style={{ padding: "0 0 12px 0", borderBottom: "1px solid #2a2a2e20" }}>
                      <div style={{ padding: "10px 14px", background: "#111115", borderLeft: "2px solid #d4a520", borderRadius: 3 }}>
                        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#d4a520", marginBottom: 6 }}>POST-MORTEM</div>
                        <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, fontStyle: "italic", color: "#888", lineHeight: 1.65 }}>
                          {d.postmortem}
                        </div>
                        {d.postmortem_at && (
                          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#444450", marginTop: 8, letterSpacing: "1px" }}>
                            {new Date(d.postmortem_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}

                {/* Expanded row */}
                {expanded === d.id && (
                  <tr key={`${d.id}-expanded`}>
                    <td colSpan={11} style={{ padding: "0 0 16px 0", borderBottom: "1px solid #2a2a2e" }}>
                      <div style={{ background: "#111115", borderRadius: 4, padding: 16, margin: "8px 0" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                          <div>
                            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#d4a520", marginBottom: 10 }}>A+ CHECKLIST</div>
                            {d.checklist && Object.entries(d.checklist).map(([key, val]: any) => (
                              <div key={key} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                                <div>
                                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#e0e0e0" }}>{key.replace(/_/g, " ").toUpperCase()}</div>
                                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#666670", marginTop: 2 }}>{val.detail}</div>
                                </div>
                                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: val.result === "PASS" ? "#22c55e" : "#ef4444", flexShrink: 0 }}>{val.result}</span>
                              </div>
                            ))}
                          </div>
                          <div>
                            {d.blocked_reasons?.length > 0 && (
                              <div style={{ marginBottom: 12 }}>
                                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#ef4444", marginBottom: 8 }}>BLOCKED BECAUSE:</div>
                                {d.blocked_reasons.map((r: string, i: number) => (
                                  <div key={i} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", marginBottom: 4 }}>· {r}</div>
                                ))}
                              </div>
                            )}
                            {d.adversarial_notes && (
                              <div style={{ marginBottom: 12 }}>
                                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#d4a520", marginBottom: 8 }}>ADVERSARIAL SCAN:</div>
                                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888" }}>{d.adversarial_notes}</div>
                              </div>
                            )}
                            {d.reasoning && (
                              <div>
                                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#d4a520", marginBottom: 8 }}>REASONING</div>
                                <div style={{ fontSize: 12, color: "#888", lineHeight: 1.65 }}>{d.reasoning}</div>
                              </div>
                            )}
                            {(() => {
                              const isClosed = d.outcome?.status === "WIN" || d.outcome?.status === "LOSS" || d.outcome?.status === "SCRATCH";
                              const running = postmortemRunning === d.id;
                              const hasPm = !!d.postmortem;
                              const disabled = !isClosed || running;
                              return (
                                <button
                                  onClick={() => { if (!disabled) void runPostmortem(d.id); }}
                                  disabled={disabled}
                                  title={!isClosed ? "Trade must be closed before post-mortem" : hasPm ? "Re-run post-mortem" : "Generate ALFRED post-mortem"}
                                  style={{
                                    marginTop: 14,
                                    padding: "7px 14px",
                                    background: "transparent",
                                    border: `1px solid ${disabled ? "#2a2a2e" : "#d4a520"}`,
                                    borderRadius: 4,
                                    cursor: disabled ? "not-allowed" : "pointer",
                                    fontFamily: "JetBrains Mono, monospace",
                                    fontSize: 9,
                                    letterSpacing: "2px",
                                    color: disabled ? "#666670" : "#d4a520",
                                  }}
                                >
                                  {running ? "RUNNING..." : hasPm ? "RE-RUN POST-MORTEM" : "RUN POST-MORTEM"}
                                </button>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={11} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#444450", padding: "24px 0" }}>NO ENTRIES YET — WAITING FOR SIGNALS</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface CalibrationPanelProps {
  snapshot: CalibrationSnapshot | null;
  notes: string[];
  loaded: boolean;
}

function CalibrationPanel({ snapshot, notes, loaded }: CalibrationPanelProps) {
  if (!loaded) {
    return (
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 32, textAlign: "center" }}>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px", color: "#444450" }}>
          LOADING CALIBRATION...
        </span>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 32, textAlign: "center" }}>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, letterSpacing: "2px", color: "#888" }}>
          NO CALIBRATION DATA — close trades to begin
        </span>
      </div>
    );
  }

  const factorsStrong = FACTOR_KEYS.filter(
    (k) => snapshot.by_factor[k]?.drift_flag === false,
  ).length;
  const edgeColor =
    factorsStrong >= 6 ? "#22c55e" : factorsStrong >= 4 ? "#d4a520" : "#ef4444";
  const r30 = snapshot.overall.rolling_30;
  const r30Display = r30.trades < 5 ? "—" : fmtPct(r30.win_rate);

  const historicalClosed = snapshot.totals.historical_closed ?? 0;
  const liveClosed = Math.max(0, snapshot.totals.trades_closed - historicalClosed);
  const dataSourceBanner = (() => {
    if (liveClosed >= 20) {
      return {
        kind: "LIVE" as const,
        message: `✓ LIVE DATA — calibration based on ${liveClosed} live trades · ${historicalClosed} historical excluded from cohorts`,
        bg: "#22c55e18",
        border: "#22c55e40",
        color: "#22c55e",
      };
    }
    if (historicalClosed >= 20) {
      return {
        kind: "BASELINE" as const,
        message: `⚡ BACKTEST BASELINE — ${historicalClosed} synthetic trades · ${liveClosed} live · calibration will switch to live data at 20 live trades`,
        bg: "#d4a52018",
        border: "#d4a52040",
        color: "#d4a520",
      };
    }
    return null;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {dataSourceBanner && (
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            letterSpacing: "2px",
            padding: "10px 16px",
            borderRadius: 4,
            marginBottom: 0,
            background: dataSourceBanner.bg,
            border: `1px solid ${dataSourceBanner.border}`,
            color: dataSourceBanner.color,
          }}
        >
          {dataSourceBanner.message}
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {[
          ["OVERALL WIN RATE", fmtPct(snapshot.overall.win_rate), `${snapshot.totals.trades_closed} trades closed`, "#e0e0e0"],
          ["LAST 30 TRADES", r30Display, `${r30.trades} trades`, "#e0e0e0"],
          ["EDGE HEALTH", `${factorsStrong} / 12`, "factors with strong edge", edgeColor],
        ].map(([label, value, sub, color]) => (
          <div key={label} style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: "18px 20px" }}>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#888", marginBottom: 10 }}>{label}</div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 28, fontWeight: 700, color, marginBottom: 6 }}>{value}</div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888" }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Lifetime vs Last 30 — full stats columns */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "3px", color: "#d4a520", marginBottom: 14 }}>
          LIFETIME vs LAST 30
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {(() => {
            const t = snapshot.totals;
            const r30sufficient = r30.trades >= 5;
            const cells = [
              ["LIFETIME", t.trades_closed, t.win_rate * 100, t.avg_win_r, t.avg_loss_r, t.expectancy_r, true],
              ["LAST 30", r30.trades, r30.win_rate, NaN, NaN, NaN, r30sufficient],
            ] as const;
            return cells.map(([label, n, wr, awR, alR, exp, ok]) => {
              if (!ok) {
                return (
                  <div key={label} style={{ background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4, padding: "14px 16px" }}>
                    <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px", color: "#d4a520", marginBottom: 12 }}>{label}</div>
                    <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#666670" }}>Insufficient data ({n}/5)</div>
                  </div>
                );
              }
              const rows: Array<[string, string]> = [
                ["TRADES", String(n)],
                ["WIN RATE", fmtPct(wr)],
              ];
              if (Number.isFinite(awR)) rows.push(["AVG R (WIN)", fmtR(awR)]);
              if (Number.isFinite(alR)) rows.push(["AVG R (LOSS)", fmtR(alR)]);
              if (Number.isFinite(exp)) rows.push(["EXPECTANCY", fmtR(exp)]);
              return (
                <div key={label} style={{ background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4, padding: "14px 16px" }}>
                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px", color: "#d4a520", marginBottom: 12 }}>{label}</div>
                  {rows.map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #2a2a2e30" }}>
                      <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", letterSpacing: "1px" }}>{k}</span>
                      <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0" }}>{v}</span>
                    </div>
                  ))}
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* By Confidence + By Session */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* By Confidence */}
        <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "3px", color: "#d4a520", marginBottom: 14 }}>
            BY CONFIDENCE
          </div>
          {snapshot.confidence_tiers_inverted && (
            <div style={{ marginBottom: 12, padding: "8px 12px", background: "#d4a52018", border: "1px solid #d4a52040", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#d4a520", letterSpacing: "1px" }}>
              ⚠ TIERS INVERTED — high confidence underperforming low
            </div>
          )}
          {(() => {
            const tiers = ["CONVICTION", "HIGH", "MEDIUM", "LOW"] as const;
            const rows = tiers
              .map((t) => ({ tier: t, b: snapshot.by_confidence?.[t] }))
              .filter((r) => r.b && r.b.trades > 0);
            if (rows.length === 0) {
              return <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#666670" }}>No data yet</div>;
            }
            return (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["TIER", "N", "WIN RATE"].map((h) => (
                      <th key={h} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#888", textAlign: "left", padding: "0 12px 8px 0", borderBottom: "1px solid #2a2a2e" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ tier, b }) => (
                    <tr key={tier}>
                      <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", padding: "9px 12px 9px 0", borderBottom: "1px solid #2a2a2e40" }}>{tier}</td>
                      <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", padding: "9px 12px 9px 0", borderBottom: "1px solid #2a2a2e40" }}>{b!.trades}</td>
                      <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", padding: "9px 12px 9px 0", borderBottom: "1px solid #2a2a2e40" }}>{fmtPct(b!.win_rate * 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </div>

        {/* By Session */}
        <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "3px", color: "#d4a520", marginBottom: 14 }}>
            BY SESSION
          </div>
          {(() => {
            const entries = Object.entries(snapshot.by_session ?? {}).filter(([, b]) => b && b.trades > 0);
            if (entries.length === 0) {
              return <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#666670" }}>No data yet</div>;
            }
            return (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["SESSION", "N", "WIN RATE"].map((h) => (
                      <th key={h} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#888", textAlign: "left", padding: "0 12px 8px 0", borderBottom: "1px solid #2a2a2e" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([s, b]) => (
                    <tr key={s}>
                      <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", padding: "9px 12px 9px 0", borderBottom: "1px solid #2a2a2e40" }}>{s.replace("_", " ")}</td>
                      <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", padding: "9px 12px 9px 0", borderBottom: "1px solid #2a2a2e40" }}>{b.trades}</td>
                      <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#e0e0e0", padding: "9px 12px 9px 0", borderBottom: "1px solid #2a2a2e40" }}>{fmtPct(b.win_rate * 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </div>
      </div>

      {/* Factor edge breakdown */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "3px", color: "#d4a520", marginBottom: 14 }}>
          FACTOR EDGE BREAKDOWN
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["FACTOR", "PASS W%", "FAIL W%", "EDGE (PP)", "STATUS"].map((h) => (
                <th key={h} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#888", textAlign: "left", padding: "0 14px 10px 0", borderBottom: "1px solid #2a2a2e" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FACTOR_KEYS.map((key) => {
              const f = snapshot.by_factor[key];
              if (!f) return null;
              const strong = f.drift_flag === false;
              const statusColor = strong ? "#22c55e" : "#d4a520";
              const edgeRowColor = f.edge_pp >= 0 ? "#22c55e" : "#ef4444";
              return (
                <tr key={key}>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 14px 11px 0", borderBottom: "1px solid #2a2a2e40" }}>{FACTOR_LABELS[key]}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 14px 11px 0", borderBottom: "1px solid #2a2a2e40" }}>{fmtPct(f.pass_stats.win_rate * 100)}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 14px 11px 0", borderBottom: "1px solid #2a2a2e40" }}>{fmtPct(f.fail_stats.win_rate * 100)}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: edgeRowColor, padding: "11px 14px 11px 0", borderBottom: "1px solid #2a2a2e40" }}>{fmtSignedPp(f.edge_pp)}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: statusColor, fontWeight: 700, letterSpacing: "1px", padding: "11px 14px 11px 0", borderBottom: "1px solid #2a2a2e40" }}>{strong ? "STRONG" : "WEAK"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Supply bias performance */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "3px", color: "#d4a520", marginBottom: 14 }}>
          SUPPLY BIAS PERFORMANCE
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {(["BEARISH", "NEUTRAL", "BULLISH"] as const).map((key) => {
            const headerColor = key === "BEARISH" ? "#ef4444" : key === "BULLISH" ? "#22c55e" : "#888";
            const bucket = snapshot.by_supply_bias?.[key];
            const enoughSamples = !!bucket && bucket.trades >= 5 && bucket.wilson_ci !== null;
            const winRateDisplay = enoughSamples ? `${(bucket!.win_rate * 100).toFixed(1)}%` : "—";
            const ci = enoughSamples && bucket!.wilson_ci
              ? `[${bucket!.wilson_ci.low.toFixed(1)}%, ${bucket!.wilson_ci.high.toFixed(1)}%]`
              : null;
            const trades = bucket?.trades ?? 0;
            return (
              <div key={key} style={{ background: "#111115", border: "1px solid #2a2a2e", borderRadius: 4, padding: "14px 16px", borderTop: `3px solid ${headerColor}` }}>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px", color: headerColor, fontWeight: 700, marginBottom: 10 }}>
                  {key}
                </div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 22, fontWeight: 700, color: enoughSamples ? "#e0e0e0" : "#666670", marginBottom: 6 }}>
                  {winRateDisplay}
                </div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", marginBottom: ci ? 6 : 0 }}>
                  {trades} trade{trades === 1 ? "" : "s"}
                  {!enoughSamples && trades > 0 && trades < 5 && (
                    <span style={{ color: "#666670" }}> · need {5 - trades} more</span>
                  )}
                </div>
                {ci && (
                  <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: "#666670", letterSpacing: "1px" }}>
                    95% CI {ci}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Observer notes */}
      <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: 20 }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "3px", color: "#d4a520", marginBottom: 14 }}>
          OBSERVER NOTES
        </div>
        {notes.length === 0 ? (
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: "#888", fontStyle: "italic" }}>
            No alerts — system operating within normal parameters
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {notes.map((note, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", background: "#d4a52010", border: "1px solid #d4a52030", borderRadius: 4 }}>
                <span style={{ color: "#d4a520", fontFamily: "JetBrains Mono, monospace", fontSize: 13, flexShrink: 0 }}>⚠</span>
                <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: "#e0e0e0", lineHeight: 1.55 }}>{note}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}