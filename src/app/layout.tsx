"use client";

import "./globals.css";
import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "DASHBOARD" },
  { href: "/pre-trade", label: "PRE-TRADE" },
  { href: "/journal", label: "JOURNAL" },
  { href: "/calibration", label: "CALIBRATION" },
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

  useEffect(() => {
    const interval = setInterval(() => {
      setSession(getSession());
      setEia(getEIA());
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
                animation: apiStatus === "checking" ? "pulse-dot 1.5s infinite" : "none",
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
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 18, fontWeight: 700, color: "#e0e0e0" }}>78.42</span>
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 13, color: "#22c55e" }}>+0.34%</span>

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
            }}>OVX 28.4</span>

            <span style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: 11, marginLeft: "auto",
              color: eia.isActive ? "#ef4444" : "#666670",
            }}>
              EIA: {eia.isActive ? "⚠ ACTIVE" : `${eia.hours}h ${eia.mins}m`}
            </span>
          </div>

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
          {eia.isActive && (
            <div style={{
              background: "rgba(239,68,68,0.08)", borderBottom: "1px solid rgba(239,68,68,0.3)",
              padding: "8px 24px", flexShrink: 0,
              fontFamily: "JetBrains Mono, monospace", fontSize: 11,
              color: "#ef4444", letterSpacing: "1px",
            }}>
              ⚠ EIA WINDOW ACTIVE — AVOID NEW ENTRIES UNTIL 13:30 ET
            </div>
          )}

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
