import React,{useEffect,useState} from 'react';
import type {ProgressEvent} from './api';

export const PHASES=[
 {id:'understand',label:'Understanding the question',done:'Understood the question'},
 {id:'explore',label:'Finding the right data',done:'Found the relevant data'},
 {id:'query',label:'Writing and running queries',done:'Wrote and ran queries'},
 {id:'verify',label:'Double-checking the results',done:'Checked the results'},
 {id:'answer',label:'Writing the answer',done:'Wrote the answer'},
] as const;
const order=(p?:string)=>Math.max(0,PHASES.findIndex(x=>x.id===p));

// Plain-language versions of internal progress messages.
export function humanEvent(m:string){
 return m.replace(/^run_sql: /,'Querying: ').replace(/^Reasoning with retrieved schema.*$/,'Reasoning over the schema')
  .replace(/^Drafting (\d+) SQL candidates in parallel$/,'Drafting $1 independent queries in parallel')
  .replace(/^Candidate (\d+) needs repair: /,'Query $1 needs a fix — ')
  .replace(/^Checking current schema and data profile$/,'Checking the latest schema')
  .replace(/^Model call: (.+)$/,(_,p:string)=>'Model · '+({'SQL candidate':'drafting a query','SQL repair':'repairing a query','SQL review':'reviewing the query against the question','SQL reasoning':'reasoning about the query','Answer writing':'writing the answer','Follow-up rewrite':'rewriting the follow-up as a full question','Planning':'splitting the question into steps','Agent step':'choosing the next tool','Intent':'reading the question','Operation planning':'planning the operations','Schema notes':'learning the schema'} as Record<string,string>)[p]||p.toLowerCase())
  .replace(/^Building chart: (\w+) of (\d+) points?$/,(_,t,n)=>`Building a ${t==='kpi'?'figure':t+' chart'} from ${n} data point${n==='1'?'':'s'}`);
}

// "Relevant tables: servers, incidents" and SQL fragments render as code chips.
function EventText({message}:{message:string}){
 const text=humanEvent(message);
 const sql=text.match(/^(.*?)(\b(?:SELECT|WITH)\b[\s\S]*)$/);
 if(sql)return <><span>{sql[1]}</span><code className="sql-chip">{sql[2].replace(/\s+/g,' ').slice(0,160)}{sql[2].length>160?'…':''}</code></>;
 const list=text.match(/^(Relevant tables|Interpreted spelling|Tables): (.+)$/);
 if(list)return <><span>{list[1]}</span>{list[2].split(/,\s*/).map((t,i)=><code key={i} className="chip">{t}</code>)}</>;
 return <span>{text}</span>;
}

function useNow(running:boolean){
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{if(!running)return;const id=setInterval(()=>setNow(Date.now()),100);return()=>clearInterval(id);},[running]);
 return now;
}

export const Spinner=()=><svg className="spinner" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".18" strokeWidth="2"/><path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
export const Check=()=><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>;

type Group={id:string;label:string;done:string;items:ProgressEvent[];start:number;end:number};
function groupEvents(events:ProgressEvent[],endAt:number):Group[]{
 const groups:Group[]=[];
 // Phases only move forward: a late "understand"-type message joins the step in progress instead of
 // reopening an earlier step, so the timeline reads top to bottom like a log.
 let at=0;
 for(const e of events){
  at=Math.max(at,order(e.phase||'understand'));const p=PHASES[at];
  const last=groups.at(-1);
  if(last&&last.id===p.id)last.items.push(e);else groups.push({...p,items:[e],start:e.at,end:e.at});
 }
 groups.forEach((g,i)=>{g.end=groups[i+1]?.start??endAt;});
 return groups;
}
const secs=(ms:number)=>ms<100?'<0.1s':(ms/1000).toFixed(1)+'s';

// One vertical trace for the whole life of a turn: live while the agent works, then it folds into a
// one-line summary that can be reopened. Every line is a real backend event.
export function Trace({events,live,startedAt,totalMs,calls,retries,model}:{events:ProgressEvent[];live:boolean;startedAt:number;totalMs?:number;calls?:number;retries?:number;model?:string}){
 const now=useNow(live);
 const elapsed=live?Math.max(0,now-startedAt):(totalMs??events.at(-1)?.at??0);
 const [open,setOpen]=useState(live);
 // Fold away once the answer arrives (after a beat, so the last step can be seen completing).
 useEffect(()=>{if(live){setOpen(true);return;}const id=setTimeout(()=>setOpen(false),700);return()=>clearTimeout(id);},[live]);
 if(!events.length&&!live)return null;
 const groups=groupEvents(events,live?elapsed:elapsed);
 const activeIndex=live?groups.length-1:-1;
 return <div className={'trace'+(live?' live':' done')+(open?' open':'')}>
  <button className="trace-head" onClick={()=>setOpen(!open)} aria-expanded={open}>
   <span className="trace-icon">{live?<Spinner/>:<span className="spark">✦</span>}</span>
   {live?<span className="trace-label shimmer">{groups.at(-1)?.label||'Thinking'}</span>:
    <span className="trace-label">{elapsed<100?'Answered instantly':`Thought for ${secs(elapsed)}`}</span>}
   <span className="trace-meta">{live?secs(elapsed):`${events.length} step${events.length===1?'':'s'}${calls?` · ${calls} model call${calls===1?'':'s'}`:''}${retries?` · ${retries} fix${retries===1?'':'es'}`:''}`}</span>
   <svg className="chev" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
  </button>
  <div className="trace-fold" aria-hidden={!open}>
   <div className="trace-inner">
    <ol className="steps">
     {!groups.length&&live&&<li className="step active"><span className="node"><Spinner/></span><div className="step-main"><div className="step-title"><span className="shimmer">Starting</span></div></div></li>}
     {groups.map((g,i)=>{
      const active=i===activeIndex;
      return <li key={g.id+i} className={'step '+(active?'active':'complete')}>
       <span className="node">{active?<Spinner/>:<Check/>}</span>
       <div className="step-main">
        <div className="step-title"><span className={active?'shimmer':''}>{active?g.label:g.done}</span><time>{secs(Math.max(0,g.end-g.start))}</time></div>
        <ul className="substeps">{g.items.map((e,k)=><li key={k} className={active&&k===g.items.length-1?'latest':''}><EventText message={e.message}/></li>)}</ul>
       </div>
      </li>;
     })}
    </ol>
    {!live&&model&&<p className="trace-model">Model · {model}</p>}
   </div>
  </div>
 </div>;
}
