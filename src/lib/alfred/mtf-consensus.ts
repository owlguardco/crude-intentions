// CRUDE INTENTIONS — Multi-Timeframe Consensus Layer (Phase 2D)
// Pure function: maps a per-timeframe trend vote into a weighted alignment score.

export type MTFTimeframe = '1H' | '4H' | 'D';

export interface MTFSignal {
  timeframe: MTFTimeframe;
  ema_aligned: boolean;
  rsi_value: number;
  above_vwap: boolean | null;
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
}

export interface MTFConsensusResult {
  score: number;
  label: 'ALIGNED' | 'MIXED' | 'CONFLICTED';
  aligned_count: number;
  total_tfs: number;
  dominant_trend: 'UP' | 'DOWN' | 'NEUTRAL';
  breakdown: Record<MTFTimeframe, { agrees: boolean; weight: number }>;
}

const WEIGHTS: Record<MTFTimeframe, number> = {
  D: 0.5,
  '4H': 0.35,
  '1H': 0.15,
};

export function computeMTFConsensus(signals: MTFSignal[]): MTFConsensusResult {
  const counts: Record<'UP' | 'DOWN' | 'NEUTRAL', number> = { UP: 0, DOWN: 0, NEUTRAL: 0 };
  for (const s of signals) counts[s.trend]++;

  let dominant: 'UP' | 'DOWN' | 'NEUTRAL';
  if (counts.UP > counts.DOWN && counts.UP > counts.NEUTRAL) dominant = 'UP';
  else if (counts.DOWN > counts.UP && counts.DOWN > counts.NEUTRAL) dominant = 'DOWN';
  else if (counts.NEUTRAL > counts.UP && counts.NEUTRAL > counts.DOWN) dominant = 'NEUTRAL';
  else dominant = 'NEUTRAL';

  const breakdown = {} as Record<MTFTimeframe, { agrees: boolean; weight: number }>;
  let totalWeight = 0;
  let agreedWeight = 0;
  let alignedCount = 0;

  for (const s of signals) {
    const agrees = s.trend === dominant;
    const weight = WEIGHTS[s.timeframe];
    breakdown[s.timeframe] = { agrees, weight };
    totalWeight += weight;
    if (agrees) {
      agreedWeight += weight;
      alignedCount++;
    }
  }

  const weighted_score = totalWeight > 0 ? (agreedWeight / totalWeight) * 100 : 0;
  const score = Math.round(weighted_score);

  const label: 'ALIGNED' | 'MIXED' | 'CONFLICTED' =
    score >= 70 ? 'ALIGNED' : score >= 40 ? 'MIXED' : 'CONFLICTED';

  return {
    score,
    label,
    aligned_count: alignedCount,
    total_tfs: signals.length,
    dominant_trend: dominant,
    breakdown,
  };
}
