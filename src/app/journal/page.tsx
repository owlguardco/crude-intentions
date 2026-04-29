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
  rsi_reset_zone: "RSI Reset",
  price_at_key_level: "Key Level",
  session_timing: "Session",
  market_bias: "Mkt Bias",
  candle_confirmation: "Candle Conf",
  volume_profile: "Vol Profile",
  no_eia_window: "No EIA",
};

const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtSignedPp = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

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
      const res = await fetch("/api/journal/observer", {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) {
        setCalLoaded(true);
        return;
      }
      const json = await res.json();
      setCalSnapshot(json.snapshot ?? null);
      setCalNotes(Array.isArray(json.notes) ? json.notes : []);
      setCalLoaded(true);
    } catch {
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Save failed');
    setOpenOutcomeModal(null);
    await loadJournal();
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
}

function JournalView({
  filtered, filter, setFilter, live, total, taken, blocked, winRate, avgScore,
  expanded, setExpanded, expandedPostmortem, setExpandedPostmortem,
  setOpenOutcomeModal, backtesting, backtestableCount, runBacktest,
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
                    {new Date(d.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.session?.replace("_", " ")}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700, color: d.direction === "LONG" ? "#22c55e" : d.direction === "SHORT" ? "#ef4444" : "#d4a520", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.direction}</td>
                  <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}><GradeBadge grade={d.grade ?? "—"} /></td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.entry_price ? `$${d.entry_price}` : "—"}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.stop_loss ? `$${d.stop_loss}` : (d.outcome?.status === 'OPEN' && d.stop_price ? `$${d.stop_price}` : "—")}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.take_profit_1 ? `$${d.take_profit_1}` : (d.outcome?.status === 'OPEN' && d.tp1_price ? `$${d.tp1_price}` : "—")}</td>
                  <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: 1, color: d.source === "WEBHOOK" ? "#60a5fa" : "#555" }}>{d.source ?? "MANUAL"}</span>
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
                          <OutcomeBadge status={d.outcome?.status} result={d.outcome?.result} />
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
                      <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, fontStyle: "italic", color: "#888", lineHeight: 1.65, padding: "10px 14px", background: "#111115", borderLeft: "2px solid #d4a520", borderRadius: 3 }}>
                        {d.postmortem}
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
                            <button style={{ marginTop: 14, padding: "7px 14px", background: "transparent", border: "1px solid #2a2a2e", borderRadius: 4, cursor: "pointer", fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#666670" }}>
                              RUN POST-MORTEM
                            </button>
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {[
          ["OVERALL WIN RATE", fmtPct(snapshot.overall.win_rate), `${snapshot.totals.trades_closed} trades closed`, "#e0e0e0"],
          ["LAST 30 TRADES", r30Display, `${r30.trades} trades`, "#e0e0e0"],
          ["EDGE HEALTH", `${factorsStrong} / 8`, "factors with strong edge", edgeColor],
        ].map(([label, value, sub, color]) => (
          <div key={label} style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: "18px 20px" }}>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px", color: "#888", marginBottom: 10 }}>{label}</div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 28, fontWeight: 700, color, marginBottom: 6 }}>{value}</div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "#888" }}>{sub}</div>
          </div>
        ))}
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