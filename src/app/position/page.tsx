"use client";

import { useEffect, useState } from "react";
import type { VirtualPosition } from "@/lib/position/position-store";
import LogOutcomeModal, { type TradeEntry } from "@/components/journal/LogOutcomeModal";

const TICK_SIZE = 0.01;
const DOLLARS_PER_TICK = 10;

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function ticksOf(diff: number): number {
  return diff / TICK_SIZE;
}

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
    tp1_price: "",
    signal_id: "",
    session: "NY_OPEN",
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);

  // Edit row state
  const [editStop, setEditStop] = useState("");
  const [editTarget, setEditTarget] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Live tracking state
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [livePriceErr, setLivePriceErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [showCloseModal, setShowCloseModal] = useState(false);

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

  // Live CL price polling — only when a position is open
  useEffect(() => {
    if (!position) {
      setLivePrice(null);
      setLivePriceErr(null);
      return;
    }
    let cancelled = false;
    const fetchPrice = async () => {
      try {
        const res = await fetch("/api/cl-price", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setLivePriceErr("PRICE FEED UNAVAILABLE");
          return;
        }
        const json = await res.json();
        if (typeof json.price === "number" && Number.isFinite(json.price)) {
          setLivePrice(json.price);
          setLivePriceErr(null);
        }
      } catch {
        if (!cancelled) setLivePriceErr("PRICE FEED UNAVAILABLE");
      }
    };
    fetchPrice();
    const t = setInterval(fetchPrice, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [position?.id]);

  // Wall clock tick for time-in-trade
  useEffect(() => {
    if (!position) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [position?.id]);

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
      if (openForm.tp1_price) body.tp1_price = parseFloat(openForm.tp1_price);
      if (openForm.signal_id.trim()) body.signal_id = openForm.signal_id.trim();
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

  async function handleCloseSave(id: string, payload: object) {
    setError(null);
    if (id) {
      const res = await fetch(`/api/journal/${id}/outcome`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? "",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j?.error ?? `Journal outcome update failed (HTTP ${res.status})`);
      }
    }
    const del = await fetch("/api/position", {
      method: "DELETE",
      headers: { "x-api-key": getApiKey() },
    });
    if (!del.ok) {
      throw new Error("Failed to clear position");
    }
    setShowCloseModal(false);
    setPosition(null);
    setEditStop("");
    setEditTarget("");
    setEditNotes("");
  }

  function buildTradeEntry(p: VirtualPosition): TradeEntry {
    return {
      id: p.signal_id ?? "",
      direction: p.direction,
      entry_price: p.entry_price,
      stop_loss: p.stop_loss,
      contracts: p.contracts,
      timestamp: p.opened_at,
      score: p.alfred_score ?? 0,
      grade: "—",
      confidence_label: p.alfred_confidence ?? "—",
      session: p.session,
    };
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
                <label style={labelStyle}>TP1 PRICE</label>
                <input
                  style={inputStyle}
                  type="number"
                  step="0.01"
                  value={openForm.tp1_price}
                  onChange={(e) => setF("tp1_price", e.target.value)}
                  placeholder="optional"
                />
              </div>
              <div>
                <label style={labelStyle}>SIGNAL ID</label>
                <input
                  style={inputStyle}
                  type="text"
                  value={openForm.signal_id}
                  onChange={(e) => setF("signal_id", e.target.value)}
                  placeholder="CI-YYYY-MM-DD-NNN (optional)"
                />
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
              {submitting ? "OPENING..." : "GO LIVE"}
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

          {/* Live P&L panel */}
          {(() => {
            const isLong = position.direction === "LONG";
            const elapsed = fmtElapsed(now - new Date(position.opened_at).getTime());
            if (livePrice == null) {
              return (
                <div style={{
                  padding: "14px 16px", marginBottom: 18,
                  background: "#0d0d10", border: `1px solid ${COLORS.border}`,
                  borderRadius: 4, display: "flex", justifyContent: "space-between",
                  alignItems: "center",
                }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "2px", color: COLORS.muted }}>
                    {livePriceErr ?? "FETCHING LIVE PRICE..."}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.muted }}>
                    TIT {elapsed}
                  </span>
                </div>
              );
            }
            const tickDiff = isLong ? livePrice - position.entry_price : position.entry_price - livePrice;
            const ticks = ticksOf(tickDiff);
            const dollars = ticks * DOLLARS_PER_TICK * position.contracts;
            const riskTicks = position.stop_loss != null
              ? Math.abs(ticksOf(position.entry_price - position.stop_loss))
              : 0;
            const riskDollars = riskTicks * DOLLARS_PER_TICK * position.contracts;
            const rMultiple = riskDollars > 0 ? dollars / riskDollars : null;
            const distToStop = position.stop_loss != null
              ? Math.abs(ticksOf(livePrice - position.stop_loss))
              : null;
            const distToTp1 = position.tp1_price != null
              ? Math.abs(ticksOf(position.tp1_price - livePrice))
              : null;
            const pnlColor = dollars > 0 ? COLORS.green : dollars < 0 ? COLORS.red : COLORS.muted;
            return (
              <div style={{
                padding: "16px 18px", marginBottom: 18,
                background: "#0d0d10", border: `1px solid ${COLORS.border}`,
                borderRadius: 4, borderLeft: `3px solid ${pnlColor}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "2px", color: COLORS.muted, marginBottom: 4 }}>
                      LIVE CL
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 24, fontWeight: 700, color: COLORS.text }}>
                      {fmt2(livePrice)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "2px", color: COLORS.muted, marginBottom: 4 }}>
                      UNREALIZED P&L
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 24, fontWeight: 700, color: pnlColor }}>
                      {dollars >= 0 ? "+" : ""}${dollars.toFixed(0)}
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: pnlColor, marginTop: 2 }}>
                      {ticks >= 0 ? "+" : ""}{ticks.toFixed(1)} ticks
                    </div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                  {[
                    ["R MULTIPLE", rMultiple == null ? "—" : `${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R`, rMultiple == null ? COLORS.text : rMultiple >= 0 ? COLORS.green : COLORS.red],
                    ["TIME IN TRADE", elapsed, COLORS.text],
                    ["DIST TO STOP", distToStop == null ? "—" : `${distToStop.toFixed(1)} ticks`, COLORS.red],
                    ["DIST TO TP1", distToTp1 == null ? "—" : `${distToTp1.toFixed(1)} ticks`, COLORS.green],
                  ].map(([label, val, color]) => (
                    <div key={label as string}>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 8, letterSpacing: "2px", color: COLORS.muted, marginBottom: 4 }}>
                        {label}
                      </div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: color as string }}>
                        {val}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

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
              ["ALFRED SCORE", position.alfred_score !== null && position.alfred_score !== undefined ? `${position.alfred_score}/12` : "—"],
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

          {/* Close — opens LogOutcomeModal pre-filled */}
          <button
            onClick={() => setShowCloseModal(true)}
            style={{
              marginTop: 18, width: "100%", padding: "11px 0",
              background: "transparent",
              border: `1px solid ${COLORS.red}`,
              borderRadius: 4, cursor: "pointer",
              fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "2px",
              fontWeight: 700, color: COLORS.red,
            }}
          >CLOSE POSITION</button>

          {/* Discard without journal write */}
          <button
            onClick={close}
            style={{
              marginTop: 8, width: "100%", padding: "8px 0",
              background: "transparent",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 4, cursor: "pointer",
              fontFamily: FONT_MONO, fontSize: 9, letterSpacing: "2px",
              color: COLORS.muted,
            }}
          >DISCARD WITHOUT LOGGING</button>
        </div>
      )}

      {showCloseModal && position && (
        <LogOutcomeModal
          trade={buildTradeEntry(position)}
          onClose={() => setShowCloseModal(false)}
          onSave={handleCloseSave}
        />
      )}
    </div>
  );
}
