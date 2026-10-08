// Prints numeric conditions and unexplained numbers: npx tsx scripts/numeric-probe.ts "question" ...
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {ground} from '../backend/grounding.js';import {numericConditions,unexplainedNumbers} from '../backend/numeric.js';
const db=await Database.open();const catalog=await new Catalog(db).build();
for(const q of process.argv.slice(2)){const g=await ground(q,catalog);const n=numericConditions(g,catalog);console.log(q,'\n  ',JSON.stringify(n),'unexplained',unexplainedNumbers(g,n.map(x=>x.text)),'unknown',g.unknownTerms,'\n  ',g.mentions.filter(m=>m.kind==='column').map(m=>m.text+'->'+m.column).join(', '));}
db.close();
