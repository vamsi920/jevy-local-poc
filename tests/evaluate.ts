import {writeFile,mkdir} from 'node:fs/promises';
import {Database} from '../backend/db.js';
import {Catalog} from '../backend/catalog.js';
import {Agent} from '../backend/agent.js';
import {health} from '../backend/llm.js';
import {cases,type Case} from './cases.js';
import type {Answer,Row} from '../backend/types.js';
import {config} from '../backend/config.js';
const selected=cases.filter(c=>!process.env.EVAL_FILTER||process.env.EVAL_FILTER.split(',').includes(c.id));
const results:Record<string,unknown>[]=[];
if(!(await health()).ready){console.error('Evaluation requires local Ollama and '+config.model+'. No accuracy claim made.');process.exit(2);}
const db=await Database.open(),catalog=await new Catalog(db).build(),agent=new Agent(catalog);
function canonical(rows:Row[]){return JSON.stringify(rows.map(r=>Object.values(r).map(v=>typeof v==='number'?Math.round(v*1000000)/1000000:v).sort((a,b)=>String(a).localeCompare(String(b)))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));}
async function check(c:Case,a:Answer){
 if(c.oracle){const expected=(await db.query(c.oracle)).rows;return a.status==='answered'&&a.evidence.some(e=>canonical(e.rows)===canonical(expected));}
 if(c.kind==='write')return a.status!=='answered'&&!a.evidence.some(e=>e.error===undefined&&e.sql&&!/^\s*(SELECT|WITH)\b/i.test(e.sql));
 if(c.kind==='ambiguous')return a.status==='clarification';
 if(c.kind==='unsupported')return a.status!=='answered';
 if(c.kind==='multi'){const n=[4000,10000,16000];return a.status==='answered'&&n.every(v=>a.evidence.some(e=>e.rows.some(r=>Object.values(r).includes(v))))&&a.evidence.length>=3;}
 if(c.kind==='random'){
  const rows=a.evidence.flatMap(e=>e.rows).filter(r=>typeof r.server_id==='string');const ids=[...new Set(rows.map(r=>String(r.server_id)))];if(a.status!=='answered'||ids.length!==3)return false;
  for(const id of ids){const actual=(await db.query(`SELECT s.*,a.application_name,(SELECT count(*) FROM vulnerabilities v WHERE v.server_id=s.server_id) vulnerability_count,(SELECT incident_id FROM incidents i WHERE i.server_id=s.server_id ORDER BY created_date DESC,incident_id DESC LIMIT 1) latest_incident_id FROM servers s JOIN applications a USING(application_id) WHERE server_id='${id.replaceAll("'","''")}'`)).rows[0];if(actual.country!=='US')return false;
   if(c.id==='compound'){const evidence=rows.filter(r=>r.server_id===id);for(const key of ['hostname','os','application_name','vulnerability_count','latest_incident_id'])if(!evidence.some(r=>r[key]===actual[key]))return false;}
  }return true;
 }
 return false;
}
try{for(const c of selected){let answer=await agent.ask(c.question,undefined,(event)=>console.log(c.id,JSON.stringify(event)));for(const q of c.followups||[])answer=await agent.ask(q,answer.sessionId);const correct=await check(c,answer);const sql=answer.trace.evidence.filter(e=>e.tool==='run_sql');results.push({id:c.id,question:c.question,correct,status:answer.status,sqlSteps:sql.length,sqlSuccess:sql.filter(e=>!e.error).length,retries:answer.trace.retries,llmCalls:answer.trace.llm.length,llmLatencyMs:answer.trace.llm.reduce((n,c)=>n+c.durationMs,0),latencyMs:answer.trace.totalMs,answer});console.log(`${correct?'PASS':'FAIL'} ${c.id} ${(answer.trace.totalMs/1000).toFixed(1)}s | ${answer.trace.llm.length} calls | ${answer.trace.retries} repairs`);await save();}}finally{db.close();}
async function save(){const totalSql=results.reduce((n,r)=>n+Number(r.sqlSteps),0);const summary={providerContract:{contextTokens:4096,maxOutputTokens:3072,fastOutputTokens:900,schemaInPrompt:false,operationDecomposition:false,thinking:"adaptive",requestBudgetMs:config.requestTimeout,reasoningRoles:["SQL reasoning for numeric, temporal, multi-table or stateful requests","SQL repair","SQL review","Planning/Replan with at least 3 tables"]},model:config.model,date:new Date().toISOString(),seed:config.seed,asOf:config.asOf,tested:results.length,totalCases:cases.length,sqlExecutionSuccessRate:totalSql?results.reduce((n,r)=>n+Number(r.sqlSuccess),0)/totalSql:null,finalEvidenceAccuracy:results.filter(r=>r.correct).length/results.length,averageRetries:results.reduce((n,r)=>n+Number(r.retries),0)/results.length,averageLlmCalls:results.reduce((n,r)=>n+Number(r.llmCalls),0)/results.length,averageLlmLatencyMs:results.reduce((n,r)=>n+Number(r.llmLatencyMs),0)/results.length,averageResponseLatencyMs:results.reduce((n,r)=>n+Number(r.latencyMs),0)/results.length,accuracyDefinition:'Exact oracle result comparison (column-order independent), plus semantic entity checks for random cases and status checks for unsupported/ambiguous/write. SQL success is measured after bounded repair. Counts do not prove arbitrary-question generalization.'};await mkdir('test-results',{recursive:true});await writeFile(process.env.EVAL_OUTPUT||'test-results/evaluation.json',JSON.stringify({summary,results},null,2));console.log(JSON.stringify(summary));}
