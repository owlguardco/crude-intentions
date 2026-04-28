'use client';

import { useState, useEffect, useCallback } from 'react';

const C = {
  bg: '#0d0d0f',
  panel: '#1a1a1e',
  panel2: '#222226',
  border: '#2a2a2e',
  amber: '#d4a520',
  green: '#22c55e',
  red: '#ef4444',
  text: '#e0e0e0',
  muted: '#666670',
  dim: '#444450',
};

const mono = { fontFamily: 'JetBrains Mono, monospace' } as const;

const label = {
  ...mono, fontSize: 9, letterSpacing: '2px',
  color: C.muted, marginBottom: 5, display: 'block', textTransform: 'uppercase' as const,
};

const sectionTitle = {
  ...mono, fontSize: 10, letterSpacing: '3px',
  color: C.amber, marginBottom: 16, textTransform: 'uppercase' as const,
};

const card = {
  background: C.panel, border: `1px solid ${C.border}`,
  borderRadius: 6, padding: '20px 24px', marginBottom: 16,
};

const input = {
  ...mono, fontSize: 13, color: C.text,
  background: C.panel2, border: `1px solid ${C.border}`,
  borderRadius: 4, padding: '8px 12px',
  width: '100%', boxSizing: 'border-box' as const,
  outline: 'none',
};

const btn = (variant: 'primary' | 'danger' | 'ghost' = 'primary') => ({
  ...mono, fontSize: 10, letterSpacing: '2px', fontWeight: 700,
  padding: '9px 18px', borderRadius: 4, border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.amber : variant === 'danger' ? C.red : C.panel2,
  color: variant === 'primary' ? '#0d0d0f' : C.text,
});

interface MarketContext {
  schema_version: string;
  last_updated: string;
  last_bar: string;
  session_count: number;
  current_bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  bias_strength: 'STRONG' | 'MODERATE' | 'WEAK';
  bias_set_at: string;
  invalidation_notes: string | null;
  key_levels: { resistance: number[]; support: number[]; notes: string | null };
  ema_stack: { ema20: number; ema50: number; ema200: number; alignment: string };
  oscillators: { rsi_4h: number; rsi_1h: number | null; macd_histogram: number | null };
  macro_backdrop: string;
  active_fvgs: unknown[];
  recent_closed_trades: unknown[];
  recent_win_rate: number | null;
  context_age_warning: boolean;
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/New_York',
    }) + ' ET';
  } catch { return iso; }
}

function biasColor(bias: string) {
  if (bias === 'LONG') return C.green;
  if (bias === 'SHORT') return C.red;
  return C.muted;
}

export default function SettingsPage() {
  const [ctx, setCtx] = useState<MarketContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const [bias, setBias] = useState<'LONG' | 'SHORT' | 'NEUTRAL'>('NEUTRAL');
  const [biasStrength, setBiasStrength] = useState<'STRONG' | 'MODERATE' | 'WEAK'>('MODERATE');
  const [resistance, setResistance] = useState('');
  const [support, setSupport] = useState('');
  const [levelNotes, setLevelNotes] = useState('');
  const [ema20, setEma20] = useState('');
  const [ema50, setEma50] = useState('');
  const [ema200, setEma200] = useState('');
  const [rsi4h, setRsi4h] = useState('');
  const [macd, setMacd] = useState('');
  const [macro, setMacro] = useState('');
  const [lastBar, setLastBar] = useState('');
  const [invalidation, setInvalidation] = useState('');

  const loadContext = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/market-context');
      const data: MarketContext = await res.json();
      setCtx(data);
      setBias(data.current_bias);
      setBiasStrength(data.bias_strength);
      setResistance(data.key_levels.resistance.join(', '));
      setSupport(data.key_levels.support.join(', '));
      setLevelNotes(data.key_levels.notes ?? '');
      setEma20(data.ema_stack.ema20 > 0 ? String(data.ema_stack.ema20) : '');
      setEma50(data.ema_stack.ema50 > 0 ? String(data.ema_stack.ema50) : '');
      setEma200(data.ema_stack.ema200 > 0 ? String(data.ema_stack.ema200) : '');
      setRsi4h(data.oscillators.rsi_4h > 0 ? String(data.oscillators.rsi_4h) : '');
      setMacd(data.oscillators.macd_histogram != null ? String(data.oscillators.macd_histogram) : '');
      setMacro(data.macro_backdrop ?? '');
      setLastBar(data.last_bar ?? '');
      setInvalidation(data.invalidation_notes ?? '');
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadContext(); }, [loadContext]);

  function parseNumbers(str: string): number[] {
    return str.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg('');
    try {
      const body: Record<string, unknown> = {
        bias,
        bias_strength: biasStrength,
        key_levels: {
          resistance: parseNumbers(resistance),
          support: parseNumbers(support),
          notes: levelNotes || null,
        },
        macro_backdrop: macro,
        last_bar: lastBar,
        invalidation_notes: invalidation || null,
      };
      if (ema20 || ema50 || ema200) {
        body.ema_stack = {
          ...(ema20 ? { ema20: parseFloat(ema20) } : {}),
          ...(ema50 ? { ema50: parseFloat(ema50) } : {}),
          ...(ema200 ? { ema200: parseFloat(ema200) } : {}),
        };
      }
      if (rsi4h) {
        body.oscillators = {
          rsi_4h: parseFloat(rsi4h),
          ...(macd ? { macd_histogram: parseFloat(macd) } : {}),
        };
      }
      const res = await fetch('/api/market-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveMsg('SAVED');
      await loadContext();
    } catch (e) {
      setSaveMsg('ERROR');
      console.error(e);
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 3000);
    }
  }

  async function handleReset() {
    if (!confirm('Reset market context to blank? This cannot be undone.')) return;
    setResetting(true);
    try {
      await fetch('/api/market-context/reset', { method: 'POST' });
      await loadContext();
    } catch (e) {
      console.error(e);
    } finally {
      setResetting(false);
    }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
      <div style={{ ...mono, fontSize: 10, letterSpacing: '3px', color: C.muted }}>LOADING...</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px' }}>

      <div style={{ marginBottom: 28 }}>
        <div style={{ ...mono, fontSize: 9, letterSpacing: '4px', color: C.dim, marginBottom: 6 }}>CRUDE INTENTIONS</div>
        <div style={{ ...mono, fontSize: 18, letterSpacing: '3px', color: C.text, fontWeight: 700 }}>SETTINGS</div>
      </div>

      {ctx && (
        <div style={{ ...card, marginBottom: 24, borderTop: `3px solid ${biasColor(ctx.current_bias)}` }}>
          <div style={sectionTitle}>ALFRED MARKET MEMORY — CURRENT STATE</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div>
              <div style={label}>BIAS</div>
              <div style={{ ...mono, fontSize: 20, fontWeight: 700, color: biasColor(ctx.current_bias), letterSpacing: '2px' }}>{ctx.current_bias}</div>
              <div style={{ ...mono, fontSize: 10, color: C.muted, marginTop: 2 }}>{ctx.bias_strength}</div>
            </div>
            <div>
              <div style={label}>SESSIONS</div>
              <div style={{ ...mono, fontSize: 20, fontWeight: 700, color: C.text }}>{ctx.session_count}</div>
              <div style={{ ...mono, fontSize: 10, color: C.muted, marginTop: 2 }}>persisted</div>
            </div>
            <div>
              <div style={label}>LAST UPDATED</div>
              <div style={{ ...mono, fontSize: 11, color: ctx.context_age_warning ? C.amber : C.text, lineHeight: 1.5 }}>{fmtTime(ctx.last_updated)}</div>
              {ctx.context_age_warning && <div style={{ ...mono, fontSize: 9, color: C.amber, marginTop: 2 }}>⚠ STALE &gt;48h</div>}
            </div>
          </div>
          {ctx.macro_backdrop && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
              <div style={label}>MACRO</div>
              <div style={{ ...mono, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>{ctx.macro_backdrop}</div>
            </div>
          )}
          {(ctx.key_levels.resistance.length > 0 || ctx.key_levels.support.length > 0) && (
            <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={label}>RESISTANCE</div>
                <div style={{ ...mono, fontSize: 12, color: C.red }}>{ctx.key_levels.resistance.join('  ·  ') || '—'}</div>
              </div>
              <div>
                <div style={label}>SUPPORT</div>
                <div style={{ ...mono, fontSize: 12, color: C.green }}>{ctx.key_levels.support.join('  ·  ') || '—'}</div>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={card}>
        <div style={sectionTitle}>UPDATE MARKET CONTEXT</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <span style={label}>WEEKLY BIAS</span>
            <select value={bias} onChange={e => setBias(e.target.value as typeof bias)} style={{ ...input, color: biasColor(bias) }}>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
              <option value="NEUTRAL">NEUTRAL</option>
            </select>
          </div>
          <div>
            <span style={label}>CONVICTION</span>
            <select value={biasStrength} onChange={e => setBiasStrength(e.target.value as typeof biasStrength)} style={input}>
              <option value="STRONG">STRONG</option>
              <option value="MODERATE">MODERATE</option>
              <option value="WEAK">WEAK</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <span style={label}>RESISTANCE LEVELS (comma separated)</span>
            <input style={input} value={resistance} onChange={e => setResistance(e.target.value)} placeholder="79.50, 80.20, 81.00" />
          </div>
          <div>
            <span style={label}>SUPPORT LEVELS (comma separated)</span>
            <input style={input} value={support} onChange={e => setSupport(e.target.value)} placeholder="77.80, 76.40, 75.00" />
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <span style={label}>LEVEL NOTES</span>
          <input style={input} value={levelNotes} onChange={e => setLevelNotes(e.target.value)} placeholder="e.g. 79.50 is prior week high, watching for rejection" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <span style={label}>EMA 20</span>
            <input style={input} value={ema20} onChange={e => setEma20(e.target.value)} placeholder="78.35" />
          </div>
          <div>
            <span style={label}>EMA 50</span>
            <input style={input} value={ema50} onChange={e => setEma50(e.target.value)} placeholder="77.90" />
          </div>
          <div>
            <span style={label}>EMA 200</span>
            <input style={input} value={ema200} onChange={e => setEma200(e.target.value)} placeholder="76.40" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <span style={label}>RSI 4H</span>
            <input style={input} value={rsi4h} onChange={e => setRsi4h(e.target.value)} placeholder="52" />
          </div>
          <div>
            <span style={label}>MACD HISTOGRAM</span>
            <input style={input} value={macd} onChange={e => setMacd(e.target.value)} placeholder="0.08" />
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <span style={label}>MACRO BACKDROP</span>
          <input style={input} value={macro} onChange={e => setMacro(e.target.value)} placeholder="OPEC+ supportive, DXY softening, OVX 28" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <span style={label}>LAST BAR REFERENCE</span>
            <input style={input} value={lastBar} onChange={e => setLastBar(e.target.value)} placeholder="2026-04-28 14:00 4H close" />
          </div>
          <div>
            <span style={label}>INVALIDATION NOTES</span>
            <input style={input} value={invalidation} onChange={e => setInvalidation(e.target.value)} placeholder="Bias invalid if price closes below 77.50" />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8 }}>
          <button style={btn('primary')} onClick={handleSave} disabled={saving}>
            {saving ? 'SAVING...' : 'SAVE CONTEXT'}
          </button>
          {saveMsg && (
            <span style={{ ...mono, fontSize: 10, letterSpacing: '2px', color: saveMsg === 'SAVED' ? C.green : C.red }}>
              {saveMsg}
            </span>
          )}
        </div>
      </div>

      <div style={{ ...card, borderColor: '#3a1a1a' }}>
        <div style={{ ...sectionTitle, color: C.red }}>DANGER ZONE</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <button style={btn('danger')} onClick={handleReset} disabled={resetting}>
            {resetting ? 'RESETTING...' : 'RESET CONTEXT'}
          </button>
          <div style={{ ...mono, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
            Wipes ALFRED's market memory back to blank state.<br />
            Use at start of a new week or if context has drifted.
          </div>
        </div>
      </div>

    </div>
  );
}