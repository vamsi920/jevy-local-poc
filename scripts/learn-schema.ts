// Runs the background schema learner once with the configured LLM: npx tsx scripts/learn-schema.ts
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {model} from '../backend/llm.js';import {learnSchemaInBackground} from '../backend/schema-notes.js';
const db=await Database.open();const catalog=await new Catalog(db).build();
const notes=await learnSchemaInBackground(catalog,model,m=>console.log(m));console.log(JSON.stringify(notes,null,1).slice(0,3000));db.close();
