// Answer shape: what kind of answer the question wants, decided before any SQL is written.
// Without this, a question with no explicit measure ("give me a summary of servers", "bring up any
// vulnerability and its history") falls through to SQL search, and any query that runs (often a raw
// row dump) gets presented as the answer. Shapes are schema-driven, so they work on any database:
//  - overview: profile one table (size, category mixes, numeric ranges, date span, linked tables),
//    computed by several small aggregate queries in parallel and merged.
//  - record:   one record in full (all columns, the records it references, its own history), either
//    the one the user named or a clearly labelled example.
//  - creative: jokes/poems; facts come from an overview, never from the model.
//  - query:    everything else (counts, breakdowns, rankings, lookups, listings) - the SQL pipeline.
import type {Catalog,Table,Column} from './catalog.js';
import {norm,type Grounding,type Mention} from './grounding.js';
import {identifier as q,sqlLiteral} from './db.js';
import {eventDateColumn,labelColumn} from './draft.js';
import type {Evidence,Row} from './types.js';

export type Shape={kind:'overview'|'record'|'creative'|'query';table?:string;id?:Mention};

const OVERVIEW=/\b(summary|summaries|summari[sz]e|summari[sz]ing|overview|overall|describe|profile|snapshot|at a glance|big picture|picture of|landscape|tell me about|talk (?:to me )?about|what do we have|what we have|what does .+ look like|give me an idea|state of|health of|status of|how (?:are|is) (?:we|our|the) .*doing|how (?:are|is) we doing|what'?s going on|insights?|stats|statistics|highlights|key facts|info(?:rmation)? (?:on|about))\b/i;
const DETAIL=/\b(details?|history|histories|everything|full|entire|complete|all (?:of )?(?:the |its |their )?(?:info|information|fields|columns|data|attributes)|deep ?dive|drill (?:down|into)|timeline|lifecycle|life cycle|story of|record of|tell me about)\b/i;
const SINGLE_WORDS='any|an?|one|single|random|some|sample|example|specific|particular';
// A question with its own measure, grouping, ranking or time trend is a query, not an overview.
const MEASURE=/\b(how many|number of|count|counts|average|avg|mean|median|total|sum|max|maximum|min|minimum|highest|lowest|most|least|fewest|top|bottom|rank|per|by|each|every|breakdown|break down|distribution|trend|over time|percent|percentage|share|ratio|compare|versus|vs|which|list|show all)\b/i;
export const JOKE=/\b(joke|jokes|funny|pun|puns|riddle|make me laugh)\b/i;
// The user asked for rows themselves; a long listing is then the right shape.
export const LISTING=/\b(list|lists|show|display|which|what are|give me (?:all|the)|find|get|fetch|rows?|records?|names?|ids?|enumerate|all the|every)\b/i;

export function answerShape(question:string,g:Grounding,catalog:Catalog):Shape{
 // Intent words are read after spelling correction ("summery of incidnets").
 question=g.normalized||question;
 const tables=g.mentions.filter(m=>m.kind==='table').sort((a,b)=>norm(g.normalized).indexOf(norm(a.text))-norm(g.normalized).indexOf(norm(b.text)));
 const subject=tables[0]?.table;
 if(JOKE.test(question))return {kind:'creative',table:subject};
 const idMentions=g.mentions.filter(m=>m.kind==='value'&&m.confidence>=1&&(m.via==='lookup'||catalog.table(m.table).primaryKey===m.column||labelColumn(catalog.table(m.table))===m.column));
 // One identifier often appears in several tables (SRV-00010 in servers, incidents, backups...): keep the table that owns it.
 const owns=(m:Mention)=>catalog.table(m.table).primaryKey===m.column||labelColumn(catalog.table(m.table))===m.column?0:1;
 const ids=[...new Map([...idMentions].sort((a,b)=>owns(b)-owns(a)).map(m=>[String(m.value).toLowerCase(),m])).values()];
 // One identified record ("tell me everything about host-00042") or one example record ("any vulnerability ... history").
 const asksWhatIs=ids.length===1&&new RegExp(`^\\s*(?:what\\s+(?:is|are)|what'?s|who\\s+is|tell me about)\\s+(?:the\\s+)?${norm(ids[0].text).replace(/ /g,'[\\s-]+')}\\s*[?.!]*\\s*$`,'i').test(norm(question));
 if(ids.length===1&&(DETAIL.test(question)||OVERVIEW.test(question)||asksWhatIs)&&!/\b(how many|count|average|avg|total|sum)\b/i.test(question))return {kind:'record',table:ids[0].table,id:ids[0]};
 if(subject&&!ids.length&&DETAIL.test(question)&&new RegExp(`\\b(?:${SINGLE_WORDS})\\s+(?:\\w+\\s+){0,2}${norm(tables[0].text).split(' ')[0]}`,'i').test(norm(g.normalized))&&!/\b(how many|count|average|avg|total|sum|per|by)\b/i.test(question))return {kind:'record',table:subject};
 if(subject&&!ids.length&&OVERVIEW.test(question)&&!MEASURE.test(question.replace(OVERVIEW,' ')))return {kind:'overview',table:subject};
 return {kind:'query',table:subject};
}

// Grounded values of the subject table become filters ("summary of open critical vulnerabilities").
function filtersFor(t:Table,g:Grounding){
 const byCol=new Map<string,string[]>();
 for(const m of g.mentions.filter(m=>m.kind==='value'&&m.table===t.name&&m.confidence>=0.9&&m.via!=='partial'&&!m.negated)){const l=byCol.get(m.column!)||[];if(!l.includes(m.value!))l.push(m.value!);byCol.set(m.column!,l);}
 const parts=[...byCol].map(([c,vs])=>vs.length===1?`${q(c)} = ${sqlLiteral(vs[0])}`:`${q(c)} IN (${vs.map(sqlLiteral).join(', ')})`);
 return {where:parts.length?' WHERE '+parts.join(' AND '):'',text:[...byCol].map(([c,vs])=>`${c.replace(/_/g,' ')} ${vs.join(' or ')}`).join(', ')};
}
const isId=(t:Table,c:Column)=>c.name===t.primaryKey||/(^|_)id$/.test(c.name);
const NUM=/INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL/;
const fmt=(v:unknown)=>typeof v==='number'?(Number.isInteger(v)?v.toLocaleString('en-US'):(Math.round(v*100)/100).toLocaleString('en-US')):typeof v==='bigint'?Number(v).toLocaleString('en-US'):v===null||v===undefined?'—':String(v).slice(0,10)===String(v).slice(0,10)&&/^\d{4}-\d{2}-\d{2}/.test(String(v))?String(v).slice(0,10):String(v);
const label=(s:string)=>s.replace(/_/g,' ');
// Lifecycle order for dates on the same day: start events, then other dates, then end events, then housekeeping.
const stage=(n:string)=>/^(created|discovered|opened|started|reported|detected)/.test(n)?0:/^(resolved|closed|completed|ended|remediated|fixed)/.test(n)?2:/^(updated|last_seen|last_)/.test(n)?3:1;
export const singularOf=(s:string)=>s.replace(/_/g,' ').replace(/ies$/,'y').replace(/(ches|shes|sses|xes)$/,m=>m.slice(0,-2)).replace(/([^s])s$/,'$1');
const ev=(stepId:string,objective:string,sql:string,r:{rows:Row[];rowCount:number;truncated:boolean}):Evidence=>({stepId,objective,tool:'run_sql',sql,rows:r.rows,rowCount:r.rowCount,truncated:r.truncated,durationMs:0,repairs:0});

// Profile of one table: several independent aggregate queries (run in parallel), merged into one answer.
export async function overview(catalog:Catalog,tableName:string,g:Grounding,emit:(m:string)=>void){
 const t=catalog.table(tableName);const f=filtersFor(t,g);const from=`${q(t.name)}${f.where}`;
 const filtered=new Set(g.mentions.filter(m=>m.kind==='value'&&m.table===t.name&&m.confidence>=0.9&&m.via!=='partial'&&!m.negated).map(m=>m.column));
 const categorical=t.columns.filter(c=>!filtered.has(c.name)&&!isId(t,c)&&c.name!==labelColumn(t)&&(c.type==='VARCHAR'||c.type==='BOOLEAN')&&c.values.length>=2&&c.values.length<=25).slice(0,6);
 const numeric=t.columns.filter(c=>!isId(t,c)&&NUM.test(c.type)&&(c.profile?.distinctCount??10)>2).slice(0,4);
 const event=eventDateColumn(t);const dates=t.columns.filter(c=>/DATE|TIMESTAMP/.test(c.type)).sort((a,b)=>Number(b.name===event)-Number(a.name===event)).slice(0,2);
 const children=catalog.tables.filter(c=>c!==t&&t.primaryKey&&c.relationships.includes(`${c.name}.${t.primaryKey} = ${t.name}.${t.primaryKey}`));
 emit(`Profiling ${t.name}${f.text?` (${f.text})`:''}: ${categorical.length} categories, ${numeric.length} measures, ${dates.length} dates, ${children.length} linked tables — in parallel`);
 type Step={id:string;objective:string;sql:string};
 const steps:Step[]=[{id:'size',objective:`Number of ${t.name}`,sql:`SELECT count(*) AS ${q(t.name+'_count')} FROM ${from}`}];
 for(const c of categorical)steps.push({id:'mix_'+c.name,objective:`${t.name} by ${label(c.name)}`,sql:`SELECT ${q(c.name)}, count(*) AS record_count FROM ${from} GROUP BY 1 ORDER BY record_count DESC, 1 LIMIT 6`});
 if(numeric.length)steps.push({id:'measures',objective:`Range of ${numeric.map(c=>label(c.name)).join(', ')}`,sql:`SELECT ${numeric.map(c=>`min(${q(c.name)}) AS ${q('min_'+c.name)}, avg(${q(c.name)}) AS ${q('avg_'+c.name)}, max(${q(c.name)}) AS ${q('max_'+c.name)}`).join(', ')} FROM ${from}`});
 if(dates.length)steps.push({id:'dates',objective:`Date span of ${dates.map(c=>label(c.name)).join(', ')}`,sql:`SELECT ${dates.map(c=>`min(${q(c.name)}) AS ${q('first_'+c.name)}, max(${q(c.name)}) AS ${q('last_'+c.name)}`).join(', ')} FROM ${from}`});
 for(const c of children.slice(0,4))steps.push({id:'linked_'+c.name,objective:`${c.name} linked to these ${t.name}`,sql:`SELECT count(*) AS ${q(c.name+'_count')}, count(DISTINCT c.${q(t.primaryKey!)}) AS ${q(t.name+'_with_'+c.name)} FROM ${q(c.name)} c WHERE c.${q(t.primaryKey!)} IN (SELECT ${q(t.primaryKey!)} FROM ${from})`});
 const evidence=await Promise.all(steps.map(async s=>ev(s.id,s.objective,s.sql,await catalog.db.query(s.sql,50))));
 const total=Number(Object.values(evidence[0].rows[0]||{})[0]??0);
 const lines:string[]=[`**${fmt(total)} ${t.name}**${f.text?` with ${f.text}`:''}.`];
 if(total>0){
  for(const e of evidence.filter(e=>e.stepId.startsWith('mix_'))){
   const col=e.stepId.slice(4);const shown=e.rows.map(r=>`${fmt(r[col])}: ${fmt(r.record_count)} (${Math.round(Number(r.record_count)/total*100)}%)`);
   const distinct=t.columns.find(c=>c.name===col)!.values.length;
   lines.push(`- **${label(col)}**: ${shown.join(', ')}${e.rows.length===6&&distinct>6?` and ${distinct-6} more`:''}`);
  }
  const m=evidence.find(e=>e.stepId==='measures')?.rows[0];
  if(m)for(const c of numeric)lines.push(`- **${label(c.name)}**: average ${fmt(m['avg_'+c.name])}, range ${fmt(m['min_'+c.name])} – ${fmt(m['max_'+c.name])}`);
  const d=evidence.find(e=>e.stepId==='dates')?.rows[0];
  if(d)for(const c of dates)lines.push(`- **${label(c.name)}**: ${fmt(d['first_'+c.name])} to ${fmt(d['last_'+c.name])}`);
  for(const e of evidence.filter(e=>e.stepId.startsWith('linked_'))){const c=e.stepId.slice(7);const r=e.rows[0]||{};lines.push(`- **linked ${label(c)}**: ${fmt(r[c+'_count'])} record${Number(r[c+'_count'])===1?'':'s'} across ${fmt(r[t.name+'_with_'+c])} of these ${t.name}`);}
 }
 return {evidence,text:lines.join('\n')};
}

// One record in full: its columns, the records it references, and its own history (child records).
export async function recordDossier(catalog:Catalog,tableName:string,g:Grounding,id:Mention|undefined,emit:(m:string)=>void){
 const t=catalog.table(tableName);const key=t.primaryKey;
 const f=filtersFor(t,g);const event=eventDateColumn(t);
 let where:string;let chosen='';
 if(id)where=` WHERE ${q(id.column!)} = ${sqlLiteral(id.value!)}`;
 else{
  // No record named: show one clearly labelled example (the most recent one matching any stated filters).
  const order=event?`${q(event)} DESC NULLS LAST${key?`, ${q(key)}`:''}`:key?q(key):'1';
  const pick=await catalog.db.query(`SELECT ${key?q(key):'*'} FROM ${q(t.name)}${f.where} ORDER BY ${order} LIMIT 1`,1);
  if(!pick.rows.length)return {evidence:[] as Evidence[],text:`No ${t.name} match${f.text?` ${f.text}`:''}, so there is no record to show.`};
  if(!key)return {evidence:[ev('record',`One ${t.name} record`,'',pick)],text:`Example ${t.name} record shown below.`};
  where=` WHERE ${q(key)} = ${sqlLiteral(String(pick.rows[0][key]))}`;
  chosen=`No specific ${singularOf(t.name)} was named, so this is an example: the ${event?`most recent by ${label(event)}`:`first by ${label(key)}`}${f.text?` with ${f.text}`:''}.`;
 }
 emit(`Collecting the full record, what it references and its history`);
 const recordSql=`SELECT * FROM ${q(t.name)}${where} LIMIT 5`;
 const record=await catalog.db.query(recordSql,5);
 if(!record.rows.length)return {evidence:[ev('record',`The ${t.name} record`,recordSql,record)],text:`No ${t.name} record matches ${id?`${label(id.column!)} “${id.value}”`:'the request'}.`};
 const row=record.rows[0];const evidence:Evidence[]=[ev('record',`The ${t.name} record (all fields)`,recordSql,record)];
 // Parents this record references, plus how many sibling records share each parent.
 const parents=catalog.tables.filter(p=>p!==t&&p.primaryKey&&t.relationships.includes(`${t.name}.${p.primaryKey} = ${p.name}.${p.primaryKey}`)&&row[p.primaryKey]!=null);
 const children=key?catalog.tables.filter(c=>c!==t&&c.relationships.includes(`${c.name}.${key} = ${t.name}.${key}`)):[];
 const tasks:Promise<Evidence>[]=[];
 for(const p of parents){
  const cols=[p.primaryKey!,labelColumn(p),...p.columns.filter(c=>!isId(p,c)&&(c.values.length&&c.values.length<=25)).map(c=>c.name)].filter((c,i,a)=>c&&a.indexOf(c)===i).slice(0,8) as string[];
  const sql=`SELECT ${cols.map(q).join(', ')}, (SELECT count(*) FROM ${q(t.name)} s WHERE s.${q(p.primaryKey!)} = ${sqlLiteral(String(row[p.primaryKey!]))}) AS ${q(t.name+'_on_same_'+singularOf(p.name))} FROM ${q(p.name)} WHERE ${q(p.primaryKey!)} = ${sqlLiteral(String(row[p.primaryKey!]))}`;
  tasks.push(catalog.db.query(sql,1).then(r=>ev('parent_'+p.name,`The ${singularOf(p.name)} it belongs to`,sql,r)));
 }
 for(const c of children){
  const ce=eventDateColumn(c);
  const sql=`SELECT * FROM ${q(c.name)} WHERE ${q(key!)} = ${sqlLiteral(String(row[key!]))} ORDER BY ${ce?`${q(ce)} DESC NULLS LAST`:'1'} LIMIT 10`;
  const countSql=`SELECT count(*) AS n FROM ${q(c.name)} WHERE ${q(key!)} = ${sqlLiteral(String(row[key!]))}`;
  tasks.push(Promise.all([catalog.db.query(sql,10),catalog.db.query(countSql,1)]).then(([r,n])=>({...ev('history_'+c.name,`Its ${c.name} (latest first)`,sql,r),totalRows:Number(n.rows[0]?.n??r.rowCount)})));
 }
 // What else is recorded against the same parent ("its server also has 3 incidents, 4 backups").
 for(const p of parents){
  const others=catalog.tables.filter(c=>c!==t&&c.relationships.includes(`${c.name}.${p.primaryKey} = ${p.name}.${p.primaryKey}`));
  for(const c of others){
   const ce=eventDateColumn(c);
   const sql=`SELECT count(*) AS n${ce?`, max(${q(ce)}) AS latest`:''} FROM ${q(c.name)} WHERE ${q(p.primaryKey!)} = ${sqlLiteral(String(row[p.primaryKey!]))}`;
   tasks.push(catalog.db.query(sql,1).then(r=>ev(`context_${p.name}_${c.name}`,`${c.name} on the same ${singularOf(p.name)}`,sql,r)));
  }
 }
 // Identifier-like values shared with other records ("the same CVE on other servers").
 const shared=t.columns.filter(c=>c.type==='VARCHAR'&&c.name!==key&&c.name!==labelColumn(t)&&!parents.some(p=>p.primaryKey===c.name)&&typeof row[c.name]==='string'&&/^[A-Z][A-Z0-9]*-\d/.test(String(row[c.name]))).slice(0,2);
 for(const c of shared){
  const sql=`SELECT count(*) AS n${parents[0]?`, count(DISTINCT ${q(parents[0].primaryKey!)}) AS ${q(parents[0].name)}`:''} FROM ${q(t.name)} WHERE ${q(c.name)} = ${sqlLiteral(String(row[c.name]))}`;
  tasks.push(catalog.db.query(sql,1).then(r=>ev('shared_'+c.name,`Other ${t.name} with the same ${label(c.name)}`,sql,r)));
 }
 evidence.push(...await Promise.all(tasks));
 // Deterministic write-up: every value comes straight from the rows above.
 const name=key?`${row[key]}`:'';const lbl=labelColumn(t);
 const lines:string[]=[];if(chosen)lines.push(`_${chosen}_`);
 lines.push(`**${singularOf(t.name)} ${name}**${lbl&&lbl!==key&&row[lbl]!=null?` — ${row[lbl]}`:''}`);
 const dateCols=t.columns.filter(c=>/DATE|TIMESTAMP/.test(c.type));
 const plain=t.columns.filter(c=>c.name!==key&&c.name!==lbl&&!dateCols.includes(c)&&!parents.some(p=>p.primaryKey===c.name));
 lines.push('- '+plain.map(c=>`${label(c.name)}: **${fmt(row[c.name])}**`).join(' · '));
 if(dateCols.length)lines.push('- Timeline: '+dateCols.map(c=>({c,v:row[c.name]})).sort((a,b)=>String(a.v??'9').localeCompare(String(b.v??'9'))||stage(a.c.name)-stage(b.c.name)).map(({c,v})=>`${label(c.name)} ${v==null?'— (not set)':fmt(v)}`).join(' → '));
 for(const p of parents){const r=evidence.find(e=>e.stepId==='parent_'+p.name)?.rows[0];if(!r)continue;
  const extra=Object.entries(r).filter(([k])=>k!==p.primaryKey&&!k.includes('_on_same_')).map(([k,v])=>`${label(k)} ${fmt(v)}`).join(', ');
  const same=Object.entries(r).find(([k])=>k.includes('_on_same_'));
  lines.push(`- ${singularOf(p.name)}: **${r[p.primaryKey!]}** (${extra})${same&&Number(same[1])>1?` — it has ${fmt(Number(same[1]))} ${t.name} in total`:''}`);}
 for(const e of evidence.filter(e=>e.stepId.startsWith('context_'))){const r=e.rows[0]||{};const [,pn,...cn]=e.stepId.split('_');const c=cn.join('_');
  if(Number(r.n)>0)lines.push(`- Same ${singularOf(pn)} also has **${fmt(Number(r.n))}** ${label(c)}${r.latest?` (latest ${fmt(r.latest)})`:''}`);}
 for(const e of evidence.filter(e=>e.stepId.startsWith('shared_'))){const r=e.rows[0]||{};const c=e.stepId.slice(7);
  if(Number(r.n)>1)lines.push(`- ${label(c)} ${row[c]} appears on **${fmt(Number(r.n))}** ${t.name}${parents[0]&&r[parents[0].name]!==undefined?` across ${fmt(Number(r[parents[0].name]))} ${Number(r[parents[0].name])===1?singularOf(parents[0].name):parents[0].name}`:''}`);}
 for(const c of children){const e=evidence.find(x=>x.stepId==='history_'+c.name)!;const ce=eventDateColumn(c);
  lines.push(`- ${c.name}: ${e.totalRows?`**${fmt(e.totalRows)}**${ce&&e.rows[0]?.[ce]?`, latest ${fmt(e.rows[0][ce])}`:''}`:'none'}`);}
 if(record.rows.length>1)lines.push(`_${record.rows.length} records match; the first is described._`);
 return {evidence,text:lines.join('\n')};
}

// "tell me a joke" with nothing to ground it: a fixed, harmless line plus what can be asked.
const JOKES=['Why did the database administrator leave the party early? Too many relationships to maintain.','A SQL query walks into a bar, goes up to two tables and asks: “Mind if I join you?”','I asked the database for a joke. It returned 0 rows — tough crowd.'];
export function plainJoke(seed:string){let h=0;for(const ch of seed)h=(h*31+ch.charCodeAt(0))>>>0;return JOKES[h%JOKES.length];}

// "what is evergreening", "what does cvss score mean", "what is P1": a definition from the schema itself
// (descriptions, learned notes, stored values and ranges), with a count where that helps. No SQL search.
const DEFINE=/^\s*(?:what\s+(?:is|are|does|do)|what'?s|define|definition of|meaning of|explain)\s+(?:an?\s+|the\s+|a\s+)?(.+?)(?:\s+(?:mean|means|stand for|refer to))?\s*[?.!]*\s*$/i;
export function definitionTerm(question:string,g:Grounding){
 const m=(g.normalized||question).match(DEFINE);if(!m)return undefined;
 const term=norm(m[1]).replace(/\b(in|on|for) (this|our|the) (data|database|dataset)\b/,'').trim();
 if(!term||term.split(' ').length>4)return undefined;
 // The whole term must be one schema item; anything more ("the os of host-00042") is a real query.
 const hit=g.mentions.filter(x=>norm(x.text)===term||norm(x.text)===term.replace(/s$/,'')||norm(x.text)+'s'===term).sort((a,b)=>(a.kind==='table'?0:a.kind==='column'?1:2)-(b.kind==='table'?0:b.kind==='column'?1:2));
 // A named record ("what is CVE-2025-1500", "what is host-00042") is described by its data, not defined.
 if(hit[0]?.kind==='value'&&hit[0].via==='lookup')return undefined;
 return hit[0]?{term,mention:hit[0]}:undefined;
}
export async function defineTerm(catalog:Catalog,mention:Mention){
 const t=catalog.table(mention.table);const learned=catalog.learned?.tables?.[t.name]?.summary;
 if(mention.kind==='table'){
  const keyCols=t.columns.filter(c=>!isId(t,c)).slice(0,8).map(c=>label(c.name));
  const links=catalog.tables.filter(o=>o!==t&&(o.relationships.some(r=>r.includes(` = ${t.name}.`))||t.relationships.some(r=>r.includes(` = ${o.name}.`)))).map(o=>o.name);
  return {evidence:[] as Evidence[],text:`**${t.name}** ${t.description?`— ${t.description.replace(/\.\s*$/,'')}`:'is a table in this database'}.${learned?` ${learned}`:''}\n\n- It holds **${fmt(t.rowCount)}** records${t.primaryKey?`, one per ${label(t.primaryKey)}`:''}.\n- Main fields: ${keyCols.join(', ')}.${links.length?`\n- Linked to: ${links.join(', ')}.`:''}\n\nAsk “summary of ${t.name}” for a full profile.`};
 }
 const c=t.columns.find(x=>x.name===mention.column)!;
 if(mention.kind==='column'){
  const values=c.values.length&&c.values.length<=25?`Possible values: ${c.values.map(String).join(', ')}.`:c.profile&&c.profile.min!==undefined?`Values range from ${fmt(c.profile.min)} to ${fmt(c.profile.max)}.`:'';
  const nulls=c.profile?.nullCount?` ${fmt(c.profile.nullCount)} of ${fmt(t.rowCount)} records leave it empty.`:'';
  return {evidence:[] as Evidence[],text:`**${label(c.name)}** is a field of ${t.name}${c.description?`: ${c.description}`:` (${c.type.toLowerCase()})`}. ${values}${nulls}`.trim()};
 }
 const sql=`SELECT count(*) AS ${q(t.name+'_count')} FROM ${q(t.name)} WHERE ${q(c.name)} = ${sqlLiteral(mention.value!)}`;
 const r=await catalog.db.query(sql,1);const n=Number(Object.values(r.rows[0]||{})[0]??0);
 const siblings=c.values.length&&c.values.length<=25?` Other ${label(c.name)} values: ${c.values.map(String).filter(v=>v!==mention.value).join(', ')}.`:'';
 return {evidence:[ev('definition',`${t.name} with ${label(c.name)} ${mention.value}`,sql,r)],text:`**${mention.value}** is a ${label(c.name)} value in ${t.name}${c.description?` (${c.description})`:''}. **${fmt(n)}** of ${fmt(t.rowCount)} ${t.name} have it.${siblings}`};
}

// "why?", "how did you get that", "explain that": describe the previous answer's queries in plain words.
export const EXPLAIN=/^\s*(?:why\b|how (?:did|do) you (?:get|calculate|work|find|know|come up)|how come|how was (?:that|this) (?:calculated|computed|worked out)|explain (?:that|this|it|the (?:answer|result|number|query))|what does (?:that|this) (?:mean|number mean)|where (?:did|does) (?:that|this) (?:come from|number come from)|show (?:me )?(?:the |your )?(?:sql|query|queries|working|work)|how did you do (?:that|it))/i;
export function explainQueries(question:string,sqls:string[],summary:string){
 if(!sqls.length)return `My previous answer to “${question}” didn’t need a database query: ${summary.slice(0,200)}`;
 const describe=(sql:string)=>{
  const tables=[...new Set([...sql.matchAll(/\b(?:FROM|JOIN)\s+"?(\w+)"?/gi)].map(m=>m[1]))];
  const filters=[...new Set([...sql.matchAll(/"?(\w+)"?\s*(=|>=|<=|<>|!=|>|<|\bIN\b|\bLIKE\b)\s*('(?:''|[^'])*'|-?\d[\d.]*|\([^)]*\))/gi)].filter(m=>!/^(rn|jevy_rank)$/i.test(m[1])).map(m=>`${label(m[1])} ${m[2].toUpperCase()==='='?'is':m[2]} ${m[3]}`))].slice(0,6);
  const group=sql.match(/GROUP BY\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+HAVING|$)/i)?.[1];
  const measure=/count\s*\(\s*DISTINCT\s+[^)]*\)/i.test(sql)?'counted distinct values':/count\s*\(/i.test(sql)?'counted records':/\bavg\s*\(/i.test(sql)?'averaged':/\bsum\s*\(/i.test(sql)?'added up':/\b(max|min)\s*\(/i.test(sql)?'took the extreme value':'listed matching records';
  return `read ${tables.join(' + ')}${filters.length?`, kept rows where ${filters.join(' and ')}`:''}, ${measure}${group&&!/^\d/.test(group)?` per ${label(group.replace(/"/g,''))}`:''}`;
 };
 const steps=sqls.slice(0,4).map((s,i)=>`${sqls.length>1?`${i+1}. `:''}I ${describe(s)}.`);
 return `For “${question}”:\n\n${steps.join('\n')}\n\nEvery number in the answer came from these read-only queries on the database; open “Show SQL” on the answer to see them exactly.`;
}
