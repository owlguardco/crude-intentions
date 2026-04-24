import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const LOG_PATH = join(process.cwd(), "src/data/safety_check_log.json");

export async function GET() {
  try {
    const raw = readFileSync(LOG_PATH, "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Could not read log file" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const entry = await req.json();
    const raw = readFileSync(LOG_PATH, "utf-8");
    const log = JSON.parse(raw);

    log.decisions.push(entry);
    log.summary.total_evaluations = log.decisions.length;
    log.summary.trades_taken = log.decisions.filter((d: any) => d.decision !== "NO TRADE").length;
    log.summary.trades_blocked = log.decisions.filter((d: any) => d.decision === "NO TRADE").length;
    log.summary.last_updated = new Date().toISOString();

    writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
