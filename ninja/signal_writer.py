import csv
import json
import os
from datetime import datetime, timezone

SIGNAL_HEADERS = [
    "DateTime", "Instrument", "Direction", "Entry_Price",
    "Stop_Loss", "TP1", "TP2", "Contracts", "Status",
    "Score", "Grade", "Signal_ID"
]

OUTCOME_HEADERS = [
    "Signal_ID", "Close_Time", "Close_Price",
    "Ticks_PnL", "Dollars_PnL", "Close_Reason"
]

def ensure_csv(filepath: str, headers: list) -> None:
    if not os.path.exists(filepath):
        with open(filepath, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()

def write_signal(signal, data_dir: str, signals_file: str, log_file: str) -> str:
    signals_path = os.path.join(data_dir, signals_file)
    log_path = os.path.join(data_dir, log_file)
    ensure_csv(signals_path, SIGNAL_HEADERS)
    row = {
        "DateTime": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "Instrument": "CL",
        "Direction": signal.direction,
        "Entry_Price": signal.entry,
        "Stop_Loss": signal.stop,
        "TP1": signal.tp1,
        "TP2": signal.tp2,
        "Contracts": signal.contracts,
        "Status": "READY",
        "Score": signal.score,
        "Grade": signal.grade,
        "Signal_ID": signal.signal_id,
    }
    with open(signals_path, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=SIGNAL_HEADERS)
        writer.writerow(row)
    log_entry = {"timestamp": row["DateTime"], "signal_id": signal.signal_id, "payload": row}
    logs = []
    if os.path.exists(log_path):
        try:
            with open(log_path) as lf:
                logs = json.load(lf)
        except Exception:
            logs = []
    logs.append(log_entry)
    with open(log_path, "w") as lf:
        json.dump(logs, lf, indent=2)
    print(f"[SIGNAL WRITER] Written {signal.signal_id} → {signals_path}")
    return signal.signal_id

def read_new_outcomes(data_dir: str, outcomes_file: str, seen_ids: set) -> list:
    path = os.path.join(data_dir, outcomes_file)
    if not os.path.exists(path):
        return []
    results = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sid = row.get("Signal_ID", "")
            if sid and sid not in seen_ids:
                results.append(dict(row))
    return results

def mark_signal_status(data_dir: str, signals_file: str, signal_id: str, status: str) -> None:
    path = os.path.join(data_dir, signals_file)
    if not os.path.exists(path):
        return
    rows = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("Signal_ID") == signal_id:
                row["Status"] = status
            rows.append(row)
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=SIGNAL_HEADERS)
        writer.writeheader()
        writer.writerows(rows)
