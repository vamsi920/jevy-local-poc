// Ad-hoc read-only query helper: npx tsx scripts/sql.ts "SELECT ..." ["SELECT ..."]
import {Database} from '../backend/db.js';
const db=await Database.open();
for(const q of process.argv.slice(2)){try{console.log(q.slice(0,90),'=>',JSON.stringify((await db.query(q,30)).rows));}catch(e){console.log('ERR',q.slice(0,90),String(e).slice(0,300));}}
db.close();
