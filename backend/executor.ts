import {config} from './config.js';
import {z} from 'zod';
import {normalizeSQL} from './sql-guard.js';
import { Catalog } from './catalog.js';
import { sqlLiteral,identifier } from './db.js';
import type { Model } from './llm.js';
import type {Plan,Step,Evidence,Trace,State} from './types.js';
export function validateDAG(plan:Plan, completed=new Set<string>()){
 const ids=new Set<string>();for(const s of plan.steps){if(ids.has(s.id)||completed.has(s.id)||!s.id)throw new Error('Duplicate/empty step ID');ids.add(s.id);}
 for(const s of plan.steps)for(const dep of s.dependencies)if(!ids.has(dep)&&!completed.has(dep))throw new Error(`Missing dependency ${dep}`);
 const done=new Set(completed);while(done.size<completed.size+ids.size){const ready=plan.steps.filter(s=>!done.has(s.id)&&s.dependencies.every(d=>done.has(d)));if(!ready.length)throw new Error('Cyclic dependencies');ready.forEach(s=>done.add(s.id));}
}
export function resolveReferences(sql:string,step:Step,evidence:Evidence[]){return sql.replace(/\{\{([\w-]+)\.([\w_]+)\}\}/g,(_,id,col)=>{if(!step.dependencies.includes(id))throw new Error('SQL references must be declared dependencies');const e=evidence.find(e=>e.stepId===id);if(!e||e.error)throw new Error('Missing dependency results');if(e.rows.length&&!e.rows.every(r=>Object.hasOwn(r,col)))throw new Error(`Dependency lacks ${col}`);const values=[...new Set(e.rows.map(r=>r[col]))];return values.length?values.map(sqlLiteral).join(','):'NULL';});}
const sqlSchema=z.object({sql:z.string()});
const reviewSchema=z.object({approved:z.boolean(),issues:z.array(z.string()).max(8)});
export class Executor {
 constructor(public catalog:Catalog,public llm:Model){}
 async execute(plan:Plan,trace:Trace,state:State,emit:(message:string)=>void){
  validateDAG(plan,new Set(trace.evidence.map(e=>e.stepId)));const pending=new Set(plan.steps.map(s=>s.id));
  while(pending.size){const ready=plan.steps.filter(s=>pending.has(s.id)&&s.dependencies.every(id=>trace.evidence.some(e=>e.stepId===id)));if(!ready.length)throw new Error('Unresolvable DAG');
   const batch=await Promise.all(ready.map(async step=>{
    const start=performance.now();let result:Evidence={stepId:step.id,objective:step.objective,tool:step.tool,rows:[],rowCount:0,truncated:false,durationMs:0,repairs:0};
    try{
     if(trace.sourceRevision!==undefined&&trace.sourceRevision!==this.catalog.db.revision)throw new Error('Dataset changed during execution; refresh the plan.');
     const entry=trace.checklist?.find(e=>e.id===step.id);if(entry)entry.status='running';
     if(step.dependencies.some(id=>trace.evidence.find(e=>e.stepId===id)?.error))throw new Error('Dependency failed; requires replan');
     emit(`${step.tool}: ${step.objective}`);
     const i=step.inputs;
     if(step.tool==='inspect_schema'){result.rows=[this.catalog.retrieve(i.query||step.objective)];result.rowCount=1;}
     else if(step.tool==='inspect_values')Object.assign(result,await this.catalog.values(i.table||'',i.column||''));
     else if(step.tool==='inspect_table'){const table=this.catalog.table(i.table||'');result.rows=[{metadata:table,samples:(await this.catalog.db.query(`SELECT * FROM ${identifier(table.name)} LIMIT 3`,3)).rows}];result.rowCount=1;}
     else {
      const calendar=this.catalog.tables.some(t=>t.name==='dataset_info')&&!i.sql?(await this.catalog.db.query("SELECT as_of, date_trunc('month',as_of)::DATE month_start, (date_trunc('month',as_of)+INTERVAL '1 month')::DATE next_month_start, (date_trunc('month',as_of)-INTERVAL '1 month')::DATE previous_month_start, (as_of-INTERVAL '30 days')::DATE recent_30_days_start FROM dataset_info")).rows[0]:{as_of:this.catalog.referenceDate||config.asOf};
      let error='';const failures=new Set<string>();let sql=i.sql||'';let requireReview=!sql;
      for(let attempt=0;attempt<=3;attempt++){
       if(!sql||attempt>0){requireReview=true;
        const context=this.catalog.context((trace.dataQuestion||trace.question)+(trace.recordSummary?' record details':'')+(state.lastQuestion?' '+trace.intent:'')+(plan.steps.length>1?' '+step.objective:''));
        emit(attempt?'Reasoning through SQL repair':'Reasoning with retrieved schema and conversation scope');
        const generated=await this.llm(sqlSchema,attempt?'SQL repair':'SQL reasoning',`You are a DuckDB SQL analyst. Reason about the requested entity, measure, fields and filters. Return JSON {"sql":"one SELECT"}. Preserve all requested fields and grouping labels. Count entity rows or IDs, not category labels. Apply only requested filters; absent values must not be replaced by unrelated categories. Use verified joins; avoid child-row count multiplication. Follow-ups use previous selected IDs. Dates require DATE 'YYYY-MM-DD'; use date_expression - INTERVAL '30 days', never MySQL DATE_SUB. ${step.dependencies.length?'Dependency placeholders: IN ({{step_id.column}}).':'Use concrete literal values.'} Use source field names and descriptive derived aliases. ${trace.recordSummary?'Include representative non-ID record properties from the supplied schema, alongside record IDs.':''} Repair the exact error.`,{question:(trace.dataQuestion||trace.question),resolvedFollowup:state.lastQuestion?trace.intent:undefined,objective:plan.steps.length>1?step.objective:undefined,schema:context.tables.map(t=>t.ddl).join('\n'),values:state.filters.length?context.tables.map(t=>({table:t.table,values:t.values})):undefined,joins:context.tables.map(t=>({table:t.table,joins:t.joins})),definitions:context.definitions,aliases:context.aliases,asOf:calendar.as_of,timeBounds:context.tables.some(t=>/DATE|TIMESTAMP/.test(t.ddl))?calendar:undefined,state:state.lastQuestion?state:undefined,dependencies:trace.evidence.filter(e=>step.dependencies.includes(e.stepId)),previousSQL:sql,error},trace);sql=generated.sql;
       }
       try{
        const resolved=resolveReferences(sql,step,trace.evidence);const normalized=await normalizeSQL(resolved,this.catalog,plan.steps.length===1?(trace.dataQuestion||trace.question):step.objective,Boolean(state.lastQuestion));result.sql=normalized.sql;
        normalized.notes.forEach(emit);Object.assign(result,await this.catalog.db.query(normalized.sql));
        const warnings=await this.catalog.checkValues(normalized.sql);
        for(const warning of warnings){const alternatives=this.catalog.table(warning.table).columns.filter(c=>c.name!==warning.column && c.values.includes(warning.literal));if(alternatives.length)throw new Error('Unrecognized '+warning.column+' value '+warning.literal+'. This stored value belongs to '+alternatives.map(c=>warning.table+'.'+c.name).join(', ')+'. Reconcile the requested filter with actual categorical fields.');}
        const reviewContext=this.catalog.context((trace.dataQuestion||trace.question)+(state.lastQuestion?' '+trace.intent:''));
        if(requireReview)emit('Independently reviewing SQL and executed evidence');
        const review=requireReview?await this.llm(reviewSchema,'SQL review',`Independently check that SQL answers the original request and step. Execution success or a returned count alone is not proof. Check measure versus COUNT, requested fields, grouping labels, entity grain, requested filters only, date bounds using asOf, join multiplication and scope of previous selected IDs. Approve only if all requested parts for this step are covered. Empty results and zero for genuinely absent values can be correct. For approval, issues must be empty. Otherwise reject with short concrete issues, not an answer.`,{question:(trace.dataQuestion||trace.question),resolvedFollowup:state.lastQuestion?trace.intent:undefined,objective:plan.steps.length>1?step.objective:undefined,sql:normalized.sql,rows:result.rows.slice(0,3),columns:Object.keys(result.rows[0]||{}),context:{schema:reviewContext.tables.map(t=>t.ddl),definitions:reviewContext.definitions,values:state.filters.length?reviewContext.tables.map(t=>t.values):undefined},asOf:calendar.as_of,timeBounds:reviewContext.tables.some(t=>/DATE|TIMESTAMP/.test(t.ddl))?calendar:undefined,selectedIds:state.selectedIds,dependencies:step.dependencies},trace):{approved:true,issues:[]};
        result.queryPlan={mode:'reasoned_sql',normalization:normalized.notes,review};if(!review.approved||review.issues.length)throw new Error('Semantic review: '+(review.issues.join('; ')||'Reviewer rejected the query without a concrete reason; check requested fields, filters and measure.'));
        error='';break;
       }catch(e){error=e instanceof Error?e.message:String(e);result.error=error;emit(`Query needs repair: ${error.slice(0,120)}`);const fingerprint=sql.trim()+'|'+error;if(failures.has(fingerprint)||error.includes('without a concrete reason'))break;failures.add(fingerprint);if(attempt<3){result.repairs++;trace.retries++;}}

      }
      if(error)throw new Error(error);delete result.error;
      result.valueWarnings=await this.catalog.checkValues(result.sql!);
      if(result.valueWarnings.length)emit('Inspecting stored values for unrecognized categorical filters: '+result.valueWarnings.map(w=>w.column+'='+w.literal).join(', '));
     }
     emit(`${step.id} completed — ${result.rowCount} rows${result.truncated?' (display capped)':''}`);
    }catch(e){result.error=e instanceof Error?e.message:String(e);emit(`${step.id} failed: ${result.error.slice(0,160)}`);}
    const entry=trace.checklist?.find(e=>e.id===step.id);if(entry){entry.status=result.error?'failed':'verified';entry.error=result.error;}
    result.durationMs=performance.now()-start;return result;
   }));trace.evidence.push(...batch);ready.forEach(s=>pending.delete(s.id));
  }
 }
}
