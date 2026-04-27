import { z } from 'zod';
const C = z.object({ result: z.enum(['PASS','FAIL']), detail: z.string().min(1).max(500) });
export const MarketContextSchema = z.object({
  price: z.number().finite().min(10).max(500),
  ema20: z.number().finite().min(10).max(500),
  ema50: z.number().finite().min(10).max(500),
  ema200: z.number().finite().min(10).max(500),
  rsi: z.number().finite().min(0).max(100),
  ovx: z.number().finite().min(0).max(300),
  dxy: z.string().max(50),
  vwap: z.number().finite().min(10).max(500).optional(),
});
export const OutcomeSchema = z.object({
  status: z.enum(['OPEN','WIN','LOSS','SCRATCH','BLOCKED','EXPIRED']),
  result: z.number().nullable().default(null),
  result_dollars: z.number().nullable().default(null),
  close_timestamp: z.string().nullable().default(null),
  close_price: z.number().nullable().default(null),
  post_mortem: z.string().nullable().default(null),
  post_mortem_timestamp: z.string().nullable().default(null),
});
export const JournalWriteSchema = z.object({
  rules_version: z.string().min(1).max(20),
  session: z.enum(['NY_OPEN','NY_AFTERNOON','LONDON','OVERLAP','ASIA','OFF_HOURS']),
  direction: z.enum(['LONG','SHORT','NO TRADE']),
  source: z.enum(['WEBHOOK','MANUAL']).default('MANUAL'),
  score: z.number().int().min(0).max(10),
  grade: z.enum(['A+','A','B+','B','F']),
  confidence_label: z.enum(['CONVICTION','HIGH','MEDIUM','LOW']),
  entry_price: z.number().finite().min(10).max(500).nullable(),
  stop_loss: z.number().finite().min(10).max(500).nullable(),
  take_profit_1: z.number().finite().min(10).max(500).nullable(),
  take_profit_2: z.number().finite().min(10).max(500).nullable(),
  contracts: z.number().int().min(0).max(99).nullable(),
  risk_dollars: z.number().finite().min(0).max(50000).nullable(),
  checklist: z.object({
    ema_stack_aligned: C, daily_confirms: C, rsi_reset_zone: C,
    macd_confirming: C, price_at_key_level: C, rr_valid: C,
    session_timing: C, eia_window_clear: C, vwap_aligned: C,
    htf_structure_clear: C,
  }),
  blocked_reasons: z.array(z.string().max(300)).default([]),
  wait_for: z.string().max(500).nullable().default(null),
  reasoning: z.string().min(10).max(2000),
  market_context_snapshot: MarketContextSchema,
  adversarial_verdict: z.enum(['PASS','CONDITIONAL_PASS','SKIP']).optional(),
  adversarial_notes: z.string().max(1000).optional(),
  outcome: OutcomeSchema.optional(),
  paper_trading: z.boolean().default(true),
}).strict();
export type JournalWriteInput = z.infer<typeof JournalWriteSchema>;
export const OutcomeUpdateSchema = z.object({
  status: z.enum(['WIN','LOSS','SCRATCH','EXPIRED']),
  close_price: z.number().finite().min(10).max(500),
  close_timestamp: z.string().datetime(),
  result: z.number().finite().min(-9999).max(9999),
  result_dollars: z.number().finite().min(-99999).max(99999),
}).strict();
export type OutcomeUpdateInput = z.infer<typeof OutcomeUpdateSchema>;
export const AdversarialScanSchema = z.object({
  verdict: z.enum(['PASS','CONDITIONAL_PASS','SKIP']),
  concerns: z.array(z.string().max(300)).default([]),
  override_note: z.string().max(1000).nullable().default(null),
}).strict();
export type AdversarialScanResult = z.infer<typeof AdversarialScanSchema>;
