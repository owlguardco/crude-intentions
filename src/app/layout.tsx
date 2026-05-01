"use client";

import "./globals.css";
import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import EIABanner from "@/components/EIABanner";
import type { GeoFlagResult } from "@/types/geo-flag";

const NAV_ITEMS = [
  { href: "/", label: "DASHBOARD" },
  { href: "/pre-trade", label: "PRE-TRADE" },
  { href: "/position", label: "POSITION" },
  { href: "/journal", label: "JOURNAL" },
  { href: "/calibration", label: "CALIBRATION" },
  { href: "/news", label: "NEWS" },
  { href: "/eia", label: "EIA" },
  { href: "/prompts", label: "PROMPTS" },
  { href: "/settings", label: "SETTINGS" },
];

function getSession() {
  const now = new Date();
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).format(now);
  const [h, m] = et.split(":").map(Number);
  const mins = h * 60 + m;
  if (mins >= 180 && mins < 480) return { label: "LONDON", color: "#3b82f6" };
  if (mins >= 570 && mins < 720) return { label: "NY OPEN", color: "#22c55e" };
  return { label: "AVOID", color: "#666670" };
}

function getEIA() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilWed);
  next.setHours(10, 30, 0, 0);
  const diff = next.getTime() - now.getTime();
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return { hours, mins, isActive: diff < 10800000 && diff > 0 };
}

// NY Open countdown — "NY OPEN 2H 14M" pre-market, "NY SESSION OPEN"
// during 9:30–11:45 AM ET, then counts to next day's 9:30. NY-local
// minute-of-day is derived via Intl.DateTimeFormat so DST flips are
// handled automatically; weekend skip is intentionally not done so
// the chip stays useful during weekend prep work.
function getNyOpenCountdown(): { label: string; color: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minPart  = parts.find((p) => p.type === "minute")?.value ?? "0";
  const hour = parseInt(hourPart, 10);
  const min  = parseInt(minPart, 10);
  const totalMin = hour * 60 + min;
  const openMin  = 9 * 60 + 30;   // 09:30 ET
  const closeMin = 11 * 60 + 45;  // 11:45 ET

  if (totalMin >= openMin && totalMin <= closeMin) {
    return { label: "NY SESSION OPEN", color: "#22c55e" };
  }
  const minutesUntil = totalMin < openMin
    ? openMin - totalMin
    : (24 * 60 - totalMin) + openMin;
  const h = Math.floor(minutesUntil / 60);
  const m = minutesUntil % 60;
  return { label: `NY OPEN ${h}H ${m}M`, color: "#666670" };
}

type AlfredStatus = "UP" | "FALLBACK" | "DOWN";
const FALLBACK_AMBER_GRACE_MS = 5 * 60 * 1000; // 5 minutes after a fallback, dot stays amber

function deriveAlfredStatus(): AlfredStatus {
  if (typeof window === "undefined") return "UP";
  const fb = parseInt(localStorage.getItem("alfred:lastFallbackAt") ?? "0", 10);
  const ok = parseInt(localStorage.getItem("alfred:lastSuccessAt") ?? "0", 10);
  if (!fb && !ok) return "UP";
  if (fb > ok) return "FALLBACK";
  if (fb && Date.now() - fb < FALLBACK_AMBER_GRACE_MS) return "DOWN"; // recovered, within grace window
  return "UP";
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [apiStatus, setApiStatus] = useState<"checking" | "online" | "offline">("checking");
  const [alfredStatus, setAlfredStatus] = useState<AlfredStatus>("UP");
  const [session, setSession] = useState(getSession());
  const [eia, setEia] = useState(getEIA());
  const [nyCountdown, setNyCountdown] = useState(getNyOpenCountdown());
  const [geoFlag, setGeoFlag] = useState<GeoFlagResult | null>(null);
  const [geoExpanded, setGeoExpanded] = useState(false);
  const [clPrice, setClPrice] = useState<number | null>(null);
  const [clSessionOpen, setClSessionOpen] = useState<number | null>(null);
  const [ovxPrice, setOvxPrice] = useState<number | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setSession(getSession());
      setEia(getEIA());
      setNyCountdown(getNyOpenCountdown());
      setAlfredStatus(deriveAlfredStatus());
    }, 30000);
    // Lightweight API health check
    fetch("/api/health")
      .then(() => setApiStatus("online"))
      .catch(() => setApiStatus("offline"));
    setAlfredStatus(deriveAlfredStatus());
    const onChange = () => setAlfredStatus(deriveAlfredStatus());
    window.addEventListener("storage", onChange);
    window.addEventListener("alfred:status-changed", onChange);
    return () => {
      clearInterval(interval);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("alfred:status-changed", onChange);
    };
  }, []);

  // Live CL price — poll every 30s. Failure branches are no-ops so the last
  // good value persists through transient fetch errors.
  useEffect(() => {
    let cancelled = false;
    const loadCl = async () => {
      try {
        const res = await fetch("/api/cl-price");
        if (cancelled || !res.ok) return;
        const json = await res.json();
        if (typeof json.price === "number" && Number.isFinite(json.price)) {
          setClPrice(json.price);
        }
        if (typeof json.session_open === "number" && Number.isFinite(json.session_open)) {
          setClSessionOpen(json.session_open);
        } else if (json.session_open === null) {
          setClSessionOpen(null);
        }
      } catch {
        // hold last good value
      }
    };
    loadCl();
    const t = setInterval(loadCl, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Live OVX — poll every 5 minutes. Same hold-last-good behavior on failure.
  useEffect(() => {
    let cancelled = false;
    const loadOvx = async () => {
      try {
        const res = await fetch("/api/ovx");
        if (cancelled || !res.ok) return;
        const json = await res.json();
        if (typeof json.price === "number" && Number.isFinite(json.price)) {
          setOvxPrice(json.price);
        }
      } catch {
        // hold last good value
      }
    };
    loadOvx();
    const t = setInterval(loadOvx, 5 * 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Geopolitical flag — Truth Social RSS poller (silent degradation)
  useEffect(() => {
    let cancelled = false;
    const loadGeo = async () => {
      try {
        const res = await fetch("/api/geo-flag");
        if (cancelled) return;
        if (!res.ok) return;
        const json = (await res.json()) as GeoFlagResult;
        setGeoFlag(json);
      } catch {
        // silent — leave previous state
      }
    };
    loadGeo();
    const t = setInterval(loadGeo, 120_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // ALFRED status overrides API health for the dot:
  //   FALLBACK = red (currently degraded), DOWN = amber (recovered, within grace),
  //   UP      = follows /api/health.
  const dotColor =
    alfredStatus === "FALLBACK" ? "#ef4444"
    : alfredStatus === "DOWN"    ? "#d4a520"
    : apiStatus === "online"     ? "#22c55e"
    : apiStatus === "checking"   ? "#d4a520"
    :                              "#ef4444";

  const alfredLabel =
    alfredStatus === "FALLBACK" ? "FALLBACK"
    : alfredStatus === "DOWN"   ? "RECOVERED"
    : apiStatus.toUpperCase();

  return (
    <html lang="en">
      <body style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#0d0d0f" }}>

        {/* ── SIDEBAR ── */}
        <aside
          style={{
            width: collapsed ? 52 : 220,
            background: "#1a1a1e",
            borderRight: "1px solid #2a2a2e",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            transition: "width 0.2s ease",
            overflow: "hidden",
          }}
        >
          {/* Wordmark */}
          <div style={{ padding: collapsed ? "20px 14px" : "24px 20px 20px", borderBottom: "1px solid #2a2a2e", minHeight: 88 }}>
            {!collapsed ? (
              <>
                <span style={{ display: "block", fontFamily: "JetBrains Mono, monospace", fontWeight: 700, fontSize: 14, letterSpacing: "6px", color: "#e0e0e0" }}>
                  CRUDE
                </span>
                <span style={{ display: "block", height: 2, background: "#d4a520", margin: "5px 0" }} />
                <span style={{ display: "block", fontFamily: "JetBrains Mono, monospace", fontWeight: 700, fontSize: 14, letterSpacing: "6px", color: "#e0e0e0" }}>
                  INTENTIONS
                </span>
                <span style={{ display: "block", fontFamily: "JetBrains Mono, monospace", fontSize: 8, letterSpacing: "3px", color: "#444450", marginTop: 6 }}>
                  CL FUTURES RESEARCH
                </span>
              </>
            ) : (
              <span style={{ display: "block", fontFamily: "JetBrains Mono, monospace", fontWeight: 700, fontSize: 12, color: "#d4a520", letterSpacing: "2px" }}>CI</span>
            )}
          </div>

          {/* Nav */}
          <nav style={{ flex: 1, paddingTop: 8 }}>
            {NAV_ITEMS.map(({ href, label }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: collapsed ? "10px 16px" : "10px 20px",
                    borderLeft: active ? "2px solid #d4a520" : "2px solid transparent",
                    background: active ? "rgba(212,165,32,0.07)" : "transparent",
                    color: active ? "#d4a520" : "#666670",
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 11,
                    letterSpacing: "2px",
                    textDecoration: "none",
                    whiteSpace: "nowrap",
                    transition: "all 0.15s",
                  }}
                >
                  {collapsed ? label[0] : label}
                </Link>
              );
            })}
          </nav>

          {/* HERMES status */}
          <div style={{ padding: collapsed ? "12px 16px" : "14px 20px", borderTop: "1px solid #2a2a2e", display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 7, height: 7, borderRadius: "50%", background: dotColor, flexShrink: 0,
                animation:
                  apiStatus === "online" && alfredStatus === "UP"
                    ? "pulse-online 2s ease-in-out infinite"
                    : apiStatus === "checking"
                    ? "pulse-dot 1.5s infinite"
                    : "none",
              }}
            />
            {!collapsed && (
              <div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px", color: "#666670" }}>ALFRED</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 8, color: dotColor }}>{alfredLabel}</div>
              </div>
            )}
          </div>

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed((c) => !c)}
            style={{
              padding: "8px 20px 12px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 9,
              color: "#444450",
              letterSpacing: "1px",
              textAlign: "left",
            }}
          >
            {collapsed ? "→" : "← COLLAPSE"}
          </button>
        </aside>

        {/* ── MAIN ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Price Strip */}
          <div style={{
            background: "#1a1a1e",
            borderBottom: "1px solid #2a2a2e",
            padding: "10px 24px",
            display: "flex",
            alignItems: "center",
            gap: 20,
            flexShrink: 0,
          }}>
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 18, fontWeight: 700, color: "#e0e0e0" }}>
              {clPrice != null ? clPrice.toFixed(2) : "—"}
            </span>
            {clPrice != null && clSessionOpen != null && clSessionOpen !== 0 && (() => {
              const deltaPct = ((clPrice - clSessionOpen) / clSessionOpen) * 100;
              const color = deltaPct > 0 ? "#22c55e" : deltaPct < 0 ? "#ef4444" : "#666670";
              const sign = deltaPct > 0 ? "+" : "";
              return (
                <span style={{
                  fontFamily: "JetBrains Mono, monospace", fontSize: 13, color,
                }}>
                  {sign}{deltaPct.toFixed(2)}%
                </span>
              );
            })()}

            <span style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "2px",
              padding: "3px 8px", borderRadius: 3,
              color: session.color, background: `${session.color}18`,
              border: `1px solid ${session.color}40`,
            }}>{session.label}</span>

            <span style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "1px",
              padding: "3px 8px", borderRadius: 3,
              color: "#666670", background: "#66667018", border: "1px solid #66667040",
            }}>OVX {ovxPrice != null ? ovxPrice.toFixed(1) : "—"}</span>

            <span style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: 10, letterSpacing: "1px",
              padding: "3px 8px", borderRadius: 3,
              color: nyCountdown.color,
              background: `${nyCountdown.color}18`,
              border: `1px solid ${nyCountdown.color}40`,
            }}>{nyCountdown.label}</span>

            {(() => {
              // 3-state chip mapped from GeoFlagResult.chip_state. Old v1
              // payloads (no chip_state) fall through to the dim "—" state
              // until the route writes a v2 cache entry.
              if (!geoFlag || !geoFlag.chip_state || geoFlag.error) {
                return (
                  <span style={{
                    fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px",
                    padding: "3px 8px", borderRadius: 3,
                    color: "#444450", background: "transparent", border: "1px solid #2a2a2e",
                  }}>GEO · —</span>
                );
              }
              if (geoFlag.chip_state === "CLEAR") {
                return (
                  <span style={{
                    fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px",
                    padding: "3px 8px", borderRadius: 3,
                    color: "#666670", background: "#66667018", border: "1px solid #66667040",
                  }}>GEO · CLEAR</span>
                );
              }
              const mins = geoFlag.matched_at
                ? Math.max(0, Math.floor((Date.now() - new Date(geoFlag.matched_at).getTime()) / 60000))
                : 0;
              if (geoFlag.chip_state === "HOT") {
                return (
                  <span
                    onClick={() => setGeoExpanded((v) => !v)}
                    title="CL is moving since the flagged post — soft pause"
                    style={{
                      fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px",
                      padding: "3px 8px", borderRadius: 3, cursor: "pointer",
                      color: "#ef4444", background: "#ef444418", border: "1px solid #ef444440",
                      fontWeight: 700,
                    }}
                  >🔴 TRUTH · {mins} MIN AGO — CL MOVING</span>
                );
              }
              return (
                <span
                  onClick={() => setGeoExpanded((v) => !v)}
                  style={{
                    fontFamily: "JetBrains Mono, monospace", fontSize: 9, letterSpacing: "2px",
                    padding: "3px 8px", borderRadius: 3, cursor: "pointer",
                    color: "#d4a520", background: "#d4a52018", border: "1px solid #d4a52040",
                  }}
                >⚡ TRUTH · {mins} MIN AGO</span>
              );
            })()}

            <span style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: 11, marginLeft: "auto",
              color: eia.isActive ? "#ef4444" : "#666670",
            }}>
              EIA: {eia.isActive ? "⚠ ACTIVE" : `${eia.hours}h ${eia.mins}m`}
            </span>
          </div>

          {/* Geopolitical flag inline expansion */}
          {geoExpanded && geoFlag?.flagged && geoFlag.post_title && (() => {
            const isHot = geoFlag.chip_state === "HOT";
            const accent = isHot ? "#ef4444" : "#d4a520";
            const bg = isHot ? "rgba(239,68,68,0.08)" : "rgba(212,165,32,0.08)";
            const borderCol = isHot ? "rgba(239,68,68,0.30)" : "rgba(212,165,32,0.30)";
            const excerpt = geoFlag.post_title.length > 120
              ? `${geoFlag.post_title.slice(0, 117)}...`
              : geoFlag.post_title;
            const delta = geoFlag.price_delta_since_post ?? 0;
            const deltaSign = delta >= 0 ? "+" : "−";
            const deltaText = geoFlag.price_delta_known
              ? `CL: ${deltaSign}$${Math.abs(delta).toFixed(2)} since post`
              : "CL Δ unknown — no recent price history";
            const deltaColor = !geoFlag.price_delta_known
              ? "#666670"
              : delta > 0 ? "#22c55e"
              : delta < 0 ? "#ef4444"
              : "#888";
            return (
              <div style={{
                background: bg,
                borderBottom: `1px solid ${borderCol}`,
                padding: "10px 24px", flexShrink: 0,
                fontFamily: "JetBrains Mono, monospace", fontSize: 11,
                color: "#e0e0e0", letterSpacing: "1px",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <span style={{ color: accent, fontSize: 10, letterSpacing: "2px", flexShrink: 0 }}>
                  {isHot ? "🔴 TRUTH POST" : "⚡ TRUTH POST"}
                </span>
                <span style={{ flex: 1, color: "#888", fontSize: 11, letterSpacing: 0 }}>
                  {excerpt}
                </span>
                <span style={{ color: deltaColor, fontSize: 10, letterSpacing: "1px", flexShrink: 0 }}>
                  {deltaText}
                </span>
                {geoFlag.post_url && (
                  <a
                    href={geoFlag.post_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: accent, fontSize: 9, letterSpacing: "2px",
                      textDecoration: "none", padding: "3px 8px",
                      border: `1px solid ${accent}40`, borderRadius: 3,
                    }}
                  >OPEN ↗</a>
                )}
                <button
                  onClick={() => setGeoExpanded(false)}
                  style={{
                    background: "transparent", border: "none", cursor: "pointer",
                    color: "#666670", fontSize: 14, lineHeight: 1, padding: "0 4px",
                  }}
                >×</button>
              </div>
            );
          })()}

          {/* ALFRED Fallback Banner — visible app-wide while in fallback or recovery */}
          {(alfredStatus === "FALLBACK" || alfredStatus === "DOWN") && (
            <div style={{
              background: alfredStatus === "FALLBACK" ? "rgba(239,68,68,0.10)" : "rgba(212,165,32,0.10)",
              borderBottom: alfredStatus === "FALLBACK"
                ? "1px solid rgba(239,68,68,0.35)"
                : "1px solid rgba(212,165,32,0.35)",
              padding: "8px 24px", flexShrink: 0,
              fontFamily: "JetBrains Mono, monospace", fontSize: 11,
              color: alfredStatus === "FALLBACK" ? "#ef4444" : "#d4a520",
              letterSpacing: "1px",
            }}>
              {alfredStatus === "FALLBACK"
                ? "⚠ ALFRED FALLBACK MODE — last analysis used the deterministic scorer (Anthropic API unreachable)"
                : "ALFRED RECOVERED — last analysis succeeded, fallback was used recently"}
            </div>
          )}

          {/* EIA Active Banner */}
          <EIABanner />

          {/* Page content */}
          <main style={{ flex: 1, overflow: "auto", padding: 24 }}>
            {children}
          </main>

          {/* Footer */}
          <footer style={{
            padding: "8px 24px",
            borderTop: "1px solid #2a2a2e",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9, letterSpacing: "1px",
            color: "#444450", flexShrink: 0,
          }}>
            CRUDE INTENTIONS is a personal research tool. Nothing here constitutes financial advice. All trading decisions are yours alone.
          </footer>
        </div>
      </body>
    </html>
  );
}
