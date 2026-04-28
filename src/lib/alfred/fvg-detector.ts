// CRUDE INTENTIONS — FVG Auto-Detection (Phase 2F)
// Pure 3-candle FVG detector. No async, no KV, no external imports.

export type FVGType = 'BULLISH' | 'BEARISH';

export interface Candle {
  high: number;
  low: number;
  close: number;
  timestamp: string;
}

export interface DetectedFVG {
  type: FVGType;
  top: number;
  bottom: number;
  formed_at: string;
  size_ticks: number;
}

const DEFAULT_MIN_SIZE_TICKS = 5.0;
const MAX_FVGS = 10;

function roundTicks(value: number): number {
  return Math.round(value * 10) / 10;
}

export function detectFVGs(candles: Candle[], minSizeTicks?: number): DetectedFVG[] {
  if (candles.length < 3) return [];

  const min = minSizeTicks ?? DEFAULT_MIN_SIZE_TICKS;
  const out: DetectedFVG[] = [];

  for (let i = 0; i < candles.length - 2; i++) {
    const prev = candles[i];
    const mid = candles[i + 1];
    const next = candles[i + 2];

    if (next.low > prev.high) {
      const top = next.low;
      const bottom = prev.high;
      const size_ticks = roundTicks((top - bottom) * 100);
      if (size_ticks >= min) {
        out.push({ type: 'BULLISH', top, bottom, formed_at: mid.timestamp, size_ticks });
      }
    } else if (next.high < prev.low) {
      const top = prev.low;
      const bottom = next.high;
      const size_ticks = roundTicks((top - bottom) * 100);
      if (size_ticks >= min) {
        out.push({ type: 'BEARISH', top, bottom, formed_at: mid.timestamp, size_ticks });
      }
    }
  }

  out.sort((a, b) => Date.parse(b.formed_at) - Date.parse(a.formed_at));
  return out.slice(0, MAX_FVGS);
}
