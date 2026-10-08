// Runs SQL through the guard + deterministic repair: npx tsx scripts/guard-probe.ts "question" "SQL" ...
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {groundSync} from '../backend/grounding.js';import {runSQL} from '../backend/tools.js';
const db=await Database.open();const catalog=await new Catalog(db).build();const [q,...sqls]=process.argv.slice(2);
for(const sql of sqls){const r=await runSQL(catalog,sql,{question:q,grounding:groundSync(q,catalog),allowedLiterals:[],followup:false});console.log('\nIN :',sql,'\nOUT:',r.ok?r.sql+' => '+JSON.stringify(r.rows.slice(0,3))+' notes '+JSON.stringify(r.notes):'ERR '+r.error+' | '+r.hint);}
db.close();
