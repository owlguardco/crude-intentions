#!/usr/bin/env python3
import json
import os
import time
import threading
import uuid
from datetime import datetime, timezone
from dotenv import load_dotenv

from signal_validator import Signal, validate_signal, calculate_targets, calculate_contracts
from signal_writer import ensure_csv, write_signal, mark_signal_status, SIGNAL_HEADERS, OUTCOME_HEADERS
from outcome_logger import run_outcome_watcher
from layer1_rules import run_layer1, load_rules

def load_config(path: str = "config.json") -> dict:
    with open(path) as f:
        return json.load(f)

def build_signal_from_payload(payload: dict, config: dict) -> Signal:
    direction = payload.get("direction", "NO TRADE")
    entry = float(payload.get("entry_price", 0))
    stop = float(payload.get("stop_loss", 0))
    score = int(payload.get("score", 0))
    grade = payload.get("grade", "F")
    session = payload.get("session", "")
    account_balance = float(os.getenv("APEX_BALANCE", "50000"))
    max_contracts = config["apex_account"]["max_contracts"]
    contracts = calculate_contracts(score, account_balance, entry, stop, max_contracts)
    tp1, tp2 = calculate_targets(entry, stop, direction)
    signal_id = payload.get("signal_id") or f"CI-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}-{uuid.uuid4().hex[:6].upper()}"
    return Signal(
        direction=direction,
        entry=entry,
        stop=stop,
        tp1=tp1,
        tp2=tp2,
        contracts=contracts,
        score=score,
        grade=grade,
        signal_id=signal_id,
        session=session,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

def process_webhook_signal(payload: dict, config: dict, rules: dict) -> None:
    print(f"[AGENT] Processing signal: {payload.get('direction')} @ {payload.get('entry_price')}")
    market_data = {
        "direction": payload.get("direction", ""),
        "ema20": float(payload.get("ema20", 0)),
        "ema50": float(payload.get("ema50", 0)),
        "ema200": float(payload.get("ema200", 0)),
        "rsi": float(payload.get("rsi", 50)),
        "price": float(payload.get("entry_price", 0)),
        "session": payload.get("session", ""),
        "fvgs": payload.get("fvgs", []),
    }
    should_trigger, reasons = run_layer1(market_data, config)
    for reason in reasons:
        print(f"  [L1] {reason}")
    if not should_trigger:
        print("[AGENT] Layer 1 SKIP — signal not written")
        return
    signal = build_signal_from_payload(payload, config)
    valid, reason = validate_signal(signal, config)
    if not valid:
        print(f"[AGENT] Validation FAIL: {reason}")
        mark_signal_status(config["data_dir"], config["signals_file"], signal.signal_id, "BLOCKED")
        return
    if config["apex_account"]["paper_mode"]:
        print("[AGENT] PAPER MODE — signal valid, writing CSV")
    write_signal(signal, config["data_dir"], config["signals_file"], config["log_file"])
    print(f"[AGENT] Signal {signal.signal_id} written with status READY")

def start_outcome_watcher(config: dict) -> None:
    seen_ids: set = set()
    t = threading.Thread(target=run_outcome_watcher, args=(config, seen_ids), daemon=True)
    t.start()
    print("[AGENT] Outcome watcher started in background")

def main():
    load_dotenv()
    config = load_config()
    rules = load_rules("../crude_intentions_rules_v2_0.json")
    os.makedirs(config["data_dir"], exist_ok=True)
    ensure_csv(os.path.join(config["data_dir"], config["signals_file"]), SIGNAL_HEADERS)
    ensure_csv(os.path.join(config["data_dir"], config["outcomes_file"]), OUTCOME_HEADERS)
    print("[CRUDE INTENTIONS] NinjaTrader Bridge Agent started")
    print(f"[CONFIG] Paper mode: {config['apex_account']['paper_mode']}")
    print(f"[CONFIG] Min score: {config['execution']['min_score']}")
    print(f"[CONFIG] Data dir: {config['data_dir']}")
    start_outcome_watcher(config)
    while True:
        time.sleep(1)

if __name__ == "__main__":
    main()
