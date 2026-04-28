# Pine Script — Close Alert Setup

This document specifies how to wire TradingView Pine Script close alerts into the
CRUDE INTENTIONS A+B auto-outcome system. The close alert tells the dashboard
when an open trade has hit TP1, TP2, or its protective stop, so journal entries
auto-resolve into WIN / LOSS / SCRATCH without manual logging.

---

## Webhook URL

Point the TradingView alert at the Railway proxy (which forwards to the Vercel
deployment):

```
https://<railway-app>.up.railway.app/webhook-close
```

If you are testing directly against Vercel:

```
https://<vercel-deployment>/api/webhook-close
```

> **Auth fallback for TradingView.** TradingView does NOT support outbound HMAC
> signing. Append a query param secret instead:
>
> ```
> https://<host>/webhook-close?secret=YOUR_WEBHOOK_SECRET
> ```
>
> The route accepts either an `x-signature` HMAC-SHA256 header (for non-TV
> callers like NinjaTrader) **or** a `?secret=` query param matching
> `WEBHOOK_SECRET`. Use one or the other.

---

## Storing `signal_id` in Pine Script

The dashboard matches close alerts to open journal entries by `signal_id`, which
is the same ID returned when the entry alert fires (`CI-YYYY-MM-DD-NNN`).

In Pine Script, persist the open trade's id in a `var` and pass it to
`strategy.entry()` / `strategy.order()` via `comment=`. TradingView will then
expose it in close alerts as `{{strategy.order.comment}}`.

```pinescript
//@version=5
strategy("CL A+ Strategy", overlay=true)

// Persist the active signal_id across bars
var string activeSignalId = na

// On entry — populate signal_id from the entry webhook response or
// pre-generate it locally and POST it to /webhook-signal first.
if (longCondition)
    activeSignalId := "CI-" + str.format_time(time, "yyyy-MM-dd") + "-001"
    strategy.entry("LONG", strategy.long, comment=activeSignalId)

// Define TP1 / Stop levels relative to entry
tp1 = strategy.position_avg_price + 2 * (strategy.position_avg_price - stopPrice)
stop = stopPrice

// Exits — comment carries the signal_id forward to the close alert
strategy.exit("TP1", from_entry="LONG", limit=tp1, stop=stop,
              comment_profit="TP1_HIT", comment_loss="STOPPED_OUT")
```

Notes:

- `comment_profit` / `comment_loss` on `strategy.exit` does NOT propagate the
  `signal_id`. Use a separate `alert()` call inside the exit-condition block,
  or use `strategy.order.comment` in the alert message template.
- Easiest pattern: set the `comment` on entry to the `signal_id`, then the
  close alert's `{{strategy.order.comment}}` resolves to that same id.

---

## Alert Conditions

Fire the close alert when any of the following occur:

| Direction | Condition                              | `close_reason` |
| --------- | -------------------------------------- | -------------- |
| LONG      | `close >= tp1_price`                   | `TP1_HIT`      |
| LONG      | `close <= stop_price`                  | `STOPPED_OUT`  |
| SHORT     | `close <= tp1_price`                   | `TP1_HIT`      |
| SHORT     | `close >= stop_price`                  | `STOPPED_OUT`  |

If the strategy supports a TP2 leg, fire a second alert with `TP2_HIT` when
`close >= tp2_price` (LONG) or `close <= tp2_price` (SHORT).

For breakeven exits (manual or rule-based), use `BREAKEVEN`. For any operator
override, use `MANUAL`.

---

## Alert JSON Payload

In the TradingView alert dialog, set **Message** to the JSON below. TradingView
will substitute the `{{...}}` placeholders at fire time.

```json
{
  "signal_id": "{{strategy.order.comment}}",
  "close_price": {{close}},
  "close_reason": "TP1_HIT",
  "ticks_pnl": 0
}
```

Field reference:

- `signal_id` — required. Must match an OPEN journal entry id.
- `close_price` — required. The fill price on the bar that triggered the alert.
- `close_reason` — required. One of `TP1_HIT`, `TP2_HIT`, `STOPPED_OUT`,
  `BREAKEVEN`, `MANUAL`.
- `ticks_pnl` — optional. If omitted, the server computes it from
  `close_price` vs the journal entry's `entry_price` using the standard CL
  contract tick of $0.01 (×100 ticks per dollar).

You will need **one alert per close reason** (TradingView does not support
conditional payloads). Create:

1. `LONG TP1_HIT` — fires on `close >= tp1_price` while `direction == LONG`
2. `LONG STOPPED_OUT` — fires on `close <= stop_price` while `direction == LONG`
3. `SHORT TP1_HIT` — fires on `close <= tp1_price` while `direction == SHORT`
4. `SHORT STOPPED_OUT` — fires on `close >= stop_price` while `direction == SHORT`

Each alert hard-codes its `close_reason` in the JSON message body.

---

## Server Response

On success the route returns:

```json
{ "ok": true, "signal_id": "CI-2026-04-28-007", "outcome": "WIN" }
```

Possible error responses:

- `401` — bad or missing secret / signature.
- `404` — no journal entry matches `signal_id`.
- `409` — entry was already closed (idempotent rejection).
- `400` — invalid JSON or schema-violating payload.

---

## End-to-end flow

1. Entry alert fires → POST `/webhook-signal` → ALFRED scores → journal entry
   written with `entry_price`, `stop_price`, `tp1_price`, `tp2_price` and id
   `CI-YYYY-MM-DD-NNN`.
2. Pine Script stores that id in `var string activeSignalId` and feeds it to
   `strategy.entry(comment=...)`.
3. Price hits TP1 or stop → close alert fires → POST `/webhook-close` with the
   stored `signal_id`.
4. Server flips entry status from `OPEN` to `WIN` / `LOSS` / `SCRATCH`,
   recalculates calibration, and fires the post-mortem in the background.
