export type ConfidenceLabel = 'CONVICTION' | 'HIGH' | 'MEDIUM' | 'LOW';
export function scoreToConfidence(score: number): ConfidenceLabel {
  if (score === 10) return 'CONVICTION';
  if (score >= 8)   return 'HIGH';
  if (score >= 7)   return 'MEDIUM';
  return 'LOW';
}
export const CONFIDENCE_SIZE_MULTIPLIER: Record<ConfidenceLabel, number> = {
  CONVICTION: 1.0, HIGH: 1.0, MEDIUM: 0.5, LOW: 0.0,
};
export const CONFIDENCE_LABEL_COPY: Record<ConfidenceLabel, string> = {
  CONVICTION: 'All 10 layers aligned. Full size.',
  HIGH: '8-9/10. Standard size.',
  MEDIUM: '7/10 minimum threshold. Half to standard size.',
  LOW: 'Below minimum. No trade.',
};
