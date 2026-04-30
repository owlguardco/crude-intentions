"use client";

import { useEffect, useState } from "react";

/**
 * EIA inventory release blackout window: Wednesday 7:30 AM - 1:30 PM ET.
 * Computed in America/New_York via Intl.DateTimeFormat so the check stays
 * correct regardless of the user's browser timezone, and follows EDT/EST
 * transitions automatically.
 */
function isEiaBlackout(): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") !== "Wed") return false;
  const h = parseInt(get("hour"), 10);
  const m = parseInt(get("minute"), 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const totalMin = h * 60 + m;
  const start = 7 * 60 + 30;   // 7:30 AM ET
  const end = 13 * 60 + 30;    // 1:30 PM ET
  return totalMin >= start && totalMin <= end;
}

export default function EIABanner() {
  const [active, setActive] = useState<boolean>(false);

  useEffect(() => {
    const tick = () => setActive(isEiaBlackout());
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!active) return null;

  return (
    <div
      style={{
        width: "100%",
        background: "rgba(212,165,32,0.12)",
        borderBottom: "1px solid rgba(212,165,32,0.45)",
        padding: "10px 24px",
        flexShrink: 0,
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
        letterSpacing: "2px",
        color: "#d4a520",
        fontWeight: 700,
        textAlign: "center",
      }}
    >
      ⚠ EIA BLACKOUT ACTIVE — NO NEW ENTRIES UNTIL 1:30 PM ET
    </div>
  );
}
