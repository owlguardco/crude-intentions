# PINE SCRIPT CLOSE ALERT — Crude Intentions
### File: docs/PINE_SCRIPT_CLOSE_ALERT.md
### Purpose: Wire TradingView close alerts so trades auto-resolve in the journal

---

## Overview

Without close alerts, every trade requires you to manually click LOG OUTCOME.
With this wired up, TradingView fires the close alert automatically when:
- TP1 is hit (LONG or SHORT)
- Stop is hit (LONG or SHORT)

The webhook router at Railway inspects the `close_reason` field and routes to
`/api/webhook-close`, which closes the journal entry, recalculates calibration,
updates market memory, and fires the post-mortem — all automatically.

---

## Step 1 — Add close conditions to your existing Pine Script

Open your existing CL1! 15-minute Pine Script alert script in the TradingView
Pine Script editor. Add the following close logic beneath your existing entry
signal logic.

```pine
// ─────────────────────────────────────────────────────────────────────────────
// CLOSE ALERT CONDITIONS — add below your existing entry signal code
// ─────────────────────────────────────────────────────────────────────────────

// These inputs mirror your entry signal — fill in the same values you use there
tp1_long  = input.float(0.0, title="TP1 LONG price", step=0.01)
tp1_short = input.float(0.0, title="TP1 SHORT price", step=0.01)
stop_long  = input.float(0.0, title="Stop LONG price", step=0.01)
stop_short = input.float(0.0, title="Stop SHORT price", step=0.01)

// Or — if your signals store entry/stop/TP in variables already, reference those
// tp1_long  = entryPrice + (rr_target * stopDistance)   // example if you calc inline

// Detect close conditions on bar close
tp1_long_hit   = close >= tp1_long  and tp1_long  > 0
tp1_short_hit  = close <= tp1_short and tp1_short > 0
stop_long_hit  = close <= stop_long  and stop_long  > 0
stop_short_hit = close >= stop_short and stop_short > 0

// Alert conditions — one alert object per condition
alertcondition(tp1_long_hit,   title="CI — TP1 Hit LONG",    message="TP1_LONG_HIT")
alertcondition(tp1_short_hit,  title="CI — TP1 Hit SHORT",   message="TP1_SHORT_HIT")
alertcondition(stop_long_hit,  title="CI — Stop Hit LONG",   message="STOP_LONG_HIT")
alertcondition(stop_short_hit, title="CI — Stop Hit SHORT",  message="STOP_SHORT_HIT")
```

> **Note:** If your script already tracks position state (e.g. `strategy.position_size`),
> you can use `strategy.closedtrades` events instead of price-level comparisons.
> The payload format below works regardless of detection method.

---

## Step 2 — Create four alerts in TradingView

In TradingView: **Alerts → Create Alert**. Repeat for each of the four conditions.

### Alert settings (same for all four):

| Field | Value |
|-------|-------|
| Condition | Select your script, then the matching alertcondition |
| Trigger | Once Per Bar Close |
| Expiration | Open-ended |
| Webhook URL | `https://web-production-078a.up.railway.app/api/webhook?secret=YOUR_WEBHOOK_SECRET` |
| Message | See payload below — one per alert |

### Alert message payloads

**Alert 1 — TP1 Hit LONG:**
```json
{
  "close_reason": "tp1",
  "direction": "LONG",
  "exit_price": {{close}},
  "signal_id": "{{strategy.order.id}}",
  "ticker": "{{ticker}}",
  "timestamp": "{{timenow}}"
}
```

**Alert 2 — TP1 Hit SHORT:**
```json
{
  "close_reason": "tp1",
  "direction": "SHORT",
  "exit_price": {{close}},
  "signal_id": "{{strategy.order.id}}",
  "ticker": "{{ticker}}",
  "timestamp": "{{timenow}}"
}
```

**Alert 3 — Stopped Out LONG:**
```json
{
  "close_reason": "stop",
  "direction": "LONG",
  "exit_price": {{close}},
  "signal_id": "{{strategy.order.id}}",
  "ticker": "{{ticker}}",
  "timestamp": "{{timenow}}"
}
```

**Alert 4 — Stopped Out SHORT:**
```json
{
  "close_reason": "stop",
  "direction": "SHORT",
  "exit_price": {{close}},
  "signal_id": "{{strategy.order.id}}",
  "ticker": "{{ticker}}",
  "timestamp": "{{timenow}}"
}
```

> `{{strategy.order.id}}` only populates inside a `strategy()` script. If you're
> using an `indicator()` script, replace with a hardcoded placeholder like
> `"manual"` for now — the webhook-close route will match on the most recent
> open journal entry if signal_id is absent or `"manual"`.

---

## Step 3 — Verify the webhook router handles close payloads

The Railway webhook router at `src/app/api/webhook/route.ts` inspects the
payload and routes based on the presence of `close_reason`:

```typescript
// Existing router logic (already shipped in commit fc3cf9d)
if (body.close_reason) {
  // → forward to /api/webhook-close
} else if (body.direction) {
  // → forward to /api/webhook-signal
}
```

No code changes needed. The routing is already live.

---

## Step 4 — Test the pipeline

### Manual test (curl):
```bash
# Simulate a stop-out on a LONG
curl -X POST "https://web-production-078a.up.railway.app/api/webhook?secret=YOUR_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "close_reason": "stop",
    "direction": "LONG",
    "exit_price": 78.20,
    "signal_id": "manual",
    "ticker": "CL1!",
    "timestamp": "2026-04-29T10:00:00Z"
  }'
```

Expected: journal entry with status `open` → flipped to `stopped_out`.
Post-mortem fires within ~5 seconds. Check Vercel function logs to confirm.

### Check post-mortem health:
```bash
curl -s https://crude-intentions.vercel.app/api/journal/postmortem-health | jq .
```
All four fields should be `true`.

---

## What fires automatically after a close alert lands

1. `webhook-close` resolves the journal entry (sets exit_price, outcome, R)
2. `calibration.ts` recalculates the full snapshot (win rate, Sharpe, Wilson CI)
3. `market-memory.ts` updates ALFRED's persistent context with the outcome
4. `post-mortem.ts` fires ALFRED analysis — coaching note auto-appears in journal
5. Phase 3 gate counter increments toward 20 live closed trades

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Alert fires but journal doesn't update | Wrong webhook URL or secret | Verify URL has `?secret=` matching `WEBHOOK_SECRET` env var |
| `signal_id not found` in logs | `{{strategy.order.id}}` not resolving | Use `"manual"` as signal_id — route falls back to latest open entry |
| Post-mortem doesn't fire | `VERCEL_APP_URL` not set on Railway | Add var: `https://crude-intentions.vercel.app` |
| Alert fires twice | Trigger set to "Every bar" not "Once per bar close" | Change trigger condition in TradingView alert settings |
| TP2 never auto-resolves | TP2 alert not created | Add two more alerts mirroring TP1 but with `"close_reason": "tp2"` |

---

*Commit this file to `docs/PINE_SCRIPT_CLOSE_ALERT.md` if not already present.*
