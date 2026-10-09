import React,{useState} from 'react';
import type {Answer as AnswerT,Evidence} from './api';
import {ChartCard} from './Chart';

const label=(c:string)=>c.replace(/^count_star\(\)$/,'count').replace(/[_()"*]+/g,' ').replace(/\s+/g,' ').trim();
const format=(v:unknown)=>v===null||v===undefined?'—':typeof v==='number'?(Number.isInteger(v)?v.toLocaleString('en-US'):v.toLocaleString('en-US',{maximumFractionDigits:2})):typeof v==='boolean'?(v?'Yes':'No'):typeof v==='object'?JSON.stringify(v):String(v);

// Safe rendering of **bold**, _italic_ and paragraphs. Fresh answers reveal word by word.
function Rich({text,animate}:{text:string;animate:boolean}){
 let w=0;
 const inline=(line:string)=>line.split(/(\*\*[^*]+\*\*|_[^_]+_)/g).map((part,j)=>{
  const bold=part.startsWith('**')&&part.endsWith('**'),italic=!bold&&part.startsWith('_')&&part.endsWith('_')&&part.length>2;
  const body=bold?part.slice(2,-2):italic?part.slice(1,-1):part;
  const words=body.split(/(\s+)/).map((t,k)=>/^\s+$/.test(t)?t:<span key={k} className={animate?'word':undefined} style={animate?{animationDelay:`${Math.min(w++*18,1400)}ms`}:undefined}>{t}</span>);
  return bold?<strong key={j}>{words}</strong>:italic?<em key={j}>{words}</em>:<React.Fragment key={j}>{words}</React.Fragment>;
 });
 // Paragraphs; lines starting with "- " or "1. " become lists, other single line breaks are kept.
 return <div className="answer-text">{text.split(/\n{2,}/).map((para,i)=>{
  const lines=para.split('\n');
  if(lines.every(l=>/^\s*(?:[-•]|\d+\.)\s+/.test(l))){const ordered=/^\s*\d+\./.test(lines[0]);const items=lines.map((l,k)=><li key={k}>{inline(l.replace(/^\s*(?:[-•]|\d+\.)\s+/,''))}</li>);return ordered?<ol key={i}>{items}</ol>:<ul key={i}>{items}</ul>;}
  const head=lines.findIndex(l=>/^\s*[-•]\s+/.test(l));
  if(head>0&&lines.slice(head).every(l=>/^\s*[-•]\s+/.test(l)))return <React.Fragment key={i}><p>{lines.slice(0,head).map((l,k)=><React.Fragment key={k}>{k>0&&<br/>}{inline(l)}</React.Fragment>)}</p><ul>{lines.slice(head).map((l,k)=><li key={k}>{inline(l.replace(/^\s*[-•]\s+/,''))}</li>)}</ul></React.Fragment>;
  return <p key={i}>{lines.map((l,k)=><React.Fragment key={k}>{k>0&&<br/>}{inline(l)}</React.Fragment>)}</p>;
 })}</div>;
}

// Prose answers (summaries, record deep dives, definitions) keep their supporting queries one click away.
function Supporting({evidence,offset}:{evidence:Evidence[];offset:number}){
 const [open,setOpen]=useState(false);
 if(!evidence.length)return null;
 return <div className="supporting"><button className="link" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'Hide':'Show'} the {evidence.length} quer{evidence.length===1?'y':'ies'} behind this answer</button>
  {open&&evidence.map((e,i)=><EvidenceCard key={e.stepId+i} e={e} index={i+offset}/>)}</div>;
}

function EvidenceCard({e,index}:{e:Evidence;index:number}){
 const [sql,setSql]=useState(false);const [copied,setCopied]=useState(false);
 const columns=Object.keys(e.rows[0]||{});
 const metric=e.rows.length===1&&columns.length<=4&&columns.every(c=>typeof e.rows[0][c]!=='object');
 return <section className="evidence" style={{animationDelay:`${200+index*120}ms`}}>
  <header><span className="evidence-label">{e.tool==='catalog'?'Schema':'Result'}</span><strong>{e.objective}</strong><span className="evidence-meta">{e.rowCount.toLocaleString('en-US')} row{e.rowCount===1?'':'s'}{e.truncated?' · capped':''}</span></header>
  {!e.rows.length?<p className="empty">No matching rows.</p>:metric?<div className="metrics">{columns.map(c=><div key={c}><span>{label(c)}</span><strong>{format(e.rows[0][c])}</strong></div>)}</div>:
   <div className="table-wrap" tabIndex={0} aria-label="Query results"><table><thead><tr>{columns.map(c=><th key={c}>{label(c)}</th>)}</tr></thead><tbody>{e.rows.map((r,i)=><tr key={i}>{columns.map(c=><td key={c} className={typeof r[c]==='number'?'num':undefined}>{format(r[c])}</td>)}</tr>)}</tbody></table></div>}
  {e.sql&&<footer><button className="link" aria-expanded={sql} onClick={()=>setSql(!sql)}>{sql?'Hide':'Show'} SQL</button>{sql&&<button className="link" onClick={()=>{navigator.clipboard?.writeText(e.sql!).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);});}}>{copied?'Copied':'Copy'}</button>}</footer>}
  {sql&&e.sql&&<pre className="sql">{e.sql}</pre>}
 </section>;
}

export function AnswerView({answer,fresh,model,onRetry,debug}:{answer:AnswerT;fresh:boolean;model?:string;onRetry:()=>void;debug:boolean}){
 const [copied,setCopied]=useState(false);
 const t=answer.trace;
 const chart=answer.chart;
 const all=[...(chart?[chart]:[]),...(answer.charts||[])];
 const sourceOf=(c:NonNullable<typeof chart>)=>answer.evidence.filter(e=>c.sourceStepIds.includes(e.stepId));
 const chartSource=all.flatMap(sourceOf);
 const card=(c:NonNullable<typeof chart>,i:number,compact=false)=>{const src=sourceOf(c);return <ChartCard key={c.title+i} spec={c} index={i} compact={compact} sql={src.map(e=>e.sql).filter(Boolean).join(';\n\n')} rows={src.length===1?src[0].rows:undefined}/>;};
 const tone=answer.status==='answered'?'':answer.status==='clarification'?' clarify':' problem';
 return <div className={'answer'+tone}>
  <Rich text={answer.text} animate={fresh}/>
  {all.length===1&&card(all[0],0)}
  {all.length>1&&<div className="chart-grid">{all.map((c,i)=>card(c,i,true))}</div>}
  {answer.presentation==='prose'?<Supporting evidence={answer.evidence.filter(e=>!chartSource.includes(e))} offset={all.length}/>:answer.evidence.filter(e=>!chartSource.includes(e)).map((e,i)=><EvidenceCard key={e.stepId+i} e={e} index={i+all.length}/>)}
  <div className="answer-actions">
   <button onClick={()=>navigator.clipboard?.writeText(answer.text).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);})} aria-label="Copy answer">{copied?'Copied':'Copy'}</button>
   <button onClick={onRetry} aria-label="Ask again">Retry</button>
   <span>{t.totalMs<100?'<0.1':(t.totalMs/1000).toFixed(1)}s{model?` · ${model}`:''}{t.driver?` · ${t.driver}`:''}</span>
  </div>
  {debug&&<details className="debug"><summary>Developer trace</summary><pre>{JSON.stringify({profile:t.profile,driver:t.driver,standalone:t.standalone,grounding:t.grounding,candidates:t.candidates,answerSource:t.answerSource,answerCheck:t.answerCheck,llm:t.llm,events:t.events,error:t.error},null,2)}</pre></details>}
 </div>;
}
