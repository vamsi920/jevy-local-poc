// Validates the 150-question oracles and prints expected values: npx tsx scripts/check-oracles150.ts
import {battery150,battery150Oracles} from '../tests/battery150-cases.js';import {Database} from '../backend/db.js';
const db=await Database.open();let bad=0;
for(const c of battery150){
 const sqls=[...[c.oracle].flat().filter(Boolean) as string[],...(battery150Oracles[c.id]?[battery150Oracles[c.id]]:[])];
 for(const o of sqls){try{const r=await db.query(o,5);console.log(c.id.padEnd(4),JSON.stringify(r.rows).slice(0,110));if(!r.rows.length)bad++;}catch(e){console.log('ERR',c.id,String(e).slice(0,150));bad++;}}
 if(c.values?.length)console.log(c.id.padEnd(4),'expects',JSON.stringify(c.values));
}
console.log('cases',battery150.length,'bad',bad);db.close();
