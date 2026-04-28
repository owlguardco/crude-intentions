"use client";

import { useEffect, useState } from "react";
import type { VirtualPosition } from "@/lib/position/position-store";

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

const inputStyle: React.CSSProperties = {
  background: COLORS.panel,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 4,
  color: COLORS.text,
  fontFamily: FONT_MONO,
  fontSize: 13,
  padding: "8px 12px",
  width: "100%",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontFamily: FONT_MONO,
  fontSize: 9,
  letterSpacing: "2px",
  color: COLORS.muted,
  marginBottom: 5,
};

const SESSIONS = ["NY_OPEN", "NY_AFTERNOON", "LONDON", "OVERLAP", "ASIA", "OFF_HOURS"];

const fmt2 = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toFixed(2);

function ticksBetween(a: number, b: number): string {
  return (Math.abs(a - b) * 100).toFixed(1);
}

function localTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function getApiKey() {
  return process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "";
}

export default function PositionPage() {
  const [position, setPosition] = useState<VirtualPosition | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open form state
  const [openForm, setOpenForm] = useState({
    direction: "LONG" as "LONG" | "SHORT",
    entry_price: "",
    contracts: "1",
    stop_loss: "",
    target: "",
    session: "NY_OPEN",
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);

  // Edit row state
  const [editStop, setEditStop] = useState("");
  const [editTarget, setEditTarget] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/position", {
        headers: { "x-api-key": getApiKey() },
      });
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const json = await res.json();
      const pos: VirtualPosition | null = json.position ?? null;
      setPosition(pos);
      if (pos) {
        setEditStop(pos.stop_loss?.toString() ?? "");
        setEditTarget(pos.target?.toString() ?? "");
        setEditNotes(pos.notes ?? "");
      }
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  function setF<K extends keyof typeof openForm>(key: K, val: string) {
    setOpenForm((f) => ({ ...f, [key]: val }));
  }

  async function submitOpen() {
    setError(null);
    if (!openForm.entry_price) {
      setError("Entry price is required");
      return;
    }
    setSubmitting(true);
    try {
      const body: any = {
        direction: openForm.direction,
        entry_price: parseFloat(openForm.entry_price),
        contracts: parseInt(openForm.contracts, 10) || 1,
        session: openForm.session,
      };
      if (openForm.stop_loss) body.stop_loss = parseFloat(openForm.stop_loss);
      if (openForm.target) body.target = parseFloat(openForm.target);
      if (openForm.notes) body.notes = openForm.notes;

      const res = await fetch("/api/position", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": getApiKey() },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to open position");
      setPosition(json.position);
      setEditStop(json.position.stop_loss?.toString() ?? "");
      setEditTarget(json.position.target?.toString() ?? "");
      setEditNotes(json.position.notes ?? "");
    } catch (e: any) {
      setError(e.message || "Unknown error");
    }
    setSubmitting(false);
  }

  async function applyUpdate() {
    setError(null);
    try {
      const body: any = {};
      body.stop_loss = editStop === "" ? null : parseFloat(editStop);
      body.target = editTarget === "" ? null : parseFloat(editTarget);
      body.notes = editNotes === "" ? null : editNotes;

      const res = await fetch("/api/position", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-api-key": getApiKey() },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Update failed");
      setPosition(json.position);
    } catch (e: any) {
      setError(e.message || "Unknown error");
    }
  }

  async function close() {
    setError(null);
    try {
      const res = await fetch("/api/position", {
        method: "DELETE",
        headers: { "x-api-key": getApiKey() },
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Close failed");
      }
      setPosition(null);
      setEditStop("");
      setEditTarget("");
      setEditNotes("");
    } catch (e: any) {
      setError(e.message || "Unknown error");
    }
  }

  if (!loaded) return null;

  const directionColor = position?.direction === "LONG" ? COLORS.green : COLORS.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      {error && (
        <div style={{
          padding: "10px 12px",
          background: `${COLORS.red}15`,
          border: `1px solid ${COLORS.red}40`,
          borderRadius: 4,
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: COLORS.red,
        }}>{error}</div>
      )}

      {!position && (
        <>
          {/* Empty state header */}
          <div style={{
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            padding: 28,
            textAlign: "center",
          }}>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 12, letterSpacing: "3px",
              color: COLORS.muted, marginBottom: 8,
            }}>NO OPEN POSITION</div>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 10,
              color: "#666670", letterSpacing: "1px",
            }}>Use the form below to open a virtual position</div>
          </div>

          {/* Open form */}
          <div style={{
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            padding: 22,
          }}>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "3px",
              color: COLORS.gold, marginBottom: 18,
            }}>OPEN POSITION</div>

            {/* Direction toggle */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>DIRECTION</label>
              <div style={{ display: "flex", gap: 8 }}>
                {(["LONG", "SHORT"] as const).map((dir) => {
                  const active = openForm.direction === dir;
                  const c = dir === "LONG" ? COLORS.green : COLORS.red;
                  return (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => setF("direction", dir)}
                      style={{
                        flex: 1, padding: "10px 0",
                        background: active ? `${c}25` : "transparent",
                        border: `1px solid ${active ? c : COLORS.border}`,
                        borderRadius: 4, cursor: "pointer",
                        fontFamily: FONT_MONO, fontSize: 12, letterSpacing: "2px",
                        fontWeight: 700,
                        color: active ? c : COLORS.muted,
                      }}
                    >{dir}</button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>ENTRY PRICE</label>
                <input
                  style={inputStyle}
                  type="number"
                  step="0.01"
                  value={openForm.entry_price}
                  onChange={(e) => setF("entry_price", e.target.value)}
                  placeholder="—"
                />
              </div>
              <div>
                <label style={labelStyle}>CONTRACTS (1–10)</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  max={10}
                  value={openForm.contracts}
                  onChange={(e) => setF("contracts", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>STOP LOSS</label>
                <input
                  style={inputStyle}
                  type="number"
                  step="0.01"
                  value={openForm.stop_loss}
                  onChange={(e) => setF("stop_loss", e.target.value)}
                  placeholder="optional"
                />
              </div>
              <div>
                <label style={labelStyle}>TARGET</label>
                <input
                  style={inputStyle}
                  type="number"
                  step="0.01"
                  value={openForm.target}
                  onChange={(e) => setF("target", e.target.value)}
                  placeholder="optional"
                />
              </div>
              <div>
                <label style={labelStyle}>SESSION</label>
                <select
                  style={inputStyle as any}
                  value={openForm.session}
                  onChange={(e) => setF("session", e.target.value)}
                >
                  {SESSIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>NOTES</label>
                <input
                  style={inputStyle}
                  type="text"
                  value={openForm.notes}
                  onChange={(e) => setF("notes", e.target.value)}
                  placeholder="optional"
                />
              </div>
            </div>

            <button
              onClick={submitOpen}
              disabled={submitting || !openForm.entry_price}
              style={{
                marginTop: 8, width: "100%", padding: "12px 0",
                background: submitting || !openForm.entry_price ? "#666670" : COLORS.gold,
                border: "none", borderRadius: 4,
                cursor: submitting || !openForm.entry_price ? "not-allowed" : "pointer",
                fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "2px",
                fontWeight: 700, color: "#0d0d0f",
              }}
            >
              {submitting ? "OPENING..." : "OPEN POSITION"}
            </button>
          </div>
        </>
      )}

      {position && (
        <div style={{
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          padding: 22,
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 16,
            paddingBottom: 16, marginBottom: 18,
            borderBottom: `1px solid ${COLORS.border}`,
          }}>
            <span style={{
              fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700,
              letterSpacing: "2px", padding: "4px 10px", borderRadius: 3,
              color: directionColor, background: `${directionColor}18`,
              border: `1px solid ${directionColor}40`,
            }}>{position.direction}</span>
            <span style={{
              fontFamily: FONT_MONO, fontSize: 28, fontWeight: 700,
              color: COLORS.text,
            }}>{fmt2(position.entry_price)}</span>
            <span style={{
              fontFamily: FONT_MONO, fontSize: 12,
              color: COLORS.muted, marginLeft: "auto",
            }}>{position.contracts} {position.contracts === 1 ? "contract" : "contracts"}</span>
          </div>

          {/* Stats grid */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18,
          }}>
            {[
              ["ENTRY", fmt2(position.entry_price)],
              ["CONTRACTS", String(position.contracts)],
              ["STOP LOSS", fmt2(position.stop_loss)],
              ["TARGET", fmt2(position.target)],
              ["SESSION", position.session],
              ["OPENED", localTime(position.opened_at)],
              ["ALFRED SCORE", position.alfred_score !== null && position.alfred_score !== undefined ? `${position.alfred_score}/10` : "—"],
              ["CONFIDENCE", position.alfred_confidence ?? "—"],
            ].map(([label, val]) => (
              <div key={label} style={{
                background: "#0d0d10",
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                padding: "10px 12px",
              }}>
                <div style={{
                  fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "2px",
                  color: COLORS.muted, marginBottom: 5,
                }}>{label}</div>
                <div style={{
                  fontFamily: FONT_MONO, fontSize: 14, color: COLORS.text,
                }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Distances */}
          {(position.stop_loss !== null || position.target !== null) && (
            <div style={{
              display: "grid",
              gridTemplateColumns: position.stop_loss !== null && position.target !== null ? "1fr 1fr" : "1fr",
              gap: 12,
              marginBottom: 18,
            }}>
              {position.stop_loss !== null && (
                <div style={{
                  padding: "10px 12px",
                  background: `${COLORS.red}10`,
                  border: `1px solid ${COLORS.red}30`,
                  borderRadius: 4,
                }}>
                  <div style={{
                    fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "2px",
                    color: COLORS.red, marginBottom: 5,
                  }}>STOP DISTANCE</div>
                  <div style={{
                    fontFamily: FONT_MONO, fontSize: 14, color: COLORS.text,
                  }}>{ticksBetween(position.entry_price, position.stop_loss)} ticks</div>
                </div>
              )}
              {position.target !== null && (
                <div style={{
                  padding: "10px 12px",
                  background: `${COLORS.green}10`,
                  border: `1px solid ${COLORS.green}30`,
                  borderRadius: 4,
                }}>
                  <div style={{
                    fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "2px",
                    color: COLORS.green, marginBottom: 5,
                  }}>TARGET DISTANCE</div>
                  <div style={{
                    fontFamily: FONT_MONO, fontSize: 14, color: COLORS.text,
                  }}>{ticksBetween(position.entry_price, position.target)} ticks</div>
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          {position.notes && (
            <div style={{
              padding: "10px 12px",
              background: "#0d0d10",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 4,
              marginBottom: 18,
            }}>
              <div style={{
                fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "2px",
                color: COLORS.muted, marginBottom: 5,
              }}>NOTES</div>
              <div style={{
                fontFamily: FONT_MONO, fontSize: 12, color: COLORS.text, lineHeight: 1.55,
              }}>{position.notes}</div>
            </div>
          )}

          {/* Edit row */}
          <div style={{
            paddingTop: 16, borderTop: `1px solid ${COLORS.border}`,
          }}>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "3px",
              color: COLORS.gold, marginBottom: 12,
            }}>UPDATE</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr auto", gap: 8 }}>
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                placeholder="Stop"
                value={editStop}
                onChange={(e) => setEditStop(e.target.value)}
              />
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                placeholder="Target"
                value={editTarget}
                onChange={(e) => setEditTarget(e.target.value)}
              />
              <input
                style={inputStyle}
                type="text"
                placeholder="Notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
              />
              <button
                onClick={applyUpdate}
                style={{
                  padding: "8px 18px",
                  background: COLORS.gold, border: "none", borderRadius: 4,
                  cursor: "pointer", fontFamily: FONT_MONO, fontSize: 10,
                  letterSpacing: "2px", fontWeight: 700, color: "#0d0d0f",
                }}
              >UPDATE</button>
            </div>
          </div>

          {/* Close */}
          <button
            onClick={close}
            style={{
              marginTop: 18, width: "100%", padding: "11px 0",
              background: "transparent",
              border: `1px solid ${COLORS.red}`,
              borderRadius: 4, cursor: "pointer",
              fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "2px",
              fontWeight: 700, color: COLORS.red,
            }}
          >CLOSE POSITION</button>
        </div>
      )}
    </div>
  );
}
