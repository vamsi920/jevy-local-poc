// Validates that every battery oracle runs and returns rows: npx tsx scripts/check-oracles.ts
import {battery100} from '../tests/battery100-cases.js';import {Database} from '../backend/db.js';
const db=await Database.open();let bad=0;
for(const c of battery100)for(const o of [c.oracle].flat().filter(Boolean) as string[]){try{const r=await db.query(o,5);if(!r.rows.length){console.log('EMPTY',c.id);bad++;}else console.log(c.id,JSON.stringify(r.rows[0]).slice(0,80));}catch(e){console.log('ERR',c.id,String(e).slice(0,120));bad++;}}
console.log('cases',battery100.length,'bad',bad);db.close();
