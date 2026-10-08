// Shows the grounded draft SQL and its result: npx tsx scripts/draft-probe.ts "question" ...
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {ground} from '../backend/grounding.js';import {draftSQL} from '../backend/draft.js';
const db=await Database.open();const catalog=await new Catalog(db).build();
for(const q of process.argv.slice(2)){const d=draftSQL(q,await ground(q,catalog),catalog);let out='';if(d){try{out=JSON.stringify((await db.query(d.sql,5)).rows).slice(0,200);}catch(e){out='ERR '+String(e).slice(0,150);}}console.log(`\n${q}\n  ${d?d.sql:'(no draft)'}\n  ${out}`);}
db.close();
