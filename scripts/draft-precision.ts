// Deterministic check of grounded-draft precision against battery oracles (no model calls).
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {ground} from '../backend/grounding.js';import {draftSQL} from '../backend/draft.js';import {runSQL} from '../backend/tools.js';
import {battery} from '../tests/battery-cases.js';import {battery100} from '../tests/battery100-cases.js';import {battery150} from '../tests/battery150-cases.js';
const db=await Database.open();const catalog=await new Catalog(db).build();
const vals=(rows:Record<string,unknown>[])=>rows.flatMap(r=>Object.values(r)).map(v=>typeof v==='number'?Math.round(v*1000)/1000:String(v));
let fired=0,right=0;
for(const c of [...battery,...battery100,...battery150]){
 if(c.turns.length>1)continue;
 const g=await ground(c.turns[0],catalog);const d=draftSQL(c.turns[0],g,catalog);if(!d)continue;fired++;
 // Through the full guard, exactly as the agent runs it.
 const r=await runSQL(catalog,d.sql,{question:c.turns[0],grounding:g,allowedLiterals:[],followup:false});
 if(!r.ok){console.log('GUARD-REJECTED',c.id,c.turns[0],r.error.slice(0,160));continue;}
 const got=vals(r.rows);
 let ok=false;
 if(c.oracle){for(const o of [c.oracle].flat()){const exp=vals((await db.query(o as string,500)).rows);if(exp.every(v=>got.some(x=>x===v||String(x).startsWith(String(v)))))ok=true;}}
 else if(c.values)ok=c.values.every(v=>got.some(x=>x===(typeof v==='number'?v:String(v))||String(x).startsWith(String(v))));
 if(ok)right++;else console.log('WRONG',c.id,c.turns[0],'\n   ',d.sql.slice(0,220));
}
console.log(`draft fired on ${fired} single-turn questions; correct ${right}`);db.close();
