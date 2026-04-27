'use client';
import { useState, useEffect, useCallback } from 'react';

interface JournalEntry {
  id: string; timestamp: string; direction: 'LONG'|'SHORT'|'NO TRADE';
  source: 'WEBHOOK'|'MANUAL'; session: string; score: number; grade: string;
  confidence_label: 'CONVICTION'|'HIGH'|'MEDIUM'|'LOW';
  entry_price: number|null; reasoning: string; blocked_reasons: string[];
  wait_for: string|null; adversarial_verdict?: 'PASS'|'CONDITIONAL_PASS'|'SKIP';
  paper_trading: boolean;
  outcome: { status: string; result: number|null; result_dollars: number|null; close_price: number|null; };
}
interface JournalData {
  decisions: JournalEntry[];
  summary: { total_evaluations:number; trades_taken:number; trades_blocked:number; win:number; loss:number; win_rate_pct:number; };
}
interface OutcomeFormData { status:'WIN'|'LOSS'|'SCRATCH'|'EXPIRED'; close_price:number; close_timestamp:string; result:number; result_dollars:number; }

function LogOutcomeModal({ entry, onClose, onSave }: { entry:JournalEntry; onClose:()=>void; onSave:(id:string,d:OutcomeFormData)=>Promise<void>; }) {
  const [form, setForm] = useState({ status:'WIN' as 'WIN'|'LOSS'|'SCRATCH'|'EXPIRED', close_price:'', result:'' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const handleSave = async () => {
    if (!form.close_price||!form.result) { setError('Close price and result required.'); return; }
    setSaving(true); setError('');
    try {
      await onSave(entry.id,{ status:form.status, close_price:parseFloat(form.close_price), close_timestamp:new Date().toISOString(), result:parseFloat(form.result), result_dollars:parseFloat(form.result)*10 });
      onClose();
    } catch { setError('Failed to save. Try again.'); } finally { setSaving(false); }
  };
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.8)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}} onClick={onClose}>
      <div style={{background:'#1a1a1e',border:'1px solid #2a2a2e',width:400,padding:24,fontFamily:'monospace'}} onClick={e=>e.stopPropagation()}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:16}}>
          <span style={{color:'#e0e0e0',fontSize:11,letterSpacing:3}}>LOG OUTCOME</span>
          <span style={{color:'#555',fontSize:10}}>{entry.id}</span>
          <button onClick={onClose} style={{background:'none',border:'none',color:'#555',cursor:'pointer',fontSize:14}}>✕</button>
        </div>
        <div style={{display:'flex',gap:8,marginBottom:16}}>
          {(['WIN','LOSS','SCRATCH','EXPIRED'] as const).map(s=>(
            <button key={s} onClick={()=>setForm(f=>({...f,status:s}))} style={{background:'transparent',border:'1px solid '+(form.status===s?s==='WIN'?'#22c55e':s==='LOSS'?'#ef4444':'#d4a520':'#2a2a2e'),color:form.status===s?s==='WIN'?'#22c55e':s==='LOSS'?'#ef4444':'#d4a520':'#555',padding:'4px 10px',cursor:'pointer',fontSize:10,fontFamily:'monospace'}}>{s}</button>
          ))}
        </div>
        <div style={{marginBottom:12}}>
          <div style={{color:'#555',fontSize:9,letterSpacing:2,marginBottom:4}}>CLOSE PRICE</div>
          <input type="number" step="0.01" placeholder="79.42" value={form.close_price} onChange={e=>setForm(f=>({...f,close_price:e.target.value}))} style={{width:'100%',background:'#111',border:'1px solid #2a2a2e',color:'#e0e0e0',padding:'7px 10px',fontFamily:'monospace',fontSize:13,boxSizing:'border-box' as const}} />
        </div>
        <div style={{marginBottom:12}}>
          <div style={{color:'#555',fontSize:9,letterSpacing:2,marginBottom:4}}>RESULT (TICKS)</div>
          <input type="number" step="1" placeholder="50 or -25" value={form.result} onChange={e=>setForm(f=>({...f,result:e.target.value}))} style={{width:'100%',background:'#111',border:'1px solid #2a2a2e',color:'#e0e0e0',padding:'7px 10px',fontFamily:'monospace',fontSize:13,boxSizing:'border-box' as const}} />
          {form.result && <div style={{color:parseFloat(form.result)>=0?'#22c55e':'#ef4444',fontSize:10,marginTop:4}}>${(parseFloat(form.result)*10).toFixed(0)} / contract</div>}
        </div>
        {error && <div style={{color:'#ef4444',fontSize:10,marginBottom:8}}>{error}</div>}
        <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:16}}>
          <button onClick={onClose} style={{background:'transparent',border:'1px solid #2a2a2e',color:'#555',padding:'6px 14px',cursor:'pointer',fontFamily:'monospace',fontSize:10}}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{background:'#d4a520',border:'none',color:'#000',padding:'6px 14px',cursor:'pointer',fontFamily:'monospace',fontSize:10,fontWeight:700}}>{saving?'Saving...':'Save Outcome'}</button>
        </div>
      </div>
    </div>
  );
}

export default function JournalTable() {
  const [data, setData] = useState<JournalData|null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string|null>(null);
  const [outcomeEntry, setOutcomeEntry] = useState<JournalEntry|null>(null);
  const [lastCount, setLastCount] = useState(0);
  const [flashId, setFlashId] = useState<string|null>(null);

  const fetchJournal = useCallback(async (silent=false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/journal');
      if (!res.ok) throw new Error();
      const json: JournalData = await res.json();
      if (silent && json.decisions.length > lastCount) {
        const newest = json.decisions[json.decisions.length-1];
        setFlashId(newest.id);
        setTimeout(()=>setFlashId(null),3000);
      }
      setLastCount(json.decisions.length);
      setData(json);
    } catch { /* silent fail on poll */ } finally { if (!silent) setLoading(false); }
  }, [lastCount]);

  useEffect(()=>{ fetchJournal(); },[]);
  useEffect(()=>{ const t=setInterval(()=>fetchJournal(true),15000); return ()=>clearInterval(t); },[fetchJournal]);

  const handleLogOutcome = async (id:string, outcome:OutcomeFormData) => {
    const res = await fetch('/api/journal',{ method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,outcome}) });
    if (!res.ok) throw new Error();
    await fetchJournal(true);
  };

  const fmt = (iso:string) => new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'America/New_York',hour12:false})+' ET';
  const dirColor = (d:string) => d==='LONG'?'#22c55e':d==='SHORT'?'#ef4444':'#d4a520';
  const confColor = (c:string) => c==='CONVICTION'||c==='HIGH'?'#22c55e':c==='MEDIUM'?'#d4a520':'#555';
  const advColor = (v?:string) => v==='PASS'?'#22c55e':v==='CONDITIONAL_PASS'?'#d4a520':v==='SKIP'?'#ef4444':'#555';
  const outColor = (s:string) => s==='WIN'?'#22c55e':s==='LOSS'?'#ef4444':s==='SCRATCH'?'#d4a520':'#555';

  if (loading) return <div style={{color:'#555',fontFamily:'monospace',fontSize:11,letterSpacing:2,padding:40}}>LOADING DECISION LEDGER...</div>;
  if (!data) return <div style={{color:'#ef4444',fontFamily:'monospace',fontSize:11,padding:40}}>JOURNAL UNAVAILABLE</div>;

  const { decisions=[], summary } = data;
  const sorted = [...decisions].reverse();
  const cols = '160px 130px 80px 70px 110px 75px 100px 130px 95px 75px 20px';

  return (
    <div style={{fontFamily:'monospace',fontSize:11}}>
      <div style={{display:'flex',alignItems:'center',gap:0,background:'#1a1a1e',border:'1px solid #2a2a2e',padding:'12px 20px',marginBottom:16}}>
        {[['SIGNALS',summary.total_evaluations,'#e0e0e0'],['TAKEN',summary.trades_taken,'#e0e0e0'],['BLOCKED',summary.trades_blocked,'#e0e0e0'],['WINS',summary.win,'#22c55e'],['LOSSES',summary.loss,'#ef4444'],['WIN RATE',summary.win_rate_pct+'%','#d4a520']].map(([label,val,color],i)=>(
          <div key={label as string} style={{display:'flex',flexDirection:'column' as const,alignItems:'center',padding:'0 16px',borderRight:i<5?'1px solid #2a2a2e':'none'}}>
            <span style={{fontSize:20,fontWeight:700,color:color as string}}>{val}</span>
            <span style={{color:'#555',fontSize:9,letterSpacing:1,marginTop:2}}>{label}</span>
          </div>
        ))}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6,color:'#22c55e',fontSize:9,letterSpacing:2}}>
          <span style={{width:6,height:6,borderRadius:'50%',background:'#22c55e',display:'inline-block'}} />LIVE
        </div>
      </div>

      {sorted.length===0 && (
        <div style={{background:'#1a1a1e',border:'1px solid #2a2a2e',padding:40,textAlign:'center' as const,color:'#555',letterSpacing:3}}>
          NO SIGNALS YET
        </div>
      )}

      {sorted.length>0 && (
        <div>
          <div style={{display:'grid',gridTemplateColumns:cols,background:'#111',border:'1px solid #2a2a2e',padding:'8px 12px',color:'#555',fontSize:9,letterSpacing:1,gap:8}}>
            {['ID','TIME (ET)','DIR','SCORE','CONFIDENCE','ENTRY','SESSION','ADVERSARIAL','OUTCOME','SOURCE',''].map(h=><span key={h}>{h}</span>)}
          </div>
          {sorted.map(entry=>(
            <div key={entry.id} style={{border:'1px solid #2a2a2e',borderTop:'none',background:flashId===entry.id?'#1a2e1a':'#1a1a1e',transition:'background 1s'}}>
              <div style={{display:'grid',gridTemplateColumns:cols,padding:'10px 12px',gap:8,alignItems:'center',cursor:'pointer'}} onClick={()=>setExpandedId(expandedId===entry.id?null:entry.id)}>
                <span style={{color:'#555',fontSize:10}}>{entry.id}</span>
                <span style={{color:'#888'}}>{fmt(entry.timestamp)}</span>
                <span style={{color:dirColor(entry.direction),fontWeight:700}}>{entry.direction}</span>
                <span style={{color:'#e0e0e0'}}><b>{entry.score}</b><span style={{color:'#555'}}>/10</span> <span style={{color:'#d4a520'}}>{entry.grade}</span></span>
                <span style={{color:confColor(entry.confidence_label)}}>{entry.confidence_label}</span>
                <span style={{color:'#e0e0e0'}}>{entry.entry_price!=null?'$'+entry.entry_price.toFixed(2):'—'}</span>
                <span style={{color:'#888',fontSize:10}}>{entry.session.replace('_',' ')}</span>
                <span style={{color:advColor(entry.adversarial_verdict)}}>{entry.adversarial_verdict?.replace('_',' ')??'—'}</span>
                <span style={{color:outColor(entry.outcome.status)}}>{entry.outcome.status}{entry.outcome.result!=null&&<span style={{color:entry.outcome.result>=0?'#22c55e':'#ef4444'}}> {entry.outcome.result>0?'+':''}{entry.outcome.result}t</span>}</span>
                <span style={{color:entry.source==='WEBHOOK'?'#60a5fa':'#555',fontSize:9,letterSpacing:1}}>{entry.source}</span>
                <span style={{color:'#555',fontSize:10}}>{expandedId===entry.id?'▲':'▼'}</span>
              </div>
              {expandedId===entry.id&&(
                <div style={{padding:'16px 24px',background:'#111',borderTop:'1px solid #2a2a2e'}}>
                  <div style={{color:'#555',fontSize:9,letterSpacing:2,marginBottom:6}}>ALFRED REASONING</div>
                  <p style={{color:'#aaa',fontSize:12,lineHeight:1.6,margin:'0 0 12px',fontFamily:'system-ui'}}>{entry.reasoning}</p>
                  {entry.blocked_reasons?.length>0&&<><div style={{color:'#555',fontSize:9,letterSpacing:2,marginBottom:6}}>BLOCKED BECAUSE</div><ul style={{margin:'0 0 12px',paddingLeft:16}}>{entry.blocked_reasons.map((r,i)=><li key={i} style={{color:'#ef4444',fontSize:11,marginBottom:4,fontFamily:'system-ui'}}>{r}</li>)}</ul></>}
                  {entry.wait_for&&<><div style={{color:'#555',fontSize:9,letterSpacing:2,marginBottom:6}}>WAIT FOR</div><p style={{color:'#aaa',fontSize:12,lineHeight:1.6,margin:'0 0 12px',fontFamily:'system-ui'}}>{entry.wait_for}</p></>}
                  {entry.outcome.status==='OPEN'&&entry.direction!=='NO TRADE'&&(
                    <button onClick={e=>{e.stopPropagation();setOutcomeEntry(entry);}} style={{background:'transparent',border:'1px solid #d4a520',color:'#d4a520',fontFamily:'monospace',fontSize:10,letterSpacing:2,padding:'6px 14px',cursor:'pointer',marginTop:4}}>+ LOG OUTCOME</button>
                  )}
                  {entry.paper_trading&&<span style={{marginLeft:12,fontSize:9,color:'#555',border:'1px solid #333',padding:'2px 6px'}}>PAPER TRADING</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {outcomeEntry&&<LogOutcomeModal entry={outcomeEntry} onClose={()=>setOutcomeEntry(null)} onSave={handleLogOutcome} />}
    </div>
  );
}
