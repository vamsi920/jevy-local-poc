// Prints normalized SQL: npx tsx scripts/normalize-probe.ts "question" "SQL"
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {normalizeSQL} from '../backend/sql-guard.js';
const db=await Database.open();const catalog=await new Catalog(db).build();
try{console.log(await normalizeSQL(process.argv[3],catalog,process.argv[2]));}catch(e){console.log('ERR',e);}db.close();
