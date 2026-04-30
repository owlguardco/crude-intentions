import { describe, it, expect } from 'vitest';
import { computeEntryAlignment } from './consensus';

describe('computeEntryAlignment', () => {
  it('LONG + BULLISH/BULLISH → score 3, label ALIGNED', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'BULLISH',
      setup_ema_stack: 'BULLISH',
      trigger_direction: 'LONG',
    });
    expect(r.score).toBe(3);
    expect(r.label).toBe('ALIGNED');
    expect(r.breakdown).toHaveLength(3);
  });

  it('LONG + BULLISH/BEARISH → score 1, label MIXED', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'BULLISH',
      setup_ema_stack: 'BEARISH',
      trigger_direction: 'LONG',
    });
    expect(r.score).toBe(1);
    expect(r.label).toBe('MIXED');
  });

  it('LONG + BEARISH/BEARISH → score 0, label CONFLICTED', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'BEARISH',
      setup_ema_stack: 'BEARISH',
      trigger_direction: 'LONG',
    });
    expect(r.score).toBe(0);
    expect(r.label).toBe('CONFLICTED');
  });

  it('SHORT + BEARISH/BEARISH → score 3, label ALIGNED', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'BEARISH',
      setup_ema_stack: 'BEARISH',
      trigger_direction: 'SHORT',
    });
    expect(r.score).toBe(3);
    expect(r.label).toBe('ALIGNED');
  });

  it('SHORT + BULLISH/BULLISH → score 0, label CONFLICTED', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'BULLISH',
      setup_ema_stack: 'BULLISH',
      trigger_direction: 'SHORT',
    });
    expect(r.score).toBe(0);
    expect(r.label).toBe('CONFLICTED');
  });

  it('NO TRADE + BULLISH/BULLISH → score 0, label CONFLICTED', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'BULLISH',
      setup_ema_stack: 'BULLISH',
      trigger_direction: 'NO TRADE',
    });
    expect(r.score).toBe(0);
    expect(r.label).toBe('CONFLICTED');
  });

  it('LONG + MIXED/BULLISH → score 1, label MIXED (only setup agrees)', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'MIXED',
      setup_ema_stack: 'BULLISH',
      trigger_direction: 'LONG',
    });
    expect(r.score).toBe(1);
    expect(r.label).toBe('MIXED');
  });

  it('LONG + BULLISH/MIXED → score 1, label MIXED (only HTF agrees)', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'BULLISH',
      setup_ema_stack: 'MIXED',
      trigger_direction: 'LONG',
    });
    expect(r.score).toBe(1);
    expect(r.label).toBe('MIXED');
  });

  it('LONG + MIXED/MIXED → score 0, label CONFLICTED', () => {
    const r = computeEntryAlignment({
      htf_ema_stack: 'MIXED',
      setup_ema_stack: 'MIXED',
      trigger_direction: 'LONG',
    });
    expect(r.score).toBe(0);
    expect(r.label).toBe('CONFLICTED');
  });
});
