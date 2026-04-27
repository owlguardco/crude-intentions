"use client";

import { useState, useEffect } from "react";

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
  const [filter, setFilter] = useState("ALL");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [lastCount, setLastCount] = useState(0);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const load = async (silent = false) => {
      try {
        const res = await fetch('/api/journal');
        const json = await res.json();
        const d = json.decisions || [];
        if (silent && d.length > lastCount) setLastCount(d.length);
        setDecisions(d);
        setLive(true);
      } catch {}
    };
    load();
    const t = setInterval(() => load(true), 15000);
    return () => clearInterval(t);
  }, [lastCount]);

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
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.stop_loss ? `$${d.stop_loss}` : "—"}</td>
                  <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#e0e0e0", padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>{d.take_profit_1 ? `$${d.take_profit_1}` : "—"}</td>
                  <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: 1, color: d.source === "WEBHOOK" ? "#60a5fa" : "#555" }}>{d.source ?? "MANUAL"}</span>
                  </td>
                  <td style={{ padding: "11px 12px 11px 0", borderBottom: "1px solid #2a2a2e20" }}>
                    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 9, color: d.adversarial_verdict === "PASS" ? "#22c55e" : d.adversarial_verdict === "CONDITIONAL_PASS" ? "#d4a520" : d.adversarial_verdict === "SKIP" ? "#ef4444" : "#555" }}>
                      {d.adversarial_verdict?.replace("_", " ") ?? "—"}
                    </span>
                  </td>
                  <td style={{ padding: "11px 0", borderBottom: "1px solid #2a2a2e20" }}><OutcomeBadge status={d.outcome?.status} result={d.outcome?.result} /></td>
                </tr>

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