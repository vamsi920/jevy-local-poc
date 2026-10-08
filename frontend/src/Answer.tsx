import React,{useState} from 'react';
import type {Answer as AnswerT,Evidence} from './api';
import {ThinkingSummary} from './Thinking';

const label=(c:string)=>c.replace(/^count_star\(\)$/,'count').replace(/[_()"*]+/g,' ').replace(/\s+/g,' ').trim();
const format=(v:unknown)=>v===null||v===undefined?'—':typeof v==='number'?(Number.isInteger(v)?v.toLocaleString('en-US'):v.toLocaleString('en-US',{maximumFractionDigits:2})):typeof v==='boolean'?(v?'Yes':'No'):typeof v==='object'?JSON.stringify(v):String(v);

// Safe rendering of **bold**, _italic_ and paragraphs. Fresh answers reveal word by word.
function Rich({text,animate}:{text:string;animate:boolean}){
 let w=0;
 return <div className="answer-text">{text.split(/\n{2,}/).map((para,i)=><p key={i}>{para.split(/(\*\*[^*]+\*\*|_[^_]+_)/g).map((part,j)=>{
  const bold=part.startsWith('**')&&part.endsWith('**'),italic=!bold&&part.startsWith('_')&&part.endsWith('_')&&part.length>2;
  const body=bold?part.slice(2,-2):italic?part.slice(1,-1):part;
  const words=body.split(/(\s+)/).map((t,k)=>/^\s+$/.test(t)?t:<span key={k} className={animate?'word':undefined} style={animate?{animationDelay:`${Math.min(w++*18,1400)}ms`}:undefined}>{t}</span>);
  return bold?<strong key={j}>{words}</strong>:italic?<em key={j}>{words}</em>:<React.Fragment key={j}>{words}</React.Fragment>;
 })}</p>)}</div>;
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
 const tone=answer.status==='answered'?'':answer.status==='clarification'?' clarify':' problem';
 return <div className={'answer'+tone}>
  <ThinkingSummary events={t.events} totalMs={t.totalMs} calls={t.llm.length} retries={t.retries} model={model}/>
  <Rich text={answer.text} animate={fresh}/>
  {answer.evidence.map((e,i)=><EvidenceCard key={e.stepId+i} e={e} index={i}/>)}
  <div className="answer-actions">
   <button onClick={()=>navigator.clipboard?.writeText(answer.text).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);})} aria-label="Copy answer">{copied?'Copied':'Copy'}</button>
   <button onClick={onRetry} aria-label="Ask again">Retry</button>
   <span>{t.totalMs<100?'<0.1':(t.totalMs/1000).toFixed(1)}s{model?` · ${model}`:''}{t.driver?` · ${t.driver}`:''}</span>
  </div>
  {debug&&<details className="debug"><summary>Developer trace</summary><pre>{JSON.stringify({profile:t.profile,driver:t.driver,standalone:t.standalone,grounding:t.grounding,candidates:t.candidates,answerSource:t.answerSource,answerCheck:t.answerCheck,llm:t.llm,events:t.events,error:t.error},null,2)}</pre></details>}
 </div>;
}
