import assert from 'node:assert/strict';
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {Agent} from '../backend/agent.js';import {writeFile} from 'node:fs/promises';
const db=await Database.open();const agent=new Agent(await new Catalog(db).build());const out=[];
for(const question of ['Compare incidents this month and last month.','give me three random servers and give a write up about them like a song','Compare vulnerability counts this quarter and last quarter.']){
 const a=await agent.ask(question);out.push(a);
 if(question.startsWith('Compare incidents')){assert.equal(a.status,'answered');assert.deepEqual(a.evidence[0].rows.map(r=>r.count),[604,2454]);}
 if(question.startsWith('give me')){assert.equal(a.status,'answered');const rows=a.evidence.flatMap(e=>e.rows);assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.server_id)).size,3);for(const row of rows){assert.ok(a.text.includes(String(row.server_id)));assert.equal((await db.query(`SELECT count(*) n FROM servers WHERE server_id='${String(row.server_id).replaceAll("'","''")}'`)).rows[0].n,1);}}
 if(question.startsWith('Compare vulnerability'))assert.equal(a.status,'clarification');
 console.log(JSON.stringify({question,status:a.status,ms:a.trace.totalMs,calls:a.trace.llm.length,rows:a.evidence.map(e=>e.rowCount),text:a.text.slice(0,500)}));await writeFile('test-results/user-check.json',JSON.stringify(out,null,2));
}db.close();
