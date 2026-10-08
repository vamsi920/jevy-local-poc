// Prints deterministic grounding for questions: npx tsx scripts/ground-probe.ts "question" ...
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {ground,groundingGap} from '../backend/grounding.js';
const db=await Database.open();const catalog=await new Catalog(db,'data/catalog.json').build();
for(const q of process.argv.slice(2)){const g=await ground(q,catalog);console.log('\n'+q+'\n  ->',g.normalized,'| corrections',JSON.stringify(g.corrections),'\n  tables',g.tables.join(','),'| unknown',g.unknownTerms.join(','),'| gap',groundingGap(g),'\n  mentions',g.mentions.map(m=>`${m.kind}:${m.text}->${m.table}${m.column?'.'+m.column:''}${m.value?'='+m.value:''}(${m.via},${m.confidence})`).join('; '),'\n  defs',g.definitions.length);}
db.close();
