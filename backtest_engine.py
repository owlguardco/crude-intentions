#!/usr/bin/env python3
"""
CRUDE INTENTIONS — 5yr historical backtest engine (Part 1)

Pulls 5y of CL=F daily OHLCV from Yahoo, computes EMA20/50/200, RSI(14),
ATR(14), simulates an EMA-stack + RSI-reset entry rule, walks the next
10 bars to determine WIN / LOSS / SCRATCH against a 1.5x ATR stop and
2R / 4R TP ladder, and writes JournalWriteSchema-shaped entries to
backtest_output.json. Cap at 200 most recent trades.

All entries are stamped historical=True and backtest_source=True so the
calibration engine excludes them from cohort breakdowns while still
counting them toward totals.trades_closed.
"""
import datetime
import json
import sys
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf

NY_TZ = ZoneInfo("America/New_York")
UTC = datetime.timezone.utc


def to_utc_iso(date_like, hour: int, minute: int) -> str:
    """Return an ISO-8601 UTC string for the given NY-local date + clock time."""
    d = pd.Timestamp(date_like).date()
    dt_et = datetime.datetime(d.year, d.month, d.day, hour, minute, 0, tzinfo=NY_TZ)
    dt_utc = dt_et.astimezone(UTC)
    return dt_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")

OUTPUT_PATH = "backtest_output.json"
MAX_TRADES = 200
HOLD_BARS = 10
MIN_GAP_BARS = 5
ATR_MULT = 1.5
TICK = 0.01
DOLLARS_PER_TICK = 10
PRICE_MIN, PRICE_MAX = 10.0, 500.0


def round2(x):
    return round(float(x), 2)


def round1(x):
    return round(float(x), 1)


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ema20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["ema50"] = df["Close"].ewm(span=50, adjust=False).mean()
    df["ema200"] = df["Close"].ewm(span=200, adjust=False).mean()

    delta = df["Close"].diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    df["rsi"] = (100 - (100 / (1 + rs))).fillna(50.0)

    high_low = df["High"] - df["Low"]
    high_close = (df["High"] - df["Close"].shift()).abs()
    low_close = (df["Low"] - df["Close"].shift()).abs()
    tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
    return df


def detect_signal(row, prev_idx, idx):
    if not all(np.isfinite([row["ema20"], row["ema50"], row["ema200"], row["rsi"], row["atr"]])):
        return None
    if not (40.0 <= row["rsi"] <= 60.0):
        return None
    if prev_idx is not None and idx - prev_idx < MIN_GAP_BARS:
        return None
    if row["ema20"] > row["ema50"] > row["ema200"]:
        return "LONG"
    if row["ema20"] < row["ema50"] < row["ema200"]:
        return "SHORT"
    return None


def simulate(direction, entry, atr, future):
    risk = ATR_MULT * atr
    if direction == "LONG":
        stop = entry - risk
        tp1 = entry + 2 * risk
        tp2 = entry + 4 * risk
    else:
        stop = entry + risk
        tp1 = entry - 2 * risk
        tp2 = entry - 4 * risk

    if not (PRICE_MIN <= stop <= PRICE_MAX and PRICE_MIN <= tp1 <= PRICE_MAX and PRICE_MIN <= tp2 <= PRICE_MAX):
        return None
    risk_ticks = abs(entry - stop) / TICK
    if risk_ticks <= 0:
        return None

    status = None
    close_price = None
    close_idx = None

    for i, (_, bar) in enumerate(future.iterrows()):
        if direction == "LONG":
            hit_tp = bar["High"] >= tp1
            hit_stop = bar["Low"] <= stop
        else:
            hit_tp = bar["Low"] <= tp1
            hit_stop = bar["High"] >= stop
        if hit_tp and hit_stop:
            # Conservative: assume stop fills first when both touch
            close_price = stop
            status = "LOSS"
            close_idx = i
            break
        if hit_tp:
            close_price = tp1
            status = "WIN"
            close_idx = i
            break
        if hit_stop:
            close_price = stop
            status = "LOSS"
            close_idx = i
            break

    if status is None:
        if len(future) == 0:
            return None
        close_price = float(future.iloc[-1]["Close"])
        status = "SCRATCH"
        close_idx = len(future) - 1

    if direction == "LONG":
        ticks_pnl = round1((close_price - entry) / TICK)
    else:
        ticks_pnl = round1((entry - close_price) / TICK)
    result_r = round(ticks_pnl / risk_ticks, 2)

    return {
        "stop_price": round2(stop),
        "tp1_price": round2(tp1),
        "tp2_price": round2(tp2),
        "risk_ticks": risk_ticks,
        "close_price": round2(close_price),
        "close_idx": close_idx,
        "status": status,
        "ticks_pnl": ticks_pnl,
        "result_r": result_r,
    }


def build_entry(date_signal, date_close, direction, entry, sim, ema20, ema50, ema200, rsi):
    score = 3  # 3 PASSes out of 12
    grade = "F"
    pass_item = lambda detail: {"result": "PASS", "detail": detail}
    fail_default = {"result": "FAIL", "detail": "Approximated from daily OHLCV — not evaluated"}
    na_default = {"result": "N/A", "detail": "Not available in daily OHLCV backtest data"}

    checklist = {
        "ema_stack_aligned": pass_item(f"EMA20/50/200 stacked {direction.lower()} on daily"),
        "daily_confirms": fail_default,
        "rsi_reset_zone": pass_item(f"RSI {rsi:.1f} in 40-60 reset band"),
        "volume_confirmed": fail_default,
        "price_at_key_level": fail_default,
        "rr_valid": fail_default,
        "session_timing": pass_item("Daily-bar approximation, stamped NY_OPEN"),
        "eia_window_clear": fail_default,
        "vwap_aligned": fail_default,
        "htf_structure_clear": fail_default,
        "overnight_range_position": na_default,
        "ovx_regime": na_default,
    }

    # 09:30 ET signal entry; close stamped at 16:00 ET on the close bar.
    # Both converted to UTC per-date so EDT/EST transitions are honored.
    signal_iso = to_utc_iso(date_signal, 9, 30)
    close_iso = to_utc_iso(date_close, 16, 0)

    return {
        "rules_version": "1.9",
        "session": "NY_OPEN",
        "direction": direction,
        "source": "IMPORT",
        "score": score,
        "grade": grade,
        "confidence_label": "MEDIUM",
        "entry_price": round2(entry),
        "stop_loss": sim["stop_price"],
        "take_profit_1": sim["tp1_price"],
        "take_profit_2": sim["tp2_price"],
        "contracts": 1,
        "risk_dollars": round2(sim["risk_ticks"] * DOLLARS_PER_TICK),
        "checklist": checklist,
        "blocked_reasons": [],
        "wait_for": None,
        "reasoning": (
            f"Backtested signal — EMA stack {direction}, RSI {rsi:.1f}, "
            f"ATR stop {sim['stop_price']:.2f}"
        ),
        "market_context_snapshot": {
            "price": round2(entry),
            "ema20": round2(ema20),
            "ema50": round2(ema50),
            "ema200": round2(ema200),
            "rsi": round1(rsi),
            "ovx": 0,
            "dxy": "Unknown",
        },
        "paper_trading": False,
        "historical": True,
        "alfred_fallback": True,
        "postmortem": None,
        "stop_price": sim["stop_price"],
        "tp1_price": sim["tp1_price"],
        "tp2_price": sim["tp2_price"],
        "backtest_source": True,
        "supply_context": None,
        "timestamp": signal_iso,
        "outcome": {
            "status": sim["status"],
            "result": sim["ticks_pnl"],
            "result_r": sim["result_r"],
            "close_price": sim["close_price"],
            "close_timestamp": close_iso,
        },
    }


def main():
    print("Fetching CL=F 5y daily OHLCV from Yahoo Finance...")
    df = yf.download("CL=F", period="5y", interval="1d", auto_adjust=False, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna()
    if len(df) == 0:
        print("ERROR: no data returned from Yahoo", file=sys.stderr)
        sys.exit(1)
    print(f"Fetched {len(df)} bars from {df.index[0].date()} to {df.index[-1].date()}")

    df = compute_indicators(df)

    trades = []
    last_sig_idx = None
    scanned = 0

    for i in range(len(df)):
        scanned += 1
        row = df.iloc[i]
        direction = detect_signal(row, last_sig_idx, i)
        if direction is None:
            continue
        if i + 1 >= len(df):
            break
        future = df.iloc[i + 1 : i + 1 + HOLD_BARS]
        sim = simulate(direction, float(row["Close"]), float(row["atr"]), future)
        if sim is None:
            continue
        entry_price = float(row["Close"])
        if not (PRICE_MIN <= entry_price <= PRICE_MAX):
            continue
        signal_date = df.index[i]
        close_date = df.index[i + 1 + sim["close_idx"]]
        trades.append(
            build_entry(
                signal_date,
                close_date,
                direction,
                entry_price,
                sim,
                float(row["ema20"]),
                float(row["ema50"]),
                float(row["ema200"]),
                float(row["rsi"]),
            )
        )
        last_sig_idx = i

    if len(trades) > MAX_TRADES:
        trades = trades[-MAX_TRADES:]

    with open(OUTPUT_PATH, "w") as f:
        json.dump(trades, f, indent=2)

    wins = sum(1 for t in trades if t["outcome"]["status"] == "WIN")
    losses = sum(1 for t in trades if t["outcome"]["status"] == "LOSS")
    scratches = sum(1 for t in trades if t["outcome"]["status"] == "SCRATCH")
    decisive = wins + losses
    win_rate = (wins / decisive * 100) if decisive > 0 else 0.0
    avg_r = (sum(t["outcome"]["result_r"] for t in trades) / len(trades)) if trades else 0.0

    print()
    print("=== Backtest Summary ===")
    print(f"Bars scanned    : {scanned}")
    print(f"Trades generated: {len(trades)}")
    print(f"  WIN     : {wins}")
    print(f"  LOSS    : {losses}")
    print(f"  SCRATCH : {scratches}")
    print(f"Win rate        : {win_rate:.1f}%  (decisive {decisive})")
    print(f"Avg R           : {avg_r:+.2f}")
    print(f"Output          : {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
