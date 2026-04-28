# CRUDE INTENTIONS — NinjaTrader CSV Bridge (Phase 3 Part 1)

Local Python agent that runs on the trading machine alongside NinjaTrader 8.
It bridges the deployed Crude Intentions webhook server (Railway) and
NinjaTrader by writing trade signals to CSV and reading outcome CSVs back.

This agent does **not** place trades automatically. It only writes CSV
signals that NinjaTrader strategies/indicators can consume — execution
remains a manual or NinjaScript-controlled step.

## Prerequisites

- **Python 3.10+** (3.11 recommended)
- **NinjaTrader 8** installed on the same machine
- **Apex** funded/eval account with paper-mode enabled while testing
- Network access to your Railway-deployed Crude Intentions server

## Install

```bash
cd ninja
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

## Configure

```bash
cp config.example.json config.json
```

Then edit `config.json`:

- `webhook_url` — your Railway server origin (no trailing slash)
- `internal_api_key` — must match `INTERNAL_API_KEY` on the server
- `data_dir` — where signal/outcome CSVs are written (created if missing)
- `apex_account.*` — guardrails enforced before any signal is written
- `execution.*` — score / grade / session gates and stale-signal cutoff

## Run

```bash
python agent.py
```

The agent runs as a long-lived loop. It polls the webhook server for new
signals, applies the Apex + execution gates, and writes one row per
qualifying signal to `<data_dir>/<signals_file>`. Closed-trade outcomes
are read back from `<data_dir>/<outcomes_file>` and POSTed to the server.

## Pointing NinjaTrader at the CSV

In NinjaTrader's Control Center → New → NinjaScript Editor, point your
strategy or indicator at the absolute path of `signals_file` from
`config.json` (default: `./data/trade_signals.csv`).

A reference NinjaScript reader is **not** included in this part — Part 2
ships the NinjaScript side. For Part 1, manual visual inspection of the
CSV is enough to verify the bridge is writing rows correctly.

## Logs

The agent appends one JSON line per processed signal to
`<data_dir>/<log_file>` (default: `signal_writer_log.json`). Each entry
records the decision, the gate that allowed or blocked it, and a
timestamp. Tail this file to debug.

## Safety

- `apex_account.paper_mode: true` is the default. Keep it true until
  the bridge has run cleanly across a full session.
- `apex_account.max_daily_loss_dollars` and `max_consecutive_losses` are
  enforced locally — the agent stops writing signals once either trips.
- `execution.stale_signal_seconds` discards signals older than the
  threshold so a webhook backlog cannot fire stale entries.
