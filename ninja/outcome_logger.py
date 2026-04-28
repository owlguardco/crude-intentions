import time
import requests
from signal_writer import read_new_outcomes

CLOSE_REASON_MAP = {
    "TP1_HIT": "WIN",
    "TP2_HIT": "WIN",
    "CLOSED_PROFIT": "WIN",
    "CLOSED_LOSS": "LOSS",
    "STOPPED_OUT": "LOSS",
    "BREAKEVEN": "SCRATCH",
    "SCRATCH": "SCRATCH",
}

def post_outcome_to_journal(
    signal_id: str,
    close_price: float,
    ticks_pnl: float,
    close_reason: str,
    api_base_url: str,
    api_key: str,
) -> bool:
    status = CLOSE_REASON_MAP.get(close_reason.upper(), "SCRATCH")
    url = f"{api_base_url}/api/journal/{signal_id}/outcome"
    payload = {
        "status": status,
        "close_price": close_price,
        "result": ticks_pnl,
        "run_postmortem": True,
    }
    try:
        resp = requests.patch(url, json=payload, headers={"x-api-key": api_key}, timeout=10)
        if resp.status_code in (200, 204):
            print(f"[OUTCOME LOGGER] Posted outcome for {signal_id}: {status}")
            return True
        else:
            print(f"[OUTCOME LOGGER] Failed for {signal_id}: HTTP {resp.status_code} {resp.text}")
            return False
    except Exception as e:
        print(f"[OUTCOME LOGGER] Error posting {signal_id}: {e}")
        return False

def run_outcome_watcher(config: dict, seen_ids: set) -> None:
    api_base = config["webhook_url"].rstrip("/")
    api_key = config["internal_api_key"]
    data_dir = config["data_dir"]
    outcomes_file = config["outcomes_file"]
    print("[OUTCOME WATCHER] Started — polling every 10s")
    while True:
        try:
            new_rows = read_new_outcomes(data_dir, outcomes_file, seen_ids)
            for row in new_rows:
                sid = row["Signal_ID"]
                try:
                    close_price = float(row["Close_Price"])
                    ticks_pnl = float(row["Ticks_PnL"])
                    close_reason = row["Close_Reason"]
                    success = post_outcome_to_journal(sid, close_price, ticks_pnl, close_reason, api_base, api_key)
                    if success:
                        seen_ids.add(sid)
                except Exception as e:
                    print(f"[OUTCOME WATCHER] Error processing row {sid}: {e}")
        except Exception as e:
            print(f"[OUTCOME WATCHER] Poll error: {e}")
        time.sleep(10)
