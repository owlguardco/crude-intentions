# CRUDE INTENTIONS — Session Handoff

**Date:** 2026-04-30
**Branch:** main (pushed through `ab62023`)
**Checklist version:** v1.9
**Repo:** github.com/owlguardco/crude-intentions

---

## Checklist Summary

- **Total points:** 12
- **Minimum to trade:** 9/12
- **Countertrend minimum:** 11/12
- **Hard blocks (override all scores):** EIA window active, OVX > 50

---

## All 12 Checklist Points

### Layer 1 — Daily / Weekly (Macro Bias) · 2 pts

1. **ema_stack_aligned** — Daily EMA20/50/200 aligned in trade direction; weekly EMA200 slope agrees.
2. **daily_confirms** — Sunday weekly bias is LONG (for longs) or SHORT (for shorts), not NEUTRAL.

### Layer 2 — 4H Momentum · 2 pts

3. **rsi_reset_zone** — 4H RSI 35–55 (longs) or 45–65 (shorts).
4. **volume_confirmed** — 15-min trigger candle volume ≥ 20-bar session average. Institutional participation present.

### Layer 3 — Structure · 2 pts

5. **price_at_key_level** — *(FVG-required, v1.9)* Unfilled 4H FVG exists, age < 75 bars, midpoint not breached, AND price inside the gap or within 0.10 of the relevant edge (top for longs, bottom for shorts). EMA20 / round-level / VWAP proximity are quality boosters only — they cannot pass this point alone.
6. **rr_valid** — 2:1 minimum R/R from 15-min entry to TP1 with stop at the 15-min structural level.

### Layer 4 — HTF Context · 2 pts

7. **session_timing** — NY Open window (9:30–11:45 AM ET primary), London or Overlap acceptable. Asia / Off-hours fail.
8. **eia_window_clear** — Not within EIA hard block (Wed 7:30 AM–1:30 PM ET).

### Layer 5 — 15-min Trigger · 2 pts

9. **vwap_aligned** — Price above session VWAP (longs) or below (shorts).
10. **htf_structure_clear** — No daily/weekly S/R within 0.50 capping the trade.

### Layer 6 — Pre-Session Context · 2 pts *(v1.9 add)*

11. **overnight_range_position** *(4-state)* — PASS: price above Asia session high (longs) or below Asia session low (shorts) at NY open. CONDITIONAL: within 0.15 of the relevant edge. FAIL: buried in the Asia range. N/A: data not provided.
12. **ovx_regime** *(4-state)* — PASS: OVX 20–35 (clean regime). CONDITIONAL: 35–50 (elevated, size down). FAIL: > 50 (hard block) or < 20 (dead tape). N/A: data not provided.

> Items 1–10 are binary PASS/FAIL. Items 11–12 may emit CONDITIONAL or N/A. CONDITIONAL contributes 0 to the score but is not an auto-fail.

---

## Grading Table

| Score   | Grade | Confidence  | Sizing             | Decision        |
|---------|-------|-------------|--------------------|------------------|
| 12/12   | A+    | CONVICTION  | Full size          | TAKE THE TRADE   |
| 10–11   | A     | HIGH        | Standard size      | TAKE THE TRADE   |
| 9       | B+    | MEDIUM      | Half size          | TAKE THE TRADE   |
| 7–8     | B     | LOW         | —                  | NO TRADE         |
| 0–6     | F     | LOW         | —                  | NO TRADE         |

**Countertrend (opposing weekly bias):** 11/12 minimum required.

---

## What Changed From v1.8

### 1. MACD → volume_confirmed (item 4)

The `macd_confirming` factor was retired and replaced by `volume_confirmed`. Pass condition: 15-min trigger candle volume ≥ 20-bar session average. The 0.85x–0.99x band is "weak" — flagged in the detail string but does not auto-pass. Below 0.85x = FAIL. Schema, ALFRED prompts, fallback scorer, calibration `FactorKey`, and `rules.json` were all migrated in a single breaking rename.

### 2. Layer 6 added (PRE-SESSION) — items 11 + 12

Two new factors added without altering the existing 10 layers:
- **overnight_range_position** — captures whether NY-open price has cleared the Asia session range in the trade direction.
- **ovx_regime** — classifies implied crude vol regime (clean / elevated / chaos / dead).

Both use a 4-state (`PASS|CONDITIONAL|FAIL|N/A`) `C4` schema item. CONDITIONAL contributes 0 to score but does not auto-fail.

### 3. FVG required for Layer 2 structural entry (item 5)

Item 5 (`price_at_key_level`) was previously an OR — could pass on EMA20 alone, FVG alone, or VWAP alone. v1.9 makes the FVG the **required** condition. EMA20 + round-level + freshness + size become quality boosters mentioned in the detail string but never PASS/FAIL drivers.

Thresholds (in `fvg_rules` block of `rules.json`):
- `pass_proximity`: 0.10 — price inside the gap or within $0.10 of the relevant edge
- `conditional_proximity`: 0.20 — approaching, treated as FAIL with "approaching" detail
- `fail_proximity`: 0.30 — no FVG context at all
- `max_age_bars`: 75 — older = stale, FAIL
- `fresh_age_bars`: 25 — booster: "fresh gap"
- `ema20_confluence`: 0.15 — booster: "high conviction zone"
- `round_level_confluence`: 0.10 — booster: "institutional confluence"
- `large_gap_size`: 0.30 — booster: "large imbalance"

The deterministic fallback scorer (`src/lib/alfred/fallback-scorer.ts`) carries an `fvg_age_bars` input field and implements the full proximity / midpoint / age engine. Webhooks already pass `fvg_age` from TradingView through to ALFRED + fallback.

### 4. Scoring expanded 10 → 12 points

| Threshold            | v1.8         | v1.9         |
|----------------------|--------------|--------------|
| Total points         | 10           | 12           |
| Minimum to trade     | 7            | 9            |
| Countertrend minimum | 9            | 11           |
| A+ score             | 10/10        | 12/12        |
| A score              | 8–9/10       | 10–11/12     |
| B+ score             | 7/10         | 9/12         |
| `score` schema cap   | `int().max(10)` | `int().max(12)` |
| Reasoning string     | `/10`        | `/12`        |

All `/10` → `/12` references migrated: postmortem prompt, post-mortem.ts, webhook adversarial prompt, position page ALFRED SCORE display, JournalTable score column, ConfidenceLabel tiers, fallback-scorer `scoreToGrade`.

---

## Hard Blocks

These override the checklist regardless of score:

1. **EIA window** — Wed 7:30 AM–1:30 PM ET. 12/12 during EIA = NO TRADE.
2. **OVX > 50** — Extreme implied crude vol. Auto-fail item 12, blocks the trade.
3. **Asia / Off-hours session** — Fails item 7 and adds a blocked reason; fallback scorer rejects to NO TRADE.

---

## System State

### Journal
- **146 historical backtest entries** loaded (5-year CL=F daily OHLCV via `backtest_engine.py` + `import_backtest.py`). All carry `historical: true` + `backtest_source: true`. They show `N/A` for `overnight_range_position` and `ovx_regime` — daily OHLCV cannot evaluate session-bound signals. They are excluded from cohort stats but counted in `totals.historical_closed`.
- **0 live trades** since v1.9 went live today.

### Calibration
- Snapshot recalculation works (`recalculateCalibration()`); banner reads "HISTORICAL — backtest only" until live trades land.
- **Waiting on 20 live closed trades** before live cohort win-rate becomes meaningful.
- `by_factor` breakdown will start populating live data for items 4 (volume) + 11 (overnight) + 12 (ovx) once trades close.

### Deployment
- Vercel auto-deploys on push. `923f216` + `ab62023` already pushed to `main`.
- `npx tsc --noEmit`: clean.
- Env vars set: `INTERNAL_API_KEY`, `ANTHROPIC_API_KEY`, `EIA_API_KEY`, `CRON_SECRET`, `VERCEL_APP_URL`.

### Untracked Local Work (NOT pushed)
- `.DS_Store` (should be `.gitignored`).
- `ninja/` Tradovate broker scaffolding: `tradovate_client.py`, `tradovate_executor.py`, `kill_switch.py`, `order_validator.py`, `env.tradovate.example`. Phase 3 / 20-trade-gate territory — separate workstream.

---

## Next Session Options

### Track A — Live data feed
1. **Pine Script update** — add `htf_ema_stack`, `setup_ema_stack`, `asia_high`, `asia_low`, `fvg_age` to TradingView webhook payload. Without these, ALFRED falls through CONDITIONAL/N/A on items 11–12 and FAIL-or-stale on item 5.
2. **Weekly bias UI surface** — render `weekly_bias` on dashboard home; currently only available via `/api/weekly-brief`.
3. **Street Pulse real implementation** — replace the NEUTRAL/0 stub with actual aggregation of Truth Social / Baker Hughes / EIA / DXY signals.

### Track B — Trade-gate progress
4. **Tradovate broker integration** — finish the `ninja/` scaffolding, wire to webhook-close path, run paper executions on live ALFRED signals to start filling the 20-trade live cohort.
5. **vectorbt 5-yr backtest** — port `backtest_engine.py` to vectorbt for proper position sizing + slippage + fee modeling. Re-import with v1.9 12-point output (overnight + OVX still N/A but factor-1-through-10 will be richer).
6. **ATR-based stop simulation refinement** — current backtest stops are 1.5x daily ATR; tune against the new 12-point scoring.

### Track C — v1.9 calibration audit
7. **Schedule a 14-day audit** — once 5–10 live trades close under v1.9, run a cohort comparison vs the historical backtest. Surface item 5 (FVG-required) impact: how often does the new tighter rule reject setups the old OR-logic would have passed? Did the rejected ones underperform the kept ones?
8. **Layer 6 acceptance testing** — verify ALFRED is correctly emitting CONDITIONAL vs FAIL on items 11/12 with edge-case inputs (price exactly at Asia high, OVX exactly 35.0, etc.).

### Track D — Operational
9. **Add `.DS_Store` to `.gitignore`** — keep macOS junk out of `git status`.
10. **Pin `claude-sonnet-4-5` model version** — confirm no drift in ALFRED scoring across model updates by adding an integration test that runs a known-good setup against the live model.

---

## Key Files Touched Today

```
backtest_engine.py                            (rules_version 1.9, N/A entries for items 11+12)
src/data/rules.json                           (v1.9 strategy, layer_6_session_context, fvg_rules, indicators, scoring expanded)
src/lib/validation/journal-schema.ts          (score max 12, C4 4-state items, two new keys)
src/lib/alfred/confidence.ts                  (12-point ConfidenceLabel tiers)
src/lib/alfred/fallback-scorer.ts             (FVG-required logic, fvg_age_bars input, quality boosters, /12 reasoning)
src/lib/journal/calibration.ts                (FactorKey + FACTOR_KEYS expanded)
src/lib/journal/post-mortem.ts                (/10 → /12)
src/app/api/analyze-setup/route.ts            (SYSTEM_PROMPT v1.9, asia_high/low inputs, FVG SCORING RULES, item 5 rewrite)
src/app/api/webhook-signal/route.ts           (ALFRED_SYSTEM_PROMPT v1.9, FVG RULES line, fvg_age threading, asia_high/low schema)
src/app/api/journal/[id]/postmortem/route.ts  (/10 → /12)
src/app/pre-trade/page.tsx                    (SESSION CONTEXT input fields, FVG hint, score clamp 12, rules_version 1.9)
src/app/journal/page.tsx                      (FACTOR_LABELS, guided wizard placeholderChecklist with N/A entries + FVG detail)
src/app/calibration/page.tsx                  (FACTOR_LABELS expanded)
src/app/page.tsx                              (CHECKLIST_ITEMS expanded to 12, score badge 12/12)
src/app/position/page.tsx                     (/10 → /12)
src/components/JournalTable.tsx               (/10 → /12)
```

---

## Git State

```
ab62023 feat: Layer 2 Point 2 — FVG required for structural entry (was OR EMA20/FVG/VWAP)
923f216 feat: A+ checklist v1.9 — Layer 6 PRE-SESSION (overnight range + OVX regime), 10→12 points
```

Both commits pushed to `origin/main`. Vercel deploy should be live.
