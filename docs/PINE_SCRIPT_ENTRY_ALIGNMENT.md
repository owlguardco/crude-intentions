# PINE SCRIPT ENTRY ALIGNMENT — Crude Intentions
### File: docs/PINE_SCRIPT_ENTRY_ALIGNMENT.md
### Purpose: Add EMA stack fields to entry alert payload to unlock entry alignment scoring

---

## Overview

The entry alignment scorer (`src/lib/mtf/consensus.ts`) grades how well the
live signal's EMA structure matches the expected setup. It needs two fields
from the alert payload that are NOT currently in the Pine Script:

| Field | Timeframe | What it is |
|-------|-----------|------------|
| `htf_ema_stack` | 4H | EMA20/50/200 alignment on the 4-hour chart |
| `setup_ema_stack` | 15m | EMA alignment on the 15-minute trigger chart |

Without these fields, `entry_alignment_score` shows as `null` on every live
signal. Adding them takes ~10 minutes in TradingView.

---

## Step 1 — Add EMA stack detection to your Pine Script

Open your CL1! 15-minute Pine Script. Add the following code.

```pine
// ─────────────────────────────────────────────────────────────────────────────
// EMA STACK DETECTION — add near the top of your script, after indicator()
// ─────────────────────────────────────────────────────────────────────────────

// 15-minute EMAs (current chart timeframe)
ema20_15m  = ta.ema(close, 20)
ema50_15m  = ta.ema(close, 50)
ema200_15m = ta.ema(close, 200)

// 4-hour EMAs via request.security()
ema20_4h  = request.security("CL1!", "240", ta.ema(close, 20),  lookahead=barmerge.lookahead_off)
ema50_4h  = request.security("CL1!", "240", ta.ema(close, 50),  lookahead=barmerge.lookahead_off)
ema200_4h = request.security("CL1!", "240", ta.ema(close, 200), lookahead=barmerge.lookahead_off)

// Stack alignment — returns "bullish", "bearish", or "mixed"
setup_ema_stack_val = ema20_15m > ema50_15m and ema50_15m > ema200_15m ? "bullish" :
                     ema20_15m < ema50_15m and ema50_15m < ema200_15m ? "bearish" : "mixed"

htf_ema_stack_val   = ema20_4h > ema50_4h and ema50_4h > ema200_4h ? "bullish" :
                      ema20_4h < ema50_4h and ema50_4h < ema200_4h ? "bearish" : "mixed"
```

> **Note:** `request.security()` with `lookahead_off` is required for
> non-repainting 4H data on a 15-minute chart. This is the correct pattern.

---

## Step 2 — Update your entry alert message payload

Find your existing entry alert in TradingView (the one that fires to Railway
on signal detection). Update the **Message** field to include the two new fields.

### Current payload (before):
```json
{
  "direction": "{{plot_0}}",
  "price": {{close}},
  "rsi": {{plot_1}},
  "ticker": "{{ticker}}",
  "timestamp": "{{timenow}}"
}
```

### Updated payload (after) — add the two EMA stack fields:
```json
{
  "direction": "{{plot_0}}",
  "price": {{close}},
  "rsi": {{plot_1}},
  "ticker": "{{ticker}}",
  "timestamp": "{{timenow}}",
  "htf_ema_stack": "{{plot("htf_ema_stack_val")}}",
  "setup_ema_stack": "{{plot("setup_ema_stack_val")}}"
}
```

> **Alternative — use `tostring()` plots:**
> Pine Script can't template string variables directly in alert messages.
> The cleanest approach is to export the string via a numeric plot and map
> it server-side, OR use the `str.format` + `alert()` approach below:

### Recommended approach — use `alert()` call directly (most reliable):

Replace your existing `alertcondition()` entry alert with an `alert()` call
that builds the full JSON string inline:

```pine
// Build the alert message string
if entry_signal  // replace with your actual entry condition variable
    alert(
        str.format(
            '{{ "direction": "{0}", "price": {1}, "rsi": {2}, "ticker": "{3}", "timestamp": "{4}", "htf_ema_stack": "{5}", "setup_ema_stack": "{6}" }}',
            direction_str,         // "LONG" or "SHORT"
            str.tostring(close, "#.##"),
            str.tostring(rsi_val, "#.##"),
            syminfo.ticker,
            str.tostring(timenow),
            htf_ema_stack_val,     // "bullish" / "bearish" / "mixed"
            setup_ema_stack_val    // "bullish" / "bearish" / "mixed"
        ),
        alert.freq_once_per_bar_close
    )
```

> `str.format` uses `{0}`, `{1}`, etc. (not `%s`). Curly braces in JSON must
> be doubled: `{{` and `}}` to escape them inside `str.format`.

---

## Step 3 — Verify the webhook-signal route handles the new fields

The existing route at `src/app/api/webhook-signal/route.ts` already passes
the full payload to the entry alignment scorer. No backend changes needed —
the fields flow through automatically once they're present in the payload.

To confirm after your first live signal with the updated alert:

```bash
curl -s "https://crude-intentions.vercel.app/api/journal" \
  -H "x-api-key: YOUR_INTERNAL_API_KEY" | jq '.[0].entry_alignment'
```

Expected: an object with `htf_ema_stack`, `setup_ema_stack`, and a numeric
`alignment_score` — not `null`.

---

## What entry alignment scoring unlocks

Once both fields are present in the payload, the consensus scorer calculates:

| Factor | Weight | Logic |
|--------|--------|-------|
| 4H EMA stack matches signal direction | 2 pts | `htf_ema_stack == "bullish"` for LONG |
| 15m EMA stack matches signal direction | 1 pt | `setup_ema_stack == "bullish"` for LONG |
| HTF/setup stacks agree | 1 pt | Both same value |

Max alignment score: 4/4. Displayed in the pre-trade output card and
surfaced in ALFRED's A+ checklist scoring under Layer 1 (Trend).

---

## EMA Stack Values Reference

| Value | Meaning |
|-------|---------|
| `"bullish"` | EMA20 > EMA50 > EMA200 — full bull stack |
| `"bearish"` | EMA20 < EMA50 < EMA200 — full bear stack |
| `"mixed"` | Any other arrangement — no directional conviction |

ALFRED interprets `"mixed"` as a partial fail on the EMA stack checklist item,
not a hard stop — the overall score is reduced but the trade isn't blocked.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `entry_alignment` still null after update | Alert message not saved | Re-create the alert in TradingView — edits don't always save reliably |
| 4H EMA values look wrong | Lookahead issue | Confirm `lookahead=barmerge.lookahead_off` in `request.security()` |
| JSON parse error in Railway logs | Unescaped braces in `str.format` | Double all JSON braces: `{{` and `}}` |
| `htf_ema_stack` showing as number | Using `plot()` approach wrong | Switch to `alert()` with `str.format` as shown above |

---

*Commit this file to `docs/PINE_SCRIPT_ENTRY_ALIGNMENT.md` if not already present.*
