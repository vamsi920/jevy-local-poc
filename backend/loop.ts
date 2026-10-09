// Tool-calling agent loop for models that support native tools: the model explores the schema,
// looks up stored values, runs (possibly parallel) queries, checks results and then answers.
import type {Catalog} from './catalog.js';
import type {Chat,ChatMessage,ToolSpec} from './llm.js';
import type {Profile} from './model-profile.js';
import {describeMentions,type Grounding} from './grounding.js';
import {runSQL,toEvidence,describeTable,findValues,metadataRows,type SqlOutcome} from './tools.js';
import {sqlRules,type Scope} from './solver.js';
import type {Evidence,Trace} from './types.js';

const tools:ToolSpec[]=[
 {type:'function',function:{name:'describe_table',description:'Show all columns of a table with types, stored categorical values and ranges.',parameters:{type:'object',properties:{table:{type:'string'}},required:['table']}}},
 {type:'function',function:{name:'find_values',description:'Find exact stored values that resemble some text (names, codes, categories, hostnames). Use before filtering on a value you are not sure about.',parameters:{type:'object',properties:{text:{type:'string'},table:{type:'string'},column:{type:'string'}},required:['text']}}},
 {type:'function',function:{name:'run_sql',description:'Run one read-only DuckDB SELECT. Returns columns, rows and row count, or an error with a hint. Several run_sql calls in one turn run in parallel.',parameters:{type:'object',properties:{sql:{type:'string'},purpose:{type:'string',description:'What this query computes'}},required:['sql','purpose']}}},
 {type:'function',function:{name:'final_answer',description:'Give the final answer to the user, based only on query results. Cite the query ids used.',parameters:{type:'object',properties:{answer:{type:'string'},query_ids:{type:'array',items:{type:'string'}}},required:['answer','query_ids']}}},
];

export type LoopResult={evidence:Evidence[];answer?:string;steps:number};
export async function toolLoop(catalog:Catalog,chat:Chat,profile:Profile,input:{question:string;grounding:Grounding;previous?:{question:string;sql:string[];summary:string};scope?:Scope;allowedLiterals:string[];followup:boolean},trace:Trace,emit:(m:string)=>void):Promise<LoopResult>{
 const g=input.grounding;
 const focus=g.tables.length?g.tables:[];
 const facts=[...describeMentions(g),...g.corrections.map(c=>`"${c.from}" was read as "${c.to}"`),...(input.scope?[`"they/those" refers to the previously listed ${input.scope.table}: ${input.scope.key} IN (${input.scope.ids.slice(0,80).map(v=>`'${v}'`).join(', ')})`]:[])];
 const system=`${sqlRules(catalog).replace(/Return JSON[^\n]*$/,'')}
You are working as an agent with tools. Process:
1. Decide which tables, columns, joins and filters the question needs. Use describe_table or find_values when unsure; do not guess stored values.
2. Use run_sql to compute the answer. Prefer one query with joins/aggregation. Run independent queries in the same turn.
3. Check the result: does it answer every part of the question with the right filters and grain? If not, fix and re-run.
4. Call final_answer with 1-3 plain sentences stating the result with exact numbers, and the ids of the queries used.
Never write data. Never answer from memory; every fact must come from query results.`;
 const overview=metadataRows(catalog).map(r=>`${(r as {table:string}).table} (${(r as {rows:number}).rows} rows)`).join(', ');
 const user=[`Question: ${input.question}`,
  input.previous?`Previous turn: "${input.previous.question}" -> ${input.previous.summary}\nPrevious SQL: ${input.previous.sql.join('; ')}`:'',
  facts.length?'Facts:\n- '+facts.join('\n- '):'',
  g.definitions.length?'Business definitions:\n- '+g.definitions.join('\n- '):'',
  `All tables: ${overview}`,
  focus.length?`Likely relevant schema:\n${catalog.schemaText(focus,{full:true,grounding:g})}`:'No table matched directly; use describe_table to explore.'].filter(Boolean).join('\n\n');
 const messages:ChatMessage[]=[{role:'system',content:system},{role:'user',content:user}];
 const queries=new Map<string,{outcome:SqlOutcome;purpose:string}>();
 let nudges=0,answer:string|undefined,cited:string[]=[];
 const sqlCtx={question:input.question,grounding:g,allowedLiterals:input.allowedLiterals,followup:input.followup,strict:false};
 let step=0;
 for(;step<profile.maxToolSteps;step++){
  compact(messages,profile.numCtx);
  const response=await chat(messages,tools,step?'Agent step':'Agent plan',trace,{think:profile.tier==='large'&&profile.thinking&&step===0});
  messages.push({role:'assistant',content:response.content,tool_calls:response.toolCalls.length?response.toolCalls:undefined});
  if(!response.toolCalls.length){
   const successful=[...queries.values()].some(q=>q.outcome.ok);
   if(successful&&response.content.length>3){answer=response.content;break;}
   if(++nudges>2)break;
   messages.push({role:'user',content:successful?'Call final_answer with your answer and the query ids.':'Use run_sql to get the data before answering.'});continue;
  }
  const final=response.toolCalls.find(c=>c.function.name==='final_answer');
  const others=response.toolCalls.filter(c=>c.function.name!=='final_answer');
  const results=await Promise.all(others.map(async call=>{
   const args=call.function.arguments as Record<string,string>;
   try{
    if(call.function.name==='describe_table'){emit('Inspecting table '+args.table);return describeTable(catalog,String(args.table||''));}
    if(call.function.name==='find_values'){emit(`Looking up stored values like "${args.text}"`);return {matches:await findValues(catalog,String(args.text||''),args.table||undefined,args.column||undefined)};}
    if(call.function.name==='run_sql'){
     const qid='q'+(queries.size+1);queries.set(qid,{outcome:{ok:false,sql:'',error:'running',hint:''},purpose:String(args.purpose||'query')});
     emit(`Running ${qid}: ${String(args.purpose||'query').slice(0,90)}`);
     const outcome=await runSQL(catalog,String(args.sql||''),sqlCtx);queries.set(qid,{outcome,purpose:String(args.purpose||'query')});
     if(!outcome.ok){emit(`${qid} failed: ${outcome.error.slice(0,100)}`);return {query_id:qid,error:outcome.error,hint:outcome.hint||undefined};}
     return {query_id:qid,columns:Object.keys(outcome.rows[0]||{}),rows:outcome.rows.slice(0,profile.rowsForModel),row_count:outcome.rowCount,truncated:outcome.truncated||outcome.rows.length>profile.rowsForModel,total_rows:outcome.totalRows,summary_of_all_rows:outcome.summary,warnings:outcome.warnings.length?outcome.warnings:undefined};
    }
    return {error:'Unknown tool '+call.function.name};
   }catch(e){return {error:e instanceof Error?e.message:String(e)};}
  }));
  others.forEach((call,i)=>messages.push({role:'tool',tool_name:call.function.name,tool_call_id:call.id,content:JSON.stringify(results[i])}));
  if(final){
   const args=final.function.arguments as {answer?:string;query_ids?:string[]};
   const ids=(Array.isArray(args.query_ids)?args.query_ids:[]).map(String).filter(id=>queries.get(id)?.outcome.ok);
   const usable=ids.length?ids:[...queries].filter(([,q])=>q.outcome.ok).map(([k])=>k).slice(-1);
   if(!usable.length){messages.push({role:'tool',tool_name:'final_answer',tool_call_id:final.id,content:'Rejected: no successful query supports this answer. Run SQL first.'});continue;}
   // One chance to reconsider when the cited query ignores something the question asked for.
   const warned=usable.flatMap(id=>{const o=queries.get(id)!.outcome;return o.ok?o.warnings:[];});
   if(warned.length&&nudges<2){nudges++;messages.push({role:'tool',tool_name:'final_answer',tool_call_id:final.id,content:'Check before answering: '+warned.join(' ')+' Fix the query or call final_answer again if it is correct.'});continue;}
   answer=String(args.answer||'');cited=usable;break;
  }
 }
 if(!cited.length)cited=[...queries].filter(([,q])=>q.outcome.ok).map(([k])=>k).slice(-2);
 trace.candidates=[...(trace.candidates||[]),...[...queries].map(([id,q])=>({step:id,purpose:q.purpose,sql:q.outcome.sql,ok:q.outcome.ok,error:q.outcome.ok?undefined:q.outcome.error}))];
 const evidence=cited.map(id=>toEvidence(id,queries.get(id)!.purpose,queries.get(id)!.outcome));
 return {evidence,answer,steps:step+1};
}

// Keep the conversation inside the context window: shrink old tool outputs first.
function compact(messages:ChatMessage[],numCtx:number){
 const budget=numCtx*3*0.7;let size=messages.reduce((n,m)=>n+m.content.length+JSON.stringify(m.tool_calls||'').length,0);
 for(let i=2;i<messages.length-2&&size>budget;i++){
  const m=messages[i];if(m.role!=='tool'||m.content.length<300)continue;
  const shorter=m.content.slice(0,240)+'… [older result truncated]';size-=m.content.length-shorter.length;m.content=shorter;
 }
}
