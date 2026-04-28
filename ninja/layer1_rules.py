import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

def load_rules(rules_path: str) -> dict:
    try:
        with open(rules_path) as f:
            return json.load(f)
    except Exception:
        return {
            "ema": {"require_stack": True},
            "rsi": {"long_min": 35, "long_max": 55, "short_min": 45, "short_max": 65},
        }

def check_ema_stack(ema20: float, ema50: float, ema200: float, direction: str) -> bool:
    if direction == "LONG":
        return ema20 > ema50 > ema200
    elif direction == "SHORT":
        return ema20 < ema50 < ema200
    return False

def check_rsi_zone(rsi: float, direction: str) -> bool:
    if direction == "LONG":
        return 35 <= rsi <= 55
    elif direction == "SHORT":
        return 45 <= rsi <= 65
    return False

def check_session(session: str, allowed: list) -> bool:
    return session in allowed

def check_eia_window(now: datetime) -> bool:
    et_now = now.astimezone(ET)
    if et_now.weekday() != 2:
        return False
    hour, minute = et_now.hour, et_now.minute
    minutes_since_midnight = hour * 60 + minute
    return 10 * 60 <= minutes_since_midnight <= 11 * 60 + 30

def check_fvg_proximity(price: float, fvgs: list, tolerance_ticks: int = 10) -> bool:
    tolerance = tolerance_ticks * 0.01
    for fvg in fvgs:
        top = fvg.get("top", 0)
        bottom = fvg.get("bottom", 0)
        if (bottom - tolerance) <= price <= (top + tolerance):
            return True
    return False

def run_layer1(market_data: dict, config: dict) -> tuple[bool, list]:
    reasons = []
    direction = market_data.get("direction", "")
    exec_cfg = config.get("execution", {})
    allowed_sessions = exec_cfg.get("allowed_sessions", [])
    block_eia = exec_cfg.get("block_eia_window", True)

    ema_ok = check_ema_stack(
        market_data.get("ema20", 0),
        market_data.get("ema50", 0),
        market_data.get("ema200", 0),
        direction,
    )
    reasons.append(f"EMA stack: {'PASS' if ema_ok else 'FAIL'}")

    rsi_ok = check_rsi_zone(market_data.get("rsi", 50), direction)
    reasons.append(f"RSI zone: {'PASS' if rsi_ok else 'FAIL'}")

    session_ok = check_session(market_data.get("session", ""), allowed_sessions)
    reasons.append(f"Session: {'PASS' if session_ok else 'FAIL'}")

    eia_blocked = block_eia and check_eia_window(datetime.now(timezone.utc))
    reasons.append(f"EIA window: {'BLOCKED' if eia_blocked else 'CLEAR'}")

    fvg_ok = check_fvg_proximity(
        market_data.get("price", 0),
        market_data.get("fvgs", []),
    )
    reasons.append(f"FVG proximity: {'PASS' if fvg_ok else 'FAIL'}")

    should_trigger = ema_ok and rsi_ok and session_ok and not eia_blocked and fvg_ok
    return should_trigger, reasons
