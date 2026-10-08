// Runs the grounded draft through the full SQL guard: npx tsx scripts/draft-guard-probe.ts "question" ...
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {ground} from '../backend/grounding.js';import {draftSQL} from '../backend/draft.js';import {runSQL} from '../backend/tools.js';
const db=await Database.open();const catalog=await new Catalog(db).build();
for(const q of process.argv.slice(2)){const g=await ground(q,catalog);const d=draftSQL(q,g,catalog);if(!d){console.log(q,'-> no draft');continue;}const r=await runSQL(catalog,d.sql,{question:q,grounding:g,allowedLiterals:[],followup:false});console.log(q,'->',r.ok?'OK '+JSON.stringify(r.rows[0]):'REJECTED '+r.error);}
db.close();
