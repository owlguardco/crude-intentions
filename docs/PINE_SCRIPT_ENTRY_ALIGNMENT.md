# Pine Script — Entry Alignment Payload Guide

This document is an **incremental update** to the entry-signal alert that
fires from TradingView into `/api/webhook-signal` (or, if you're using the
unified router, `/api/webhook?secret=…`). It only covers the two new
fields needed to populate the `entry_alignment` scorer; everything else
in your existing alert stays the same.

The matching close-side doc lives at
[`docs/PINE_SCRIPT_CLOSE_ALERT.md`](./PINE_SCRIPT_CLOSE_ALERT.md). Read
that one for the close (TP1/TP2/STOPPED_OUT) payload and the
TradingView-can't-do-HMAC fallback notes.

---

## Why these two fields

The server-side scorer in `src/lib/mtf/consensus.ts` (`computeEntryAlignment`)
takes three inputs:

| Input | Source | Values |
| --- | --- | --- |
| `htf_ema_stack` | 4H chart's EMA 20/50/200 stack | `BULLISH` / `BEARISH` / `MIXED` |
| `setup_ema_stack` | 15-minute chart's EMA 20/50/200 stack | `BULLISH` / `BEARISH` / `MIXED` |
| `trigger_direction` | ALFRED's decision after scoring | `LONG` / `SHORT` / `NO TRADE` |

The trigger direction is computed server-side from ALFRED's response, so
TradingView only needs to send the two EMA-stack reads. Both are optional
on the wire — when either is omitted the route simply skips the alignment
score and the response will not include `entry_alignment`.

The score is `0–3`:
- **+1** if the HTF stack agrees with the trigger direction
- **+1** if the setup stack agrees with the trigger direction
- **+1** if both agree

Label: `3 → ALIGNED`, `1–2 → MIXED`, `0 → CONFLICTED`.

---

## How to derive each field in Pine Script

Both fields use the same rule, just on different timeframes. You compute
EMA 20 / 50 / 200 on the relevant timeframe, then label the stack:

```
IF   ema20 > ema50 > ema200   →  "BULLISH"
ELIF ema20 < ema50 < ema200   →  "BEARISH"
ELSE                           →  "MIXED"
```

### `htf_ema_stack` — 4H stack

Compute the three EMAs from the **4-hour** close series. From a chart on
any lower timeframe you can pull the higher-timeframe values via Pine's
`request.security(syminfo.tickerid, "240", ...)` (240 minutes = 4 hours).

The "BULLISH" / "BEARISH" / "MIXED" string from the rule above is what
goes on the wire as `htf_ema_stack`.

### `setup_ema_stack` — 15-minute stack

Same rule, computed on the **15-minute** close series. If the alert is
firing from a 15m chart you can read the EMAs directly off the chart's
own series with no `request.security` call.

> **Equality note.** The rule uses strict `>` and `<`. If two EMAs are
> exactly equal (rare on real prices), label `MIXED` — the scorer treats
> `MIXED` as "no agreement" so this is the safe default.

---

## What to add to the alert message

Your current entry-alert JSON (whatever you're sending today to populate
`WebhookSignal`) gets two extra string fields appended. Both are optional
— if you're not ready to compute them, leave them out entirely and the
route still works exactly as it does today.

**Add:**

```json
{
  "htf_ema_stack": "BULLISH",
  "setup_ema_stack": "MIXED"
}
```

The values are always one of `"BULLISH"`, `"BEARISH"`, `"MIXED"`. Any
other string (or null) will be silently ignored by the route — the
zod-equivalent type check is `z.enum(['BULLISH','BEARISH','MIXED'])` and
the entry_alignment computation is gated on both fields being present
and matching the enum.

In the TradingView alert dialog, you build these strings the same way
you build any other Pine value — write a `var string htfStack = "MIXED"`
that gets reassigned by the EMA-stack rule on each bar, then reference
`{{plot("htfStack")}}` (or whatever your standard interpolation is) in
the alert message.

---

## Full updated entry alert payload

This is the full JSON that goes to `/api/webhook-signal` (or the router
endpoint), with the two new fields highlighted at the bottom. Field order
does not matter — `JSON.parse` doesn't care.

```json
{
  "direction": "LONG",
  "price": 78.42,
  "ema20": 78.35,
  "ema50": 77.90,
  "ema200": 76.40,
  "rsi": 52.1,
  "macd": 0.08,
  "vwap": 78.12,
  "ovx": 28.4,
  "dxy": "neutral",
  "fvg_direction": "bullish",
  "fvg_top": 78.55,
  "fvg_bottom": 78.20,
  "fvg_age": 6,
  "session": "NY_OPEN",
  "weekly_bias": "LONG",
  "htf_resistance": 79.50,
  "htf_support": 77.80,
  "eia_active": false,
  "stop_loss": 77.90,

  "htf_ema_stack":   "BULLISH",
  "setup_ema_stack": "BULLISH"
}
```

The bottom two fields are the only adds. Everything above is the existing
schema accepted by the `WebhookSignal` interface in
`src/app/api/webhook-signal/route.ts`.

---

## Authentication and routing

Unchanged from before:

- Direct `/api/webhook-signal` requires header `x-api-key: <INTERNAL_API_KEY>`.
  TradingView can't send arbitrary headers, so this endpoint is meant to
  be called from a Railway proxy that stamps the header before forwarding.
- Unified `/api/webhook?secret=<WEBHOOK_SECRET>` accepts a query-param
  secret directly — TradingView-friendly. The router parses the body,
  detects `direction` (entry) vs. `close_reason` (close), and forwards to
  the right handler with the correct auth.

Use whichever entry point you've already wired. The two new fields ride
along inside the JSON body and don't touch auth at all.

---

## Verifying the score lands

After firing the alert, check the response from `/api/webhook-signal` (or
look at the Vercel function log for the response JSON). When both stacks
are sent and both parse as valid enum values, the response will include:

```json
{
  "received_at": "2026-04-29T20:30:00.000Z",
  "signal": { ... },
  "alfred": { "decision": "LONG", "score": 8, ... },
  "adversarial": { ... },
  "journal": { "id": "CI-2026-04-29-001", ... },
  "entry_alignment": {
    "score": 3,
    "label": "ALIGNED",
    "breakdown": [
      "HTF (4H) stack BULLISH: agrees with LONG",
      "Setup (15m) stack BULLISH: agrees with LONG",
      "Both timeframes confirm trigger direction"
    ]
  }
}
```

If `entry_alignment` is missing from the response, one of the two stacks
either wasn't sent, was an empty string, or didn't match the enum. The
existing analysis fields (`alfred`, `adversarial`, `journal`) are
unaffected either way.
