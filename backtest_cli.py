#!/usr/bin/env python3
"""
CRUDE INTENTIONS — Backtest CLI Wrapper

Thin wrapper around backtest_engine.py for running historical backtests
against a 1-minute CL CSV exported from NinjaTrader instead of pulling
Yahoo Finance daily bars.

Pipeline:
  1. Load 1-min CSV from --csv path (auto-detects {Date,Time,...} or
     {Datetime,...} header layouts)
  2. Localize naive timestamps to America/New_York (NinjaTrader default)
  3. Resample to 15-min and 4H bars
  4. Run backtest_engine.compute_indicators(df_4h) — EMA20/50/200, RSI(14), ATR(14)
  5. Walk the 4H frame, calling detect_signal + simulate for each bar
  6. Compute extended stats: win rate, profit factor, expectancy R,
     Sharpe-style ratio, max drawdown, total R, equity curve
  7. Print summary, optionally write {--output} JSON and {--equity-curve} CSV

The core signal detection + trade simulation logic in backtest_engine.py
is imported as-is and not modified. This wrapper only adds I/O, resampling,
and extended-stats computation.

Usage:
  python backtest_cli.py --csv data/CL_1min.csv
  python backtest_cli.py --csv data/CL_1min.csv --output results.json
  python backtest_cli.py --csv data/CL_1min.csv --equity-curve equity.csv
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from backtest_engine import (
    compute_indicators,
    detect_signal,
    simulate,
    HOLD_BARS,
    PRICE_MIN,
    PRICE_MAX,
)

NY_TZ = ZoneInfo("America/New_York")
UTC = datetime.timezone.utc


# ─── CSV loading ────────────────────────────────────────────────────────────

def load_nt_csv(path: Path) -> pd.DataFrame:
    """Load a NinjaTrader 1-min CSV into a tz-aware NY-local DataFrame
    indexed by timestamp with Open/High/Low/Close/Volume columns."""
    raw = pd.read_csv(path)
    cols_lower = {c.lower(): c for c in raw.columns}

    # Resolve a single timestamp column from common NT layouts.
    if "datetime" in cols_lower:
        ts = pd.to_datetime(raw[cols_lower["datetime"]])
    elif "date" in cols_lower and "time" in cols_lower:
        ts = pd.to_datetime(
            raw[cols_lower["date"]].astype(str) + " " + raw[cols_lower["time"]].astype(str)
        )
    elif "timestamp" in cols_lower:
        ts = pd.to_datetime(raw[cols_lower["timestamp"]])
    else:
        raise ValueError(
            f"Could not find a timestamp column in {path}. "
            f"Expected one of: Datetime / Date+Time / Timestamp. Got: {list(raw.columns)}"
        )

    # Localize to NY if naive — NinjaTrader exports default to local time.
    if ts.dt.tz is None:
        ts = ts.dt.tz_localize(NY_TZ, ambiguous="infer", nonexistent="shift_forward")
    else:
        ts = ts.dt.tz_convert(NY_TZ)

    def col(*names: str) -> str:
        for n in names:
            if n.lower() in cols_lower:
                return cols_lower[n.lower()]
        raise ValueError(f"Missing required column. Tried: {names}")

    df = pd.DataFrame({
        "Open":   raw[col("Open")].astype(float),
        "High":   raw[col("High")].astype(float),
        "Low":    raw[col("Low")].astype(float),
        "Close":  raw[col("Close")].astype(float),
        "Volume": raw[col("Volume")].astype(float) if "volume" in cols_lower else 0.0,
    })
    df.index = ts
    df.index.name = "timestamp"
    df = df.sort_index()
    df = df[~df.index.duplicated(keep="last")]
    return df


def resample_ohlcv(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample a 1-min bar frame to a higher timeframe (e.g. '15min', '4h')."""
    out = df.resample(rule).agg({
        "Open":   "first",
        "High":   "max",
        "Low":    "min",
        "Close":  "last",
        "Volume": "sum",
    })
    out = out.dropna(subset=["Open", "High", "Low", "Close"])
    return out


# ─── Signal walk ────────────────────────────────────────────────────────────

def run_backtest(df_4h: pd.DataFrame) -> list[dict]:
    """Walk the 4H frame and return a list of trade dicts (one per signal)."""
    df = compute_indicators(df_4h)
    trades: list[dict] = []
    last_sig_idx: int | None = None

    for i in range(len(df)):
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

        signal_ts = df.index[i]
        close_ts = df.index[i + 1 + sim["close_idx"]]

        trades.append({
            "signal_at": signal_ts.tz_convert(UTC).isoformat(),
            "close_at":  close_ts.tz_convert(UTC).isoformat(),
            "direction": direction,
            "entry_price": round(entry_price, 2),
            "stop_price": sim["stop_price"],
            "tp1_price": sim["tp1_price"],
            "tp2_price": sim["tp2_price"],
            "close_price": sim["close_price"],
            "status": sim["status"],
            "ticks_pnl": sim["ticks_pnl"],
            "result_r": sim["result_r"],
            "rsi": round(float(row["rsi"]), 2),
            "ema20": round(float(row["ema20"]), 4),
            "ema50": round(float(row["ema50"]), 4),
            "ema200": round(float(row["ema200"]), 4),
            "atr": round(float(row["atr"]), 4),
        })
        last_sig_idx = i

    return trades


# ─── Stats ──────────────────────────────────────────────────────────────────

def compute_stats(trades: list[dict]) -> dict:
    n = len(trades)
    if n == 0:
        return {
            "total_trades": 0,
            "wins": 0, "losses": 0, "scratches": 0,
            "win_rate": 0.0,
            "avg_r": 0.0, "avg_win_r": 0.0, "avg_loss_r": 0.0,
            "expectancy_r": 0.0,
            "profit_factor": 0.0,
            "total_r": 0.0,
            "sharpe_per_trade": 0.0,
            "max_drawdown_r": 0.0,
            "max_drawdown_pct_of_peak": 0.0,
        }

    rs = np.array([float(t["result_r"]) for t in trades], dtype=float)
    statuses = [t["status"] for t in trades]

    wins = sum(1 for s in statuses if s == "WIN")
    losses = sum(1 for s in statuses if s == "LOSS")
    scratches = sum(1 for s in statuses if s == "SCRATCH")
    decisive = wins + losses

    win_r = rs[rs > 0]
    loss_r = rs[rs < 0]

    win_rate = (wins / decisive * 100.0) if decisive > 0 else 0.0
    avg_r = float(rs.mean()) if n > 0 else 0.0
    avg_win_r = float(win_r.mean()) if win_r.size > 0 else 0.0
    avg_loss_r = float(loss_r.mean()) if loss_r.size > 0 else 0.0

    p = win_rate / 100.0
    expectancy_r = p * avg_win_r + (1 - p) * avg_loss_r

    gross_win = float(win_r.sum())
    gross_loss = float(-loss_r.sum())  # positive number
    profit_factor = (gross_win / gross_loss) if gross_loss > 0 else float("inf") if gross_win > 0 else 0.0

    sharpe_per_trade = float(rs.mean() / rs.std(ddof=1)) if n > 1 and rs.std(ddof=1) > 0 else 0.0

    cum = rs.cumsum()
    peak = np.maximum.accumulate(cum)
    drawdowns = peak - cum
    max_dd_r = float(drawdowns.max()) if drawdowns.size > 0 else 0.0
    peak_at_max_dd = float(peak[drawdowns.argmax()]) if drawdowns.size > 0 else 0.0
    max_dd_pct = (max_dd_r / peak_at_max_dd * 100.0) if peak_at_max_dd > 0 else 0.0

    return {
        "total_trades": n,
        "wins": wins, "losses": losses, "scratches": scratches,
        "win_rate": round(win_rate, 2),
        "avg_r": round(avg_r, 3),
        "avg_win_r": round(avg_win_r, 3),
        "avg_loss_r": round(avg_loss_r, 3),
        "expectancy_r": round(expectancy_r, 3),
        "profit_factor": round(profit_factor, 3) if np.isfinite(profit_factor) else None,
        "total_r": round(float(rs.sum()), 3),
        "sharpe_per_trade": round(sharpe_per_trade, 3),
        "max_drawdown_r": round(max_dd_r, 3),
        "max_drawdown_pct_of_peak": round(max_dd_pct, 2),
    }


def write_equity_curve(trades: list[dict], path: Path) -> None:
    rows = []
    cum = 0.0
    for i, t in enumerate(trades):
        cum += float(t["result_r"])
        rows.append({
            "trade_index": i + 1,
            "close_at": t["close_at"],
            "direction": t["direction"],
            "status": t["status"],
            "result_r": t["result_r"],
            "cumulative_r": round(cum, 3),
        })
    pd.DataFrame(rows).to_csv(path, index=False)


def print_report(stats: dict, csv_path: Path, bars_4h: int, bars_15m: int) -> None:
    print()
    print("=== CRUDE INTENTIONS Backtest Report ===")
    print(f"Source CSV       : {csv_path}")
    print(f"4H bars          : {bars_4h}")
    print(f"15M bars         : {bars_15m}")
    print(f"Trades generated : {stats['total_trades']}")
    print(f"  WIN     : {stats['wins']}")
    print(f"  LOSS    : {stats['losses']}")
    print(f"  SCRATCH : {stats['scratches']}")
    print()
    print(f"Win rate         : {stats['win_rate']:.2f}%")
    print(f"Avg R            : {stats['avg_r']:+.3f}")
    print(f"Avg WIN R        : {stats['avg_win_r']:+.3f}")
    print(f"Avg LOSS R       : {stats['avg_loss_r']:+.3f}")
    print(f"Expectancy R     : {stats['expectancy_r']:+.3f}")
    pf = stats["profit_factor"]
    print(f"Profit factor    : {pf if pf is not None else '∞'}")
    print(f"Total R          : {stats['total_r']:+.3f}")
    print(f"Sharpe (trade)   : {stats['sharpe_per_trade']:+.3f}")
    print(f"Max drawdown R   : {stats['max_drawdown_r']:.3f}  ({stats['max_drawdown_pct_of_peak']:.2f}% of peak)")
    print()


# ─── CLI ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Run the CRUDE INTENTIONS backtest against a NinjaTrader 1-min CL CSV.",
    )
    ap.add_argument("--csv", required=True, type=Path, help="Path to 1-min CL CSV exported from NinjaTrader")
    ap.add_argument("--output", type=Path, default=None, help="Write {stats, trades, ...} JSON to this path")
    ap.add_argument("--equity-curve", type=Path, default=None, help="Write per-trade equity curve CSV to this path")
    args = ap.parse_args()

    if not args.csv.exists():
        print(f"ERROR: CSV not found: {args.csv}", file=sys.stderr)
        return 2

    print(f"Loading {args.csv}…")
    df_1m = load_nt_csv(args.csv)
    if df_1m.empty:
        print("ERROR: CSV produced an empty frame after parsing", file=sys.stderr)
        return 3
    print(f"Loaded {len(df_1m)} 1-min bars from {df_1m.index[0]} to {df_1m.index[-1]}")

    df_15m = resample_ohlcv(df_1m, "15min")
    df_4h = resample_ohlcv(df_1m, "4h")
    print(f"Resampled → {len(df_15m)} 15-min bars, {len(df_4h)} 4H bars")

    trades = run_backtest(df_4h)
    stats = compute_stats(trades)
    print_report(stats, args.csv, bars_4h=len(df_4h), bars_15m=len(df_15m))

    if args.output:
        payload = {
            "source_csv": str(args.csv),
            "generated_at": datetime.datetime.now(tz=UTC).isoformat(),
            "bars": {"one_min": len(df_1m), "fifteen_min": len(df_15m), "four_hour": len(df_4h)},
            "stats": stats,
            "trades": trades,
        }
        args.output.write_text(json.dumps(payload, indent=2))
        print(f"Wrote results JSON → {args.output}")

    if args.equity_curve:
        write_equity_curve(trades, args.equity_curve)
        print(f"Wrote equity curve CSV → {args.equity_curve}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
