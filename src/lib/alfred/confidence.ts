export type ConfidenceLabel = 'CONVICTION' | 'HIGH' | 'MEDIUM' | 'LOW';
export function scoreToConfidence(score: number): ConfidenceLabel {
  if (score === 12) return 'CONVICTION';
  if (score >= 10)  return 'HIGH';
  if (score >= 9)   return 'MEDIUM';
  return 'LOW';
}
export const CONFIDENCE_SIZE_MULTIPLIER: Record<ConfidenceLabel, number> = {
  CONVICTION: 1.0, HIGH: 1.0, MEDIUM: 0.5, LOW: 0.0,
};
export const CONFIDENCE_LABEL_COPY: Record<ConfidenceLabel, string> = {
  CONVICTION: 'All 12 layers aligned. Full size.',
  HIGH: '10-11/12. Standard size.',
  MEDIUM: '9/12 minimum threshold. Half to standard size.',
  LOW: 'Below minimum. No trade.',
};
