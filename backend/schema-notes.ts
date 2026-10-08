// Background schema understanding: once per schema version the configured LLM studies each table
// (profile, values, relationships) and writes notes — a one-line purpose, example questions and
// business synonyms. Every synonym is validated against real tables and stored values before use,
// so a weak model cannot inject wrong mappings. Notes are cached in data/schema-notes.json.
import {z} from 'zod';
import {writeFile} from 'node:fs/promises';
import {config} from './config.js';
import {getProfile} from './model-profile.js';
import type {Catalog,LearnedNotes} from './catalog.js';
import type {Model} from './llm.js';
import type {Trace} from './types.js';
import {isCommonWord,norm} from './grounding.js';

const noteSchema=z.object({
 summary:z.string().max(240),
 examples:z.array(z.string().max(160)).max(4),
 tableSynonyms:z.array(z.string().max(40)).max(8),
 valueSynonyms:z.array(z.object({term:z.string().max(40),column:z.string(),value:z.string()})).max(12),
});

let running:Promise<LearnedNotes|undefined>|undefined;
export function learnSchemaInBackground(catalog:Catalog,llm:Model,log:(m:string)=>void=()=>{}){
 if(running)return running;
 running=learn(catalog,llm,log).catch(e=>{log('Schema notes skipped: '+(e instanceof Error?e.message:String(e)));return undefined;}).finally(()=>{running=undefined;});
 return running;
}

async function learn(catalog:Catalog,llm:Model,log:(m:string)=>void){
 if(catalog.learned?.fingerprint===catalog.schemaFingerprint&&Date.now()-Date.parse(catalog.learned.learnedAt||'1970-01-01')<config.schemaRefreshMs)return catalog.learned;
 const profile=await getProfile();
 const notes:LearnedNotes={fingerprint:catalog.schemaFingerprint,model:config.model,learnedAt:new Date().toISOString(),tables:{},tableSynonyms:{},valueSynonyms:{}};
 const tables=catalog.tables.filter(t=>!catalog.isReferenceTable(t.name));
 for(const t of tables){
  const trace:Trace={question:'schema notes',intent:'',schema:null,plans:[],events:[],evidence:[],llm:[],retries:0,totalMs:0,deadlineMs:Date.now()+120000};
  try{
   const out=await llm(noteSchema,'Schema notes',`You document a database table for analysts. From the schema, sample values and relationships, write: summary (one sentence: what one row represents and what it is used for), examples (up to 4 realistic business questions answerable with this table), tableSynonyms (other words users may use for this table, e.g. "hosts" for servers), valueSynonyms (user words that mean a stored value, e.g. term "prod" means column environment value "Production"; value must be copied exactly from the shown values). Do not invent columns or values.`,
    {table:t.name,schema:catalog.schemaText([t.name],{full:true}),related:t.relationships},trace,{maxTokens:700});
   const columnValues=(c:string)=>{const col=t.columns.find(x=>x.name===c);return col?[...col.values,...col.lookup].map(String):[];};
   // Small models' free-text summaries are not trusted in prompts; validated synonyms are.
   if(profile.tier!=='tiny')notes.tables[t.name]={summary:out.summary.trim(),examples:out.examples};
   const syns=out.tableSynonyms.map(s=>s.toLowerCase().trim()).filter(s=>s.length>=3&&!/[^a-z0-9 _-]/.test(s)&&!isCommonWord(s)&&!['data','record','records','row','rows','table','item','items','entry','entries','info'].includes(s)&&!catalog.tables.some(x=>x.name===s||norm(x.name).startsWith(s)||(catalog.semantic.tableSynonyms[x.name]||[]).includes(s)&&x.name!==t.name));
   const trusted=profile.tier==='tiny'?syns.filter(x=>norm(t.name).startsWith(x.slice(0,4))):syns;
   if(trusted.length)notes.tableSynonyms[t.name]=trusted;
   for(const v of out.valueSynonyms){const term=v.term.toLowerCase().trim();const related=norm(v.value).includes(term)||v.value.split(/[^A-Za-z0-9]+/).map(w=>w[0]||'').join('').toLowerCase()===term;
    const ambiguous=columnValues(v.column).filter(val=>norm(val).includes(term)).length>1;
    const stored=catalog.tables.some(x=>x.columns.some(c=>c.values.some(val=>String(val).toLowerCase()===term)));
    // Small models only contribute abbreviations/prefixes of the value; larger ones any validated term.
    if(term.length>=2&&term!==v.value.toLowerCase()&&!stored&&!ambiguous&&!isCommonWord(term)&&columnValues(v.column).includes(v.value)&&(profile.tier!=='tiny'||related)&&!catalog.tables.some(x=>x.name===term||x.columns.some(c=>c.name===term)))notes.valueSynonyms[term]=v.value;}
   log(`Schema notes: ${t.name} (${trusted.length} table synonyms)`);
  }catch(e){log(`Schema notes for ${t.name} failed: ${e instanceof Error?e.message:String(e)}`);}
 }
 await writeFile(config.notesPath,JSON.stringify(notes,null,2));
 await catalog.build();
 return notes;
}
