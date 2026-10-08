// The grounded draft outranks tiny models' votes, so it must never be wrong when it fires.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {ground} from '../backend/grounding.js';import {draftSQL} from '../backend/draft.js';import {runSQL} from '../backend/tools.js';
import {battery} from './battery-cases.js';import {battery100} from './battery100-cases.js';import {battery150} from './battery150-cases.js';
let db:Database,catalog:Catalog;before(async()=>{db=await Database.open();catalog=await new Catalog(db).build();});after(()=>db.close());
const vals=(rows:Record<string,unknown>[])=>rows.flatMap(r=>Object.values(r)).map(v=>typeof v==='number'?Math.round(v*1000)/1000:String(v));
test('every grounded draft matches the independent oracle',async()=>{
 const wrong:string[]=[];let fired=0;
 for(const c of [...battery,...battery100,...battery150]){
  if(c.turns.length>1)continue;const g=await ground(c.turns[0],catalog);const d=draftSQL(c.turns[0],g,catalog);if(!d)continue;fired++;
  const r=await runSQL(catalog,d.sql,{question:c.turns[0],grounding:g,allowedLiterals:[],followup:false});
  if(!r.ok){wrong.push(`${c.id}: guard rejected ${d.sql}: ${r.error}`);continue;}
  const got=vals(r.rows);let ok=false;
  const has=(v:unknown)=>got.some(x=>x===v||String(x).startsWith(String(v)));
  if(c.oracle){for(const o of [c.oracle].flat())if(vals((await db.query(o as string,500)).rows).every(has))ok=true;}
  else if(c.values)ok=c.values.every(v=>has(typeof v==='number'?v:String(v)));
  if(!ok)wrong.push(`${c.id}: ${c.turns[0]} -> ${d.sql}`);
 }
 assert.ok(fired>=60,'draft should cover most single-shape questions, fired '+fired);
 assert.deepEqual(wrong,[]);
});
test('draft refuses questions it does not fully understand',async()=>{
 for(const q of ['which incident looks the scariest','list the hostnames of production servers','incidents opened in the last 7 days','servers whose owner left','what is the weather'])assert.equal(draftSQL(q,await ground(q,catalog),catalog),null,q);
});
