import {createHash} from 'node:crypto';
import {config} from './config.js';
import { writeFile,readFile } from 'node:fs/promises';
import { Database,identifier } from './db.js';
import {groundSync,definitionsFor,type Grounding} from './grounding.js';
export type Column={name:string;type:string;values:unknown[];lookup:unknown[];representatives:unknown[];description?:string;profile?:{nullCount:number;distinctCount:number;min?:unknown;max?:unknown}};
export type Table={name:string;description:string;rowCount:number;columns:Column[];primaryKey?:string;relationships:string[];notes?:string[]};
// Notes the app writes about the data itself (see schema-notes.ts), keyed by schema fingerprint.
export type LearnedNotes={fingerprint:string;model:string;learnedAt?:string;tables:Record<string,{summary?:string;examples?:string[]}>;tableSynonyms:Record<string,string[]>;valueSynonyms:Record<string,string>};
export type Semantic={referenceDateSql?:string;tableSynonyms:Record<string,string[]>;valueSynonyms:Record<string,string>;definitions:{terms:string[];text:string}[]};
const emptySemantic=():Semantic=>({tableSynonyms:{},valueSynonyms:{},definitions:[]});
// Small categorical sets are shown to models; larger sets stay in memory only for grounding.
const PROMPT_VALUES=16,LOOKUP_VALUES=2000;
export class Catalog {
 tables:Table[]=[]; aliases:Record<string,string>={}; semantic:Semantic=emptySemantic();
 learned?:LearnedNotes;schemaFingerprint='';
 referenceDate='';refreshedAt=0;version=0;fingerprint='';refreshError='';private refreshing?:Promise<this>;private sourceRevision=-1;
 constructor(public db:Database,public cachePath:string|null='data/catalog.json'){}
 async ensureFresh(){await this.db.reopenIfChanged();if(!this.refreshedAt||this.sourceRevision!==this.db.revision||Date.now()-this.refreshedAt>=config.schemaRefreshMs)await this.build();return this;}
 async build(){if(this.refreshing)return this.refreshing;this.refreshing=this.scan().catch(e=>{this.refreshError=e instanceof Error?e.message:String(e);throw e;}).finally(()=>{this.refreshing=undefined;});return this.refreshing;}
 private async scan(){
  const sourceRevision=this.db.revision;const tables:Table[]=[];
  const {rows}=await this.db.query('SELECT table_name, comment FROM duckdb_tables() WHERE schema_name=\'main\' ORDER BY table_name',500);
  for(const r of rows){
   const name=String(r.table_name);
   const cols=(await this.db.query(`SELECT column_name,data_type,comment FROM duckdb_columns() WHERE table_name='${name.replaceAll("'","''")}' AND schema_name='main' ORDER BY column_index`,500)).rows.filter(c=>/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(c.column_name)));
   const samples=(await this.db.query(`SELECT * FROM ${identifier(name)} LIMIT 3`,3)).rows;
   // One pass for profile statistics of every column.
   const expressions=cols.flatMap((c,i)=>{const q=identifier(String(c.column_name));const type=String(c.data_type);return [`count(*)-count(${q}) AS n${i}`,`count(DISTINCT ${q}) AS d${i}`,...(/INT|FLOAT|DOUBLE|DECIMAL|DATE|TIMESTAMP|NUMERIC|REAL/.test(type)&&!type.includes('[]')?[`min(${q}) AS lo${i}`,`max(${q}) AS hi${i}`]:[])];});
   const stats=(await this.db.query(`SELECT count(*) AS __n${expressions.length?','+expressions.join(','):''} FROM ${identifier(name)}`,1)).rows[0]||{};
   const columns:Column[]=[];
   for(const [i,col] of cols.entries()){
    const cn=String(col.column_name),type=String(col.data_type);let values:unknown[]=[],lookup:unknown[]=[];
    const distinctCount=Number(stats['d'+i]||0);
    if(type==='VARCHAR'&&distinctCount<=LOOKUP_VALUES){
     const all=(await this.db.query(`SELECT ${identifier(cn)} AS "value" FROM ${identifier(name)} WHERE ${identifier(cn)} IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT ${LOOKUP_VALUES}`,LOOKUP_VALUES)).rows.map(x=>x.value);
     if(all.length<=PROMPT_VALUES)values=[...all].sort((a,b)=>String(a).localeCompare(String(b)));else lookup=all;
    }
    columns.push({name:cn,type,values,lookup,representatives:[...new Set(samples.map(r=>r[cn]))],description:col.comment?String(col.comment):undefined,profile:{nullCount:Number(stats['n'+i]||0),distinctCount,...Object.hasOwn(stats,'lo'+i)?{min:stats['lo'+i],max:stats['hi'+i]}:{}}});
   }
   const rowCount=Number(stats.__n||0);
   // Primary key: first *_id / id column whose values are unique and non-null.
   const primaryKey=columns.find(c=>/(^|_)id$/.test(c.name)&&c.profile!.distinctCount===rowCount&&c.profile!.nullCount===0)?.name;
   tables.push({name,description:String(r.comment||''),rowCount,columns,primaryKey,relationships:[]});
  }
  // Infer FK-like joins from same-named unique keys, then verify no orphan values.
  for(const t of tables)for(const c of t.columns)for(const target of tables){
   if(target===t||target.primaryKey!==c.name)continue;
   const check=await this.db.query(`SELECT count(*) n FROM ${identifier(t.name)} a LEFT JOIN ${identifier(target.name)} b USING (${identifier(c.name)}) WHERE b.${identifier(c.name)} IS NULL AND a.${identifier(c.name)} IS NOT NULL`);
   if(Number(check.rows[0].n)===0)t.relationships.push(`${t.name}.${c.name} = ${target.name}.${c.name}`);
  }
  // Relationship cardinality notes: how many child rows each parent row has, and how many have none.
  for(const child of tables)for(const r of child.relationships){
   const [[,key],[parentName]]=r.split(' = ').map(x=>x.split('.'));const parent=tables.find(t=>t.name===parentName);if(!parent||!parent.rowCount)continue;
   const avg=child.rowCount/parent.rowCount;
   if(avg<=1.0001&&child.columns.find(c=>c.name===key)?.profile?.distinctCount===child.rowCount){(child.notes||=[]).push(`one row per ${parentName} row (1:1 via ${key})`);continue;}
   const none=Number((await this.db.query(`SELECT count(*) n FROM ${identifier(parentName)} p WHERE NOT EXISTS (SELECT 1 FROM ${identifier(child.name)} c WHERE c.${identifier(key)} = p.${identifier(key)})`)).rows[0].n);
   (parent.notes||=[]).push(`has many ${child.name} rows (avg ${avg.toFixed(1)} per ${parentName} row; ${none} ${parentName} rows have none) - counting ${parentName} across this join needs count(DISTINCT ${parentName}.${key})`);
   (child.notes||=[]).push(`many rows per ${parentName} row (joined by ${key})`);
  }
  try{this.aliases=JSON.parse(await readFile('data/aliases.json','utf8'));}catch{}
  let semantic=emptySemantic();
  if(this.cachePath)try{semantic={...semantic,...JSON.parse(await readFile(config.semanticPath,'utf8'))};}catch{}
  // Semantic hints only apply to tables that exist in this database.
  semantic.tableSynonyms=Object.fromEntries(Object.entries(semantic.tableSynonyms).filter(([t])=>tables.some(x=>x.name===t)));
  const fingerprintNow=createHash('sha256').update(JSON.stringify(tables.map(t=>[t.name,t.rowCount,t.columns.map(c=>[c.name,c.type])]))).digest('hex');
  // Learned notes apply only to the exact schema they were written for; synonyms are re-validated.
  let learned:LearnedNotes|undefined;
  if(this.cachePath)try{const l=JSON.parse(await readFile(config.notesPath,'utf8')) as LearnedNotes;if(l.fingerprint===fingerprintNow)learned=l;}catch{}
  if(learned){
   for(const [t,syns] of Object.entries(learned.tableSynonyms||{}))if(tables.some(x=>x.name===t))semantic.tableSynonyms[t]=[...new Set([...(semantic.tableSynonyms[t]||[]),...syns])];
   for(const [term,value] of Object.entries(learned.valueSynonyms||{}))if(!semantic.valueSynonyms[term]&&tables.some(t=>t.columns.some(c=>c.values.includes(value)||c.lookup.includes(value))))semantic.valueSynonyms[term]=value;
  }
  this.learned=learned;this.schemaFingerprint=fingerprintNow;
  if(sourceRevision!==this.db.revision)throw new Error('Dataset changed while catalog was refreshing; retry the request.');
  const referenceDate=await this.detectReferenceDate(tables,semantic);
  const fingerprint=createHash('sha256').update(JSON.stringify(tables)).digest('hex');
  if(this.cachePath)await writeFile(this.cachePath,JSON.stringify({tables,referenceDate},null,2));
  this.tables=tables;this.semantic=semantic;this.referenceDate=referenceDate;if(fingerprint!==this.fingerprint)this.version++;this.fingerprint=fingerprint;this.refreshedAt=Date.now();this.sourceRevision=this.db.revision;this.refreshError='';return this;
 }
 // Snapshot databases often carry an "as of" date. Relative dates must use it, not the host clock.
 private async detectReferenceDate(tables:Table[],semantic:Semantic){
  const sqls=[semantic.referenceDateSql,...tables.filter(t=>t.rowCount===1).flatMap(t=>t.columns.filter(c=>c.type==='DATE'&&/as_of|reference|snapshot|extract/i.test(c.name)).map(c=>`SELECT ${identifier(c.name)} FROM ${identifier(t.name)}`))].filter(Boolean) as string[];
  for(const sql of sqls){try{const v=Object.values((await this.db.query(sql,1)).rows[0]||{})[0];if(v&&/^\d{4}-\d{2}-\d{2}/.test(String(v)))return String(v).slice(0,10);}catch{}}
  return '';
 }
 // Single-row metadata tables (e.g. dataset_info) are not business entities.
 isReferenceTable(name:string){const t=this.tables.find(x=>x.name===name);return Boolean(t&&t.rowCount<=1&&this.tables.length>1&&!t.relationships.length&&!this.tables.some(o=>o.relationships.some(r=>r.split(' = ')[1].startsWith(name+'.'))));}
 overview(){return this.tables.map(t=>({table:t.name,description:t.description,rows:t.rowCount}));}
 // Connect chosen tables through the shortest verified join paths (adds bridge tables generically).
 connect(names:string[]){
  const edges=this.tables.flatMap(t=>t.relationships).map(r=>{const [l,rr]=r.split(' = ');return [l.split('.')[0],rr.split('.')[0]];});
  const result=new Set(names.slice(0,1));
  for(const target of names.slice(1)){
   if(result.has(target))continue;
   const queue:string[][]=[[target]];const seen=new Set([target]);let path:string[]|undefined;
   while(queue.length){const p=queue.shift()!;const last=p.at(-1)!;if(result.has(last)){path=p;break;}for(const [a,b] of edges){const next=a===last?b:b===last?a:undefined;if(next&&!seen.has(next)){seen.add(next);queue.push([...p,next]);}}}
   for(const n of path||[target])result.add(n);
  }
  return [...result];
 }
 retrieve(query:string,_limit=4){const g=groundSync(query,this);return {tables:g.tables.map(n=>this.table(n)),definitions:g.definitions,aliases:this.aliases,grounding:g};}
 // Compact annotated DDL for prompts. Small models get value lists only for mentioned or tiny columns;
 // `full` shows every categorical list and numeric range.
 schemaText(tableNames:string[],opts:{full?:boolean;grounding?:Grounding}={}){
  const mentioned=new Set((opts.grounding?.mentions||[]).filter(m=>m.column).map(m=>m.table+'.'+m.column));
  return tableNames.map(n=>{
   const t=this.table(n);
   const cols=t.columns.map(c=>{
    const p=c.profile;let note='';
    if(c.values.length&&(opts.full||mentioned.has(t.name+'.'+c.name)||c.values.length<=8))note=' -- values: '+c.values.map(v=>String(v)).join(' | ');
    else if(c.values.length)note=` -- ${c.values.length} categories, e.g. ${c.values.slice(0,3).map(String).join(' | ')}`;
    else if(c.lookup.length)note=` -- ${p?.distinctCount} distinct, e.g. ${c.lookup.slice(0,2).map(String).join(' | ')}`;
    else if(p?.min!==undefined&&/DATE|TIME/.test(c.type))note=` -- range ${String(p.min).slice(0,10)} .. ${String(p.max).slice(0,10)}`;
    else if(p?.min!==undefined)note=` -- range ${String(p.min)} .. ${String(p.max)}`;
    else if(c.type==='VARCHAR'&&c.representatives.length&&c.representatives[0]!==null)note=` -- e.g. ${String(c.representatives[0]).slice(0,40)}`;
    else if(c.type==='BOOLEAN')note=' -- true/false';
    return `  ${c.name} ${c.type}${c.name===t.primaryKey?' PRIMARY KEY':''}${note}`;
   });
   const joins=t.relationships.filter(r=>tableNames.includes(r.split(' = ')[1].split('.')[0]));
   const summary=this.learned?.tables[t.name]?.summary;
   const notes=(t.notes||[]).filter(n=>tableNames.some(o=>o!==t.name&&n.includes(o))||n.startsWith('one row'));
   return `-- ${t.name}: ${t.description||summary||'table'} (${t.rowCount} rows${t.primaryKey?`, one row per ${t.primaryKey}`:''})${notes.map(n=>'\n-- '+t.name+' '+n).join('')}\nCREATE TABLE ${t.name} (\n${cols.join(',\n')}\n);${joins.length?'\n-- join: '+joins.join('; '):''}`;
  }).join('\n\n');
 }
 // Backwards-compatible structured context.
 context(query:string){
  const r=this.retrieve(query);
  return {tables:r.tables.map(t=>({table:t.name,description:t.description,columns:t.columns.map(c=>c.name+':'+c.type).join(', '),ddl:`CREATE TABLE ${identifier(t.name)} (${t.columns.map(c=>identifier(c.name)+' '+c.type).join(', ')});`,values:Object.fromEntries(t.columns.filter(c=>c.values.length&&r.grounding.mentions.some(m=>m.table===t.name&&m.column===c.name)).map(c=>[c.name,c.values])),joins:t.relationships.filter(link=>link.split(' = ').every(part=>r.tables.some(table=>table.name===part.split('.')[0])))})),definitions:definitionsFor(query,this),aliases:Object.fromEntries(Object.entries(this.aliases).filter(([k])=>query.toLowerCase().includes(k.toLowerCase())))};
 }
 table(name:string){const t=this.tables.find(x=>x.name===name)||this.tables.find(x=>x.name.toLowerCase()===String(name).toLowerCase());if(!t)throw new Error(`Unknown table ${name}. Known tables: ${this.tables.map(x=>x.name).join(', ')}`);return t;}
 async values(table:string,column:string){const t=this.table(table);if(!t.columns.some(c=>c.name===column))throw new Error(`Unknown column ${column} in ${t.name}. Columns: ${t.columns.map(c=>c.name).join(', ')}`);return this.db.query(`SELECT ${identifier(column)} AS "value",count(*) frequency FROM ${identifier(t.name)} GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 30`,30);}
 async checkValues(sql:string){
  const warnings:{column:string;literal:string;table:string;knownValues:unknown[];inspectionSql:string}[]=[];
  for(const match of sql.matchAll(/(?:[a-zA-Z_]\w*\.)?"?([a-zA-Z_]\w*)"?\s*=\s*'((?:''|[^'])*)'/g)){
   const column=match[1],literal=match[2].replaceAll("''","'");
   const candidates=this.tables.filter(t=>new RegExp('\\b'+t.name+'\\b','i').test(sql)&&t.columns.some(c=>c.name===column&&c.values.length>0));
   if(!candidates.length||candidates.some(t=>t.columns.find(c=>c.name===column)!.values.includes(literal)))continue;
   for(const t of candidates){const result=await this.values(t.name,column);warnings.push({column,literal,table:t.name,knownValues:result.rows.map(r=>r.value),inspectionSql:`SELECT "${column}",count(*) FROM "${t.name}" GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 30`});}
  }
  return warnings;
 }
 async remember(alias:string,value:string,question:string){if(!alias||alias.length>80||value.length>100||!question.toLowerCase().includes(alias.toLowerCase())||alias.toLowerCase()===value.toLowerCase()||this.tables.some(t=>t.name===alias.toLowerCase()||t.columns.some(c=>c.name===alias.toLowerCase())))return;const valid=this.tables.some(t=>t.columns.some(c=>c.values.includes(value)));if(!valid)return;this.aliases[alias]=value;if(this.cachePath)await writeFile('data/aliases.json',JSON.stringify(this.aliases,null,2));}
}
