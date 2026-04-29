// CRUDE INTENTIONS — Tactical Entry Alignment (4H setup ↔ 15m structure ↔ 5m trigger)
//
// Pure function. Distinct from src/lib/alfred/mtf-consensus.ts which scores
// macro context (Daily/4H/1H weighted). This one scores tactical alignment
// at trigger time: does the higher-timeframe EMA stack agree with the lower-
// timeframe stack, and do they both agree with the trigger direction?

export type EmaStack = 'BULLISH' | 'BEARISH' | 'MIXED';
export type TriggerDirection = 'LONG' | 'SHORT' | 'NO TRADE';

export interface EntryAlignmentInput {
  htf_ema_stack: EmaStack;
  setup_ema_stack: EmaStack;
  trigger_direction: TriggerDirection;
}

export interface EntryAlignmentResult {
  score: 0 | 1 | 2 | 3;
  label: 'ALIGNED' | 'MIXED' | 'CONFLICTED';
  breakdown: string[];
}

function agreesWithDirection(stack: EmaStack, dir: TriggerDirection): boolean {
  if (dir === 'LONG' && stack === 'BULLISH') return true;
  if (dir === 'SHORT' && stack === 'BEARISH') return true;
  return false;
}

export function computeEntryAlignment(input: EntryAlignmentInput): EntryAlignmentResult {
  const { htf_ema_stack, setup_ema_stack, trigger_direction } = input;

  const htfAgrees = agreesWithDirection(htf_ema_stack, trigger_direction);
  const setupAgrees = agreesWithDirection(setup_ema_stack, trigger_direction);
  const bothAgree = htfAgrees && setupAgrees;

  let score: 0 | 1 | 2 | 3 = 0;
  if (htfAgrees) score = (score + 1) as 0 | 1 | 2 | 3;
  if (setupAgrees) score = (score + 1) as 0 | 1 | 2 | 3;
  if (bothAgree) score = (score + 1) as 0 | 1 | 2 | 3;

  const breakdown: string[] = [
    `HTF (4H) stack ${htf_ema_stack}: ${htfAgrees ? 'agrees with' : 'does not agree with'} ${trigger_direction}`,
    `Setup (15m) stack ${setup_ema_stack}: ${setupAgrees ? 'agrees with' : 'does not agree with'} ${trigger_direction}`,
    bothAgree
      ? 'Both timeframes confirm trigger direction'
      : 'Cross-timeframe confirmation missing',
  ];

  const label: EntryAlignmentResult['label'] =
    score === 3 ? 'ALIGNED' : score === 0 ? 'CONFLICTED' : 'MIXED';

  return { score, label, breakdown };
}
