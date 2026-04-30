import { describe, it, expect } from 'vitest';
import { wilsonCi } from './calibration';

// Note: wilsonCi returns bounds in PERCENT units (0-100), not 0-1 fractions.
// The thresholds below are scaled accordingly.

describe('wilsonCi', () => {
  it('wilsonCi(10, 10) → low and high both close to 100% (perfect win rate)', () => {
    const ci = wilsonCi(10, 10);
    expect(ci.low).toBeGreaterThan(60);
    expect(ci.high).toBeCloseTo(100, 0);
    expect(ci.high).toBeGreaterThanOrEqual(99.9);
  });

  it('wilsonCi(0, 10) → low close to 0, high < 35', () => {
    const ci = wilsonCi(0, 10);
    expect(ci.low).toBeCloseTo(0, 0);
    expect(ci.high).toBeLessThan(35);
    expect(ci.high).toBeGreaterThan(0);
  });

  it('wilsonCi(5, 10) → low and high symmetric around 50', () => {
    const ci = wilsonCi(5, 10);
    const mid = (ci.low + ci.high) / 2;
    expect(mid).toBeCloseTo(50, 0);
    expect(ci.low).toBeLessThan(50);
    expect(ci.high).toBeGreaterThan(50);
    // 50% +/- the same margin -> high - 50 should equal 50 - low
    expect(Math.abs(50 - ci.low) - Math.abs(ci.high - 50)).toBeLessThan(0.01);
  });

  it('wilsonCi(0, 0) → returns { low: 0, high: 0 } (n=0 guard)', () => {
    const ci = wilsonCi(0, 0);
    expect(ci).toEqual({ low: 0, high: 0 });
  });

  it('low and high are always within [0, 100]', () => {
    for (const [w, n] of [[0, 10], [1, 10], [5, 10], [9, 10], [10, 10], [50, 100]]) {
      const ci = wilsonCi(w, n);
      expect(ci.low).toBeGreaterThanOrEqual(0);
      expect(ci.high).toBeLessThanOrEqual(100);
      expect(ci.low).toBeLessThanOrEqual(ci.high);
    }
  });

  it('CI shrinks as n grows for the same win rate', () => {
    const small = wilsonCi(5, 10);    // 50% on 10 trials
    const large = wilsonCi(50, 100);  // 50% on 100 trials
    const smallWidth = small.high - small.low;
    const largeWidth = large.high - large.low;
    expect(largeWidth).toBeLessThan(smallWidth);
  });
});
