// Times a full catalog build: DB_PATH=./data/jevy-large.duckdb npx tsx scripts/catalog-timing.ts
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';
const db=await Database.open();const t=performance.now();
try{const c=await new Catalog(db,null).build();console.log('catalog built in',((performance.now()-t)/1000).toFixed(1),'s; tables',c.tables.map(t=>`${t.name}:${t.rowCount}`).join(' '),'| rels',c.tables.flatMap(t=>t.relationships).length);}
catch(e){console.log('FAILED after',((performance.now()-t)/1000).toFixed(1),'s:',String(e).slice(0,300));}
db.close();
