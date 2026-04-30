'use client';

import { useState, useEffect, useCallback } from 'react';
import type {
  ActiveFvg,
  FvgQuality,
  FvgStatus,
  FvgTimeframe,
  IdeaStatus,
  TradeIdea,
} from '@/lib/market-memory/context';
import FVGScanWidget from '@/components/FVGScanWidget';
import type { FvgScanSnapshot, ScannedFVG } from '@/app/api/fvg-scan-auto/route';

const C = {
  bg: '#0d0d0f',
  panel: '#1a1a1e',
  panel2: '#222226',
  border: '#2a2a2e',
  rowHover: '#1e1e22',
  amber: '#d4a520',
  green: '#22c55e',
  red: '#ef4444',
  text: '#e0e0e0',
  muted: '#666670',
  dim: '#444450',
};

const STALE_HOURS_UI = 24;
const SESSION_DISMISS_KEY = 'mc_stale_dismissed_until';

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

const tableActionBtn = (color: string) => ({
  ...mono, fontSize: 9, letterSpacing: '1.5px', fontWeight: 700,
  padding: '4px 8px', borderRadius: 3,
  background: 'transparent', border: `1px solid ${color}40`,
  color, cursor: 'pointer',
});

const th = {
  ...mono, fontSize: 8, letterSpacing: '2px', color: C.dim,
  textAlign: 'left' as const, padding: '8px 10px',
  borderBottom: `1px solid ${C.border}`, fontWeight: 700,
  textTransform: 'uppercase' as const,
};

const td = {
  ...mono, fontSize: 11, color: C.text,
  padding: '10px', borderBottom: `1px solid ${C.border}`,
  verticalAlign: 'middle' as const,
};

const API_KEY = process.env.NEXT_PUBLIC_INTERNAL_API_KEY ?? '';

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
  oscillators: { rsi_4h: number; rsi_1h: number | null };
  macro_backdrop: string;
  active_fvgs: ActiveFvg[];
  active_trade_ideas: TradeIdea[];
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

function ageHours(iso: string): number {
  try { return (Date.now() - new Date(iso).getTime()) / 3600000; }
  catch { return 0; }
}

function fmtAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function biasColor(bias: string) {
  if (bias === 'LONG') return C.green;
  if (bias === 'SHORT') return C.red;
  return C.muted;
}

function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json', 'x-api-key': API_KEY };
}

function ideaStatusColor(s: IdeaStatus): string {
  switch (s) {
    case 'WATCHING':    return C.muted;
    case 'READY':       return C.amber;
    case 'TRIGGERED':   return C.green;
    case 'INVALIDATED': return C.red;
  }
}

function fvgDirColor(dir: 'bullish' | 'bearish'): string {
  return dir === 'bullish' ? C.green : C.red;
}

export default function SettingsPage() {
  const [ctx, setCtx] = useState<MarketContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [staleDismissed, setStaleDismissed] = useState(false);

  const [bias, setBias] = useState<'LONG' | 'SHORT' | 'NEUTRAL'>('NEUTRAL');
  const [biasStrength, setBiasStrength] = useState<'STRONG' | 'MODERATE' | 'WEAK'>('MODERATE');
  const [resistance, setResistance] = useState('');
  const [support, setSupport] = useState('');
  const [levelNotes, setLevelNotes] = useState('');
  const [ema20, setEma20] = useState('');
  const [ema50, setEma50] = useState('');
  const [ema200, setEma200] = useState('');
  const [rsi4h, setRsi4h] = useState('');
  // MACD removed in v1.9 swap — Layer 2 momentum is now volume-confirmation
  // on the 15-min trigger candle (per-trade, not market-state).
  const [macro, setMacro] = useState('');
  const [lastBar, setLastBar] = useState('');
  const [invalidation, setInvalidation] = useState('');

  // FVG auto-scan state
  const [fvgScan, setFvgScan] = useState<FvgScanSnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanToast, setScanToast] = useState<string | null>(null);

  // Weekly brief state
  type WeeklyBriefValue = {
    direction: string;
    strength: string;
    rationale: string;
    invalidation: string | null;
    generated_at: string;
  };
  const [weeklyBrief, setWeeklyBrief] = useState<WeeklyBriefValue | null>(null);
  const [briefRunning, setBriefRunning] = useState(false);
  const [briefToast, setBriefToast] = useState<string | null>(null);

  // Supply-context scan state
  type SupplyContextValue = {
    cushing_vs_4wk: 'BUILDING' | 'DRAWING' | 'FLAT' | null;
    eia_4wk_trend: 'BUILDS' | 'DRAWS' | 'MIXED' | null;
    rig_count_trend: 'RISING' | 'FALLING' | 'FLAT' | null;
    supply_bias: 'BEARISH' | 'NEUTRAL' | 'BULLISH' | null;
    updated_at?: string;
  };
  const [supplyCtx, setSupplyCtx] = useState<SupplyContextValue | null>(null);
  const [supplyScanning, setSupplyScanning] = useState(false);
  const [supplyToast, setSupplyToast] = useState<string | null>(null);

  // FVG add-form state
  const [fvgDir, setFvgDir] = useState<'bullish' | 'bearish'>('bullish');
  const [fvgTop, setFvgTop] = useState('');
  const [fvgBottom, setFvgBottom] = useState('');
  const [fvgTimeframe, setFvgTimeframe] = useState<FvgTimeframe>('4H');
  const [fvgQuality, setFvgQuality] = useState<FvgQuality>('high');
  const [fvgAge, setFvgAge] = useState('0');
  const [fvgErr, setFvgErr] = useState('');

  // Idea add-form state
  const [ideaDir, setIdeaDir] = useState<'LONG' | 'SHORT'>('LONG');
  const [ideaZone, setIdeaZone] = useState('');
  const [ideaStop, setIdeaStop] = useState('');
  const [ideaTarget, setIdeaTarget] = useState('');
  const [ideaNotes, setIdeaNotes] = useState('');
  const [ideaErr, setIdeaErr] = useState('');

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

  const loadFvgScan = useCallback(async () => {
    try {
      const res = await fetch('/api/fvg-scan-auto');
      if (!res.ok) return;
      const json = (await res.json()) as FvgScanSnapshot;
      setFvgScan(json);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { loadFvgScan(); }, [loadFvgScan]);

  async function runAutoScan() {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await fetch('/api/fvg-scan-auto', {
        method: 'POST',
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) {
        setScanToast(`✗ ${json.error ?? 'scan failed'}`);
      } else {
        const bull = Array.isArray(json.bullish) ? json.bullish.length : 0;
        const bear = Array.isArray(json.bearish) ? json.bearish.length : 0;
        setScanToast(`✓ ${bull} bullish · ${bear} bearish FVGs detected`);
        setFvgScan({
          bullish: json.bullish ?? [],
          bearish: json.bearish ?? [],
          scanned_at: json.scanned_at ?? '',
        });
      }
    } catch {
      setScanToast('✗ feed_unavailable');
    } finally {
      setScanning(false);
      setTimeout(() => setScanToast(null), 4000);
    }
  }

  // Weekly brief — public GET on mount; RUN NOW POSTs with the cron secret
  const loadBrief = useCallback(async () => {
    try {
      const res = await fetch('/api/cron/weekly-brief', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      if (json?.weekly_bias) setWeeklyBrief(json.weekly_bias as WeeklyBriefValue);
    } catch {
      // ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadBrief(); }, [loadBrief]);

  async function runBrief() {
    if (briefRunning) return;
    setBriefRunning(true);
    try {
      // Server-side proxy holds CRON_SECRET; client only ships
      // INTERNAL_API_KEY (already client-safe via NEXT_PUBLIC_INTERNAL_API_KEY).
      const res = await fetch('/api/cron/weekly-brief/trigger', {
        method: 'POST',
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok || json?.error) {
        setBriefToast(`✗ ${json?.error ?? 'run failed'}`);
      } else if (json?.weekly_bias) {
        const wb = json.weekly_bias as WeeklyBriefValue;
        setWeeklyBrief(wb);
        setBriefToast(`✓ ${wb.direction} · ${wb.strength}`);
      } else {
        setBriefToast('✗ run failed');
      }
    } catch {
      setBriefToast('✗ network');
    } finally {
      setBriefRunning(false);
      setTimeout(() => setBriefToast(null), 4000);
    }
  }

  // Supply context — cached read on mount, fresh fetch via SCAN NOW button
  const loadSupply = useCallback(async () => {
    try {
      const res = await fetch('/api/supply-context', {
        method: 'GET',
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const json = await res.json();
      if (json?.supply_context) setSupplyCtx(json.supply_context as SupplyContextValue);
    } catch {
      // ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadSupply(); }, [loadSupply]);

  async function runSupplyScan() {
    if (supplyScanning) return;
    setSupplyScanning(true);
    try {
      const res = await fetch('/api/supply-context', {
        method: 'POST',
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok || json?.error) {
        setSupplyToast(`✗ ${json?.error ?? 'scan failed'}`);
        if (json?.supply_context) setSupplyCtx(json.supply_context as SupplyContextValue);
      } else {
        const bias = json?.supply_context?.supply_bias ?? '—';
        setSupplyToast(`✓ ${bias} supply bias`);
        setSupplyCtx({
          ...(json.supply_context as SupplyContextValue),
          updated_at: new Date().toISOString(),
        });
      }
    } catch {
      setSupplyToast('✗ eia_unavailable');
    } finally {
      setSupplyScanning(false);
      setTimeout(() => setSupplyToast(null), 4000);
    }
  }

  // Honor session-only staleness dismissal
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const dismissedFor = sessionStorage.getItem(SESSION_DISMISS_KEY);
    if (dismissedFor && ctx && dismissedFor === ctx.last_updated) {
      setStaleDismissed(true);
    } else {
      setStaleDismissed(false);
    }
  }, [ctx]);

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
        };
      }
      const res = await fetch('/api/market-context', {
        method: 'POST',
        headers: authHeaders(),
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
      await fetch('/api/market-context/reset', {
        method: 'POST',
        headers: authHeaders(),
      });
      sessionStorage.removeItem(SESSION_DISMISS_KEY);
      await loadContext();
    } catch (e) {
      console.error(e);
    } finally {
      setResetting(false);
    }
  }

  // ── FVG actions (optimistic) ──
  async function handleAddFvg() {
    setFvgErr('');
    const top = parseFloat(fvgTop);
    const bottom = parseFloat(fvgBottom);
    const ageBars = parseInt(fvgAge, 10);
    if (isNaN(top) || isNaN(bottom)) { setFvgErr('Top and bottom must be numbers'); return; }
    if (top <= bottom) { setFvgErr('Top must be greater than bottom'); return; }
    if (!ctx) return;
    if (ctx.active_fvgs.length >= 10) { setFvgErr('At limit (10) — remove one first'); return; }

    const tempId = `tmp-${Date.now()}`;
    const optimistic: ActiveFvg = {
      id: tempId,
      direction: fvgDir,
      top, bottom,
      age_bars: isNaN(ageBars) ? 0 : ageBars,
      status: 'unfilled',
      timeframe: fvgTimeframe,
      quality: fvgQuality,
      created_at: new Date().toISOString(),
    };
    const prev = ctx;
    setCtx({ ...ctx, active_fvgs: [...ctx.active_fvgs, optimistic] });

    try {
      const res = await fetch('/api/market-context/fvg', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          direction: fvgDir,
          top, bottom,
          timeframe: fvgTimeframe,
          quality: fvgQuality,
          age_bars: isNaN(ageBars) ? 0 : ageBars,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Add failed');
      }
      setFvgTop(''); setFvgBottom(''); setFvgAge('0');
      await loadContext();
    } catch (e) {
      setCtx(prev);
      setFvgErr(e instanceof Error ? e.message : 'Add failed');
    }
  }

  async function handleMarkFvgFilled(id: string) {
    if (!ctx) return;
    const prev = ctx;
    setCtx({
      ...ctx,
      active_fvgs: ctx.active_fvgs.map(f => f.id === id ? { ...f, status: 'filled' as FvgStatus } : f),
    });
    try {
      const res = await fetch(`/api/market-context/fvg/${id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'filled' }),
      });
      if (!res.ok) throw new Error('Patch failed');
      await loadContext();
    } catch {
      setCtx(prev);
    }
  }

  async function handleDeleteFvg(id: string) {
    if (!ctx) return;
    if (!confirm('Delete this FVG?')) return;
    const prev = ctx;
    setCtx({ ...ctx, active_fvgs: ctx.active_fvgs.filter(f => f.id !== id) });
    try {
      const res = await fetch(`/api/market-context/fvg/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Delete failed');
      await loadContext();
    } catch {
      setCtx(prev);
    }
  }

  // ── Idea actions (optimistic) ──
  async function handleAddIdea() {
    setIdeaErr('');
    const stop = parseFloat(ideaStop);
    const target = parseFloat(ideaTarget);
    if (!ideaZone.trim()) { setIdeaErr('Entry zone is required'); return; }
    if (isNaN(stop) || isNaN(target)) { setIdeaErr('Stop and target must be numbers'); return; }
    if (ideaDir === 'LONG' && target <= stop) { setIdeaErr('LONG: target must be > stop'); return; }
    if (ideaDir === 'SHORT' && target >= stop) { setIdeaErr('SHORT: target must be < stop'); return; }
    if (!ctx) return;
    const liveCount = ctx.active_trade_ideas.filter(i => i.status === 'WATCHING' || i.status === 'READY').length;
    if (liveCount >= 5) { setIdeaErr('At limit (5 active) — invalidate one first'); return; }

    const tempId = `tmp-${Date.now()}`;
    const now = new Date().toISOString();
    const optimistic: TradeIdea = {
      id: tempId,
      direction: ideaDir,
      status: 'WATCHING',
      entry_zone: ideaZone.trim(),
      entry_price: null,
      target, stop,
      notes: ideaNotes,
      created_at: now,
      last_updated: now,
    };
    const prev = ctx;
    setCtx({ ...ctx, active_trade_ideas: [...ctx.active_trade_ideas, optimistic] });

    try {
      const res = await fetch('/api/market-context/idea', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          direction: ideaDir,
          entry_zone: ideaZone.trim(),
          entry_price: null,
          target, stop,
          notes: ideaNotes,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Add failed');
      }
      setIdeaZone(''); setIdeaStop(''); setIdeaTarget(''); setIdeaNotes('');
      await loadContext();
    } catch (e) {
      setCtx(prev);
      setIdeaErr(e instanceof Error ? e.message : 'Add failed');
    }
  }

  async function handleIdeaStatus(id: string, status: IdeaStatus) {
    if (!ctx) return;
    const prev = ctx;
    setCtx({
      ...ctx,
      active_trade_ideas: ctx.active_trade_ideas.map(i =>
        i.id === id ? { ...i, status, last_updated: new Date().toISOString() } : i
      ),
    });
    try {
      const res = await fetch(`/api/market-context/idea/${id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('Patch failed');
      await loadContext();
    } catch {
      setCtx(prev);
    }
  }

  async function handleDeleteIdea(id: string) {
    if (!ctx) return;
    if (!confirm('Delete this trade idea?')) return;
    const prev = ctx;
    setCtx({ ...ctx, active_trade_ideas: ctx.active_trade_ideas.filter(i => i.id !== id) });
    try {
      const res = await fetch(`/api/market-context/idea/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Delete failed');
      await loadContext();
    } catch {
      setCtx(prev);
    }
  }

  function dismissStale() {
    if (!ctx) return;
    sessionStorage.setItem(SESSION_DISMISS_KEY, ctx.last_updated);
    setStaleDismissed(true);
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
      <div style={{ ...mono, fontSize: 10, letterSpacing: '3px', color: C.muted }}>LOADING...</div>
    </div>
  );

  const ageH = ctx ? ageHours(ctx.last_updated) : 0;
  const isStale = ctx ? ageH >= STALE_HOURS_UI : false;
  const showStaleBanner = isStale && !staleDismissed;

  // Sort ideas: WATCHING/READY first, then TRIGGERED/INVALIDATED at bottom
  const sortedIdeas = ctx
    ? [...ctx.active_trade_ideas].sort((a, b) => {
        const live = (s: IdeaStatus) => s === 'WATCHING' || s === 'READY' ? 0 : 1;
        return live(a.status) - live(b.status);
      })
    : [];

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '24px 16px' }}>

      <div style={{ marginBottom: 28 }}>
        <div style={{ ...mono, fontSize: 9, letterSpacing: '4px', color: C.dim, marginBottom: 6 }}>CRUDE INTENTIONS</div>
        <div style={{ ...mono, fontSize: 18, letterSpacing: '3px', color: C.text, fontWeight: 700 }}>SETTINGS</div>
      </div>

      {showStaleBanner && ctx && (
        <div style={{
          background: `${C.amber}14`,
          border: `1px solid ${C.amber}55`,
          borderRadius: 6,
          padding: '14px 18px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ ...mono, fontSize: 10, letterSpacing: '2px', color: C.amber, fontWeight: 700, marginBottom: 4 }}>
              ⚠ MARKET CONTEXT IS STALE
            </div>
            <div style={{ ...mono, fontSize: 11, color: C.text, lineHeight: 1.5 }}>
              Last updated {fmtAge(ageH)} ({fmtTime(ctx.last_updated)}). ALFRED will treat this context as background reference only. Update the levels and bias below, or reset to a clean slate.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button style={tableActionBtn(C.amber)} onClick={dismissStale}>DISMISS</button>
            <button style={tableActionBtn(C.red)} onClick={handleReset} disabled={resetting}>
              {resetting ? '...' : 'RESET TO BLANK'}
            </button>
          </div>
        </div>
      )}

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
              <div style={{ ...mono, fontSize: 11, color: isStale ? C.amber : C.text, lineHeight: 1.5 }}>{fmtTime(ctx.last_updated)}</div>
              <div style={{ ...mono, fontSize: 9, color: isStale ? C.amber : C.muted, marginTop: 2 }}>
                {isStale ? `⚠ ${fmtAge(ageH)}` : fmtAge(ageH)}
              </div>
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

      {/* ── FVG AUTO-SCAN ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>FVG AUTO-SCAN</span>
          <span style={{ ...mono, fontSize: 9, color: C.dim }}>
            {fvgScan?.scanned_at ? `last scan ${fmtTime(fvgScan.scanned_at)}` : 'never scanned'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <button
            style={{ ...btn('primary'), opacity: scanning ? 0.6 : 1, cursor: scanning ? 'not-allowed' : 'pointer' }}
            onClick={runAutoScan}
            disabled={scanning}
          >
            {scanning ? 'SCANNING...' : 'SCAN NOW'}
          </button>
          {scanToast && (
            <span style={{ ...mono, fontSize: 10, letterSpacing: '1px', color: scanToast.startsWith('✓') ? C.green : C.red }}>
              {scanToast}
            </span>
          )}
          <span style={{ ...mono, fontSize: 9, color: C.muted, marginLeft: 'auto' }}>
            CL=F 4H · 60d window
          </span>
        </div>

        {(!fvgScan || (fvgScan.bullish.length === 0 && fvgScan.bearish.length === 0)) ? (
          <div style={{ ...mono, fontSize: 11, color: C.muted, padding: '12px 0', textAlign: 'center' }}>
            NO FVG DATA — run scan to populate
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Type</th>
                  <th style={th}>Top</th>
                  <th style={th}>Bottom</th>
                  <th style={th}>Mid</th>
                  <th style={th}>Score</th>
                  <th style={th}>Age</th>
                  <th style={th}>Formed</th>
                </tr>
              </thead>
              <tbody>
                {([...fvgScan.bullish, ...fvgScan.bearish] as ScannedFVG[]).map((f, i) => {
                  const c = f.type === 'BULLISH' ? C.green : C.red;
                  return (
                    <tr key={`${f.type}-${f.formed_at}-${i}`}>
                      <td style={{ ...td, color: c, fontWeight: 700 }}>{f.type}</td>
                      <td style={td}>{f.top.toFixed(2)}</td>
                      <td style={td}>{f.bottom.toFixed(2)}</td>
                      <td style={{ ...td, color: C.muted }}>{f.midpoint.toFixed(2)}</td>
                      <td style={{ ...td, color: C.amber, fontWeight: 700 }}>{f.score.toFixed(1)}</td>
                      <td style={{ ...td, color: C.muted }}>{f.age_bars} bars</td>
                      <td style={{ ...td, color: C.muted }}>{fmtTime(f.formed_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── WEEKLY BRIEF ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>WEEKLY BRIEF</span>
          <span style={{ ...mono, fontSize: 9, color: C.dim }}>
            {weeklyBrief?.generated_at ? `last run ${fmtTime(weeklyBrief.generated_at)}` : 'never run'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: weeklyBrief ? 14 : 0 }}>
          <button
            style={{ ...btn('primary'), opacity: briefRunning ? 0.6 : 1, cursor: briefRunning ? 'not-allowed' : 'pointer' }}
            onClick={runBrief}
            disabled={briefRunning}
          >
            {briefRunning ? 'RUNNING...' : 'RUN NOW'}
          </button>
          {briefToast && (
            <span style={{ ...mono, fontSize: 10, letterSpacing: '1px', color: briefToast.startsWith('✓') ? C.green : C.red }}>
              {briefToast}
            </span>
          )}
          <span style={{ ...mono, fontSize: 9, color: C.muted, marginLeft: 'auto' }}>
            DXY · VIX · OVX · XLE → ALFRED
          </span>
        </div>

        {weeklyBrief ? (() => {
          const dir = weeklyBrief.direction;
          const dirColor =
            dir === 'LONG' || dir === 'BULLISH' ? C.green
            : dir === 'SHORT' || dir === 'BEARISH' ? C.red
            : C.muted;
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span style={{
                  ...mono, fontSize: 12, fontWeight: 700, letterSpacing: '2px',
                  padding: '3px 10px', borderRadius: 3,
                  color: dirColor, background: `${dirColor}18`, border: `1px solid ${dirColor}40`,
                }}>{dir}</span>
                <span style={{ ...mono, fontSize: 11, letterSpacing: '1px', color: C.muted }}>
                  {weeklyBrief.strength}
                </span>
              </div>
              {weeklyBrief.rationale && (
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: C.muted, lineHeight: 1.55, marginBottom: weeklyBrief.invalidation ? 12 : 0 }}>
                  {weeklyBrief.rationale}
                </div>
              )}
              {weeklyBrief.invalidation && (
                <div style={{ ...mono, fontSize: 10, letterSpacing: '1px', color: C.red }}>
                  ✗ INVALIDATED IF: <span style={{ fontFamily: 'Inter, sans-serif', letterSpacing: 0 }}>{weeklyBrief.invalidation}</span>
                </div>
              )}
            </>
          );
        })() : (
          <div style={{ ...mono, fontSize: 11, color: C.muted, padding: '12px 0', textAlign: 'center' }}>
            No brief yet — runs Sunday 20:00 UTC or click RUN NOW
          </div>
        )}
      </div>

      {/* ── SUPPLY CONTEXT ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>SUPPLY CONTEXT</span>
          <span style={{ ...mono, fontSize: 9, color: C.dim }}>
            {supplyCtx?.updated_at ? `last scan ${fmtTime(supplyCtx.updated_at)}` : 'never scanned'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <button
            style={{ ...btn('primary'), opacity: supplyScanning ? 0.6 : 1, cursor: supplyScanning ? 'not-allowed' : 'pointer' }}
            onClick={runSupplyScan}
            disabled={supplyScanning}
          >
            {supplyScanning ? 'SCANNING...' : 'SCAN NOW'}
          </button>
          {supplyToast && (
            <span style={{ ...mono, fontSize: 10, letterSpacing: '1px', color: supplyToast.startsWith('✓') ? C.green : C.red }}>
              {supplyToast}
            </span>
          )}
          <span style={{ ...mono, fontSize: 9, color: C.muted, marginLeft: 'auto' }}>
            EIA WSTK + Cushing · 5-week window
          </span>
        </div>

        {(() => {
          const sc = supplyCtx;
          const biasColor =
            sc?.supply_bias === 'BEARISH' ? C.red
            : sc?.supply_bias === 'BULLISH' ? C.green
            : C.muted;
          const cells: Array<[string, string, string]> = [
            ['CUSHING',     sc?.cushing_vs_4wk ?? '—',  C.text],
            ['EIA 4WK',     sc?.eia_4wk_trend ?? '—',   C.text],
            ['RIG COUNT',   sc?.rig_count_trend ?? '—', C.muted],
            ['SUPPLY BIAS', sc?.supply_bias ?? '—',     biasColor],
          ];
          return (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {cells.map(([labelText, value, color]) => (
                <div
                  key={labelText}
                  style={{
                    background: C.panel2,
                    border: `1px solid ${C.border}`,
                    borderRadius: 4,
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ ...mono, fontSize: 8, letterSpacing: '2px', color: C.muted, marginBottom: 4 }}>{labelText}</div>
                  <div style={{ ...mono, fontSize: 13, fontWeight: 700, color }}>{value}</div>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

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
        <div style={{ marginBottom: 16 }}>
          <span style={label}>RSI 4H</span>
          <input style={input} value={rsi4h} onChange={e => setRsi4h(e.target.value)} placeholder="52" />
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

      {/* ── ACTIVE FVGs ───────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>ACTIVE FVGs</span>
          <span style={{ ...mono, fontSize: 9, color: C.dim }}>
            {ctx?.active_fvgs.length ?? 0} / 10
          </span>
        </div>

        {ctx && ctx.active_fvgs.length === 0 ? (
          <div style={{ ...mono, fontSize: 11, color: C.muted, padding: '12px 0', textAlign: 'center' }}>
            No active FVGs — add one below
          </div>
        ) : (
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Direction</th>
                  <th style={th}>Range</th>
                  <th style={th}>TF</th>
                  <th style={th}>Quality</th>
                  <th style={th}>Status</th>
                  <th style={th}>Age</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {ctx?.active_fvgs.map(f => (
                  <tr key={f.id} style={{ opacity: f.status === 'filled' ? 0.5 : 1 }}>
                    <td style={{ ...td, color: fvgDirColor(f.direction), fontWeight: 700 }}>
                      {f.direction.toUpperCase()}
                    </td>
                    <td style={td}>{f.bottom}–{f.top}</td>
                    <td style={td}>{f.timeframe}</td>
                    <td style={{ ...td, color: C.muted }}>{f.quality}</td>
                    <td style={{ ...td, color: f.status === 'filled' ? C.muted : f.status === 'partially_filled' ? C.amber : C.text }}>
                      {f.status}
                    </td>
                    <td style={{ ...td, color: C.muted }}>{f.age_bars} bars</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        {f.status !== 'filled' && (
                          <button style={tableActionBtn(C.amber)} onClick={() => handleMarkFvgFilled(f.id)}>
                            MARK FILLED
                          </button>
                        )}
                        <button style={tableActionBtn(C.red)} onClick={() => handleDeleteFvg(f.id)}>
                          DELETE
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
          <div style={{ ...mono, fontSize: 9, letterSpacing: '2px', color: C.dim, marginBottom: 10 }}>ADD FVG</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <span style={label}>Direction</span>
              <select value={fvgDir} onChange={e => setFvgDir(e.target.value as 'bullish' | 'bearish')} style={{ ...input, color: fvgDirColor(fvgDir) }}>
                <option value="bullish">BULLISH</option>
                <option value="bearish">BEARISH</option>
              </select>
            </div>
            <div>
              <span style={label}>Top</span>
              <input style={input} value={fvgTop} onChange={e => setFvgTop(e.target.value)} placeholder="78.55" />
            </div>
            <div>
              <span style={label}>Bottom</span>
              <input style={input} value={fvgBottom} onChange={e => setFvgBottom(e.target.value)} placeholder="78.20" />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 10, alignItems: 'end' }}>
            <div>
              <span style={label}>Timeframe</span>
              <select value={fvgTimeframe} onChange={e => setFvgTimeframe(e.target.value as FvgTimeframe)} style={input}>
                <option value="4H">4H</option>
                <option value="1H">1H</option>
                <option value="15min">15min</option>
              </select>
            </div>
            <div>
              <span style={label}>Quality</span>
              <select value={fvgQuality} onChange={e => setFvgQuality(e.target.value as FvgQuality)} style={input}>
                <option value="high">HIGH</option>
                <option value="medium">MEDIUM</option>
                <option value="low">LOW</option>
              </select>
            </div>
            <div>
              <span style={label}>Age (bars)</span>
              <input style={input} value={fvgAge} onChange={e => setFvgAge(e.target.value)} placeholder="0" />
            </div>
            <button
              style={{ ...tableActionBtn(C.green), padding: '9px 16px', fontSize: 10 }}
              onClick={handleAddFvg}
              disabled={ctx ? ctx.active_fvgs.length >= 10 : true}
            >
              ADD FVG
            </button>
          </div>
          {fvgErr && (
            <div style={{ ...mono, fontSize: 10, color: C.red, marginTop: 8 }}>{fvgErr}</div>
          )}
          {ctx && ctx.active_fvgs.length >= 10 && (
            <div style={{ ...mono, fontSize: 10, color: C.amber, marginTop: 8 }}>
              ⚠ At limit (10) — remove an FVG before adding
            </div>
          )}
        </div>
      </div>

      {/* ── TRADE IDEAS ───────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>TRADE IDEAS</span>
          <span style={{ ...mono, fontSize: 9, color: C.dim }}>
            {ctx?.active_trade_ideas.filter(i => i.status === 'WATCHING' || i.status === 'READY').length ?? 0} active / 5
          </span>
        </div>

        {ctx && ctx.active_trade_ideas.length === 0 ? (
          <div style={{ ...mono, fontSize: 11, color: C.muted, padding: '12px 0', textAlign: 'center' }}>
            No trade ideas — add one below
          </div>
        ) : (
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Status</th>
                  <th style={th}>Direction</th>
                  <th style={th}>Entry Zone</th>
                  <th style={th}>Stop</th>
                  <th style={th}>Target</th>
                  <th style={th}>Notes</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedIdeas.map(i => {
                  const isDone = i.status === 'TRIGGERED' || i.status === 'INVALIDATED';
                  return (
                    <tr key={i.id} style={{ opacity: isDone ? 0.5 : 1 }}>
                      <td style={{ ...td, color: ideaStatusColor(i.status), fontWeight: 700 }}>
                        {i.status}
                      </td>
                      <td style={{ ...td, color: i.direction === 'LONG' ? C.green : C.red, fontWeight: 700 }}>
                        {i.direction}
                      </td>
                      <td style={td}>{i.entry_zone}</td>
                      <td style={{ ...td, color: C.red }}>{i.stop}</td>
                      <td style={{ ...td, color: C.green }}>{i.target}</td>
                      <td style={{ ...td, color: C.muted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {i.notes || '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {i.status === 'WATCHING' && (
                            <>
                              <button style={tableActionBtn(C.amber)} onClick={() => handleIdeaStatus(i.id, 'READY')}>
                                MARK READY
                              </button>
                              <button style={tableActionBtn(C.red)} onClick={() => handleIdeaStatus(i.id, 'INVALIDATED')}>
                                INVALIDATE
                              </button>
                            </>
                          )}
                          {i.status === 'READY' && (
                            <>
                              <button style={tableActionBtn(C.green)} onClick={() => handleIdeaStatus(i.id, 'TRIGGERED')}>
                                MARK TRIGGERED
                              </button>
                              <button style={tableActionBtn(C.red)} onClick={() => handleIdeaStatus(i.id, 'INVALIDATED')}>
                                INVALIDATE
                              </button>
                            </>
                          )}
                          {isDone && (
                            <button style={tableActionBtn(C.muted)} onClick={() => handleDeleteIdea(i.id)}>
                              DELETE
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
          <div style={{ ...mono, fontSize: 9, letterSpacing: '2px', color: C.dim, marginBottom: 10 }}>ADD TRADE IDEA</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <span style={label}>Direction</span>
              <select value={ideaDir} onChange={e => setIdeaDir(e.target.value as 'LONG' | 'SHORT')} style={{ ...input, color: ideaDir === 'LONG' ? C.green : C.red }}>
                <option value="LONG">LONG</option>
                <option value="SHORT">SHORT</option>
              </select>
            </div>
            <div>
              <span style={label}>Entry Zone</span>
              <input style={input} value={ideaZone} onChange={e => setIdeaZone(e.target.value)} placeholder="77.80–78.00" />
            </div>
            <div>
              <span style={label}>Stop</span>
              <input style={input} value={ideaStop} onChange={e => setIdeaStop(e.target.value)} placeholder="77.40" />
            </div>
            <div>
              <span style={label}>Target</span>
              <input style={input} value={ideaTarget} onChange={e => setIdeaTarget(e.target.value)} placeholder="80.20" />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
            <div>
              <span style={label}>Notes</span>
              <input style={input} value={ideaNotes} onChange={e => setIdeaNotes(e.target.value)} placeholder="FVG retest setup, watching for rejection at zone" />
            </div>
            <button
              style={{ ...tableActionBtn(C.green), padding: '9px 16px', fontSize: 10 }}
              onClick={handleAddIdea}
            >
              ADD IDEA
            </button>
          </div>
          {ideaErr && (
            <div style={{ ...mono, fontSize: 10, color: C.red, marginTop: 8 }}>{ideaErr}</div>
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

      <div style={{ height: 1, background: C.border, margin: '8px 0' }} />

      <FVGScanWidget />

    </div>
  );
}
