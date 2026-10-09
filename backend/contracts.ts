import {Catalog} from './catalog.js';
import {identifier,sqlLiteral} from './db.js';
import {groundedFilters} from './query-plan.js';
import type {Plan,Evidence} from './types.js';
export type Contract={kind:'category_profile'|'latest_related';baseTable:string;entityKey?:string;groupBy:string[];columns:string[];relatedTable?:string;relatedColumns?:string[];latestBy?:string;limit:number;random:boolean;scopeIds:string[];question:string};
const words=(s:string)=>s.toLowerCase().replace(/operating systems?/g,'os').replace(/[^a-z0-9_]+/g,' ').split(' ');
const mentions=(question:string,name:string)=>{const w=words(question);return w.includes(name)||w.some(token=>token.replace(/ies$/,'y').replace(/s$/,'')===name.replace(/ies$/,'y').replace(/s$/,''))||question.toLowerCase().includes(name.replaceAll('_',' '));};
export function requestedLimit(question:string){const m=question.match(/\b(?:show|pick|choose|give|return|select|sample)\s+(?:me\s+)?(?:the\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);if(!m)return undefined;const n=Number(m[1])||['one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(m[1].toLowerCase())+1;return n>0&&n<=200?n:undefined;}
export function resolveContract(question:string,catalog:Catalog,scopeIds:string[]=[]):Contract|null{
 const query=question.replace(/operating systems?/ig,'os');const tables=catalog.retrieve(query).tables;
 const numericRequest=tables.some(t=>t.columns.some(c=>/INT|FLOAT|DOUBLE|DECIMAL/.test(c.type)&&words(query).includes(c.name.split('_')[0])));
 // Time buckets ("per month", "weekly") are a trend, not a plain category profile.
 const timeBucket=/\b(?:per|by|each|every|over) (?:the )?(?:day|week|month|quarter|year)s?\b|\b(daily|weekly|monthly|quarterly|yearly|annually|over time|trend)\b/i.test(query);
 if(!timeBucket&&!numericRequest&&!/\b(average|avg|sum|minimum|maximum|min|max|percent|percentage|share|ratio|how many different)\b/i.test(query)&&/\b(summary|summariz\w*|overview|different|diferent|distribution|breakdown|group|each|every|per|by)\b/i.test(query)&&!requestedLimit(query)){
  const choices=tables.map(t=>({t,groups:t.columns.filter(c=>c.values.length>1&&mentions(query,c.name)).map(c=>c.name)})).filter(x=>x.groups.length);
  if(choices.length===1){const {t,groups}=choices[0];return {kind:'category_profile',baseTable:t.name,entityKey:t.primaryKey,groupBy:groups,columns:[],limit:200,random:false,scopeIds,question};}
 }
 const limit=requestedLimit(query);
 if(limit&&/\b(latest|most recent|last)\b/i.test(query)){
  for(const child of tables.filter(t=>new RegExp('(?:latest|most recent|last)\\s+(?:[a-z]+\\s+){0,2}'+t.name.replace(/ies$/,'y').replace(/s$/,'').replaceAll('_',' '),'i').test(query)))for(const link of child.relationships){const [left,right]=link.split(' = ');const [parent,key]=right.split('.');const base=tables.find(t=>t.name===parent);if(!base||!mentions(query,child.name))continue;
   if(left.split('.')[1]!==key||key!==base.primaryKey)continue;
   const dates=child.columns.filter(c=>/DATE|TIMESTAMP/.test(c.type));
   const explicit=dates.find(c=>mentions(query,c.name)||mentions(query,c.name.replace(/_(date|at|time|timestamp)$/,'')));
   const eventDate=explicit||dates.find(c=>['created_date','started_at','discovered_date'].includes(c.name))||(dates.length===1?dates[0]:undefined);
   if(!eventDate||!child.primaryKey)return null;
   if(tables.some(t=>t!==base&&t!==child&&t.columns.some(c=>!c.name.endsWith('_id')&&mentions(query,c.name))))return null;
   const columns=[...new Set([key,...base.columns.filter(c=>mentions(query,c.name)).map(c=>c.name),...groundedFilters(catalog,base.name,query).map(f=>f.column.split('.')[1])])];
   const relatedColumns=[...new Set([child.primaryKey,eventDate.name,...child.columns.filter(c=>mentions(query,c.name)).map(c=>c.name)])];
   return {kind:'latest_related',baseTable:base.name,entityKey:key,columns,groupBy:[],relatedTable:child.name,relatedColumns,latestBy:eventDate.name,limit,random:/\brandom(?:ly)?\b/i.test(query),scopeIds,question};
  }
 }
 return null;
}
function predicate(c:Contract,catalog:Catalog){
 const filters=groundedFilters(catalog,c.baseTable,c.question).map(f=>`${identifier(f.column.split('.')[1])} = ${sqlLiteral(f.values[0])}`);
 if(c.scopeIds.length&&c.entityKey)filters.push(`${identifier(c.entityKey)} IN (${c.scopeIds.map(sqlLiteral).join(',')})`);
 return filters.length?' WHERE '+filters.join(' AND '):'';
}
export function compileContract(c:Contract,catalog:Catalog):Plan{
 const base=catalog.table(c.baseTable),q=identifier;const where=predicate(c,catalog);
 if(c.kind==='category_profile'){
  for(const g of c.groupBy)if(!base.columns.some(col=>col.name===g))throw new Error('Unknown grouping field '+g);
  const sql=`SELECT ${c.groupBy.map(q).join(',')},count(*) AS record_count FROM ${q(base.name)}${where} GROUP BY ${c.groupBy.map(q).join(',')} ORDER BY record_count DESC,${c.groupBy.map(q).join(',')}`;
  return {intent:c.question,clarification:'',steps:[{id:'profile',objective:'Count records for each requested category',tool:'run_sql',inputs:{sql},dependencies:[]}]};
 }
 const child=catalog.table(c.relatedTable!),key=c.entityKey!;
 if(!child.relationships.includes(`${child.name}.${key} = ${base.name}.${key}`))throw new Error('Latest-record operator requires a verified child relationship');
 for(const col of c.columns)if(!base.columns.some(x=>x.name===col))throw new Error('Unknown base column');
 for(const col of c.relatedColumns!)if(!child.columns.some(x=>x.name===col))throw new Error('Unknown related column');
 if(!child.columns.some(x=>x.name===c.latestBy&&/DATE|TIMESTAMP/.test(x.type)))throw new Error('Latest-record operator requires a timestamp');
 const sample=`SELECT ${c.columns.map(q).join(',')} FROM ${q(base.name)}${where} ORDER BY ${c.random?'random()':q(key)} LIMIT ${c.limit}`;
 const latest=`WITH ranked AS (SELECT *,row_number() OVER(PARTITION BY ${q(key)} ORDER BY ${q(c.latestBy!)} DESC NULLS LAST,${q(child.primaryKey!)} DESC) AS jevy_rank FROM ${q(child.name)} WHERE ${q(key)} IN ({{selected.${key}}})) SELECT ${c.columns.map(col=>'b.'+q(col)).join(',')},${c.relatedColumns!.filter(col=>col!==key).map(col=>`r.${q(col)} AS ${q('latest_'+col)}`).join(',')} FROM ${q(base.name)} b LEFT JOIN ranked r ON b.${q(key)}=r.${q(key)} AND r.jevy_rank=1 WHERE b.${q(key)} IN ({{selected.${key}}}) ORDER BY b.${q(key)}`;
 return {intent:c.question,clarification:'',steps:[{id:'selected',objective:'Select requested base records and preserve entity IDs',tool:'run_sql',inputs:{sql:sample},dependencies:[]},{id:'latest',objective:'Attach one latest related record to each selected entity',tool:'run_sql',inputs:{sql:latest},dependencies:['selected']}]};
}
export function verifyContract(c:Contract,evidence:Evidence[]){
 const result=evidence.find(e=>e.stepId===(c.kind==='category_profile'?'profile':'latest'));
 if(!result||result.error)throw new Error(result?.error||'Contract execution missing');
 if(c.kind==='latest_related'){
  const selected=evidence.find(e=>e.stepId==='selected')!;const ids=result.rows.map(r=>r[c.entityKey!]);
  if(ids.length!==new Set(ids).size||ids.length!==selected.rows.length||selected.rows.some(r=>!ids.includes(r[c.entityKey!])))throw new Error('Latest-record evidence changed the selected entity grain');
  for(const r of result.rows)for(const col of [...c.columns,...c.relatedColumns!.filter(k=>k!==c.entityKey).map(k=>'latest_'+k)])if(!Object.hasOwn(r,col))throw new Error('Missing requested field '+col);
 }else{
  for(const r of result.rows)if(!c.groupBy.every(g=>Object.hasOwn(r,g))||typeof r.record_count!=='number')throw new Error('Incomplete categorical profile');
 }
 return result;
}
export function factualSummary(c:Contract,result:Evidence){
 if(c.kind!=='category_profile')return 'Selected records with their latest related record. Records with no related history are retained.';
 const total=result.rows.reduce((n,r)=>n+Number(r.record_count),0);
 return `${result.rows.length} category groups cover ${total.toLocaleString()} records${result.truncated?' in the displayed results':''}.\n\n`+result.rows.map(r=>`${c.groupBy.map(g=>`${g.replaceAll('_',' ')}: ${String(r[g])}`).join('; ')} — ${Number(r.record_count).toLocaleString()} records.`).join('\n');
}
