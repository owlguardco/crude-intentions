#!/usr/bin/env python3
"""
CRUDE INTENTIONS — Backtest Importer

Reads backtest_output.json and POSTs to /api/journal/import in batches of
50 (the route caps at 50 per call). Per-batch summary printed.

Required env:
  INTERNAL_API_KEY      — used as x-api-key header
  CRUDE_INTENTIONS_URL  — optional, defaults to http://localhost:3000

Usage:
  INTERNAL_API_KEY=... python3 import_backtest.py
  CRUDE_INTENTIONS_URL=https://your-app.vercel.app INTERNAL_API_KEY=... python3 import_backtest.py
"""
import json
import os
import sys

import requests

INPUT_PATH = "backtest_output.json"
BATCH_SIZE = 50
DEFAULT_URL = "http://localhost:3000"


def main():
    base_url = os.environ.get("CRUDE_INTENTIONS_URL", DEFAULT_URL).rstrip("/")
    api_key = os.environ.get("INTERNAL_API_KEY")

    if not api_key:
        print("ERROR: INTERNAL_API_KEY env var is not set", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(INPUT_PATH):
        print(f"ERROR: {INPUT_PATH} not found. Run backtest_engine.py first.", file=sys.stderr)
        sys.exit(1)

    with open(INPUT_PATH) as f:
        trades = json.load(f)

    if not isinstance(trades, list) or len(trades) == 0:
        print("ERROR: backtest_output.json is empty or not an array", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(trades)} trades from {INPUT_PATH}")
    print(f"Target : {base_url}/api/journal/import")
    print(f"Batches: {(len(trades) + BATCH_SIZE - 1) // BATCH_SIZE} (size {BATCH_SIZE})")

    url = f"{base_url}/api/journal/import"
    headers = {"Content-Type": "application/json", "x-api-key": api_key}

    total_imported = 0
    total_skipped = 0

    for batch_idx, start in enumerate(range(0, len(trades), BATCH_SIZE)):
        batch = trades[start : start + BATCH_SIZE]
        print()
        print(f"--- Batch {batch_idx + 1}: trades {start + 1}..{start + len(batch)} ---")
        try:
            res = requests.post(url, headers=headers, json={"trades": batch}, timeout=120)
        except Exception as e:
            print(f"  REQUEST FAILED: {e}", file=sys.stderr)
            continue

        if res.status_code != 200:
            print(f"  HTTP {res.status_code}: {res.text[:500]}")
            continue

        body = res.json()
        imported = int(body.get("imported", 0))
        skipped = int(body.get("skipped", 0))
        errs = body.get("errors", []) or []
        total_imported += imported
        total_skipped += skipped
        print(f"  imported: {imported}  ·  skipped: {skipped}")
        for e in errs[:5]:
            print(f"    ! [{e.get('index')}] {e.get('message')}")
        if len(errs) > 5:
            print(f"    ... and {len(errs) - 5} more error(s)")

    print()
    print("=== Final ===")
    print(f"Total imported: {total_imported}")
    print(f"Total skipped : {total_skipped}")


if __name__ == "__main__":
    main()
