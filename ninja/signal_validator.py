from dataclasses import dataclass
from typing import Optional
import math

@dataclass
class Signal:
    direction: str
    entry: float
    stop: float
    tp1: float
    tp2: float
    contracts: int
    score: int
    grade: str
    signal_id: str
    session: str
    timestamp: str

def validate_signal(signal: Signal, config: dict) -> tuple[bool, str]:
    if signal.direction not in ("LONG", "SHORT"):
        return False, f"direction '{signal.direction}' not LONG or SHORT"
    exec_cfg = config["execution"]
    if signal.score < exec_cfg["min_score"]:
        return False, f"score {signal.score} below minimum {exec_cfg['min_score']}"
    if signal.grade not in ("A+", "A"):
        return False, f"grade '{signal.grade}' not A+ or A"
    if signal.session not in exec_cfg["allowed_sessions"]:
        return False, f"session '{signal.session}' not in allowed sessions"
    apex_cfg = config["apex_account"]
    if signal.contracts < 1 or signal.contracts > apex_cfg["max_contracts"]:
        return False, f"contracts {signal.contracts} out of range [1, {apex_cfg['max_contracts']}]"
    if not signal.signal_id:
        return False, "signal_id is empty"
    if signal.direction == "LONG":
        if not (signal.stop < signal.entry < signal.tp1 < signal.tp2):
            return False, "LONG price order invalid: need stop < entry < tp1 < tp2"
        risk = signal.entry - signal.stop
        if risk <= 0:
            return False, "risk is zero or negative"
        rr = (signal.tp1 - signal.entry) / risk
    else:
        if not (signal.stop > signal.entry > signal.tp1 > signal.tp2):
            return False, "SHORT price order invalid: need stop > entry > tp1 > tp2"
        risk = signal.stop - signal.entry
        if risk <= 0:
            return False, "risk is zero or negative"
        rr = (signal.entry - signal.tp1) / risk
    if rr < 1.5:
        return False, f"R:R {rr:.2f} below minimum 1.5"
    return True, ""

def is_price_current(entry: float, current_price: float, tolerance_pct: float = 0.5) -> bool:
    if current_price <= 0:
        return False
    return abs(entry - current_price) / current_price * 100 <= tolerance_pct

def calculate_targets(entry: float, stop: float, direction: str) -> tuple[float, float]:
    if direction == "LONG":
        risk = entry - stop
        tp1 = round(entry + 2 * risk, 2)
        tp2 = round(entry + 4 * risk, 2)
    else:
        risk = stop - entry
        tp1 = round(entry - 2 * risk, 2)
        tp2 = round(entry - 4 * risk, 2)
    return tp1, tp2

def calculate_contracts(score: int, account_balance: float, entry: float, stop: float, max_contracts: int) -> int:
    risk_per_contract = abs(entry - stop) * 100 * 10
    if risk_per_contract <= 0:
        return 1
    contracts = math.floor(account_balance * 0.01 / risk_per_contract)
    return max(1, min(contracts, max_contracts))
