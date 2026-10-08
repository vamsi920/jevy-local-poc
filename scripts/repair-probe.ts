// Shows deterministic repair for an SQL + error: npx tsx scripts/repair-probe.ts "SQL" "error"
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {autoRepair} from '../backend/sql-guard.js';
const db=await Database.open();const catalog=await new Catalog(db).build();
try{console.log(await autoRepair(process.argv[2],process.argv[3],catalog));}catch(e){console.log('ERR',e);}db.close();
