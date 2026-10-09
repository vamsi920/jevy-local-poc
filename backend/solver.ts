// Structured driver: generate several SQL candidates in parallel, repair each against real
// database errors, then pick the answer most candidates agree on (execution-based self-consistency).
// This is what lets very small models answer reliably; larger models need fewer candidates.
import {z} from 'zod';
import type {Catalog} from './catalog.js';
import type {Model} from './llm.js';
import type {Profile} from './model-profile.js';
import {describeMentions,type Grounding} from './grounding.js';
import {runSQL,toEvidence,type SqlOutcome} from './tools.js';
import {joinPath} from './sql-guard.js';
import {draftSQL} from './draft.js';
import type {Evidence,Trace} from './types.js';

export type Scope={table:string;key:string;ids:string[]};
export type SolveInput={question:string;grounding:Grounding;previous?:{question:string;sql:string[]};scope?:Scope;allowedLiterals:string[];followup:boolean};

const sqlSchema=z.object({sql:z.string().min(6)});
const reviewSchema=z.object({verdict:z.enum(['correct','incorrect']),problem:z.enum(['none','missing_filter','extra_filter','wrong_measure','wrong_grouping','wrong_join','wrong_time_range','missing_column','wrong_entity','other']),fix:z.string().max(400)});

// Rules are selected per question so small models only see guidance that applies.
const RULES:{when?:RegExp;text:(ref:string)=>string}[]=[
 {text:()=>'Use only tables and columns from the schema. Join tables only with the listed join keys.'},
 {text:()=>'Filter categorical columns with the exact stored values shown in the schema or facts. Apply every filter the question asks for and no other filters. Select only the columns needed to answer.'},
 {when:/\b(how many|count|number of)\b/i,text:()=>'Count rows of the table the question is about with count(*). Use count(DISTINCT key) only when counting a different entity through a join (e.g. servers that have vulnerabilities).'},
 {when:/\b(compare|vs|versus|or|more|fewer|less)\b/i,text:()=>'Comparing groups: one query with GROUP BY the compared column and WHERE column IN (the compared values).'},
 {when:/\b(by|per|each|every|breakdown|break down|group|split)\b/i,text:()=>'"by/per/each X": GROUP BY X and select X next to the measure.'},
 {when:/\b(top|most|least|highest|lowest|largest|smallest|biggest|best|worst|which \w+ has)\b/i,text:()=>'"top N"/"most": ORDER BY the measure DESC LIMIT N (LIMIT 1 for "which ... most"); select the label columns and the measure value.'},
 {when:/\b(percent|percentage|%|share|fraction|ratio|proportion|rate)\b/i,text:()=>'Percentage: 100.0 * count(*) FILTER (WHERE condition) / count(*). Fraction: avg(CASE WHEN condition THEN 1.0 ELSE 0 END).'},
 {when:/\b(average|avg|mean)\b/i,text:()=>'Average: avg(column).'},
 {when:/\b(total|sum|combined|overall|altogether)\b/i,text:()=>'"Total X" of a numeric column means sum(X) in one row, not a list of rows.'},
 {when:/\b(latest|most recent|newest|last \w+ (run|record|backup|incident)|current status)\b/i,text:()=>'Latest record per entity: row_number() OVER (PARTITION BY key ORDER BY time DESC) = 1 inside a CTE, then filter.'},
 {when:/\b(never|without|no \w+|none|not have|don't have|do not have|missing)\b/i,text:()=>'"never/without": NOT EXISTS (correlated subquery).'},
 {when:/\b(both|and also|as well as)\b/i,text:()=>'Entities meeting two conditions in child tables: EXISTS (...) AND EXISTS (...).'},
 {when:/\b(day|days|week|weeks|month|months|year|years|quarter|today|yesterday|recent|recently|last|past|since|ago|this|oldest|earliest|newest|date|when)\b/i,text:ref=>ref?`Today is ${ref}. Never use CURRENT_DATE or now(). Last N days: col >= DATE '${ref}' - INTERVAL N DAY. This month: col >= date_trunc('month', DATE '${ref}'). Last month: col >= date_trunc('month', DATE '${ref}') - INTERVAL 1 MONTH AND col < date_trunc('month', DATE '${ref}'). Oldest/earliest: min(col).`:'Use DuckDB date functions: col >= current_date - INTERVAL N DAY, date_trunc(\'month\', d).'},
 {text:()=>'Boolean columns: WHERE column or WHERE NOT column. Name result columns clearly (e.g. server_count).'},
];
export function sqlRules(catalog:Catalog,question=''){
 const rules=RULES.filter(r=>!r.when||!question||r.when.test(question)).map(r=>'- '+r.text(catalog.referenceDate));
 return `You are an expert DuckDB analyst. Write ONE read-only SELECT query that answers the question exactly.\nRules:\n${rules.join('\n')}\nReturn JSON {"sql":"..."}.`;
}

export function isComplex(question:string,g:Grounding){
 return g.tables.length>=2||/\b(average|avg|mean|percent|percentage|ratio|fraction|share|top|most|least|highest|lowest|latest|recent|last|never|without|both|compare|per|each|by|trend|between|since|days|month|week|year|distinct|unique)\b/i.test(question);
}

const rowSig=(r:Record<string,unknown>)=>Object.values(r).map(v=>typeof v==='number'?String(Math.round(v*1e6)/1e6):String(v));
function canonical(o:SqlOutcome){if(!o.ok)return '';return JSON.stringify(o.rows.map(r=>JSON.stringify(rowSig(r).sort())).sort());}
// a "agrees with" b when they have the same rows and one result's values are contained in the other's
// (e.g. a bare count vs. the same count plus extra columns).
function agrees(a:Extract<SqlOutcome,{ok:true}>,b:Extract<SqlOutcome,{ok:true}>){
 if(a.rows.length!==b.rows.length)return false;if(!a.rows.length)return true;
 const contained=(x:typeof a,y:typeof a)=>x.rows.every(r=>{const v=rowSig(r);return y.rows.some(s=>{const w=rowSig(s);return v.every(z=>w.includes(z));});});
 return contained(a,b)||contained(b,a);
}

export async function solveSQL(catalog:Catalog,llm:Model,profile:Profile,input:SolveInput,trace:Trace,emit:(m:string)=>void,id:string):Promise<Evidence>{
 const g=input.grounding;
 const tables=g.tables.length?g.tables:catalog.tables.filter(t=>!catalog.isReferenceTable(t.name)).map(t=>t.name);
 const facts=[...(tables.length>1?[`Join path: ${joinPath(catalog,tables)}`]:[]),...describeMentions(g),...g.corrections.map(c=>`"${c.from}" was read as "${c.to}"`),...(input.scope?[`The user refers to the previously listed ${input.scope.table}: ${input.scope.key} IN (${input.scope.ids.slice(0,60).map(v=>`'${v}'`).join(', ')}${input.scope.ids.length>60?', …':''})`]:[])];
 const context={question:input.question,schema:catalog.schemaText(tables,{full:profile.tier!=='tiny',grounding:g}),facts:facts.length?facts:undefined,definitions:g.definitions.length?g.definitions:undefined,previous:input.previous};
 const complex=isComplex(input.question,g)||input.followup;
 const system=sqlRules(catalog,input.question);
 const sqlCtx={question:input.question,grounding:g,allowedLiterals:input.allowedLiterals,followup:input.followup};

 const attempt=async(index:number)=>{
  const options=index===0?{think:complex}:{think:false,temperature:0.6+0.15*index,seed:1000+index*7919};
  let draft=await llm(sqlSchema,index?'SQL candidate':'SQL reasoning',system,context,trace,options);
  emit(`Query ${index+1} drafted — running it`);
  let outcome=await runSQL(catalog,draft.sql,sqlCtx);
  const history:{sql:string;error:string}[]=[];
  for(let r=0;r<profile.repairs&&!outcome.ok;r++){
   history.push({sql:outcome.sql,error:outcome.error+(outcome.hint?' Hint: '+outcome.hint:'')});
   emit(`Candidate ${index+1} needs repair: ${outcome.error.slice(0,110)}`);trace.retries++;
   draft=await llm(sqlSchema,'SQL repair',system+'\nThe previous query failed. Fix the exact problem and return a corrected query.',{...context,failedAttempts:history},trace,{think:profile.thinking&&complex,temperature:r?0.4:0,seed:2000+r+index*31});
   if(history.some(h=>h.sql.trim()===draft.sql.trim()))break;
   outcome=await runSQL(catalog,draft.sql,sqlCtx);
  }
  emit(outcome.ok?`Query ${index+1} returned ${outcome.rowCount} row${outcome.rowCount===1?'':'s'}`:`Query ${index+1} could not be fixed`);
  return outcome;
 };

 // Grounded draft: built from the schema when the question is fully understood; joins the vote.
 // Rewritten follow-ups are complete questions; only row-scoped ones ("those servers") skip the draft.
 const grounded=input.scope?null:draftSQL(input.question,g,catalog);
 const groundedRun=grounded?runSQL(catalog,grounded.sql,sqlCtx):undefined;
 if(grounded)emit('Built a grounded draft from the schema: '+grounded.explain.slice(0,120));
 // For tiny models a fully grounded draft outranks every model vote, so extra model calls add only latency.
 const groundedFirst=profile.tier==='tiny'&&groundedRun?await groundedRun:undefined;
 const modelCandidates=groundedFirst?.ok?0:profile.candidates;
 if(groundedFirst?.ok)emit('Question fully grounded in the schema; answering with the verified grounded query');
 const settled=await Promise.allSettled(Array.from({length:modelCandidates},(_,i)=>attempt(i)));
 const groundedOutcome=groundedFirst||(groundedRun?await groundedRun:undefined);
 const outcomes=settled.flatMap(s=>s.status==='fulfilled'?[s.value]:[]);
 const budgetHit=settled.find(s=>s.status==='rejected');
 const good=outcomes.filter((o):o is Extract<SqlOutcome,{ok:true}>=>o.ok);
 trace.candidates=[...(trace.candidates||[]),...outcomes.map(o=>({step:id,sql:o.sql,ok:o.ok,error:o.ok?undefined:o.error,rows:o.ok?o.rowCount:0,warnings:o.ok?o.warnings:undefined}))];
 if(groundedOutcome){
  trace.candidates.push({step:id,source:'grounded draft',sql:groundedOutcome.sql,ok:groundedOutcome.ok,error:groundedOutcome.ok?undefined:groundedOutcome.error,rows:groundedOutcome.ok?groundedOutcome.rowCount:0});
  // Tiny models share blind spots (they often agree on the same mistake), so a fully grounded draft
  // outranks them; larger models can still outvote it.
  if(groundedOutcome.ok)for(let k=0;k<(profile.tier==='tiny'?profile.candidates+1:1);k++)good.push(groundedOutcome);
 }
 if(!good.length){
  if(budgetHit&&!outcomes.length)throw (budgetHit as PromiseRejectedResult).reason;
  const last=outcomes.at(-1);return toEvidence(id,input.question,last||{ok:false,sql:'',error:'No SQL candidate succeeded',hint:''});
 }
 // Vote: each result scores the candidates that agree with it; ties prefer clean, minimal, non-empty results.
 const scored=good.map((o,i)=>({o,i,score:good.filter(x=>agrees(o,x)).length,cols:Object.keys(o.rows[0]||{}).length}));
 const assumes=(o:typeof good[number])=>o.notes.some(n=>n.startsWith('Assumed'))?1:0;
 // Results that actually measure something beat bare listings when the question asks for a quantity.
 const wantsMeasure=/\b(how many|count|number|most|least|top|total|sum|average|avg|percent|per|by)\b/i.test(input.question);
 const measures=(o:typeof good[number])=>wantsMeasure&&/\b(count|sum|avg|min|max|count_star)\s*\(/i.test(o.sql)?0:1;
 scored.sort((a,b)=>assumes(a.o)-assumes(b.o)||b.score-a.score||measures(a.o)-measures(b.o)||Number(!b.o.warnings.length)-Number(!a.o.warnings.length)||Number(b.o.rows.length>0)-Number(a.o.rows.length>0)||a.i-b.i);
 let chosen=scored[0].o;
 if(new Set(good.map(canonical)).size>1)emit(scored[0].score>=good.length?`Queries were written differently but all ${good.length} return matching results`:scored[0].score>1?`Queries disagreed — ${scored[0].score} of ${good.length} agree on the chosen result`:'Queries disagreed — kept the most reliable result');else if(good.length>1)emit(`All ${good.length} queries agree`);

 // Larger models review the chosen query once against the question; concrete problems get one repair.
 if(profile.review&&(trace.deadlineMs||Infinity)-Date.now()>25000){
  emit('Reviewing SQL against the question');
  try{
   const review=await llm(reviewSchema,'SQL review','Check whether the SQL and its result correctly answer the question. Look for missing or extra filters, wrong measure (count vs sum/avg/distinct), wrong grouping, wrong join, wrong date range, missing requested columns, or wrong entity. Say correct unless you find a concrete problem.',{question:input.question,facts:context.facts,sql:chosen.sql,columns:Object.keys(chosen.rows[0]||{}),firstRows:chosen.rows.slice(0,5),rowCount:chosen.rowCount},trace,{think:profile.tier==='large'});
   if(review.verdict==='incorrect'&&review.problem!=='none'&&review.fix.trim().length>8){
    emit('Reviewer found: '+review.problem.replaceAll('_',' ')+' — repairing');
    const repaired=await llm(sqlSchema,'SQL repair',system+'\nA reviewer found a problem in the previous query. Fix it.',{...context,previousSql:chosen.sql,problem:review.problem,fix:review.fix},trace,{think:profile.thinking&&complex});
    const outcome=await runSQL(catalog,repaired.sql,sqlCtx);
    if(outcome.ok)chosen=outcome;
   }
   (trace.candidates as unknown[]).push({step:id,review});
  }catch(e){if((e as Error).message?.includes('budget'))emit('Skipped review: time budget');}
 }
 // A grounded result carries a precise description of what was computed.
 const evidence=toEvidence(id,groundedOutcome&&chosen===groundedOutcome&&grounded?grounded.explain:input.question,chosen);evidence.repairs=trace.retries;
 return evidence;
}
