"use client";

import { useState, useEffect } from "react";

const mono = { fontFamily: "JetBrains Mono, monospace" } as const;

const C = {
  bg: "#1a1a1e",
  border: "#2a2a2e",
  text: "#e0e0e0",
  muted: "#666670",
  dim: "#444450",
  amber: "#d4a520",
  green: "#22c55e",
  red: "#ef4444",
  panel: "#111115",
};

export interface TradeEntry {
  id: string;
  direction: "LONG" | "SHORT";
  entry_price: number | null;
  stop_loss: number | null;
  // Either spelling appears in stored entries (legacy take_profit_1
  // from the JournalWriteSchema vs tp1_price from the pre-trade
  // logSetup payload). The modal reads whichever is present.
  tp1_price?: number | null;
  take_profit_1?: number | null;
  contracts: number | null;
  timestamp: string;
  score: number;
  grade: string;
  confidence_label: string;
  session: string;
}

export type RunnerManagement =
  | "HELD_TO_TP2"
  | "TRAILED_TO_STRUCTURE"
  | "TRAILED_TO_VWAP"
  | "MANUAL_CLOSE"
  | "NO_RUNNER";

const RUNNER_OPTIONS: Array<{ value: RunnerManagement; label: string }> = [
  { value: "HELD_TO_TP2",          label: "HELD TO TP2 — full target" },
  { value: "TRAILED_TO_STRUCTURE", label: "TRAILED TO STRUCTURE — swing low/high" },
  { value: "TRAILED_TO_VWAP",      label: "TRAILED TO VWAP" },
  { value: "MANUAL_CLOSE",         label: "MANUAL CLOSE — discretionary" },
  { value: "NO_RUNNER",            label: "NO RUNNER — single contract" },
];

interface Props {
  trade: TradeEntry;
  onClose: () => void;
  onSave: (id: string, payload: object) => Promise<void>;
}

function statusColor(s: "WIN" | "LOSS" | "SCRATCH" | null): string {
  if (s === "WIN") return C.green;
  if (s === "LOSS") return C.red;
  if (s === "SCRATCH") return C.amber;
  return C.muted;
}

export default function LogOutcomeModal({ trade, onClose, onSave }: Props) {
  const [closePriceStr, setClosePriceStr] = useState("");
  const [runPostmortem, setRunPostmortem] = useState(false);
  const [runnerManagement, setRunnerManagement] = useState<RunnerManagement | "">("");
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const closePrice = parseFloat(closePriceStr);
  const isValid = !isNaN(closePrice) && closePrice > 10 && closePrice < 500;

  const entryPrice = trade.entry_price;
  const stopLoss = trade.stop_loss;
  const contracts = trade.contracts ?? 1;
  const isLong = trade.direction === "LONG";

  let ticks = 0,
    dollars = 0,
    rMultiple = 0;
  let status: "WIN" | "LOSS" | "SCRATCH" | null = null;

  if (isValid && entryPrice != null && stopLoss != null) {
    const rawTicks = (closePrice - entryPrice) / 0.01;
    ticks = isLong ? rawTicks : -rawTicks;
    dollars = ticks * 10 * contracts;
    const riskTicks = Math.abs((entryPrice - stopLoss) / 0.01);
    rMultiple = riskTicks > 0 ? ticks / riskTicks : 0;
    status =
      Math.abs(ticks) <= 2 ? "SCRATCH" : ticks > 0 ? "WIN" : "LOSS";
  }

  const holdHours =
    Math.round(
      ((Date.now() - new Date(trade.timestamp).getTime()) / 3_600_000) * 10
    ) / 10;

  const pastStop =
    isValid &&
    stopLoss != null &&
    (isLong ? closePrice < stopLoss - 2.0 : closePrice > stopLoss + 2.0);

  // TP1-hit detection — runner-management dropdown only renders when
  // the close price meets/exceeds tp1 in the trade direction.
  const tp1 = trade.tp1_price ?? trade.take_profit_1 ?? null;
  const tp1Hit =
    isValid &&
    tp1 != null &&
    (isLong ? closePrice >= tp1 : closePrice <= tp1);

  // Reset two-click confirmation when close price changes
  useEffect(() => {
    setConfirmed(false);
  }, [closePriceStr]);

  async function handleSave() {
    if (!isValid) return;
    if (pastStop && !confirmed) {
      setConfirmed(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(trade.id, {
        close_price: closePrice,
        run_postmortem: runPostmortem,
        // Only attach when the trader actually picked an option AND the
        // trade reached TP1. Skipping the prompt keeps the field absent
        // so the route preserves any prior value.
        ...(tp1Hit && runnerManagement !== ""
          ? { runner_management: runnerManagement }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error && err.message
        ? err.message
        : "Save failed. Try again.";
      setSaveError(msg);
      setSaving(false);
    }
  }

  const buttonLabel = saving
    ? "SAVING..."
    : pastStop && !confirmed
    ? "CONFIRM ANYWAY →"
    : "SAVE OUTCOME →";

  const buttonBg =
    pastStop && !confirmed ? C.red : status === "WIN" ? C.green : C.amber;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: 28,
          width: 480,
          maxWidth: "calc(100vw - 32px)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 20,
          }}
        >
          <div>
            <div
              style={{
                ...mono,
                fontSize: 9,
                letterSpacing: "3px",
                color: C.amber,
                marginBottom: 4,
              }}
            >
              LOG OUTCOME
            </div>
            <div
              style={{
                ...mono,
                fontSize: 13,
                fontWeight: 700,
                color: C.text,
                letterSpacing: "1px",
              }}
            >
              {trade.id}
            </div>
            <div
              style={{
                ...mono,
                fontSize: 10,
                color: C.muted,
                marginTop: 3,
              }}
            >
              {trade.direction} · Score {trade.score} {trade.grade} ·{" "}
              {trade.session.replace("_", " ")}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: C.muted,
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            ×
          </button>
        </div>

        {/* Trade details reference */}
        <div
          style={{
            background: C.panel,
            borderRadius: 4,
            padding: "10px 14px",
            marginBottom: 18,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 10,
          }}
        >
          {[
            ["ENTRY", entryPrice != null ? `$${entryPrice.toFixed(2)}` : "—"],
            ["STOP", stopLoss != null ? `$${stopLoss.toFixed(2)}` : "—"],
            ["CONTRACTS", contracts],
          ].map(([label, val]) => (
            <div key={label as string}>
              <div
                style={{
                  ...mono,
                  fontSize: 8,
                  letterSpacing: "2px",
                  color: C.dim,
                  marginBottom: 3,
                }}
              >
                {label}
              </div>
              <div style={{ ...mono, fontSize: 13, color: C.text }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Close price input */}
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              ...mono,
              fontSize: 9,
              letterSpacing: "2px",
              color: C.muted,
              marginBottom: 6,
            }}
          >
            CLOSE PRICE
          </div>
          <input
            autoFocus
            type="number"
            step="0.01"
            placeholder={entryPrice != null ? String(entryPrice) : "0.00"}
            value={closePriceStr}
            onChange={(e) => setClosePriceStr(e.target.value)}
            style={{
              ...mono,
              fontSize: 20,
              color: C.text,
              background: C.panel,
              border: `1px solid ${isValid ? C.border : "#3a2a2e"}`,
              borderRadius: 4,
              padding: "10px 14px",
              width: "100%",
              boxSizing: "border-box",
              outline: "none",
            }}
          />
        </div>

        {/* Computed preview */}
        {isValid && status && (
          <div
            style={{
              background: C.panel,
              borderRadius: 4,
              padding: "14px 16px",
              marginBottom: 18,
              borderLeft: `3px solid ${statusColor(status)}`,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  ...mono,
                  fontSize: 18,
                  fontWeight: 700,
                  color: statusColor(status),
                  letterSpacing: "2px",
                }}
              >
                {status}
              </span>
              <span
                style={{
                  ...mono,
                  fontSize: 18,
                  fontWeight: 700,
                  color: rMultiple >= 0 ? C.green : C.red,
                }}
              >
                {rMultiple >= 0 ? "+" : ""}
                {rMultiple.toFixed(2)}R
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr 1fr",
                gap: 10,
              }}
            >
              {[
                ["TICKS", ticks >= 0 ? `+${ticks.toFixed(1)}` : ticks.toFixed(1)],
                [
                  "P&L",
                  `${dollars >= 0 ? "+" : ""}$${dollars.toFixed(0)}`,
                ],
                ["HOLD", `${holdHours}h`],
                [
                  "RISK",
                  stopLoss != null && entryPrice != null
                    ? `${Math.abs(((entryPrice - stopLoss) / 0.01)).toFixed(0)}t`
                    : "—",
                ],
              ].map(([label, val]) => (
                <div key={label as string}>
                  <div
                    style={{
                      ...mono,
                      fontSize: 8,
                      letterSpacing: "2px",
                      color: C.dim,
                      marginBottom: 3,
                    }}
                  >
                    {label}
                  </div>
                  <div
                    style={{
                      ...mono,
                      fontSize: 13,
                      color:
                        label === "P&L"
                          ? dollars >= 0
                            ? C.green
                            : C.red
                          : C.text,
                    }}
                  >
                    {val}
                  </div>
                </div>
              ))}
            </div>
            {pastStop && (
              <div
                style={{
                  ...mono,
                  fontSize: 9,
                  color: C.red,
                  marginTop: 10,
                  letterSpacing: "1px",
                }}
              >
                ⚠ CLOSE PRICE IS MORE THAN $2.00 PAST STOP LOSS
              </div>
            )}
          </div>
        )}

        {/* Runner management — surfaces only when the close price hit TP1.
            Optional; null when the trader skips, so no nag if forgotten. */}
        {tp1Hit && (
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: "block", ...mono, fontSize: 9, letterSpacing: "2px", color: C.muted, marginBottom: 6 }}>
              HOW DID YOU MANAGE THE RUNNER?
            </label>
            <select
              value={runnerManagement}
              onChange={(e) => setRunnerManagement(e.target.value as RunnerManagement | "")}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                color: runnerManagement === "" ? C.muted : C.text,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
              }}
            >
              <option value="">— optional · skip if you forget —</option>
              {RUNNER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Post-mortem checkbox */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 20,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={runPostmortem}
            onChange={(e) => setRunPostmortem(e.target.checked)}
            style={{ accentColor: C.amber, width: 14, height: 14 }}
          />
          <span style={{ ...mono, fontSize: 10, color: C.muted, letterSpacing: "1px" }}>
            Run Prompt 10 post-mortem (ALFRED background analysis)
          </span>
        </label>

        {saveError && (
          <div
            style={{ ...mono, fontSize: 10, color: C.red, marginBottom: 12 }}
          >
            {saveError}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            style={{
              ...mono,
              flex: 1,
              padding: "11px 0",
              borderRadius: 4,
              border: "none",
              cursor: isValid && !saving ? "pointer" : "not-allowed",
              background: isValid ? buttonBg : "#2a2a2e",
              color: isValid ? "#0d0d0f" : C.muted,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "2px",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {buttonLabel}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              ...mono,
              padding: "11px 18px",
              borderRadius: 4,
              border: `1px solid ${C.border}`,
              cursor: "pointer",
              background: "transparent",
              color: C.muted,
              fontSize: 10,
              letterSpacing: "2px",
            }}
          >
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}
