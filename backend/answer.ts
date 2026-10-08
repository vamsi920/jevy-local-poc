// Final answers: a model writes the prose, but every number, date and identifier it states must be
// present in (or arithmetically derived from) executed query results. Otherwise a deterministic
// template built from the rows is used instead.
import {z} from 'zod';
import type {Model} from './llm.js';
import type {Evidence,Row,Trace} from './types.js';

const isNum=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
export function fmt(v:unknown):string{
 if(v===null||v===undefined)return '—';
 if(isNum(v)){const n=v as number;return Number.isInteger(n)?n.toLocaleString('en-US'):Math.abs(n)>=100?n.toLocaleString('en-US',{maximumFractionDigits:1}):n.toLocaleString('en-US',{maximumFractionDigits:2});}
 if(typeof v==='boolean')return v?'yes':'no';
 return String(v);
}
export const humanize=(c:string)=>c.replace(/^count_star\(\)$/,'count').replace(/[_()*"]+/g,' ').replace(/\s+/g,' ').trim();

export function templateAnswer(evidence:Evidence[]):string{
 const parts=evidence.map(e=>{
  const rows=e.rows;const cols=Object.keys(rows[0]||{});
  if(!rows.length)return 'No matching records were found.';
  // Grounded results have a precise objective ("servers with at least one incidents where priority = 'P1' ...").
  if(rows.length===1&&cols.length===1)return `**${fmt(rows[0][cols[0]])}** — ${/ where | with (no|at least one) |^(count|avg|sum|max|min|earliest|latest) /.test(e.objective)?e.objective.replace(/"/g,''):describeQuery(cols[0],e.sql)}.`;
  if(rows.length===1)return cols.map(c=>`${humanize(c)}: **${fmt(rows[0][c])}**`).join(' · ')+'.';
  const labels=cols.filter(c=>!rows.every(r=>isNum(r[c])||r[c]===null));
  const measures=cols.filter(c=>rows.every(r=>isNum(r[c])||r[c]===null));
  if(labels.length>=1&&labels.length<=3&&measures.length>=1&&measures.length<=3){
   const m=measures[measures.length-1];const name=(r:Row)=>labels.map(l=>fmt(r[l])).join(' / ');
   const sorted=[...rows].sort((a,b)=>Number(b[m]??-Infinity)-Number(a[m]??-Infinity));
   const head=`${e.totalRows?fmt(e.totalRows):`${e.truncated?'More than ':''}${rows.length}`} groups by ${labels.map(humanize).join(' and ')}.`;
   if(rows.length<=8)return head+' '+sorted.map(r=>`${name(r)}: **${fmt(r[m])}**`).join(', ')+'.';
   return head+` Highest ${humanize(m)}: ${name(sorted[0])} (**${fmt(sorted[0][m])}**); lowest: ${name(sorted.at(-1)!)} (**${fmt(sorted.at(-1)![m])}**).`;
  }
  const first=cols.slice(0,2);
  return `${e.totalRows?`**${fmt(e.totalRows)}** matching records (first ${rows.length} shown)`:`${rows.length} records found`}${rows.length>5?', for example':''}: `+rows.slice(0,5).map(r=>first.map(c=>fmt(r[c])).join(' ')).join('; ')+'.';
 });
 return [...new Set(parts)].join('\n\n')+(evidence.some(e=>e.truncated)?' Only the first rows are displayed.':'');
}
// Plain description of what a scalar query measured, from its own SQL.
export function describeQuery(column:string,sql=''){
 const flat=sql.replace(/\s+/g,' ').replace(/"/g,'');
 const from=[...flat.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*)/gi)].map(m=>m[1]).filter((t,i,a)=>a.indexOf(t)===i&&!/^(select|ranked|latest|base|cte)$/i.test(t));
 const tidy=(x:string)=>x.replace(/to_(days|months|years|hours)\(CAST\(trunc\(CAST\((\d+) AS DOUBLE\)\) AS INTEGER\)\)/gi,(_m,u,n)=>`${n} ${u}`).replace(/to_(days|months|years|hours)\((\d+)\)/gi,(_m,u,n)=>`${n} ${u}`).replace(/\s*=\s*CAST\('t' AS BOOLEAN\)/gi,'').replace(/\s*=\s*CAST\('f' AS BOOLEAN\)/gi,' is false').replace(/CAST\('([^']+)' AS DATE\)/gi,"'$1'").replace(/[()]/g,'').replace(/\s+/g,' ').trim();
 const where=flat.match(/\bWHERE\s+(.+?)(?:\s+(?:GROUP BY|ORDER BY|LIMIT|HAVING|QUALIFY)\b|\)\s*SELECT|$)/i)?.[1]?.replace(/\b\w+\./g,'').trim();
 const cleanWhere=where?tidy(where):undefined;
 const what=humanize(column.replace(/^count\(DISTINCT [\w.]*?(\w+)\)$/i,'count of distinct $1').replace(/^count_star\(\)$|^count\(\*\)$/i,'count'));
 return `${what}${from.length?' of '+from.slice(0,3).join(' + '):''}${cleanWhere&&cleanWhere.length<160?' where '+cleanWhere:''}`;
}
const capital=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);

// Numbers a correct answer may state: cells, row counts, column totals and simple ratios/percentages.
function allowedNumbers(evidence:Evidence[]){
 const cells:number[]=[];const add=(n:number)=>{if(Number.isFinite(n))cells.push(n);};
 for(const e of evidence){
  add(e.rowCount);add(e.rows.length);if(e.totalRows)add(e.totalRows);
  const cols=Object.keys(e.rows[0]||{});
  for(const r of e.rows)for(const c of cols){const v=r[c];if(isNum(v))add(v as number);else if(typeof v==='string'){for(const m of v.matchAll(/-?\d+(?:\.\d+)?/g))add(Number(m[0]));}}
  for(const c of cols){const nums=e.rows.map(r=>r[c]).filter(isNum) as number[];if(nums.length>1){const sum=nums.reduce((a,b)=>a+b,0);add(sum);add(sum/nums.length);}}
 }
 const base=[...new Set(cells)].slice(0,80);
 const derived:number[]=[];
 for(const a of base)for(const b of base)if(b!==0&&a!==b){derived.push(a/b*100,a/b,a-b);}
 return {base,derived};
}
const closeTo=(x:number,y:number,text:string)=>{const decimals=(text.split('.')[1]||'').replace(/\D/g,'').length;return Math.abs(x-y)<=Math.max(0.5*10**-decimals,Math.abs(y)*0.005)+1e-9;};

export function verifyProse(text:string,evidence:Evidence[],question:string){
 const problems:string[]=[];
 const evidenceText=JSON.stringify(evidence.map(e=>e.rows)).toLowerCase();
 let rest=text;
 for(const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g)){if(!evidenceText.includes(m[0].slice(0,10))&&!question.includes(m[0].slice(0,10)))problems.push('date '+m[0]+' not in results');rest=rest.replace(m[0],' ');}
 for(const m of text.matchAll(/\b[A-Za-z]{2,}[-_]\d[\w-]*\b/g)){if(!evidenceText.includes(m[0].toLowerCase())&&!question.toLowerCase().includes(m[0].toLowerCase()))problems.push('identifier '+m[0]+' not in results');rest=rest.replace(m[0],' ');}
 const questionNumbers=new Set((question.match(/\d+(?:\.\d+)?/g)||[]).map(Number));
 const {base,derived}=allowedNumbers(evidence);
 for(const m of rest.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)){
  const raw=m[0].replaceAll(',','');const n=Number(raw);
  if(!Number.isFinite(n)||questionNumbers.has(n))continue;
  if(base.some(b=>closeTo(n,b,raw))||derived.some(d=>closeTo(n,d,raw)))continue;
  if(Number.isInteger(n)&&n>=0&&n<=10&&!base.length)continue;
  problems.push('number '+m[0]+' not supported by results');
 }
 const hasRows=evidence.some(e=>e.rows.length);
 if(hasRows&&/\b(no|zero) (matching )?(records|results|rows|data)\b|\bnot found\b|\bcould not find\b/i.test(text)&&!evidence.every(e=>e.rows.length===1&&Object.values(e.rows[0]).every(v=>v===0||v===null)))problems.push('claims no data although rows exist');
 if(!text.trim())problems.push('empty');
 if(/[{}\[\]]|\w':|":/.test(text))problems.push('looks like raw data, not prose');
 return {ok:!problems.length,problems};
}

const proseSchema=z.object({answer:z.string().min(1).max(1200)});
export async function composeAnswer(question:string,evidence:Evidence[],llm:Model,trace:Trace,opts:{rows:number;notes?:string[];draft?:string;templateForTables?:boolean}){
 const template=templateAnswer(evidence);
 // Small models summarise multi-row tables poorly; the deterministic summary is clearer.
 if(opts.templateForTables&&!opts.draft&&evidence.some(e=>e.rows.length>3))return {text:template,source:'template' as const,problems:[]};
 if(opts.draft){const check=verifyProse(opts.draft,evidence,question);if(check.ok)return {text:opts.draft,source:'model' as const,problems:[]};trace.answerCheck={draft:opts.draft,problems:check.problems};}
 // Trivial single values do not need a model call to read well.
 const remaining=(trace.deadlineMs||Infinity)-Date.now();
 if(remaining<8000)return {text:template,source:'template' as const,problems:[]};
 try{
  const prose=await llm(proseSchema,'Answer writing','You answer a user question using ONLY the SQL query results provided. Write 1-3 short sentences in plain English. Start with the direct answer. Copy numbers exactly as they appear in the results (you may round decimals). Do not mention SQL, tables or queries. Do not add facts, causes or advice that are not in the results. If results are empty, say nothing matched.',
   {question,results:evidence.map(e=>({purpose:e.objective,columns:Object.keys(e.rows[0]||{}),rows:e.rows.slice(0,opts.rows),totalRows:e.totalRows??e.rowCount,truncated:e.truncated})),notes:opts.notes?.length?opts.notes:undefined},
   {...trace,deadlineMs:Math.min(trace.deadlineMs||Infinity,Date.now()+20000)},{maxTokens:400});
  const check=verifyProse(prose.answer,evidence,question);
  if(check.ok&&prose.answer.trim().split(/\s+/).length<4)return {text:template,source:'template' as const,problems:['too terse']};
  if(check.ok)return {text:prose.answer.trim(),source:'model' as const,problems:[]};
  trace.answerCheck={draft:prose.answer,problems:check.problems};
  return {text:template,source:'template' as const,problems:check.problems};
 }catch{return {text:template,source:'template' as const,problems:[]};}
}
