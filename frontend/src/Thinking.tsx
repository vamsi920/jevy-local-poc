import React,{useEffect,useState} from 'react';
import type {ProgressEvent} from './api';

export const PHASES=[
 {id:'understand',label:'Understanding the question',short:'Understand'},
 {id:'explore',label:'Finding the right data',short:'Explore'},
 {id:'query',label:'Writing and running queries',short:'Query'},
 {id:'verify',label:'Double-checking the results',short:'Verify'},
 {id:'answer',label:'Writing the answer',short:'Answer'},
] as const;
const order=(p?:string)=>Math.max(0,PHASES.findIndex(x=>x.id===p));

// Plain-language versions of internal progress messages.
export function humanEvent(m:string){
 return m.replace(/^run_sql: /,'Querying: ').replace(/^Reasoning with retrieved schema.*$/,'Reasoning over the schema')
  .replace(/^Drafting (\d+) SQL candidates in parallel$/,'Drafting $1 independent queries in parallel')
  .replace(/^Candidate (\d+) needs repair: /,'Query $1 needs a fix — ')
  
  .replace(/^Checking current schema and data profile$/,'Checking the latest schema');
}

function useElapsed(running:boolean,startedAt:number){
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{if(!running)return;const id=setInterval(()=>setNow(Date.now()),100);return()=>clearInterval(id);},[running]);
 return (now-startedAt)/1000;
}

export function ThinkingLive({events,startedAt}:{events:ProgressEvent[];startedAt:number}){
 const elapsed=useElapsed(true,startedAt);
 const current=events.length?order(events.at(-1)!.phase):0;
 const furthest=events.reduce((m,e)=>Math.max(m,order(e.phase)),0);
 const active=Math.max(current,furthest);
 const recent=events.slice(-4);
 return <div className="thinking" role="status" aria-live="polite">
  <div className="thinking-head">
   <div className="orb" aria-hidden="true"><i/><i/><i/></div>
   <div className="thinking-title">
    <strong className="shimmer" key={active}>{PHASES[active].label}</strong>
    <span>{elapsed.toFixed(1)}s · {events.length} step{events.length===1?'':'s'}</span>
   </div>
  </div>
  <ol className="phase-rail" aria-label="Progress">
   {PHASES.map((p,i)=><li key={p.id} className={i<active?'done':i===active?'active':''}><span className="dot">{i<active?<Check/>:null}</span><em>{p.short}</em></li>)}
  </ol>
  <ul className="live-log">
   {recent.map((e,i)=><li key={events.length-recent.length+i} className={i===recent.length-1?'latest':''}><span className="tick"/>{humanEvent(e.message)}</li>)}
  </ul>
 </div>;
}

export function ThinkingSummary({events,totalMs,calls,retries,model}:{events:ProgressEvent[];totalMs:number;calls:number;retries:number;model?:string}){
 const [open,setOpen]=useState(false);
 if(!events.length)return null;
 const groups=PHASES.map(p=>({...p,items:events.filter(e=>(e.phase||'understand')===p.id)})).filter(g=>g.items.length);
 return <div className={'thought'+(open?' open':'')}>
  <button className="thought-pill" aria-expanded={open} onClick={()=>setOpen(!open)}>
   <span className="spark" aria-hidden="true">✦</span>
   {totalMs<100?'Answered instantly':`Thought for ${(totalMs/1000).toFixed(1)}s`} · {events.length} steps{calls?` · ${calls} model call${calls===1?'':'s'}`:''}{retries?` · ${retries} fix${retries===1?'':'es'}`:''}
   <span className="chev" aria-hidden="true">›</span>
  </button>
  <div className="thought-body" hidden={!open}>
   {groups.map(g=><section key={g.id}><h4><span className="dot done"><Check/></span>{g.label}</h4><ol>{g.items.map((e,i)=><li key={i}><span>{humanEvent(e.message)}</span><time>{(e.at/1000).toFixed(1)}s</time></li>)}</ol></section>)}
   {model&&<p className="thought-model">Model: {model}</p>}
  </div>
 </div>;
}
export const Check=()=><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
