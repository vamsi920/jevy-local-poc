import express from 'express';
import {existsSync} from 'node:fs';
import {generate} from './generate.js';
import {Database} from './db.js';
import {Catalog} from './catalog.js';
import {Agent} from './agent.js';
import {config} from './config.js';
import {health,warm,speedOf} from './llm.js';
import {provider} from './providers.js';
import {learnSchemaInBackground} from './schema-notes.js';
import {model as llmModel} from './llm.js';
import {getProfile} from './model-profile.js';
import {ChatStore} from './chat-store.js';
import {randomUUID} from 'node:crypto';
if(!existsSync(config.dbPath))await generate();
const db=await Database.open();const catalog=await new Catalog(db).build();const agent=new Agent(catalog);const store=await ChatStore.open(config.chatDbPath);const app=express();
app.use(express.json({limit:'16kb'}));
app.use((req,res,next)=>{const origin=req.headers.origin;if(origin&&!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))return res.status(403).json({error:'Local origins only'});next();});
// Study the schema in the background (once per schema version) so prompts carry the app's own notes.
const learnNotes=()=>{if(process.env.SCHEMA_NOTES!=='off')health().then(h=>{if(h.ready)learnSchemaInBackground(catalog,llmModel,m=>console.log(m));}).catch(()=>{});};
learnNotes();
// Cheap check every few minutes (file changed? -> rebuild now); full re-profile and re-learning daily.
const refreshTimer=setInterval(()=>{catalog.ensureFresh().then(()=>{const stale=!catalog.learned||catalog.learned.fingerprint!==catalog.schemaFingerprint||Date.now()-Date.parse(catalog.learned.learnedAt||'1970-01-01')>=config.schemaRefreshMs;if(stale)learnNotes();}).catch(e=>console.error('Catalog refresh failed:',e instanceof Error?e.message:String(e)));},Math.min(config.schemaChangeCheckMs,config.schemaRefreshMs));refreshTimer.unref();
app.get('/api/health',async(_req,res)=>{const h=await health();const p=h.ready?await getProfile():undefined;res.json({...h,profile:p&&{tier:p.tier,paramsB:Math.round(p.paramsB*100)/100,toolLoop:p.toolLoop,thinking:p.thinking,numCtx:p.numCtx,candidates:p.candidates,budgetMs:p.budgetMs},catalog:{version:catalog.version,refreshedAt:new Date(catalog.refreshedAt).toISOString(),refreshIntervalMs:config.schemaRefreshMs,error:catalog.refreshError},database:{tables:catalog.tables.length,rows:catalog.tables.reduce((n,t)=>n+t.rowCount,0),asOf:catalog.referenceDate||config.asOf,synthetic:true},ports:{backend:config.port,frontend:Number(process.env.FRONTEND_PORT||5173)}});});
app.get('/api/catalog',(_req,res)=>res.json({tables:catalog.tables,aliases:catalog.aliases,version:catalog.version,refreshedAt:catalog.refreshedAt,error:catalog.refreshError}));
// Installed local models with the strategy tier the harness will use for each.
async function models(){
 const listed=await provider().listModels();
 const list=await Promise.all(listed.map(async m=>{const p=await getProfile(m.name);return {name:m.name,parameters:m.parameters||(p.paramsB?`${Math.round(p.paramsB*10)/10}B`:''),family:m.family||'',sizeGb:m.sizeGb||0,tier:p.tier,toolLoop:p.toolLoop,thinking:p.thinking};}));
 return list.sort((a,b)=>parseFloat(a.parameters)*(a.parameters.endsWith('M')?0.001:1)-parseFloat(b.parameters)*(b.parameters.endsWith('M')?0.001:1));
}
app.get('/api/models',async(_req,res)=>res.json({default:config.model,models:(await models()).map(m=>({...m,tokensPerSecond:speedOf(m.name)?Math.round(speedOf(m.name)!.genTps):undefined}))}));
const warming=new Map<string,Promise<unknown>>();
app.post('/api/models/warm',async(req,res)=>{
 const name=String(req.body?.model||'');if(!(await models()).some(m=>m.name===name))return res.status(400).json({error:'Unknown local model'});
 if(!warming.has(name))warming.set(name,warm(name).finally(()=>setTimeout(()=>warming.delete(name),60000)));
 try{const r=await warming.get(name) as {ms:number;speed?:{genTps:number}};res.json({ok:true,ms:r.ms,tokensPerSecond:r.speed?Math.round(r.speed.genTps):undefined});}catch(e){res.status(502).json({error:e instanceof Error?e.message:String(e)});}
});
// Example questions derived from the live schema (no hardcoded dataset knowledge).
app.get('/api/suggestions',(_req,res)=>{
 const tables=catalog.tables.filter(t=>!catalog.isReferenceTable(t.name)).sort((a,b)=>b.rowCount-a.rowCount);
 const out:string[]=[];
 for(const t of tables){const cat=t.columns.find(c=>c.values.length>2&&c.values.length<=8);if(cat&&out.length<2)out.push(`How many ${t.name} are there by ${cat.name.replaceAll('_',' ')}?`);}
 const child=tables.find(t=>t.relationships.length);const rel=child?.relationships[0];
 if(child&&rel){const parent=rel.split(' = ')[1].split('.')[0];const label=catalog.tables.find(t=>t.name===parent)?.columns.find(c=>/(_name|hostname|title)$/.test(c.name));out.push(`Which 5 ${parent} have the most ${child.name}${label?`, with their ${label.name.replaceAll('_',' ')}`:''}?`);}
 const dated=tables.find(t=>t.columns.some(c=>/DATE|TIMESTAMP/.test(c.type)&&/created|start|discover/.test(c.name)));
 if(dated)out.push(`How many ${dated.name} were recorded last month?`);
 // One chart example, so people discover that any breakdown or trend can be drawn.
 if(dated)out.splice(1,0,`Plot ${dated.name} per month`);
 else{const t=tables.find(x=>x.columns.some(c=>c.values.length>2&&c.values.length<=8));const c=t?.columns.find(c=>c.values.length>2&&c.values.length<=8);if(t&&c)out.splice(1,0,`Pie chart of ${t.name} by ${c.name.replaceAll('_',' ')}`);}
 res.json({suggestions:out.slice(0,4)});
});
app.get('/api/conversations',async(_req,res)=>res.json({conversations:await store.list()}));
app.get('/api/conversations/:id',async(req,res)=>{const c=await store.get(req.params.id);if(!c)return res.status(404).json({error:'Conversation not found'});res.json({...c,state:undefined});});
app.patch('/api/conversations/:id',async(req,res)=>{const title=String(req.body?.title||'').trim();if(!title)return res.status(400).json({error:'Title required'});await store.rename(req.params.id,title);res.json({ok:true});});
app.delete('/api/conversations/:id',async(req,res)=>{if(agent.busy.has(req.params.id))return res.status(409).json({error:'Conversation is answering'});await store.remove(req.params.id);agent.sessions.delete(req.params.id);res.json({ok:true});});
app.post('/api/chat',async(req,res)=>{
 const {question,model}=req.body||{};let {sessionId}=req.body||{};
 if(model!==undefined&&(typeof model!=='string'||!(await models()).some(m=>m.name===model)))return res.status(400).json({error:'Unknown or unavailable local model.'});
 sessionId=sessionId||randomUUID();if(typeof question!=='string'||!question.trim()||question.length>4000||sessionId&&(!/^[\w-]{1,80}$/.test(sessionId)))return res.status(400).json({error:'Question must be 1–4000 characters; invalid session ID.'});
 if(agent.busy.size>=2)return res.status(429).json({error:'Two local requests are running. Try again after they finish.'});
 res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');res.flushHeaders();
 try{
  if(!agent.sessions.has(sessionId)){const state=await store.state(sessionId);if(state)agent.restore(sessionId,state);}
  const used=model||config.model;
  res.write(JSON.stringify({type:'start',sessionId,model:used})+'\n');
  const answer=await agent.ask(question.trim(),sessionId,event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');},used);
  await store.append(sessionId,question.trim(),answer,used).catch(e=>console.error('History save failed:',e));
  if(!res.destroyed)res.end(JSON.stringify({type:'result',answer,model:used})+'\n');
 }catch(e){res.end(JSON.stringify({type:'error',error:e instanceof Error?e.message:String(e)})+'\n');}
});
const server=app.listen(config.port,'127.0.0.1',()=>console.log(`Jevy backend http://127.0.0.1:${config.port}\nLLM ${config.llm.provider} ${config.llm.provider==='openai'?config.llm.baseUrl:config.ollamaUrl} | ${config.model}`));
process.on('SIGTERM',()=>{clearInterval(refreshTimer);server.close(()=>{db.close();store.close();process.exit(0);});});
