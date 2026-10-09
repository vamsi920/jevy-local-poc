// Grounded draft: when every part of a question maps onto the schema (measure, filters, grouping,
// ranking and join path), build the SQL deterministically. It joins the candidate vote, so a weak
// model gets a correct baseline and a strong model gets an independent second opinion. Returns null
// whenever the question has anything the draft does not fully understand.
import type {Catalog,Table} from './catalog.js';
import {norm,isCommonWord,groundSync,type Grounding,type Mention} from './grounding.js';
import {identifier as q,sqlLiteral} from './db.js';
import {numericConditions,unexplainedNumbers} from './numeric.js';

// DRAFT_DEBUG=1 prints which rule declined a question.
const no=(line:number):null=>{if(process.env.DRAFT_DEBUG)console.log('draft declined at line',line);return null;};
const NUMBER_WORDS=['one','two','three','four','five','six','seven','eight','nine','ten'];
const NUMERIC=/INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL/;
// The column that dates an event row ("incidents in the last 30 days" -> created_date).
const EVENT_DATE=['started','created','opened','discovered','reported','occurred','detected','event'];
export function eventDateColumn(t:Table){
 const dates=t.columns.filter(c=>/DATE|TIMESTAMP/.test(c.type));
 for(const w of EVENT_DATE){const hit=dates.filter(c=>c.name.startsWith(w));if(hit.length===1)return hit[0].name;if(hit.length>1)return undefined;}
 return dates.length===1?dates[0].name:undefined;
}
export const labelColumn=(t:Table)=>t.columns.find(c=>c.type==='VARCHAR'&&/(^|_)(name|title|hostname)$/.test(c.name))?.name||t.primaryKey;

export function draftSQL(question:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null{
 // "upgrade status breakdown" is "breakdown by upgrade status".
 let text=norm(g.normalized).replace(/^(?:(?:show|give|get)\s+(?:me\s+)?(?:the\s+|a\s+)?)?(.+?)\s+(breakdown|distribution|split|mix)$/,'$2 by $1');
 // "compare servers in production vs staging" is the comparison itself.
 if(/\b(vs|versus|and|with|to|against)\b/.test(text))text=text.replace(/^(?:compare|comparing|comparison of)\s+(?:the\s+)?(?:number of\s+|count of\s+)?/,'');
 // "unresolved"/"unpatched": un- + a date column's stem means that date is missing (IS NULL).
 const unNull:{table:string;column:string}[]=[];
 for(const t of g.unknownTerms.filter(w=>/^un/.test(w))){const stem=t.slice(2).replace(/(ed|d)$/,'');
  for(const tb of g.tables.map(n=>catalog.table(n)))for(const c of tb.columns)if(/DATE|TIME/.test(c.type)&&c.name.split('_')[0].startsWith(stem.slice(0,5))&&stem.length>=4&&(c.profile?.nullCount||0)>0)unNull.push({table:tb.name,column:c.name});}
 const unknown=g.unknownTerms.filter(w=>!(/^un/.test(w)&&unNull.length));
 if(unknown.length)return no(31);
 // "share of servers by environment": the grouped count, plus each group's percentage of the total.
 const shareRaw=text.match(/^(?:what (?:is |are )?)?(?:the )?(?:share|percentage|percent|proportion|fraction|split)(?:s)? (?:of )?(.+? (?:by|per|across|for each) .+)$/)
  ||text.match(/^(?:what (?:is |are )?)?(?:the )?(?:share|percentage|percent|proportion|fraction)s? of (.+?) (?:(?:are|is|that are|which are) )?(?:in|for) (?:each|every) (.+)$/);
 const shareMatch=shareRaw?(shareRaw[2]?[shareRaw[0],`${shareRaw[1]} by ${shareRaw[2]}`]:shareRaw):null;
 if(shareMatch&&!/\b(average|avg|mean|total|sum|max|min)\b/.test(shareMatch[1])){
  const inner=draftSQL(shareMatch[1],groundSync(shareMatch[1],catalog),catalog);
  const countExpr=inner?.sql.match(/count\(\*\) AS (?:"[^"]+"|\w+)/i)?.[0];
  if(inner&&countExpr&&/GROUP BY/i.test(inner.sql))return {sql:inner.sql.replace(countExpr,`${countExpr}, round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS percentage`),explain:inner.explain+', with each group\'s percentage of the total'};
  return no(29);
 }
 const latest=latestPerEntity(text,g,catalog);if(latest!==undefined)return latest;
 const exists=existencePattern(text,g,catalog);if(exists!==undefined)return exists;
 const extreme=dateExtreme(text,g,catalog);if(extreme!==undefined)return extreme;
 const trend=periodTrend(text,g,catalog);if(trend!==undefined)return trend;
 const record=recordLookup(text,g,catalog);if(record!==undefined)return record;
 const twoWay=twoWayBreakdown(text,g,catalog);if(twoWay!==undefined)return twoWay;
 const listing=firstRows(text,g,catalog);if(listing!==undefined)return listing;
 const ranked=rankedAggregate(text,g,catalog);if(ranked!==undefined)return ranked;
 const due=dueWithin(text,g,catalog);if(due!==undefined)return due;
 // "in the last/past N days|weeks" on a named date column is the only time window the draft handles.
 // "this month", "last year", "today": calendar periods relative to the dataset reference date.
 const periodMatch=text.match(/\b(this|current|last|previous) (week|month|quarter|year)\b|\b(today|yesterday)\b/);
 const windowMatch=text.match(/\b(?:in the |within the |during the )?(?:last|past) (\d+|seven|thirty|ninety|fourteen) (day|days|week|weeks)\b/);
 let stripped=windowMatch?text.replace(windowMatch[0],' '):text;
 if(periodMatch)stripped=stripped.replace(periodMatch[0],' ');
 stripped=stripped.replace(/\b(overdue|past due|past their due date)\b/,' ');
 if(g.mentions.some(m=>m.negated))stripped=stripped.replace(/\b(not|no|non|without|excluding|except)\b/g,' ');
 // Columns asked about by presence ("have a resolved date") are not time filters.
 for(const m of g.mentions.filter(m=>m.kind==='column'&&new RegExp('\\b(have|has|with|without|missing|no|having)\\s+(?:an?\\s+|the\\s+|any\\s+)?'+norm(m.text)).test(text)))stripped=stripped.replace(norm(m.text),' ');
 if(windowMatch)stripped=stripped.replace(/\b(not|never)\b(?=.*$)/,' ');
 // Field names that contain time words ("retention days", "rto minutes") are fields, not time windows.
 for(const m of g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.9&&/\b(day|days|week|weeks|month|months|year|years)\b/.test(norm(m.text))&&!/DATE|TIME/.test(catalog.table(m.table).columns.find(c=>c.name===m.column)?.type||'')))stripped=stripped.replace(norm(m.text),' ');
 if(/\b(day|days|week|weeks|month|months|year|years|quarter|recent|recently|last|past|since|ago|today|yesterday|date|when|oldest|newest|latest|earliest|first|never|without|not|no|none|except|excluding|list|show me the|which servers|random|percent|percentage|share|ratio|fraction|both|and also)\b/.test(stripped))return no(47);
 // Any uncertain interpretation (inflected or partial matches) means the model decides, not the draft.
 if(g.mentions.some(m=>m.kind==='value'&&(m.via==='partial'||m.confidence<0.9)))return no(49);
 // Position of a mention; multi-word column phrases may be split ("backups by type" ~ backup type).
 const pos=(m:Mention)=>{const i=text.indexOf(norm(m.text));if(i>=0)return i;const last=norm(m.text).split(' ').at(-1)!;return text.search(new RegExp('\\b'+last+'\\b'));};
 const tableMentions=g.mentions.filter(m=>m.kind==='table').sort((a,b)=>pos(a)-pos(b));
 // "average downtime by environment": no table is named, but the measured numeric field identifies it.
 if(!tableMentions.length&&(text.match(/\b(average|avg|mean|total|sum of|maximum|max|minimum|min|median)\b/g)||[]).length===1){
  const measures=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.6&&NUMERIC.test(catalog.table(m.table).columns.find(c=>c.name===m.column)?.type||''));
  if(measures.length===1)tableMentions.push({kind:'table',table:measures[0].table,text:measures[0].text,confidence:1,via:'exact'});
 }
 // "how many are blocked": no table named, but every stated value belongs to one table, so that table is the subject.
 if(!tableMentions.length&&/\b(how many|number of|count)\b/.test(text)){
  const values=g.mentions.filter(m=>m.kind==='value'&&m.confidence>=0.9&&m.via!=='partial');
  const owners=[...new Set(values.map(m=>m.table))];
  if(values.length&&owners.length===1)tableMentions.push({kind:'table',table:owners[0],text:values[0].text,confidence:0.9,via:'exact'});
 }
 // "restore test results breakdown" ("breakdown by restore test results"): the grouping field names its table.
 if(!tableMentions.length&&/\b(by|per|breakdown)\b/.test(text)){
  const fields=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.8);
  const owners=[...new Set(fields.map(m=>m.table))];
  if(fields.length&&owners.length===1&&!g.mentions.some(m=>m.kind==='value'&&m.table!==owners[0]))tableMentions.push({kind:'table',table:owners[0],text:owners[0],confidence:0.9,via:'exact'});
 }
 if(!tableMentions.length)return no(53);

 // 1. Measure
 // "top 3 applications by incident count" ranks applications by how many incidents they have.
 const rankBy=!/\b(average|avg|mean|total|sum|max|min)\b/.test(text)?text.match(/\b(?:top|bottom) \w+ \w+(?: \w+)? by (?:the )?(?:number of |count of |total )?((?:\w+ ){0,2}?\w+)(?: count| counts| number| volume)?(?= (?:in|for|during|over|with|where|on|at|from|since|last|this)\b|$)/):null;
 // "by number of open incidents": the ranked table is the last word; earlier words are qualifiers (filters).
 const rankTable=rankBy?tableMentions.find(m=>norm(m.text).split(' ')[0].replace(/s$/,'')===rankBy[1].split(' ').at(-1)!.replace(/s$/,'')):undefined;
 let superlative=text.match(/(?<!\bat )\b(most|fewest|least|highest number of|lowest number of)\b/);
 // "bottom 2 countries by server count" ranks ascending.
 const bottom=/\bbottom \w+ \w+/.test(text)&&!superlative;
 // "top 3 datacenters by incident count": the label may be a column of the counted table.
 const rankColumn=rankTable&&tableMentions[0]===rankTable?g.mentions.find(m=>m.kind==='column'&&m.confidence>=0.9&&!/_id$/.test(m.column!)&&pos(m)<text.indexOf(' by ')&&catalog.table(m.table).columns.find(c=>c.name===m.column)?.type==='VARCHAR'):undefined;
 if(!superlative&&rankTable&&(tableMentions[0]!==rankTable||rankColumn))superlative=Object.assign(bottom?['fewest','fewest']:['most','most'],{index:text.indexOf(rankBy![0])}) as unknown as RegExpMatchArray;
 const topN=text.match(/\b(?:top|bottom) (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:which|what|the|show|list|give me|find) (\d+|two|three|four|five|six|seven|eight|nine|ten)\b(?! (?:day|days|week|weeks|month|months|year|years)\b)/);
 const n=topN?Number(topN[1]||topN[2])||NUMBER_WORDS.indexOf(topN[1]||topN[2])+1:1;
 const aggWord=text.match(/\b(average|avg|mean|total|sum of|maximum|max|minimum|min|largest|biggest|highest|longest|smallest|lowest|shortest)\b(?! number)/)?.[1];
 const agg=!aggWord?'count':/average|avg|mean/.test(aggWord)?'avg':/total|sum/.test(aggWord)?'sum':/max|largest|biggest|highest|longest/.test(aggWord)?'max':'min';
 // A bare noun phrase about a table ("failed backups in London", "backups started in the last 7 days") is a count.
 // Every word before the subject must be a qualifier the grounding explains ("failed backups", "open critical vulns"),
 // so imperatives like "truncate backups" or "update all servers" never count as noun phrases.
 const lead=tableMentions.length?text.slice(0,pos(tableMentions[0])).trim():'x';
 const explainedWords=new Set(g.mentions.filter(m=>m.kind!=='table').flatMap(m=>norm(m.text).split(' ')));
 const nounPhrase=!/\b(what|which|who|list|show|display|give|get|find|tell)\b/.test(text)&&(lead===''||lead.split(' ').every(w=>explainedWords.has(w)||['the','our','my','all','any'].includes(w)));
 // "SLA breaches in the Americas estate": a leading yes/no flag is the thing being counted.
 const flagLead=g.mentions.find(m=>m.kind==='column'&&m.confidence>=0.9&&pos(m)>=0&&pos(m)<=text.split(' ').slice(0,2).join(' ').length&&catalog.table(m.table).columns.find(c=>c.name===m.column)?.type==='BOOLEAN'&&!/\b(what|which|who|list|show)\b/.test(text));
 const counting=agg==='count'&&(Boolean(flagLead)||(/\b(more|fewer|less)\b/.test(text)&&/\b(or|than|versus|vs)\b/.test(text))||/\b(how many|number of|count|counts|tally)\b/.test(text)||superlative||/\b(per|by|each|every|breakdown|break down)\b/.test(text)||nounPhrase);
 if(agg==='count'&&!counting)return no(76);
 // Numeric conditions ("more than 100 cpu cores"); every number in the question must be explained.
 const nums=numericConditions(g,catalog);
 if(unexplainedNumbers(g,nums.map(x=>x.text)).length)return no(79);
 const condCols=new Set(nums.map(x=>x.table+'.'+x.column));
 // "how many different CVEs": a distinct count of the named column.
 const distinctWord=text.match(/\b(different|distinct|unique)\s+/);
 // "different CVEs": the word after distinct may also be a table synonym; a same-named column wins.
 const afterDistinct=distinctWord?text.slice(text.indexOf(distinctWord[0])+distinctWord[0].length).split(' ')[0].replace(/s$/,''):'';
 const namedCol=afterDistinct?g.tables.map(t=>catalog.table(t)).flatMap(t=>t.columns.filter(c=>c.name===afterDistinct).map(c=>({kind:'column' as const,table:t.name,column:c.name,text:afterDistinct,confidence:1,via:'exact' as const}))).at(0):undefined;
 // "distinct servers had incidents": distinct parent keys seen in the other (child) table named.
 const entity=afterDistinct&&!namedCol?tableMentions.find(m=>norm(m.text).split(' ')[0].replace(/s$/,'')===afterDistinct):undefined;
 const entityTable=entity?catalog.table(entity.table):undefined;
 const childOf=entityTable?.primaryKey?[...new Set(tableMentions.map(m=>m.table))].filter(t=>t!==entityTable.name).map(t=>catalog.table(t)).filter(t=>t.relationships.includes(`${t.name}.${entityTable.primaryKey} = ${entityTable.name}.${entityTable.primaryKey}`)):[];
 const entityKey=childOf.length===1?{kind:'column' as const,table:childOf[0].name,column:entityTable!.primaryKey!,text:afterDistinct,confidence:1,via:'exact' as const}:undefined;
 const distinctCol=namedCol||entityKey||(distinctWord?g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.6&&pos(m)>=text.indexOf(distinctWord[0])&&pos(m)<=text.indexOf(distinctWord[0])+distinctWord[0].length+2).sort((a,b)=>b.confidence-a.confidence)[0]:undefined);
 if(distinctWord&&!distinctCol)return no(87);
 // Numeric measure: prefer a column of a table the user named ("disk size of any server" -> servers.disk_gb).
 const named=new Set(tableMentions.map(m=>m.table));
 const numericMention=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.6&&!condCols.has(m.table+'.'+m.column)&&NUMERIC.test(catalog.table(m.table).columns.find(c=>c.name===m.column)?.type||'')).sort((a,b)=>Number(named.has(b.table))-Number(named.has(a.table))||b.confidence-a.confidence)[0];
 if(agg!=='count'&&!numericMention)return no(91);
 if(agg==='sum'&&/\btotal (number|count)\b/.test(text))return no(92);

 // 2. Measured table and label (grouping)
 const trigger=Math.max(text.search(/\b(how many|number of|count|most|fewest|least|average|avg|mean|total|sum of|maximum|max|minimum|min)\b/),0);
 // "incident count by ...": the table word right before "count" is what is counted.
 const countedBefore=/\bcounts?\b/.test(text.slice(trigger,trigger+6))?tableMentions.find(m=>pos(m)>=0&&pos(m)+norm(m.text).length+1===trigger):undefined;
 let measured=(agg!=='count'?catalog.table(numericMention!.table):undefined)||(flagLead?catalog.table(flagLead.table):undefined)||catalog.table((countedBefore||tableMentions.find(m=>pos(m)>=trigger)||tableMentions[0]).table);
 let label:{table:Table;column:string}|undefined;
 let byMatch=rankTable?null:text.match(/\b(?:by|per|each|every|for each|across)\s+(?:the\s+)?([a-z0-9 ]+)/);
 // "average memory per server": per-row normalisation of the measured table, not a grouping.
 // "per server in Production" normalises; "by upgrade status" names an attribute right after the table word.
 if(byMatch){const bm=byMatch;const self=tableMentions.find(m=>m.table===measured.name&&norm(bm[1]).startsWith(norm(m.text)));
  if(self){const next=norm(bm[1]).slice(norm(self.text).length).trim().split(' ')[0]||'';
   if(!g.mentions.some(c=>c.kind==='column'&&c.table===measured.name&&!/_id$/.test(c.column!)&&next&&norm(c.text).split(' ')[0]===next))byMatch=null;}}
 if(byMatch){
  const after=text.indexOf(byMatch[0])+byMatch[0].length-byMatch[1].length;
  // Prefer a real attribute over an id column ("by server operating system" -> os, not server_id).
  // Only columns of tables in scope; the measured table's own columns first.
  const afterCols=g.mentions.filter(m=>m.kind==='column'&&pos(m)>=after&&m.confidence>=0.6&&(g.tables.includes(m.table)||m.table===measured.name||tableMentions.some(t=>t.table===m.table))).sort((a,b)=>Number(b.table===measured.name)-Number(a.table===measured.name));
  const pool=afterCols.some(m=>!/_id$/.test(m.column!))?afterCols.filter(m=>!/_id$/.test(m.column!)):afterCols;
  const col=pool.sort((a,b)=>Number(b.table===measured.name)-Number(a.table===measured.name)||pos(a)-pos(b)||b.confidence-a.confidence)[0];
  const tab=tableMentions.find(m=>pos(m)>=after);
  // "by the application business unit": a column of the table named right after "by" wins.
  const tabCol=tab?pool.find(m=>m.table===tab.table&&pos(m)>pos(tab)):undefined;
  if(tabCol){const t=catalog.table(tabCol.table);label={table:t,column:tabCol.column!};}
  // "by server operating system": a column of the named table is the grouping, not the table itself.
  else
  if(col&&(!tab||pos(col)<=pos(tab)||(col.table===tab.table&&!/_id$/.test(col.column!)))){const t=catalog.table(col.table);const c=t.columns.find(x=>x.name===col.column)!;if(c.name===t.primaryKey||/_id$/.test(c.name)){const owner=catalog.tables.find(x=>x.primaryKey===c.name);if(owner)label={table:owner,column:labelColumn(owner)!};}else label={table:t,column:c.name};}
  else if(tab&&tab.table!==measured.name){const t=catalog.table(tab.table);label={table:t,column:labelColumn(t)!};}
  if(!label)return no(119);
 }else if(rankTable&&superlative){
  if(rankColumn){label={table:catalog.table(rankColumn.table),column:rankColumn.column!};measured=catalog.table(rankTable.table);}
  else{const t=catalog.table(tableMentions[0].table);label={table:t,column:labelColumn(t)!};measured=catalog.table(rankTable.table);}
 }else if(superlative){
  const head=text.slice(0,text.indexOf(superlative[0]));
  const tab=tableMentions.find(m=>pos(m)<head.length&&m.table!==measured.name);
  const col=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.6&&pos(m)>=0&&pos(m)<head.length&&catalog.table(m.table).columns.find(c=>c.name===m.column)?.type==='VARCHAR'&&!/_id$/.test(m.column!)).sort((a,b)=>b.confidence-a.confidence)[0];
  if(tab){const t=catalog.table(tab.table);label={table:t,column:labelColumn(t)!};}
  else if(col)label={table:catalog.table(col.table),column:col.column!};
  else return no(129);
  // "which applications have the most vulnerabilities": the measured table follows the superlative.
  const after=tableMentions.find(m=>pos(m)>text.indexOf(superlative[0]));if(after)measured=catalog.table(after.table);
 }
 if(label&&!label.column)return no(133);

 // 3. Filters: one column per user phrase, preferring tables already on the path.
 const pathSeed=[measured.name,...(label?[label.table.name]:[])];
 const values=g.mentions.filter(m=>m.kind==='value'&&m.confidence>=0.85&&!(label&&m.table===label.table.name&&m.column===label.column));
 const byText=new Map<string,Mention[]>();for(const m of values){byText.set(m.text,[...(byText.get(m.text)||[]),m]);}
 const filters:Mention[]=[];
 for(const [,list] of byText){
  const onPath=list.filter(m=>pathSeed.includes(m.table));
  const pick=(onPath.length?onPath:list).sort((a,b)=>b.confidence-a.confidence||a.column!.length-b.column!.length);
  if(onPath.length>1&&new Set(onPath.map(m=>m.column)).size>1&&pick[0].confidence===pick[1].confidence&&pick[0].column!.length===pick[1].column!.length)return no(143);
  filters.push(pick[0]);
 }
 // Comparisons ("production versus test servers", "P1 compared to P4"): two values of one column become a
 // grouping on that column restricted to the compared values — one query, both answers side by side.
 const inFilters:{table:string;column:string;values:string[]}[]=[];
 if(/\b(versus|vs|compared to|compare|comparison|or|and|against|difference)\b/.test(text)){
  const byCol=new Map<string,Mention[]>();for(const f of filters){const k=f.table+'.'+f.column;byCol.set(k,[...(byCol.get(k)||[]),f]);}
  for(const [,fs] of byCol){
   const vals=[...new Set(fs.filter(f=>!f.negated).map(f=>String(f.value)))];if(vals.length<2)continue;
   if(label&&!(label.table.name===fs[0].table&&label.column===fs[0].column))return no(153);
   label={table:catalog.table(fs[0].table),column:fs[0].column!};
   inFilters.push({table:fs[0].table,column:fs[0].column!,values:vals});
   for(const f of fs)filters.splice(filters.indexOf(f),1);
  }
 }
 // "X or Y" is only understood as a comparison of two values of one column.
 if(/\b(or|either)\b/.test(text)&&!inFilters.length)return no(160);
 // A yes/no field that is the grouping ("servers by virtualized") is a label, not a filter.
 const booleans=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.9&&catalog.table(m.table).columns.find(c=>c.name===m.column)?.type==='BOOLEAN'&&!(label&&label.table.name===m.table&&label.column===m.column));
 // Every strong column mention must be used; otherwise the question asks for something else.
 const presenceWords=new Set(g.mentions.filter(m=>m.kind==='column'&&new RegExp('\\b(have|has|with|without|missing|no|having)\\s+(?:an?\\s+|the\\s+|any\\s+)?'+norm(m.text).split(' ')[0]).test(text)).map(m=>m.table+'.'+m.column));
 const used=new Set([...presenceWords,...condCols,...(distinctCol?[distinctCol.table+'.'+distinctCol.column]:[]),...(numericMention?[numericMention.table+'.'+numericMention.column]:[]),...(label?[label.table.name+'.'+label.column]:[]),...booleans.map(m=>m.table+'.'+m.column)]);
 for(const m of g.mentions.filter(m=>m.kind==='column'&&m.confidence>=1&&g.tables.includes(m.table)&&!g.mentions.some(o=>o!==m&&o.kind==='column'&&o.text===m.text&&o.table!==m.table)))if(!used.has(m.table+'.'+m.column)&&!filters.some(f=>f.table===m.table&&f.column===m.column)&&!/_id$/.test(m.column!)&&!tableMentions.some(t=>t.text===m.text))return no(165);
 for(const t of tableMentions)if(![measured.name,label?.table.name,...inFilters.map(f=>f.table),...filters.map(f=>f.table),...booleans.map(b=>b.table),...nums.map(x=>x.table),...(distinctCol?[distinctCol.table]:[])].includes(t.table))return no(166);

 let timeFilter='';
 // 4. Join path
 const names=catalog.connect([measured.name,...(label?[label.table.name]:[]),...inFilters.map(f=>f.table),...filters.map(f=>f.table),...booleans.map(b=>b.table),...nums.map(x=>x.table),...(distinctCol?[distinctCol.table]:[])]);
 const edges=catalog.tables.flatMap(t=>t.relationships).map(r=>r.split(' = ').map(x=>x.split('.')));
 const joined=[measured.name];const clauses:string[]=[];let fanout=false;
 for(let guard=0;joined.length<names.length&&guard<20;guard++)for(const t of names){
  if(joined.includes(t))continue;
  const link=edges.find(([[a],[b]])=>(a===t&&joined.includes(b))||(b===t&&joined.includes(a)));if(!link)continue;
  const [[a,key],[b]]=link;const other=a===t?b:a;
  clauses.push(`JOIN ${q(t)} ON ${q(other)}.${q(key)} = ${q(t)}.${q(key)}`);joined.push(t);
 }
 if(joined.length<names.length)return no(179);
// Joining a child table (many rows per measured row) multiplies counts.
 if(names.some(t=>t!==measured.name&&catalog.table(t).relationships.some(r=>r.startsWith(t+'.')&&r.endsWith(' = '+measured.name+'.'+measured.primaryKey))))fanout=true;

 // 5. SQL
 const measureSql=distinctCol&&agg==='count'?`count(DISTINCT ${q(distinctCol.table)}.${q(distinctCol.column!)})`:agg==='count'?(fanout&&measured.primaryKey?`count(DISTINCT ${q(measured.name)}.${q(measured.primaryKey)})`:'count(*)'):`${agg}(${q(numericMention!.table)}.${q(numericMention!.column!)})`;
 const alias=distinctCol&&agg==='count'?`distinct_${distinctCol.column}_count`:agg==='count'?`${measured.name}_count`:`${agg}_${numericMention!.column}`;
 // "overdue" / "past due": a due-style date before the reference date.
 if(/\b(overdue|past due|past their due date)\b/.test(text)){
  const due=measured.columns.find(c=>/DATE|TIME/.test(c.type)&&/(^|_)(due|deadline|target)(_|$)/.test(c.name));
  if(!due||!catalog.referenceDate)return null;
  timeFilter=`${q(measured.name)}.${q(due.name)} < DATE '${catalog.referenceDate}'`;
 }
 if(periodMatch&&!windowMatch){
  const dateCol=g.mentions.filter(m=>m.kind==='column'&&m.table===measured.name&&/DATE|TIME/.test(measured.columns.find(c=>c.name===m.column)?.type||'')).sort((a,b)=>b.confidence-a.confidence)[0];
  const dateName=dateCol?.column||eventDateColumn(measured);
  if(!dateName||!catalog.referenceDate)return null;
  const ref=`DATE '${catalog.referenceDate}'`;const col=`${q(measured.name)}.${q(dateName)}`;
  if(periodMatch[3])timeFilter=periodMatch[3]==='today'?`${col} >= ${ref} AND ${col} < ${ref} + INTERVAL 1 DAY`:`${col} >= ${ref} - INTERVAL 1 DAY AND ${col} < ${ref}`;
  else{const unit=periodMatch[2];const back=/last|previous/.test(periodMatch[1]);const start=`date_trunc('${unit}', ${ref})${back?` - INTERVAL 1 ${unit.toUpperCase()}`:''}`;timeFilter=`${col} >= ${start} AND ${col} < ${start} + INTERVAL 1 ${unit.toUpperCase()}`;}
 }
 if(windowMatch){
  // The window words themselves ("last 7 days") must not pick a column like last_backup.
  // A date column named by the user's other words ("patched" -> last_patch_date), else the event date.
  const qWords=text.split(' ');
  const dateCols=measured.columns.filter(c=>/DATE|TIME/.test(c.type));
  const tableWords=new Set(g.mentions.filter(m=>m.kind==='table').flatMap(m=>norm(m.text).split(' ').map(w=>w.replace(/s$/,''))));
  const named=dateCols.find(c=>c.name.split('_').filter(w=>!/^(last|past|date|at|time)$/.test(w)&&!tableWords.has(w)).some(w=>w.length>=4&&qWords.some(x=>x.startsWith(w))));
  const dateName=named?.name||eventDateColumn(measured);
  if(!dateName||!catalog.referenceDate)return no(208);
  const k=Number(windowMatch[1])||({seven:7,thirty:30,ninety:90,fourteen:14} as Record<string,number>)[windowMatch[1]];
  // "not patched in the last 90 days" inverts the window.
  const negatedWindow=/\b(not|never|haven't|hasn't|wasn't|weren't|no)\b/.test(text.slice(0,text.indexOf(windowMatch[0])));
  timeFilter=`${q(measured.name)}.${q(dateName)} ${negatedWindow?'<':'>='} DATE '${catalog.referenceDate}' - INTERVAL ${/week/.test(windowMatch[2])?k*7:k} DAY`;
 }
 // "have a resolved date", "with an error code" -> IS NOT NULL; "without a blocker reason" -> IS NULL.
 const presence=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.8&&m.table===measured.name&&catalog.table(m.table).columns.find(c=>c.name===m.column)!.profile!.nullCount>0&&!/BOOLEAN/.test(catalog.table(m.table).columns.find(c=>c.name===m.column)!.type)&&new RegExp('\\b(have|has|with|without|missing|no|having|lack|lacking)\\s+(?:an?\\s+|the\\s+|any\\s+)?'+norm(m.text).split(' ')[0]).test(text)&&!condCols.has(m.table+'.'+m.column));
 // "<column> <token>" with a token that is not a stored value ("priority P9"): keep it as a filter so the
 // honest answer is zero rather than silently ignoring the condition.
 const typed=g.question.split(/\s+/).map(w=>w.replace(/[^A-Za-z0-9_-]/g,''));
 const literalFilters:string[]=[];
 for(const m of g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.9&&m.table===measured.name)){
  const col=catalog.table(m.table).columns.find(c=>c.name===m.column)!;if(!col.values.length)continue;
  const last=norm(m.text).split(' ').at(-1)!;const i=typed.findIndex(w=>w.toLowerCase()===last||w.toLowerCase()===last+'s');const next=typed[i+1];
  if(i>=0&&next&&/\d/.test(next)&&!col.values.includes(next)&&!g.mentions.some(x=>x.kind==='value'&&x.text.toLowerCase()===next.toLowerCase()))literalFilters.push(`${q(m.table)}.${q(m.column!)} = ${sqlLiteral(next.toUpperCase()===next||/\d/.test(next)?next.toUpperCase():next)}`);
 }
 const where=[...inFilters.map(f=>`${q(f.table)}.${q(f.column)} IN (${f.values.map(sqlLiteral).join(', ')})`),...literalFilters,...unNull.filter(u=>u.table===measured.name).map(u=>`${q(u.table)}.${q(u.column)} IS NULL`),...(timeFilter?[timeFilter]:[]),...nums.map(x=>`${q(x.table)}.${q(x.column)} ${x.op} ${x.value}`),...filters.map(f=>`${q(f.table)}.${q(f.column!)} ${f.negated?'<>':'='} ${sqlLiteral(f.value)}`),...booleans.map(b=>`${b.negated?'NOT ':''}${q(b.table)}.${q(b.column!)}`),
  ...presence.map(p=>`${q(p.table)}.${q(p.column!)} IS ${new RegExp('\\b(without|missing|no|lack|lacking)\\s+(?:an?\\s+|the\\s+|any\\s+)?'+norm(p.text).split(' ')[0]).test(text)||p.negated?'':'NOT '}NULL`)];
 const labelSql=label?`${q(label.table.name)}.${q(label.column)}`:'';
 const order=superlative?`ORDER BY ${alias} ${/fewest|least|lowest/.test(superlative[0])?'ASC':'DESC'}, ${labelSql} LIMIT ${n}`:label?`ORDER BY ${alias} DESC, ${labelSql}`:'';
 const sql=`SELECT ${label?labelSql+', ':''}${measureSql} AS ${q(alias)} FROM ${q(measured.name)} ${clauses.join(' ')}${where.length?' WHERE '+where.join(' AND '):''}${label?' GROUP BY '+labelSql:''} ${order}`.replace(/\s+/g,' ').trim();
 const explain=`${agg} of ${measured.name}${label?` by ${label.table.name}.${label.column}`:''}${where.length?' where '+where.join(' and '):''}`;
 if(filters.some(f=>isCommonWord(f.text)&&f.confidence<1))return no(231);
 return {sql,explain};
}

// "How many servers had their most recent backup fail?" / "which servers' latest incident is P1":
// rank each parent's child rows by the event date and test only the newest one.
function latestPerEntity(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 const m=text.match(/\b(latest|most recent|newest|last|current)\s+(?:\w+\s+){0,2}?/);if(!m)return undefined;
 const tables=[...new Set(g.mentions.filter(x=>x.kind==='table').map(x=>x.table))].map(n=>catalog.table(n));
 if(tables.length!==2)return undefined;
 const [a,b]=tables;
 const refs=(c:Table,p:Table)=>Boolean(p.primaryKey)&&c.relationships.includes(`${c.name}.${p.primaryKey} = ${p.name}.${p.primaryKey}`);
 const parent=refs(a,b)?b:refs(b,a)?a:undefined;if(!parent)return undefined;
 const child=parent===a?b:a;
 // The recency word must qualify the child ("their most recent backup"), not the parent.
 const childMention=g.mentions.find(x=>x.kind==='table'&&x.table===child.name)!;
 const at=text.indexOf(m[0]);const childPos=text.indexOf(norm(childMention.text),at);
 if(childPos<0||childPos-at>m[0].length+12)return undefined;
 const date=eventDateColumn(child);if(!date||!child.primaryKey)return no(249);
 const values=g.mentions.filter(x=>x.kind==='value'&&x.confidence>=0.85);
 if(values.some(v=>v.table!==child.name))return no(251);
 const booleans=g.mentions.filter(x=>x.kind==='column'&&x.confidence>=0.9&&x.table===child.name&&child.columns.find(c=>c.name===x.column)?.type==='BOOLEAN');
 const cond=[...values.map(v=>`${q(v.column!)} = ${sqlLiteral(v.value)}`),...booleans.map(b=>q(b.column!))];
 const key=q(parent.primaryKey!);
 const listing=/\b(which|list|show|what are)\b/.test(text)&&!/\b(how many|number of|count)\b/.test(text);
 const label=labelColumn(parent);
 const ranked=`WITH ranked AS (SELECT *, row_number() OVER (PARTITION BY ${key} ORDER BY ${q(date)} DESC, ${q(child.primaryKey)} DESC) AS rn FROM ${q(child.name)})`;
 const filter=`rn = 1${cond.length?' AND '+cond.join(' AND '):''}`;
 const sql=listing&&label&&label!==parent.primaryKey
  ?`${ranked} SELECT p.${key}, p.${q(label)} FROM ranked r JOIN ${q(parent.name)} p ON p.${key} = r.${key} WHERE ${filter.replace(/(^|AND )(?!rn)/g,'$1r.')} ORDER BY p.${key}`
  :`${ranked} SELECT count(*) AS ${q(parent.name+'_count')} FROM ranked r JOIN ${q(parent.name)} p ON p.${key} = r.${key} WHERE ${filter.replace(/(^|AND )(?!rn)/g,'$1r.')}`;
 return {sql,explain:`${parent.name} whose latest ${child.name} (by ${date})${cond.length?' has '+cond.join(' and '):''}`};
}

// Entities defined by related rows: "servers with both an open critical vulnerability and a P1 incident",
// "open vulnerabilities but no incidents", "servers that never had a failed backup".
function existencePattern(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 const neg=/\b(no|never|without|not have|don't have|do not have|zero)\b/;
 const named=[...new Set(g.mentions.filter(m=>m.kind==='table').map(m=>m.table))].map(n=>catalog.table(n));
 const refs=(c:Table,p:Table)=>Boolean(p.primaryKey)&&c.relationships.includes(`${c.name}.${p.primaryKey} = ${p.name}.${p.primaryKey}`);
 let parent=named.find(p=>named.some(c=>c!==p&&refs(c,p)));
 if(!parent){const common=catalog.tables.filter(p=>named.length>=2&&named.every(c=>refs(c,p)));if(common.length===1)parent=common[0];}
 if(!parent)return undefined;
 const children=named.filter(c=>c!==parent);
 if(!children.length||!children.every(c=>refs(c,parent!)))return undefined;
 const negated=(c:Table)=>{const m=g.mentions.find(x=>x.kind==='table'&&x.table===c.name)!;const i=text.indexOf(norm(m.text));const before=text.slice(Math.max(0,i-28),i);return neg.test(before);};
 if(children.length<2&&!children.some(negated))return undefined;
 const parentFirst=text.indexOf(norm(g.mentions.find(x=>x.kind==='table'&&x.table===parent!.name)?.text||'@@'))<=8;
 if(!/\b(how many|number of|count)\b/.test(text)&&!(parentFirst&&!/\b(which|list|show|what)\b/.test(text)))return null;
 if(g.unknownTerms.length||g.mentions.some(m=>m.kind==='value'&&m.confidence<0.85))return null;
 if(/\b(day|days|week|month|year|recent|last|since|ago|latest|or|either)\b/.test(text))return null;
 // Each value phrase describes the noun that follows it ("open critical vulnerability", "P1 incident").
 const tablePos=g.mentions.filter(x=>x.kind==='table').map(x=>({table:x.table,at:text.indexOf(norm(x.text))}));
 const owner=(m:Mention)=>{const at=text.indexOf(norm(m.text));const cands=tablePos.filter(t=>catalog.table(t.table).columns.some(c=>c.name===m.column)&&g.mentions.some(o=>o.kind==='value'&&o.text===m.text&&o.table===t.table));
  const after=cands.filter(t=>t.at>=at).sort((a,b)=>a.at-b.at)[0];return (after||cands.sort((a,b)=>b.at-a.at)[0])?.table||m.table;};
 const conds=(t:Table,alias:string)=>[...g.mentions.filter(m=>m.kind==='value'&&m.table===t.name&&m.confidence>=0.85&&owner(m)===t.name).map(m=>`${alias}.${q(m.column!)} = ${sqlLiteral(m.value)}`),
  ...g.mentions.filter(m=>m.kind==='column'&&m.table===t.name&&m.confidence>=0.9&&t.columns.find(c=>c.name===m.column)?.type==='BOOLEAN').map(m=>`${alias}.${q(m.column!)}`)];
 // Values must belong to the parent or a child; anything else is not understood.
 if(g.mentions.some(m=>m.kind==='value'&&m.table!==parent!.name&&!children.some(c=>c.name===m.table)))return null;
 const key=q(parent.primaryKey!);
 const clauses=[...conds(parent,'p'),...children.map((c,i)=>`${negated(c)?'NOT ':''}EXISTS (SELECT 1 FROM ${q(c.name)} c${i} WHERE c${i}.${key} = p.${key}${conds(c,'c'+i).map(x=>' AND '+x).join('')})`.replace(/c\.(?=")/g,`c${i}.`))];
 const sql=`SELECT count(*) AS ${q(parent.name+'_count')} FROM ${q(parent.name)} p WHERE ${clauses.join(' AND ')}`;
 const describe=(t:Table)=>conds(t,'x').map(x=>x.replace(/^x\./,'').replace(/"/g,'')).join(' and ');
 return {sql,explain:`${parent.name}${conds(parent,'p').length?' where '+describe(parent):''} ${children.map(c=>`${negated(c)?'with no':'with at least one'} ${c.name}${describe(c)?' where '+describe(c):''}`).join(' and ')}`};
}

// "when was the oldest open incident created", "most recent backup date", "when did SRV-00003 last have an incident".
function dateExtreme(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 if(!/\b(when|date|what time|what day)\b/.test(text)||/\b(how many|number of|count|per|by|each)\b/.test(text))return undefined;
 const dir=/\b(oldest|earliest|first)\b/.test(text)?'min':/\b(newest|latest|most recent|last|recent)\b/.test(text)?'max':undefined;if(!dir)return undefined;
 const tables=[...new Set(g.mentions.filter(m=>m.kind==='table').map(m=>m.table))];
 const vals=g.mentions.filter(m=>m.kind==='value'&&m.confidence>=0.85);
 // The dated table: the one mentioned (or the one holding every filter), not a parent like servers.
 const candidates=tables.map(t=>catalog.table(t)).filter(t=>eventDateColumn(t));
 const measured=candidates.find(t=>vals.every(v=>v.table===t.name||t.columns.some(c=>c.name===v.column)))||candidates[0];
 if(!measured)return null;
 if(g.unknownTerms.length)return null;
 const dateMention=g.mentions.find(m=>m.kind==='column'&&m.table===measured.name&&/DATE|TIME/.test(measured.columns.find(c=>c.name===m.column)?.type||'')&&!/\b(last|first)\b/.test(norm(m.text)));
 const date=dateMention?.column||eventDateColumn(measured)!;
 const filters=vals.map(v=>measured.columns.some(c=>c.name===v.column)?`${q(v.column!)} = ${sqlLiteral(v.value)}`:'').filter(Boolean);
 if(filters.length!==vals.length)return null;
 const sql=`SELECT ${dir}(${q(date)}) AS ${q(dir==='min'?'earliest_'+date:'latest_'+date)} FROM ${q(measured.name)}${filters.length?' WHERE '+filters.join(' AND '):''}`;
 return {sql,explain:`${dir==='min'?'earliest':'latest'} ${measured.name}.${date}`};
}
// "incidents per month for the last 3 months", "monthly vulnerability trend".
function periodTrend(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 // "monthly vulnerabilities" too, unless the word is a stored value ("monthly patch schedule").
 const adverb=text.match(/\b(daily|weekly|monthly|quarterly|yearly)\b/);
 const adverbIsValue=adverb&&g.mentions.some(x=>x.kind==='value'&&norm(x.text).split(' ').includes(adverb[1]));
 const m=text.match(/\b(?:per|by|each|every) (day|week|month|quarter|year)\b|\b(daily|weekly|monthly|quarterly|yearly) (?:trend|count|counts|breakdown)\b/)||(adverb&&!adverbIsValue&&g.mentions.some(x=>x.kind==='table')?Object.assign([adverb[0],undefined,adverb[1]],{index:adverb.index}) as RegExpMatchArray:null);if(!m)return undefined;
 const unit=m[1]||{daily:'day',weekly:'week',monthly:'month',quarterly:'quarter',yearly:'year'}[m[2] as 'daily'];
 const tables=[...new Set(g.mentions.filter(x=>x.kind==='table').map(x=>x.table))];if(tables.length!==1)return null;
 const t=catalog.table(tables[0]);const date=eventDateColumn(t);if(!date||!catalog.referenceDate||g.unknownTerms.length)return null;
 const vals=g.mentions.filter(x=>x.kind==='value'&&x.confidence>=0.85);if(vals.some(v=>v.table!==t.name))return null;
 const last=text.match(/\b(?:last|past) (\d+|two|three|four|five|six|twelve) (day|days|week|weeks|month|months|quarter|quarters|year|years)\b/);
 const words:Record<string,number>={two:2,three:3,four:4,five:5,six:6,twelve:12};
 const where=[...vals.map(v=>`${q(v.column!)} = ${sqlLiteral(v.value)}`)];
 // Yes/no flags named in the question ("major incidents per month") filter the counted rows.
 const fieldMentions=g.mentions.filter(x=>x.kind==='column'&&x.confidence>=0.6&&x.table===t.name&&x.column!==date&&!/_id$/.test(x.column!));
 // "incidents per month by priority": one category splits the trend into one series per value.
 let split:string|undefined;
 for(const f of fieldMentions){
  const type=t.columns.find(c=>c.name===f.column)?.type||'';
  if(type!=='BOOLEAN'){
   const asSplit=f.confidence>=0.9&&type==='VARCHAR'&&new RegExp('\\b(?:by|per|split by|broken down by|for each)\\s+(?:the\\s+)?'+norm(f.text)+'\\b').test(text)&&!vals.some(v=>v.column===f.column);
   if(asSplit&&!split){split=f.column!;continue;}
   if(f.confidence>=0.9)return null;continue;
  }
  where.push(f.negated?`NOT ${q(f.column!)}`:q(f.column!));
 }
 if(last){const k=Number(last[1])||words[last[1]];const u=last[2].replace(/s$/,'');where.push(`${q(date)} >= date_trunc('${u}', DATE '${catalog.referenceDate}') - INTERVAL ${k-1} ${u.toUpperCase()}`);}
 const sql=`SELECT date_trunc('${unit}', ${q(date)})::DATE AS ${q(unit+'_start')}, ${split?q(split)+', ':''}count(*) AS ${q(t.name+'_count')} FROM ${q(t.name)}${where.length?' WHERE '+where.join(' AND '):''} GROUP BY ${split?'1, 2':'1'} ORDER BY ${split?'1, 2':'1'}`;
 return {sql,explain:`${t.name} per ${unit}${split?' by '+split:''}`};
}

// "What OS does host-00042 run and which application is it on?": attributes of one identified record,
// plus the label of each parent record it references. Child tables (many rows) are left to the model.
function recordLookup(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 if(!/^(what|which|who|where|show|tell|give|get|find|list)\b/.test(text))return undefined;
 if(/\b(how many|count|number of|average|avg|mean|total|sum|max|min|most|fewest|least|per|each|every|latest|last|first|recent|when)\b/.test(text))return undefined;
 const ids=g.mentions.filter(m=>m.kind==='value'&&m.confidence>=1&&(m.via==='lookup'||catalog.table(m.table).primaryKey===m.column||labelColumn(catalog.table(m.table))===m.column));
 if(ids.length!==1||g.mentions.some(m=>m.kind==='value'&&m!==ids[0]))return undefined;
 const id=ids[0],base=catalog.table(id.table);
 const refs=(c:Table,p:Table)=>Boolean(p.primaryKey)&&c.relationships.includes(`${c.name}.${p.primaryKey} = ${p.name}.${p.primaryKey}`);
 const parents:Table[]=[];
 for(const m of g.mentions.filter(m=>m.kind==='table'&&m.table!==base.name)){
  const t=catalog.table(m.table);if(!refs(base,t))return undefined;if(!parents.includes(t))parents.push(t);
 }
 const cols:{table:Table;column:string}[]=[];
 // "upgrade status" ~ evergreen_status: a partial column match counts when the question names its last part.
 const qWords=new Set(text.split(' '));
 for(const m of g.mentions.filter(m=>m.kind==='column'&&(m.confidence>=0.9||m.confidence>=0.8&&qWords.has(m.column!.split('_').at(-1)!)))){
  const t=catalog.table(m.table);if(t!==base&&!parents.includes(t))continue;
  if(m.column===id.column||/_id$/.test(m.column!)||cols.some(c=>c.table===t&&c.column===m.column))continue;cols.push({table:t,column:m.column!});
 }
 for(const p of parents){const label=labelColumn(p);if(label&&!cols.some(c=>c.table===p&&c.column===label))cols.push({table:p,column:label});}
 if(!cols.length)return undefined;
 const select=[`${q(base.name)}.${q(id.column!)}`,...cols.map(c=>`${q(c.table.name)}.${q(c.column)}`)].join(', ');
 const joins=parents.map(p=>` LEFT JOIN ${q(p.name)} ON ${q(base.name)}.${q(p.primaryKey!)} = ${q(p.name)}.${q(p.primaryKey!)}`).join('');
 return {sql:`SELECT ${select} FROM ${q(base.name)}${joins} WHERE ${q(base.name)}.${q(id.column!)} = ${sqlLiteral(id.value!)} LIMIT 20`,
  explain:`${cols.map(c=>c.column.replace(/_/g,' ')).join(', ')} of ${base.name} where ${id.column} = '${id.value}'`};
}

// "List the first 5 Windows servers by server ID": a filtered, ordered listing of one table.
function firstRows(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 const m=text.match(/^(?:list|show|give me|get|display)\s+(?:me\s+)?(?:the\s+)?(?:first|top)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+?)\s+(?:by|ordered by|sorted by)\s+(.+)$/);
 if(!m)return undefined;
 const n=Number(m[1])||NUMBER_WORDS.indexOf(m[1])+1;
 const tables=[...new Set(g.mentions.filter(x=>x.kind==='table').map(x=>x.table))];if(tables.length!==1)return undefined;
 const t=catalog.table(tables[0]);
 const values=g.mentions.filter(x=>x.kind==='value');
 if(values.some(v=>v.table!==t.name||v.confidence<0.9||v.via==='partial'))return undefined;
 // The ordering phrase must name one column of this table.
 const orderPhrase=m[3].trim().replace(/\s+/g,'_');
 const order=t.columns.find(c=>c.name===orderPhrase||c.name===orderPhrase.replace(/s$/,''))||g.mentions.filter(x=>x.kind==='column'&&x.table===t.name&&x.confidence>=0.9&&norm(x.text)===m[3].trim()).map(x=>t.columns.find(c=>c.name===x.column)).at(0);
 if(!order)return undefined;
 const byCol=new Map<string,string[]>();for(const v of values){const list=byCol.get(v.column!)||[];if(!list.includes(v.value!))list.push(v.value!);byCol.set(v.column!,list);}
 const where=[...byCol].map(([c,vs])=>vs.length===1?`${q(t.name)}.${q(c)} = ${sqlLiteral(vs[0])}`:`${q(t.name)}.${q(c)} IN (${vs.map(sqlLiteral).join(', ')})`);
 const cols=[...new Set([t.primaryKey,...byCol.keys(),order.name].filter(Boolean) as string[])];
 const desc=/\b(desc|descending|newest|latest|highest|largest)\b/.test(text)?' DESC':'';
 return {sql:`SELECT ${cols.map(c=>`${q(t.name)}.${q(c)}`).join(', ')} FROM ${q(t.name)}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY ${q(t.name)}.${q(order.name)}${desc} LIMIT ${n}`,
  explain:`first ${n} ${t.name}${where.length?' where '+[...byCol].map(([c,vs])=>`${c} = '${vs.join("' or '")}'`).join(' and '):''} ordered by ${order.name}`};
}

// "vulnerabilities by severity and status": counts for every combination of two fields of one table.
// Without this the single-label draft would silently drop the second field.
function twoWayBreakdown(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 const m=text.match(/\b(?:by|per|across) (?:the )?(.+?) and (?:by )?(?:the )?(.+?)$/);if(!m)return undefined;
 const tables=[...new Set(g.mentions.filter(x=>x.kind==='table').map(x=>x.table))];
 if(tables.length!==1)return null;
 const t=catalog.table(tables[0]);
 const field=(phrase:string)=>g.mentions.filter(x=>x.kind==='column'&&x.table===t.name&&x.confidence>=0.9&&norm(x.text)===phrase.trim()&&!/_id$/.test(x.column!))[0];
 const a=field(m[1]),b=field(m[2]);
 if(!a||!b||a.column===b.column)return null;
 if(/\b(average|avg|mean|total|sum|max|min|top|most|least|percent|share|last|past|since|not|no|without)\b/.test(text))return null;
 const vals=g.mentions.filter(x=>x.kind==='value'&&x.confidence>=0.9);
 if(vals.some(v=>v.table!==t.name||v.via==='partial'))return null;
 const where=vals.map(v=>`${q(t.name)}.${q(v.column!)} = ${sqlLiteral(v.value)}`);
 const cols=[a.column!,b.column!].map(c=>`${q(t.name)}.${q(c)}`);
 return {sql:`SELECT ${cols.join(', ')}, count(*) AS ${q(t.name+'_count')} FROM ${q(t.name)}${where.length?' WHERE '+where.join(' AND '):''} GROUP BY ${cols.join(', ')} ORDER BY ${cols.join(', ')}`,
  explain:`count of ${t.name} by ${a.column} and ${b.column}${where.length?' where '+vals.map(v=>`${v.column} = '${v.value}'`).join(' and '):''}`};
}

// "which root cause has the longest average downtime", "which os has the highest total disk gb":
// group by one attribute, aggregate one measure of the same table, rank by it.
function rankedAggregate(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 const m=text.match(/^(?:which|what)\s+(.+?)\s+(?:has|have|had|is|shows?)\s+(?:the\s+)?(highest|longest|largest|biggest|greatest|most|lowest|shortest|smallest|least)\s+(average|avg|mean|total|sum of|overall)\s+(.+?)\s*$/);
 if(!m)return undefined;
 const cols=g.mentions.filter(x=>x.kind==='column'&&x.confidence>=0.6);
 const inPhrase=(x:Mention,phrase:string)=>norm(phrase).includes(norm(x.text));
 const group=cols.filter(x=>inPhrase(x,m[1])&&!/_id$/.test(x.column!)&&!NUMERIC.test(catalog.table(x.table).columns.find(c=>c.name===x.column)?.type||''));
 const measure=cols.filter(x=>inPhrase(x,m[4])&&NUMERIC.test(catalog.table(x.table).columns.find(c=>c.name===x.column)?.type||''));
 const pairs=group.flatMap(gc=>measure.filter(mc=>mc.table===gc.table).map(mc=>({gc,mc})));
 const tables=[...new Set(pairs.map(p=>p.gc.table))];
 if(tables.length!==1)return undefined;
 const {gc,mc}=pairs[0];const t=catalog.table(gc.table);
 // Values may filter the same table ("which root cause has the highest average downtime for P1 incidents").
 const values=g.mentions.filter(x=>x.kind==='value'&&x.confidence>=0.9&&x.via!=='partial');
 if(values.some(v=>v.table!==t.name))return undefined;
 if(unexplainedNumbers(g,[]).length)return undefined;
 const agg=/total|sum|overall/.test(m[3])?'sum':'avg';const dir=/lowest|shortest|smallest|least/.test(m[2])?'ASC':'DESC';
 const where=values.length?' WHERE '+values.map(v=>`${q(t.name)}.${q(v.column!)} = ${sqlLiteral(v.value!)}`).join(' AND '):'';
 const alias=`${agg}_${mc.column}`;
 return {sql:`SELECT ${q(t.name)}.${q(gc.column!)}, ${agg}(${q(t.name)}.${q(mc.column!)}) AS ${q(alias)} FROM ${q(t.name)}${where} GROUP BY 1 ORDER BY 2 ${dir} NULLS LAST, 1 LIMIT 1`,
  explain:`${gc.column} with the ${dir==='DESC'?'highest':'lowest'} ${agg} ${mc.column}${values.length?' where '+values.map(v=>`${v.column} = '${v.value}'`).join(' and '):''}`};
}

// "how many upgrades are due in the next 30 days": a due-style date between the reference date and N days/weeks ahead.
function dueWithin(text:string,g:Grounding,catalog:Catalog):{sql:string;explain:string}|null|undefined{
 const m=text.match(/^how many\s+(.+?)\s+(?:are|is)?\s*(?:due|scheduled|planned|expiring|expire)\s+(?:in|within)\s+the\s+next\s+(\d+|seven|fourteen|thirty|ninety)\s+(days?|weeks?)\s*$/);
 if(!m)return undefined;
 const tables=[...new Set(g.mentions.filter(x=>x.kind==='table').map(x=>x.table))];if(tables.length!==1)return undefined;
 const t=catalog.table(tables[0]);
 const dueCols=t.columns.filter(c=>/DATE|TIME/.test(c.type)&&/(^|_)(due|deadline|target|scheduled|planned|expiry|expires)(_|$)/.test(c.name));
 if(dueCols.length!==1||!catalog.referenceDate)return undefined;
 const values=g.mentions.filter(x=>x.kind==='value'&&x.confidence>=0.9&&x.via!=='partial');
 if(values.some(v=>v.table!==t.name)||g.unknownTerms.length)return undefined;
 const words:Record<string,number>={seven:7,fourteen:14,thirty:30,ninety:90};
 const days=(Number(m[2])||words[m[2]])*(/week/.test(m[3])?7:1);
 const col=`${q(t.name)}.${q(dueCols[0].name)}`;const ref=`DATE '${catalog.referenceDate}'`;
 const where=[`${col} >= ${ref}`,`${col} < ${ref} + INTERVAL ${/week/.test(m[3])?`${days/7} WEEK`:`${days} DAY`}`,...values.map(v=>`${q(t.name)}.${q(v.column!)} = ${sqlLiteral(v.value!)}`)];
 return {sql:`SELECT count(*) AS ${q(t.name+'_count')} FROM ${q(t.name)} WHERE ${where.join(' AND ')}`,explain:`${t.name} with ${dueCols[0].name} in the next ${days} days (from ${catalog.referenceDate})`};
}
