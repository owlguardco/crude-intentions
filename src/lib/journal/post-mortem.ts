/**
 * CRUDE INTENTIONS — Post-Mortem Auto-Fire
 *
 * firePostMortem(entry) — fire-and-forget. Generates a 3-sentence post-mortem
 * via Anthropic and PATCHes /api/journal/[id]/outcome with { postmortem } to
 * write it into the journal entry without re-triggering calibration.
 *
 * Never throws, never blocks. Errors are swallowed with a console.error.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CalibrationEntry } from '@/lib/journal/calibration';

const SYSTEM_PROMPT =
  'You are a trading coach reviewing a closed CL futures trade. Be direct, ' +
  'specific, and clinical. No fluff. 3 sentences maximum.';

type EntryWithLevels = CalibrationEntry & {
  stop_price?: number | null;
  tp1_price?: number | null;
};

function buildUserPrompt(entry: EntryWithLevels): string {
  const cl = entry.checklist ?? {};
  let passes = 0;
  let fails = 0;
  for (const v of Object.values(cl)) {
    if (v?.result === 'PASS') passes++;
    else if (v?.result === 'FAIL') fails++;
  }
  const o = entry.outcome ?? {};
  const lines = [
    `Direction: ${entry.direction}`,
    `Grade: ${entry.grade} (score ${entry.score}/12)`,
    `Checklist: ${passes} pass / ${fails} fail`,
    `Entry: ${entry.entry_price ?? 'N/A'}`,
    `Stop: ${entry.stop_price ?? entry.stop_loss ?? 'N/A'}`,
    `TP1: ${entry.tp1_price ?? 'N/A'}`,
    `Outcome: ${o.status ?? 'N/A'}`,
    `Ticks PnL: ${o.result ?? 'N/A'}`,
    `R-multiple: ${o.result_r != null ? o.result_r.toFixed(2) + 'R' : 'N/A'}`,
    '',
    'What did this trade do well, what failed, and what is the one thing to watch for next time?',
  ];
  return lines.join('\n');
}

export function firePostMortem(entry: CalibrationEntry): void {
  void (async () => {
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const internalKey = process.env.INTERNAL_API_KEY;
      const baseUrl = process.env.VERCEL_APP_URL;

      // Explicit per-env-var guards so a missing config produces a
      // specific Vercel log line instead of a swallowed network error
      // against `undefined/api/...`.
      if (!baseUrl) {
        console.error(
          `[POSTMORTEM] VERCEL_APP_URL not set — skipping post-mortem for ${entry.id}`,
        );
        return;
      }
      if (!internalKey) {
        console.error(
          `[POSTMORTEM] INTERNAL_API_KEY not set — skipping post-mortem for ${entry.id}`,
        );
        return;
      }
      if (!apiKey) {
        console.error(
          `[POSTMORTEM] ANTHROPIC_API_KEY not set — skipping post-mortem for ${entry.id}`,
        );
        return;
      }

      const client = new Anthropic({ apiKey });
      const res = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(entry as EntryWithLevels) }],
      });

      const block = res.content[0];
      const text = block && block.type === 'text' ? block.text.trim() : '';
      if (!text) {
        console.error('[POSTMORTEM] empty completion');
        return;
      }

      const url = `${baseUrl.replace(/\/$/, '')}/api/journal/${entry.id}/outcome`;
      const patchRes = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': internalKey,
        },
        body: JSON.stringify({ postmortem: text }),
      });
      if (!patchRes.ok) {
        const detail = await patchRes.text().catch(() => '');
        console.error('[POSTMORTEM] patch failed', patchRes.status, detail);
      }
    } catch (err) {
      console.error('[POSTMORTEM]', err);
    }
  })();
}
