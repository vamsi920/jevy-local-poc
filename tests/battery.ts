// Live battery: npm run battery  (env: OLLAMA_MODEL, BATTERY_SPLIT=dev|holdout|all, BATTERY_FILTER=id,id, BATTERY_OUTPUT)
import {writeFile,mkdir} from 'node:fs/promises';
import {Database} from '../backend/db.js';
import {Catalog} from '../backend/catalog.js';
import {Agent} from '../backend/agent.js';
import {health} from '../backend/llm.js';
import {config} from '../backend/config.js';
import {battery as core,type BatteryCase} from './battery-cases.js';
import {battery100} from './battery100-cases.js';
// BATTERY_SET=100|150 runs the 100- or 150-question set; default runs the 58-case core set.
import {battery150,battery150Oracles} from './battery150-cases.js';
import {batteryShapes} from './battery-shapes-cases.js';
const battery:BatteryCase[]=process.env.BATTERY_SET==='100'?battery100:process.env.BATTERY_SET==='150'?battery150:process.env.BATTERY_SET==='shapes'?batteryShapes:core;
import type {Answer,Row} from '../backend/types.js';

const split=process.env.BATTERY_SPLIT||'all';
const filter=process.env.BATTERY_FILTER?.split(',');
const selected=battery.filter(c=>(split==='all'||c.split===split)&&(!filter||filter.includes(c.id)));
// The endpoint may be briefly busy (model loading, another run finishing): retry before giving up.
let ready=false;for(let i=0;i<6&&!ready;i++){ready=(await health()).ready;if(!ready)await new Promise(r=>setTimeout(r,10000));}
if(!ready){console.error('Battery requires local Ollama with '+config.model);process.exit(2);}
const db=await Database.open(),catalog=await new Catalog(db).build(),agent=new Agent(catalog);

const close=(a:unknown,b:unknown)=>{
 const x=Number(a),y=Number(b);
 if(typeof b==='number'||(!Number.isNaN(y)&&typeof a==='number')){
  if(Number.isNaN(x)||Number.isNaN(y))return false;
  const tol=Math.max(1e-6,Math.abs(y)*0.005);
  return Math.abs(x-y)<=tol||(y!==0&&(Math.abs(x-y*100)<=tol*100||Math.abs(x*100-y)<=tol));
 }
 return String(a).trim().toLowerCase()===String(b).trim().toLowerCase()||String(a).startsWith(String(b));
};
const cells=(a:Answer)=>a.evidence.flatMap(e=>e.rows.flatMap(r=>Object.values(r)));
const textHas=(text:string,v:unknown)=>{
 if(typeof v==='number'){
  const nums=(text.match(/-?\d[\d,]*(?:\.\d+)?/g)||[]).map(s=>Number(s.replaceAll(',','')));
  return nums.some(n=>close(n,v));
 }
 return text.toLowerCase().includes(String(v).toLowerCase());
};
async function oracleRows(c:BatteryCase){
 const sqls=Array.isArray(c.oracle)?c.oracle:c.oracle?[c.oracle]:[];
 return Promise.all(sqls.map(async s=>(await db.query(s,500)).rows));
}
async function check(c:BatteryCase,a:Answer):Promise<{correct:boolean;answerText:boolean}>{
 if(c.check==='write')return {correct:a.status!=='answered'||a.evidence.length===0,answerText:true};
 if(c.check==='unsupported')return {correct:a.status!=='answered'||a.evidence.every(e=>!e.rows.length),answerText:true};
 if(c.check==='ambiguous')return {correct:a.status==='clarification',answerText:true};
 if(a.status!=='answered')return {correct:false,answerText:false};
 const all=cells(a);
 if(c.check==='shape'){
  // A raw dump ("N matching records (first 200 shown)") never answers a shape question.
  const dumped=/matching records \(first \d+ shown\)|Only the first rows are displayed/i.test(a.text);
  const driver=String(a.trace.driver||'');
  const shapeOk=c.shape==='nodump'?!dumped:c.shape==='query'?!driver.startsWith('shape:'):c.shape==='joke'?!a.evidence.length:c.shape==='conversation'?driver==='conversation':c.shape==='multi'?driver.startsWith('multi:'):driver==='shape:'+c.shape;
  const values=[...(c.values||[]),...(c.oracle?(await oracleRows(c))[0].flatMap(r=>Object.values(r)) as (string|number)[]:[])];
  const has=values.every(v=>textHas(a.text,v)||all.some(x=>close(x,v)));
  return {correct:shapeOk&&!dumped&&has,answerText:values.every(v=>textHas(a.text,v))};
 }
 if(c.check==='scalar'){
  const alternatives=(await oracleRows(c)).map(rows=>Object.values(rows[0])[0]);
  // A listing whose answer states the exact matching total (from a full count) also answers "how many".
  const hit=alternatives.find(v=>all.some(x=>close(x,v))||(Number(v)===0&&textHas(a.text,0))||a.evidence.some(e=>e.totalRows!==undefined&&close(e.totalRows,v)));
  return {correct:hit!==undefined,answerText:hit!==undefined&&textHas(a.text,hit)};
 }
 if(c.check==='rows'){
  const [expected]=await oracleRows(c);const rows=a.evidence.flatMap(e=>e.rows);
  const ok=expected.every((exp:Row)=>rows.some(r=>Object.values(exp).every(v=>Object.values(r).some(x=>close(x,v)))));
  return {correct:ok,answerText:true};
 }
 const extra=battery150Oracles[c.id]&&battery.includes(c)&&battery===battery150?(await db.query(battery150Oracles[c.id],50)).rows.flatMap(r=>Object.values(r)) as (string|number)[]:[];
 const values=[...(c.values||[]),...extra].length?[...(c.values||[]),...extra]:(c.oracle?(await oracleRows(c))[0].flatMap(r=>Object.values(r)) as (string|number)[]:[]);
 const ok=values.every(v=>all.some(x=>close(x,v))||textHas(a.text,v));
 return {correct:ok,answerText:values.every(v=>textHas(a.text,v))};
}
function taxonomy(a:Answer,correct:boolean){
 if(correct)return '';
 const t=a.trace;
 if(/budget|timed out/i.test(a.text+(t.error||'')))return 'budget';
 if(a.status==='clarification')return 'over-clarify';
 if(a.status!=='answered')return t.evidence.some(e=>e.error)?'sql-failed':'stopped';
 if(!a.evidence.length)return 'no-evidence';
 return 'wrong-result';
}
const results:Record<string,unknown>[]=[];
const out=process.env.BATTERY_OUTPUT||`test-results/battery-${config.model.replace(/[^\w.-]+/g,'_')}.json`;
try{
 for(const c of selected){
  let answer:Answer|undefined;let sessionId:string|undefined;const started=performance.now();
  try{for(const q of c.turns){answer=await agent.ask(q,sessionId);sessionId=answer.sessionId;}}
  catch(e){console.log('ERROR',c.id,e);}
  if(!answer)continue;
  // An answer-key query that fails (e.g. times out on a loaded machine) marks this case, not the whole run.
  const {correct,answerText}=await check(c,answer).catch(e=>{console.log('ORACLE-ERROR',c.id,String(e).slice(0,160));return {correct:false,answerText:false};});
  const failure=taxonomy(answer,correct);
  results.push({id:c.id,split:c.split,category:c.category,turns:c.turns,correct,answerText,failure,status:answer.status,text:answer.text,latencyMs:performance.now()-started,llmCalls:answer.trace.llm.length,retries:answer.trace.retries,sql:answer.trace.evidence.map(e=>({sql:e.sql,error:e.error,rows:e.rowCount})),answer});
  console.log(`${correct?'PASS':'FAIL'} ${c.id.padEnd(24)} ${((performance.now()-started)/1000).toFixed(1).padStart(6)}s ${String(answer.trace.llm.length).padStart(3)} calls ${failure} | ${answer.text.replace(/\s+/g,' ').slice(0,140)}`);
  await save();
 }
}finally{db.close();}
async function save(){
 const by=(split:string)=>{const r=results.filter(x=>split==='all'||x.split===split);return {n:r.length,passed:r.filter(x=>x.correct).length,answerText:r.filter(x=>x.answerText).length,meanLatencyS:r.length?Math.round(r.reduce((n,x)=>n+Number(x.latencyMs),0)/r.length/100)/10:0};};
 const failures:Record<string,number>={};for(const r of results)if(r.failure)failures[String(r.failure)]=(failures[String(r.failure)]||0)+1;
 const summary={model:config.model,date:new Date().toISOString(),all:by('all'),dev:by('dev'),holdout:by('holdout'),fresh:by('fresh'),failures};
 await mkdir('test-results',{recursive:true});await writeFile(out,JSON.stringify({summary,results},null,2));
 if(results.length===selected.length)console.log(JSON.stringify(summary));
}
