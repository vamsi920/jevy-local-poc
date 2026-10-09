import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../backend/db.js';
import {Catalog} from '../backend/catalog.js';
import {validateDAG,resolveReferences,Executor} from '../backend/executor.js';
import type {Trace,Step} from '../backend/types.js';
import {emptyState,Agent} from '../backend/agent.js';
import type {Model} from '../backend/llm.js';
import {buildProfile} from '../backend/model-profile.js';
let db:Database,catalog:Catalog;
before(async()=>{db=await Database.open();catalog=await new Catalog(db).build();});after(()=>db.close());
const trace=():Trace=>({question:'Count servers',intent:'Count servers',schema:null,plans:[],events:[],evidence:[],llm:[],retries:0,totalMs:0});
test('seeded inventory has 4000 servers',async()=>assert.equal((await db.query('SELECT count(*) n FROM servers')).rows[0].n,4000));
test('catalog includes inferred joins and exact values',()=>{assert.ok(catalog.table('servers').relationships.includes('servers.application_id = applications.application_id'));assert.ok(catalog.table('servers').columns.find(c=>c.name==='country')?.values.includes('US'));});
test('CTE, join, aggregation and window SQL work',async()=>{const r=await db.query('WITH counts AS (SELECT application_id,count(*) n FROM servers GROUP BY 1) SELECT a.application_id,n,rank() OVER(ORDER BY n DESC) ranking FROM counts JOIN applications a USING(application_id) ORDER BY n DESC LIMIT 3');assert.equal(r.rowCount,3);});
for(const sql of ["INSERT INTO servers(server_id) VALUES ('BAD')",'UPDATE servers SET environment=\'Test\'','DELETE FROM servers','DROP TABLE servers','ALTER TABLE servers ADD COLUMN bad INT','CREATE TABLE bad(x INT)',"COPY servers TO '/tmp/jevy-bad.csv'","ATTACH '/tmp/jevy-bad.duckdb' AS bad",'SELECT 1; SELECT 2',"SELECT * FROM read_csv('/etc/passwd')","SELECT * FROM read_text('/etc/passwd')","SELECT * FROM 'https://example.com/data.parquet'",'INSTALL httpfs','LOAD httpfs','PRAGMA enable_external_access=true','SET enable_external_access=true','CALL dbgen(sf=1)'])test('reject unsafe SQL: '+sql,async()=>assert.rejects(()=>db.query(sql)));
test('mutation keywords inside literal remain safe',async()=>assert.equal((await db.query("SELECT 'DROP TABLE servers' AS text")).rows[0].text,'DROP TABLE servers'));
test('large result is capped with explicit truncation',async()=>{const r=await db.query('SELECT * FROM servers');assert.equal(r.rowCount,200);assert.equal(r.truncated,true);});
test('random sampling is seeded per connection',async()=>{const q='SELECT server_id FROM servers ORDER BY random() LIMIT 3';assert.deepEqual((await db.query(q)).rows,(await db.query(q)).rows);});
test('DAG rejects cycles and unknown dependencies',()=>{const s:Step={id:'a',objective:'count',tool:'run_sql',inputs:{},dependencies:['b']};assert.throws(()=>validateDAG({intent:'',clarification:'',steps:[s]}));assert.throws(()=>validateDAG({intent:'',clarification:'',steps:[s,{...s,id:'b',dependencies:['a']}]}));});
test('references are escaped and restricted to dependencies',()=>{const s:Step={id:'b',objective:'',tool:'run_sql',inputs:{},dependencies:['a']};const t=trace();t.evidence.push({stepId:'a',objective:'',tool:'run_sql',rows:[{server_id:"x' OR true --"}],rowCount:1,truncated:false,durationMs:0,repairs:0});assert.equal(resolveReferences('SELECT {{a.server_id}}',s,t.evidence),"SELECT 'x'' OR true --'");assert.throws(()=>resolveReferences('SELECT {{a.server_id}}',{...s,dependencies:[]},t.evidence));});
test('independent DAG steps overlap; dependent waits',async()=>{const original=db.query.bind(db);let active=0,max=0;const starts:string[]=[];db.query=async(sql,maxRows)=>{active++;max=Math.max(max,active);starts.push(sql);await new Promise(r=>setTimeout(r,20));try{return await original(sql,maxRows);}finally{active--;}};try{const e=new Executor(catalog,async()=>{throw new Error('not needed')});const t=trace();await e.execute({intent:'',clarification:'',steps:[{id:'a',objective:'a',tool:'run_sql',inputs:{sql:'SELECT 1 id'},dependencies:[]},{id:'b',objective:'b',tool:'run_sql',inputs:{sql:'SELECT 2 id'},dependencies:[]},{id:'c',objective:'c',tool:'run_sql',inputs:{sql:'SELECT {{a.id}} id'},dependencies:['a','b']}]},t,emptyState(),()=>{});assert.equal(max,2);assert.equal(t.evidence.at(-1)?.stepId,'c');assert.ok(t.evidence.every(x=>!x.error));}finally{db.query=original;}});
test('SQL repair uses execution error and stops after bound',async()=>{let calls=0;const llm:Model=async(schema,purpose,_system,input)=>{if(purpose==='SQL review')return schema.parse({approved:true,issues:[]});calls++;assert.ok(String(JSON.stringify(input)).includes('error'));return schema.parse({sql:'SELECT count(*) n FROM servers'});};const e=new Executor(catalog,llm),t=trace();await e.execute({intent:'',clarification:'',steps:[{id:'a',objective:'count',tool:'run_sql',inputs:{sql:'SELECT missing FROM servers'},dependencies:[]}]},t,emptyState(),()=>{});assert.equal(calls,1);assert.equal(t.retries,1);assert.equal(t.evidence[0].rows[0].n,4000);});
test('identical failed repairs stop early and preserve error evidence',async()=>{let calls=0;const llm:Model=async(schema)=>{calls++;return schema.parse({sql:'SELECT missing FROM servers'});};const t=trace();await new Executor(catalog,llm).execute({intent:'',clarification:'',steps:[{id:'a',objective:'count',tool:'run_sql',inputs:{sql:'SELECT missing FROM servers'},dependencies:[]}]},t,emptyState(),()=>{});assert.equal(calls,1);assert.equal(t.retries,1);assert.ok(t.evidence[0].error);});
test('agent renders only selected executed evidence and keeps real IDs',async()=>{const llm:Model=async(schema,purpose)=>{const outputs:Record<string,unknown>={Intent:{access:'read',request:'List first server',concepts:['servers'],filters:[],timeRange:'',aliases:[]},Planning:{intent:'List server',clarification:'',steps:[{id:'a',objective:'List server',tool:'run_sql',inputs:{sql:'SELECT server_id FROM servers ORDER BY server_id LIMIT 1'},dependencies:[]}]},'SQL reasoning':{sql:'SELECT server_id FROM servers ORDER BY server_id LIMIT 1'},'SQL review':{approved:true,issues:[]},Observation:{decision:'enough',missing:'',clarification:''},'Evidence synthesis':{evidenceIds:['r0_a'],presentation:'records'}};return schema.parse(outputs[purpose]);};const agent=new Agent(catalog,llm);const r=await agent.ask('List first server');assert.equal(r.status,'answered');assert.deepEqual(r.state.selectedIds,['SRV-00001']);assert.equal(r.evidence[0].rows[0].server_id,'SRV-00001');assert.equal(agent.busy.size,0);});
test('schema context excludes unrelated values from production count',()=>{const context=catalog.context('Count Production servers');const server=context.tables.find(t=>t.table==='servers')!;assert.deepEqual(context.tables.map(t=>t.table),['servers']);assert.ok(server.columns.includes('environment'));assert.equal(Object.hasOwn(server.values,'country'),false);assert.equal(context.definitions.some(d=>d.startsWith('Relative dates')),false);});
test('discovered aliases must be grounded in question and not catalog identifiers',async()=>{const before={...catalog.aliases};await catalog.remember('applications','US','How many applications?');await catalog.remember('imagined alias','US','Count servers');assert.deepEqual(catalog.aliases,before);});
test('alias context retrieves country for United States and OS for RHEL',()=>{assert.ok(catalog.context('Count United States servers').tables.find(t=>t.table==='servers')?.columns.includes('country'));assert.ok(catalog.context('Count RHEL servers').tables.find(t=>t.table==='servers')?.columns.includes('os:'));});
test('unrecognized categorical predicates trigger fresh value inspection',async()=>{const warnings=await catalog.checkValues("SELECT count(*) FROM servers WHERE country='United States'");assert.equal(warnings[0].column,'country');assert.ok(warnings[0].knownValues.includes('US'));assert.equal((await catalog.checkValues("SELECT count(*) FROM servers WHERE country='US'")).length,0);});
test('long read-only queries are interrupted by timeout',async()=>{const {config}=await import('../backend/config.js');const previous=config.sqlTimeout;config.sqlTimeout=10;try{await assert.rejects(()=>db.query('SELECT sum(hash(i,j)) FROM range(100000) a(i), range(100000) b(j)'),/interrupt|exceeded/i);}finally{config.sqlTimeout=previous;}});
test('structured driver votes across candidates and answers with verified prose',async()=>{
 const calls:string[]=[];let candidate=0;
 const llm:Model=async(schema,purpose)=>{calls.push(purpose);
  if(purpose==='SQL reasoning'||purpose==='SQL candidate')return schema.parse({sql:candidate++===1?'SELECT count(*) AS server_count FROM servers WHERE os=\'Ubuntu\'':'SELECT count(*) AS server_count FROM servers'});
  if(purpose==='Answer writing')return schema.parse({answer:'There are 4,000 servers in the inventory.'});
  throw new Error('Unexpected call '+purpose);};
 const profile=buildProfile('test',0.6,8192,['completion']);
 const answer=await new Agent(catalog,llm,undefined,profile).ask('list the number of servers');
 assert.equal(answer.status,'answered');assert.equal(answer.evidence.length,1);assert.equal(answer.evidence[0].rows[0].server_count,4000);
 assert.equal(answer.text,'There are 4,000 servers in the inventory.');
 assert.ok(calls.includes('SQL repair'),'unrequested filter must trigger repair');
});
test('tiny models answer fully grounded questions with the verified grounded query and no model SQL',async()=>{
 const calls:string[]=[];
 const llm:Model=async(schema,purpose)=>{calls.push(purpose);if(purpose==='Answer writing')return schema.parse({answer:'There are 970 Production servers.'});throw new Error('Unexpected '+purpose);};
 const answer=await new Agent(catalog,llm,undefined,buildProfile('test',0.6,8192,['completion'])).ask('how many servers are in production?');
 assert.equal(answer.status,'answered');assert.equal(Object.values(answer.evidence[0].rows[0])[0],970);assert.ok(!calls.some(c=>c.startsWith('SQL')));
});
test('prose with numbers not in the results falls back to the template answer',async()=>{
 const llm:Model=async(schema,purpose)=>schema.parse(purpose==='Answer writing'?{answer:'There are 4,321 servers in total.'}:{sql:'SELECT count(*) AS server_count FROM servers'});
 const answer=await new Agent(catalog,llm,undefined,buildProfile('test',0.6,8192,['completion'])).ask('list the number of servers');
 assert.match(answer.text,/4,000/);assert.ok(!answer.text.includes('4,321'));assert.equal(answer.trace.answerSource,'template');
});
test('a categorical value placed on wrong field triggers schema-grounded repair',async()=>{
 const t=trace();t.question='Count unsupported servers';t.intent=t.question;
 const llm:Model=async(schema,purpose,_system,input)=>{if(purpose==='SQL review')return schema.parse({approved:true,issues:[]});assert.match(JSON.stringify(input),/servers.support_status/);return schema.parse({sql:"SELECT count(*) AS n FROM servers WHERE support_status='Unsupported'"});};
 await new Executor(catalog,llm).execute({intent:t.intent,clarification:'',steps:[{id:'a',objective:t.question,tool:'run_sql',inputs:{sql:"SELECT count(*) AS n FROM servers WHERE os='Unsupported'"},dependencies:[]}]},t,emptyState(),()=>{});
 assert.equal(t.retries,1);assert.ok(!t.evidence[0].error);assert.equal(t.evidence[0].rows[0].n,(await db.query("SELECT count(*) AS n FROM servers WHERE support_status='Unsupported'")).rows[0].n);
});
test('generic table requests do not import unrelated business definitions',()=>{
 const incidents=catalog.context('How many incidents exist?');assert.ok(!incidents.definitions.some(d=>d.includes('P1')));
 const vulnerabilities=catalog.context('Count vulnerability findings');assert.ok(!vulnerabilities.definitions.some(d=>d.startsWith('Active vulnerabilities')));
});
test('explicit domains survive retrieval even when another table scores much higher',()=>{
 const tables=catalog.retrieve('servers hostname OS application name total vulnerability count and latest incident ID').tables.map(t=>t.name);
 for(const name of ['servers','applications','vulnerabilities','incidents'])assert.ok(tables.includes(name),name+' omitted');
});
test('dependency-free generation is not primed with unresolved dependency placeholders',async()=>{
 const t=trace();
 const llm:Model=async(schema,purpose,system)=>{if(purpose==='SQL review')return schema.parse({approved:true,issues:[]});assert.ok(!system.includes('{{'));return schema.parse({sql:'SELECT count(*) AS n FROM servers'});};
 await new Executor(catalog,llm).execute({intent:t.intent,clarification:'',steps:[{id:'a',objective:t.question,tool:'run_sql',inputs:{},dependencies:[]}]},t,emptyState(),()=>{});
 assert.equal(t.evidence[0].rows[0].n,4000);assert.ok(!t.evidence[0].error);
});
test('explicit inventory scope excludes upgrade-table distractors and unloaded joins',()=>{
 const context=catalog.context('How many RHEL servers are there?');assert.deepEqual(context.tables.map(t=>t.table),['servers']);assert.deepEqual(context.tables[0].joins,[]);
 const joined=catalog.context('Return server_id and application_name for SRV-00001');assert.ok(joined.tables.some(t=>t.table==='applications'));assert.ok(joined.tables.some(t=>t.joins.includes('servers.application_id = applications.application_id')));
});
test('creative phase failure preserves verified records and never enters SQL repair',async()=>{
 const calls:string[]=[];const llm:Model=async(schema,purpose,_system,input)=>{calls.push(purpose);if(purpose==='Creative writing')throw new Error('writing timeout');const outputs:Record<string,unknown>={Intent:{access:'read',request:'Pick three random servers with server_id',writing:'Write a song',concepts:['servers'],filters:[],timeRange:'',aliases:[]},Planning:{intent:'Pick servers',clarification:'',steps:[{id:'a',objective:'Pick three random servers with server_id',tool:'run_sql',inputs:{},dependencies:[]}]},'SQL reasoning':{sql:'SELECT server_id FROM servers ORDER BY random() LIMIT 3'},'SQL review':{approved:true,issues:[]}};if(purpose==='SQL review')assert.ok(!JSON.stringify(input).includes('song'));return schema.parse(outputs[purpose]);};
 const answer=await new Agent(catalog,llm).ask('Pick three random servers and write a song');assert.equal(answer.status,'answered',JSON.stringify(answer.trace.events));assert.equal(answer.evidence[0].rows.length,3);assert.match(answer.text,/could not finish/);assert.ok(!calls.includes('SQL repair'));
});
test('calendar field selection respects requested timestamp instead of default creation date',async()=>{
 const llm:Model=async(schema,purpose)=>{if(purpose==='Answer writing')throw new Error('offline');throw new Error('Calendar operator should not need model SQL: '+purpose);};
 const answer=await new Agent(catalog,llm,undefined,buildProfile('test',0.6,8192,['completion'])).ask('Count incidents resolved last month');const expected=(await db.query("SELECT count(*) count FROM incidents WHERE resolved_date>=DATE '2026-09-01' AND resolved_date<DATE '2026-10-01'")).rows;
 assert.equal(answer.status,'answered');assert.deepEqual(answer.evidence[0].rows,expected);assert.match(answer.evidence[0].sql!,/resolved_date/);
});
