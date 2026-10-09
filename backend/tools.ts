// Tools shared by every driver. All database access goes through the read-only connection and the
// AST guard; mechanical errors are repaired deterministically before a model is asked to fix them.
import {normalizeSQL,autoRepair} from './sql-guard.js';
import {editDistance,norm,type Grounding} from './grounding.js';
import {identifier,sqlLiteral} from './db.js';
import type {Catalog} from './catalog.js';
import type {Evidence,Row} from './types.js';

export type SqlContext={question:string;grounding:Grounding;allowedLiterals:string[];followup:boolean;strict?:boolean};
export type SqlOutcome={ok:true;sql:string;rows:Row[];rowCount:number;truncated:boolean;totalRows?:number;summary?:ResultSummary;notes:string[];warnings:string[];durationMs:number}|{ok:false;sql:string;error:string;hint:string};

export async function runSQL(catalog:Catalog,sql:string,ctx:SqlContext):Promise<SqlOutcome>{
 const start=performance.now();let current=sql.trim().replace(/;\s*$/,'');const notes:string[]=[];const warnings:string[]=[];
 for(let attempt=0;attempt<3;attempt++){
  try{
   let normalized;
   try{normalized=await normalizeSQL(current,catalog,ctx.question,ctx.followup,{grounding:ctx.grounding,allowedLiterals:ctx.allowedLiterals});}
   catch(e){
    const message=e instanceof Error?e.message:String(e);
    // Exploratory agent queries may legitimately omit filters; keep them as warnings instead of failing.
    if(ctx.strict===false&&/not requested|filter missing|not grounded|not a stored value|does not read|names "/.test(message)){warnings.push(message);normalized=await normalizeSQL(current,catalog,'',true);}
    else throw e;
   }
   notes.push(...normalized.notes);
   const result=await catalog.db.query(normalized.sql);
   const sanity=checkResult(result.rows);if(sanity)warnings.push(sanity);
   // Large results: also count every matching row so answers state the true total, not "200+".
   let totalRows:number|undefined;
   let summary:ResultSummary|undefined;
   if(result.truncated){
    try{totalRows=Number(Object.values((await catalog.db.query(`SELECT count(*) AS n FROM (${normalized.sql.replace(/;\s*$/,'')}) jevy_total`,1)).rows[0])[0]);}catch{}
    summary=await summarizeResult(catalog,normalized.sql,result.rows).catch(()=>undefined);
   }
   return {ok:true,sql:normalized.sql,...result,totalRows,summary,notes:[...new Set(notes)],warnings,durationMs:performance.now()-start};
  }catch(e){
   const error=e instanceof Error?e.message:String(e);
   const repair=await autoRepair(current,error,catalog);
   if(repair.sql&&repair.sql!==current){notes.push(repair.hint);current=repair.sql;continue;}
   return {ok:false,sql:current,error:error.split('\n')[0].slice(0,400),hint:repair.hint};
  }
 }
 return {ok:false,sql:current,error:'Repeated mechanical repair failed',hint:''};
}

function checkResult(rows:Row[]){
 if(rows.length===1){const v=Object.values(rows[0]);if(v.length&&v.every(x=>x===null))return 'Every aggregate returned NULL: the filters probably match no rows or the wrong column was used.';}
 return '';
}

export function toEvidence(id:string,objective:string,o:SqlOutcome):Evidence{
 return o.ok?{stepId:id,objective,tool:'run_sql',sql:o.sql,rows:o.rows,rowCount:o.rowCount,truncated:o.truncated,totalRows:o.totalRows,summary:o.summary,durationMs:o.durationMs,repairs:0,warnings:o.warnings,queryPlan:{notes:o.notes}}
  :{stepId:id,objective,tool:'run_sql',sql:o.sql,rows:[],rowCount:0,truncated:false,durationMs:0,repairs:0,error:o.error+(o.hint?' Hint: '+o.hint:'')};
}

export function describeTable(catalog:Catalog,name:string){
 const t=catalog.tables.find(x=>x.name===name)||catalog.tables.map(x=>({x,d:editDistance(norm(name),x.name,4)})).sort((a,b)=>a.d-b.d)[0]?.x;
 if(!t)return {error:'No such table. Tables: '+catalog.tables.map(x=>x.name).join(', ')};
 return {table:t.name,schema:catalog.schemaText([t.name],{full:true}),sample:t.columns.slice(0,12).reduce((r,c)=>({...r,[c.name]:c.representatives[0]}),{})};
}

// Finds stored values that resemble user text, across categorical and high-cardinality text columns.
export async function findValues(catalog:Catalog,text:string,table?:string,column?:string){
 const needle=norm(text);const out:{table:string;column:string;value:string;score:number}[]=[];
 const tables=catalog.tables.filter(t=>!table||t.name===table);
 for(const t of tables)for(const c of t.columns){
  if(column&&c.name!==column)continue;
  for(const v of [...c.values,...c.lookup]){
   if(typeof v!=='string')continue;const nv=norm(v);
   // Exact > contains (whole words) > small edit distance; editDistance is capped, so a capped result means "no match".
   const d=editDistance(needle,nv,3);
   const score=nv===needle?1:(nv.length>2&&(` ${nv} `.includes(` ${needle} `)||` ${needle} `.includes(` ${nv} `)))?0.8:d<=3?1-d/Math.max(needle.length,nv.length,1):0;
   if(score>=0.6)out.push({table:t.name,column:c.name,value:v,score});
  }
 }
 if(out.length<5){
  const queries:Promise<void>[]=[];
  for(const t of tables)for(const c of t.columns){
   if(column&&c.name!==column)continue;
   if(c.type!=='VARCHAR'||c.values.length||c.lookup.length)continue;
   queries.push(catalog.db.query(`SELECT DISTINCT ${identifier(c.name)} AS v FROM ${identifier(t.name)} WHERE ${identifier(c.name)} ILIKE ${sqlLiteral('%'+text.trim()+'%')} LIMIT 5`,5).then(r=>{for(const row of r.rows)out.push({table:t.name,column:c.name,value:String(row.v),score:0.7});}).catch(()=>{}));
  }
  await Promise.all(queries);
 }
 return out.sort((a,b)=>b.score-a.score).slice(0,12);
}

export function metadataRows(catalog:Catalog,tableNames?:string[]){
 if(tableNames?.length===1){const t=catalog.table(tableNames[0]);return t.columns.map(c=>({column:c.name,type:c.type,example:c.values.length?c.values.slice(0,6).join(', '):c.representatives[0]===undefined?null:String(c.representatives[0])}));}
 return catalog.tables.filter(t=>!catalog.isReferenceTable(t.name)).map(t=>({table:t.name,rows:t.rowCount,columns:t.columns.length,description:t.description||null}));
}

// Large results are never shipped to the model row by row: DuckDB computes column statistics over the
// complete result (ranges, averages, distinct counts, top categories) and only that summary is shown.
export type ResultSummary={column:string;min?:unknown;max?:unknown;avg?:number;sum?:number;distinct?:number;top?:{value:unknown;count:number}[]}[];
export async function summarizeResult(catalog:Catalog,sql:string,sample:Row[]):Promise<ResultSummary>{
 const cols=Object.keys(sample[0]||{}).filter(c=>/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)).slice(0,12);
 const isNum=(c:string)=>sample.every(r=>r[c]===null||typeof r[c]==='number');
 const base=`(${sql.replace(/;\s*$/,'')}) jevy_summary`;
 const exprs=cols.flatMap(c=>{const q=identifier(c);return isNum(c)?[`min(${q}) AS "${c}__min"`,`max(${q}) AS "${c}__max"`,`avg(${q}) AS "${c}__avg"`,`sum(${q}) AS "${c}__sum"`]:[`approx_count_distinct(${q}) AS "${c}__distinct"`,`min(${q}) AS "${c}__min"`,`max(${q}) AS "${c}__max"`];});
 const stats=(await catalog.db.query(`SELECT ${exprs.join(', ')} FROM ${base}`,1)).rows[0]||{};
 const out:ResultSummary=cols.map(c=>({column:c,min:stats[c+'__min'],max:stats[c+'__max'],...(isNum(c)?{avg:Number(stats[c+'__avg']),sum:Number(stats[c+'__sum'])}:{distinct:Number(stats[c+'__distinct'])})}));
 // Top categories for low-cardinality text columns.
 for(const s of out.filter(x=>x.distinct!==undefined&&x.distinct>0&&x.distinct<=50).slice(0,3)){
  const q=identifier(s.column);
  s.top=(await catalog.db.query(`SELECT ${q} AS value, count(*) AS count FROM ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,5)).rows.map(r=>({value:r.value,count:Number(r.count)}));
 }
 return out;
}
