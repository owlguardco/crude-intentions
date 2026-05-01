/**
 * CRUDE INTENTIONS — Geo Flag types
 *
 * Canonical shape for the geopolitical risk monitor. Currently fed by
 * Truth Social RSS but the type is intentionally source-agnostic so a
 * future Reuters Energy / OPEC newsroom feed can populate the same
 * envelope without changing consumers.
 */

export type GeoChipState =
  /** No keyword match in the freshness window. Dim grey chip. */
  | 'CLEAR'
  /** Keyword match, |CL price delta since post| <= $0.40 (or unknown). Amber. */
  | 'ACTIVE'
  /** Keyword match AND |CL price delta since post| > $0.40. Red — soft pause. */
  | 'HOT';

export interface GeoFlagResult {
  flagged: boolean;
  matched_at: string | null;
  matched_keyword: string | null;
  post_title: string | null;
  post_url: string | null;
  /**
   * Source feed identifier — present only when flagged. CLEAR state hides
   * this so the widget reads as a generic geopolitical monitor instead of
   * a Trump-specific watcher.
   */
  source: 'truth_social' | null;
  checked_at: string;
  chip_state: GeoChipState;
  /**
   * CL price delta in dollars since the matched post's timestamp. Positive
   * = price rose. 0 when no match or no history available.
   */
  price_delta_since_post: number;
  /**
   * False when the route had to fall back to "delta = 0" because no usable
   * price history was available within ±5 minutes of the post time. UI
   * treats unknown deltas as ACTIVE rather than HOT.
   */
  price_delta_known: boolean;
  error?: string;
}
