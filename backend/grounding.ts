import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';import {resolve} from 'node:path';
// Deterministic grounding: maps the user's words (including typos, synonyms and acronyms) onto
// discovered tables, columns and stored values. Everything is derived from the live catalog plus
// optional semantic hints, so it works for any DuckDB database.
import type {Catalog,Table} from './catalog.js';
import {identifier,sqlLiteral} from './db.js';

export type Mention={text:string;kind:'table'|'column'|'value';table:string;column?:string;value?:string;confidence:number;via:'exact'|'synonym'|'acronym'|'partial'|'fuzzy'|'lookup';negated?:boolean};
export type Grounding={question:string;normalized:string;corrections:{from:string;to:string}[];mentions:Mention[];unknownTerms:string[];tables:string[];definitions:string[];
 // Identifier-shaped names ("host-00010") that look like a column's values but match no stored record.
 missingIdentifiers?:{token:string;table:string;column:string;example:string}[]};

export const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const words=(s:string)=>norm(s).split(' ').filter(Boolean);
const singular=(w:string)=>w.endsWith('ies')?w.slice(0,-3)+'y':w.endsWith('sses')?w.slice(0,-2):w.endsWith('s')&&!w.endsWith('ss')&&w.length>3?w.slice(0,-1):w;

// Common English and question words: never "corrected" into schema vocabulary.
const COMMON=new Set(`a about above across after again against all almost also always am among an and another any anyone anything are area around as ask at available average avg away back bad be because been before being below best better between big both bottom break breakdown broken but by can cannot change compare compared contain contains count counts current currently data database day days did different do does doing done down during each either else empty enough entire entries entry ever every everything exactly exist exists fail failed failing fails few fewer find first for found fraction from full get give given go good greater group grouped had has have having he her here high higher highest him his hit how however i if in include including instead into is it its just keep kind know largest last latest least less let like list little long look lookup lot low lower lowest made make many max maximum may me mean mean median min minimum more most much must my name named names near need never new next no none nor not now number numbers of off often old older oldest on once one ones only or order other our out over overall own part per percent percentage pick please point possible previous rate rather ratio real record records related report result results return right row rows run running same say see select separate set several share she should show showing since single size small smallest so some something sort split sql still such sum summarize summary table tables tell than that the their them then there these they thing things this those though through tally time times to today together top total totals tried type types under unique until up us use used using value values very via want was we week weeks were what whatever when where whether which while who whole whose why will with within without would year years yes yet you your zero month months quarter quarters yesterday tomorrow ago past recent recently latest earliest newest oldest daily weekly monthly yearly whats hows wheres whos overall insight insights stats statistics highlights doing summary summaries summarize summarise overview details detail history histories everything entire complete timeline lifecycle snapshot landscape joke jokes funny riddle laugh bring brief glance picture idea distinct affect affects affecting negative positive nonzero one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand couple few several dozen random sample quarterly annually planning review reviews director manager quarter planned non excluding except without overdue due late patched date dates day days week weeks year years trend trends minute minutes hour hours second seconds gb mb tb kb gib cores core percent points handle handles handled handling manage manages managed managing own owns owned owning use uses used assigned work works working update delete insert create remove change modify rename drop truncate export import restore backup copy move set reset assign close reopen fix restart stop start add make send email write save upload download happened happen happens occurred occur occurs belong belongs belonging located hosted hosting running runs affected affecting impacted associated linked related attached found have having had has fewest fewer least smallest largest highest lowest biggest greatest longest shortest maximum minimum average mean median sum total count counts number numbers percent percentage proportion ratio rate share top bottom rank ranking compare comparison versus vs breakdown distribution overall altogether combined currently still ever never already any anything everything nothing across among between within under over above below whose which what who how many much`.split(/\s+/));
export const isCommonWord=(w:string)=>COMMON.has(norm(w));
export const phraseInText=(haystack:string,needle:string)=>phraseIn(norm(haystack),norm(needle));
const QUESTION_WORDS=new Set(`how many much what which who when where why is are was were do does did have has had there the a an of in on at for to by with and or me show list give tell count number total find get return all each every per our we us my i please can could would should`.split(' '));
const VAGUE=new Set(`wrong broken weird odd strange interesting important problematic concerning unusual everything bad good ones one thing things stuff it them those these that this ok okay fine worst best issues problems problem issue info information details anything something everything`.split(' '));

export function editDistance(a:string,b:string,max=3){
 if(Math.abs(a.length-b.length)>max)return max+1;
 const d:number[][]=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);
 for(let j=1;j<=b.length;j++)d[0][j]=j;
 for(let i=1;i<=a.length;i++){let rowMin=Infinity;for(let j=1;j<=b.length;j++){
  const cost=a[i-1]===b[j-1]?0:1;
  d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+cost);
  if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);
  rowMin=Math.min(rowMin,d[i][j]);}
  if(rowMin>max)return max+1;}
 return d[a.length][b.length];
}
const acronym=(value:string)=>{const parts=value.split(/[^A-Za-z0-9]+/).filter(Boolean);return parts.length>=3?parts.map(p=>p[0]).join('').toLowerCase():'';};
const phraseIn=(haystack:string,needle:string)=>needle.length>0&&(' '+haystack+' ').includes(' '+needle+' ');

type Vocab={word:string;weight:number}[];
const vocabCache=new WeakMap<Catalog,{version:number;vocab:Vocab;set:Set<string>}>();
function vocabulary(catalog:Catalog){
 const hit=vocabCache.get(catalog);if(hit&&hit.version===catalog.version)return hit;
 const weights=new Map<string,number>();const add=(w:string,weight:number)=>{if(w.length>=3)weights.set(w,Math.max(weights.get(w)||0,weight));};
 for(const t of catalog.tables){
  for(const w of words(t.name)){add(w,3);add(singular(w),3);}
  for(const syn of catalog.semantic.tableSynonyms[t.name]||[])for(const w of words(syn))add(w,3);
  for(const c of t.columns){for(const w of words(c.name))add(w,2);for(const v of [...c.values,...c.lookup])if(typeof v==='string'&&v.length<=40)for(const w of words(v))if(!/\d/.test(w))add(w,1);}
 }
 for(const k of Object.keys(catalog.semantic.valueSynonyms))for(const w of words(k))add(w,2);
 const vocab=[...weights].map(([word,weight])=>({word,weight}));
 const entry={version:catalog.version,vocab,set:new Set(weights.keys())};vocabCache.set(catalog,entry);return entry;
}

// English dictionary (Webster's 2nd, public domain; data/english-words.txt.gz) for telling real words from typos.
let english:Set<string>|undefined;
function isEnglishWord(w:string){
 if(!english){try{english=new Set(gunzipSync(readFileSync(resolve('data/english-words.txt.gz'))).toString('utf8').split('\n'));}catch{english=new Set();}}
 const forms=[w,w.replace(/ies$/,'y'),w.replace(/es$/,''),w.replace(/s$/,''),w.replace(/ed$/,''),w.replace(/ed$/,'e'),w.replace(/ing$/,''),w.replace(/ing$/,'e')];
 return forms.some(f=>f.length>=4&&english!.has(f));
}
// Frequent misspellings of question words; schema vocabulary is corrected by edit distance below.
const WORD_TYPOS:Record<string,string>={sever:'server',severs:'servers',bringup:'bring up',abou:'about',summery:'summary',sumary:'summary',summry:'summary',detials:'details',detales:'details',histroy:'history',wich:'which',whcih:'which',whihc:'which',witch:'which',waht:'what',wat:'what',hwo:'how',hw:'how',teh:'the',thier:'their',wiht:'with',wtih:'with',frm:'from',nmber:'number',numbr:'number',cuont:'count',mnay:'many',mny:'many',shwo:'show',lsit:'list',whre:'where',wher:'where',becuase:'because',averge:'average',avrage:'average',totla:'total'};
export function correctTypos(question:string,catalog:Catalog){
 const {vocab,set}=vocabulary(catalog);const corrections:{from:string;to:string}[]=[];
 // "high level" means overall, not severity High.
 question=question.replace(/\bhigh[- ]level\b/gi,'overall');
 const corrected=question.replace(/[A-Za-z]+/g,token=>{
  const w=token.toLowerCase();
  if(WORD_TYPOS[w]&&!set.has(w)){corrections.push({from:token,to:WORD_TYPOS[w]});return WORD_TYPOS[w];}
  if(w.length<4||set.has(w)||set.has(singular(w))||COMMON.has(w)||COMMON.has(singular(w)))return token;
  // Inflections of known words ("opened", "running", "patched") are not typos.
  const stem=w.replace(/(ing|ed|es|s|er|ers|ly|d)$/,'');if(stem.length>=3&&(set.has(stem)||COMMON.has(stem)||set.has(stem+'e')||COMMON.has(stem+'e')))return token;
  const max=w.length<=5?1:2;let best:{word:string;weight:number;d:number}|undefined;
  for(const v of vocab){if(Math.abs(v.word.length-w.length)>max)continue;const d=editDistance(w,v.word,max);if(d<=max&&(!best||d<best.d||d===best.d&&v.weight>best.weight))best={...v,d};}
  if(!best)return token;
  // Different word forms of one root ("operating" vs "operations") are not typos.
  const suffix=(x:string)=>x.match(/(ing|ed|ion|ions|er|ers|ment|ments|ly|ive|al)$/)?.[0];
  if(suffix(w)&&suffix(best.word)&&suffix(w)!==suffix(best.word))return token;
  // A real English word ("details", "sever") is only a typo when it is one edit away from a schema word;
  // "details" is not a misspelling of "retail".
  // Short real words ("dive", "form") are kept even one edit away: too many neighbours to guess safely.
  if((best.d>=2||w.length<=5)&&isEnglishWord(w))return token;
  // "unresolved" is the negation of "resolved", not a typo of it.
  if(/^(un|non|in|im|dis|ir|il)/.test(w)&&w.replace(/^(un|non|in|im|dis|ir|il)-?/,'')===best.word)return token;
  corrections.push({from:token,to:best.word});return best.word;
 });
 return {corrected,corrections};
}

export function definitionsFor(question:string,catalog:Catalog){
 const n=norm(question);
 return catalog.semantic.definitions.filter(d=>d.terms.some(t=>phraseIn(n,norm(t)))).map(d=>d.text);
}

// Synchronous grounding against in-memory catalog metadata.
export function groundSync(question:string,catalog:Catalog):Grounding{
 const {corrected,corrections}=correctTypos(question,catalog);
 const n=norm(corrected);const originalTokens=corrected.split(/[^A-Za-z0-9]+/).filter(Boolean);
 const mentions:Mention[]=[];
 const tables=catalog.tables.filter(t=>!catalog.isReferenceTable(t.name));
 // Tables
 for(const t of tables){
  const names=[t.name,singular(t.name),t.name.replaceAll('_',' '),...(catalog.semantic.tableSynonyms[t.name]||[])].map(norm);
  // Longest synonym first, plural forms included ("os upgrades" ~ "os upgrade").
  const variants=[...new Set(names.flatMap(x=>[x,x.endsWith('s')?x:x+'s']))].sort((a,b)=>b.length-a.length);
  const hit=variants.find(x=>phraseIn(n,x));if(hit)mentions.push({text:hit,kind:'table',table:t.name,confidence:1,via:hit===norm(t.name)||hit===singular(norm(t.name))?'exact':'synonym'});
 }
 // Columns
 for(const t of tables)for(const c of t.columns){
  const label=norm(c.name);const stem=label.replace(/ (date|at|time|timestamp|id|name|count|gb|minutes|days)$/,'');
  if(phraseIn(n,label))mentions.push({text:label,kind:'column',table:t.name,column:c.name,confidence:1,via:'exact'});
  // Plural of a one-word column ("datacenters" -> datacenter).
  else if(!label.includes(' ')&&label.length>=4&&words(n).some(w=>w!==label&&singular(w)===label))mentions.push({text:words(n).find(w=>singular(w)===label)!,kind:'column',table:t.name,column:c.name,confidence:1,via:'exact'});
  else if(stem!==label&&stem.length>=4&&phraseIn(n,stem))mentions.push({text:stem,kind:'column',table:t.name,column:c.name,confidence:0.6,via:'partial'});
  else if(/^[a-z]{2,4}$/.test(c.name)&&!COMMON.has(c.name)){
   // Short column names are often acronyms of the user's words ("operating system" -> os).
   const ws=words(n);for(let i=0;i+c.name.length<=ws.length;i++){const span=ws.slice(i,i+c.name.length);if(span.map(x=>x[0]).join('')===c.name&&span.every(x=>x.length>=3)){mentions.push({text:span.join(' '),kind:'column',table:t.name,column:c.name,confidence:0.9,via:'acronym'});break;}}
  }
  else{const parts=label.split(' ');const qWords=new Set(words(n).map(singular));if(parts.length>=2&&parts.every(w=>w.length>=2&&(qWords.has(w)||qWords.has(singular(w))||[...qWords].some(q=>q.length>=5&&(q.startsWith(w.slice(0,5))||w.startsWith(q.slice(0,5)))))))mentions.push({text:parts.join(' '),kind:'column',table:t.name,column:c.name,confidence:0.9,via:'partial'});
   // "restore test results" ~ restore_test_status: all distinctive parts present, generic tail omitted.
   else if(parts.length>=3&&/^(status|date|type|count|id|code|level|flag)$/.test(parts.at(-1)!)&&parts.slice(0,-1).every(w=>qWords.has(w)||qWords.has(singular(w))))mentions.push({text:parts.slice(0,-1).join(' '),kind:'column',table:t.name,column:c.name,confidence:0.8,via:'partial'});}
 }
 // A distinctive first word of a column name ("cvss" -> cvss_score) names that column.
 {
  const firstWords=new Map<string,{table:string;column:string}[]>();
  for(const t of tables)for(const c of t.columns){const parts=c.name.split('_');if(parts.length<2||c.type==='BOOLEAN')continue;const f=parts[0];if(f.length<4||COMMON.has(f))continue;firstWords.set(f,[...(firstWords.get(f)||[]),{table:t.name,column:c.name}]);}
  for(const word of new Set(words(n))){const w=firstWords.has(word)?word:singular(word);const cols=firstWords.get(w);if(!cols||cols.length!==1)continue;
   const tb=catalog.tables.find(t=>t.name===cols[0].table)!;if(norm(tb.name).startsWith(w)||singular(norm(tb.name))===w)continue;
   if(!mentions.some(m=>m.kind==='column'&&m.column===cols[0].column))mentions.push({text:word,kind:'column',table:cols[0].table,column:cols[0].column,confidence:0.8,via:'partial'});}
 }
 // Boolean flags named by their distinctive word: "have an exploit" -> exploit_available, "is regulated" -> regulated.
 for(const t of tables)for(const c of t.columns){
  if(c.type!=='BOOLEAN'||mentions.some(m=>m.kind==='column'&&m.table===t.name&&m.column===c.name))continue;
  const key=c.name.split('_').filter(w=>!/^(is|has|have|flag|available|approved|enabled|required|exists)$/.test(w));
  if(key.length===1&&key[0].length>=5&&words(n).some(w=>singular(w)===key[0]||w===key[0]))mentions.push({text:key[0],kind:'column',table:t.name,column:c.name,confidence:0.9,via:'partial'});
 }
 // Values: exact phrase, short codes, synonyms, acronyms, distinctive words
 const schemaWords=new Set(catalog.tables.flatMap(t=>[...words(t.name),singular(norm(t.name)),...t.columns.flatMap(c=>words(c.name))]));
 for(const t of tables)for(const c of t.columns){
  const pool=[...new Set([...c.values,...c.lookup])].filter((v):v is string=>typeof v==='string'&&v.length>0);
  if(!pool.length)continue;
  const wordFreq=new Map<string,number>();for(const v of pool)for(const w of new Set(words(v)))wordFreq.set(w,(wordFreq.get(w)||0)+1);
  for(const v of pool){
   const nv=norm(v);if(!nv)continue;
   if(v.length<=2){
    // "64 GB" is a unit, not the country code GB.
    const code=v.replace(/[^A-Za-z0-9]/g,'');
    // "64 GB" or "average size in GB" (a measure question naming a column's unit) is a unit, not a code.
    const unitColumn=catalog.tables.some(t=>t.columns.some(c=>/INT|DOUBLE|DECIMAL|FLOAT/.test(c.type)&&c.name.toLowerCase().endsWith('_'+code.toLowerCase())));
    // Each occurrence is judged on its own: "servers in GB with 64 GB memory" has one code and one unit.
    const occurrences=[...corrected.matchAll(new RegExp('(\\S+\\s+)?\\b'+code+'\\b','g'))];
    const isUnit=(o:RegExpMatchArray)=>/\d\s*$/.test(o[1]||'')||(unitColumn&&/\b(average|avg|mean|total|sum|size|max|maximum|min|minimum|how much|capacity|largest|smallest)\b/i.test(corrected)&&/^(in|of)\s+$/i.test(o[1]||''));
    const unit=occurrences.length>0&&occurrences.every(isUnit);
    if(!unit&&(originalTokens.includes(v)||(/\d/.test(v)&&originalTokens.some(tok=>tok.toLowerCase()===nv))))mentions.push({text:v,kind:'value',table:t.name,column:c.name,value:v,confidence:1,via:'exact'});continue;}
   if(phraseIn(n,nv)){mentions.push({text:nv,kind:'value',table:t.name,column:c.name,value:v,confidence:1,via:'exact'});continue;}
   // "under investigation" ~ Investigating: the -ation noun of a stored verb form is the same state.
   if(!nv.includes(' ')&&nv.length>=6){const noun=(x:string)=>x.replace(/(ations?|ating|ated|ates?|ions?|ing|ed)$/,'');const hit=words(n).find(w=>/(ation|ion)s?$/.test(w)&&noun(w).length>=6&&noun(w)===noun(nv));if(hit){mentions.push({text:hit,kind:'value',table:t.name,column:c.name,value:v,confidence:0.9,via:'synonym'});continue;}}
   // Inflected forms: "fail" ~ Failed, "remediate" ~ Remediated, "blocking" ~ Blocked.
   if(!nv.includes(' ')&&nv.length>=4){const stem=(x:string)=>x.replace(/(ful|fully|ly|ing|ed|es|s|d|e)$/,'');const derive=(x:string)=>x.replace(/(eeded|eeding|eeds|eed|essfully|essful|ess|ures|ure)$/,'');const hit=words(n).find(w=>w.length>=4&&w!==nv&&!/^(day|days|week|weeks|month|months|year|years|quarter|quarters|hour|hours|minute|minutes|time|times|date|dates)$/.test(w)&&(((stem(w)===stem(nv)||stem(w)===nv)&&!(/(ed|ing)$/.test(w)&&!/(ed|ing)$/.test(nv)))||(derive(w)!==w&&derive(w).length>=4&&derive(w)===derive(nv)&&!/ly$/.test(words(n)[words(n).indexOf(w)-1]||''))));if(hit){mentions.push({text:hit,kind:'value',table:t.name,column:c.name,value:v,confidence:0.85,via:'partial'});continue;}}
   const a=acronym(v);if(a&&phraseIn(n,a)){mentions.push({text:a,kind:'value',table:t.name,column:c.name,value:v,confidence:0.9,via:'acronym'});continue;}
   if(c.values.includes(v)){
    const distinctive=words(v).filter(w=>w.length>=4&&!/\d/.test(w)&&wordFreq.get(w)===1&&!COMMON.has(w)&&!schemaWords.has(w)&&!schemaWords.has(singular(w)));
    const hit=distinctive.find(w=>phraseIn(n,w));
    if(hit)mentions.push({text:hit,kind:'value',table:t.name,column:c.name,value:v,confidence:0.7,via:'partial'});
   }
  }
 }
 for(const [alias,canonical] of Object.entries({...catalog.semantic.valueSynonyms,...Object.fromEntries(Object.entries(catalog.aliases).map(([k,v])=>[k.toLowerCase(),v]))})){
  if(!phraseIn(n,norm(alias)))continue;
  for(const t of tables)for(const c of t.columns)if(c.values.includes(canonical)||c.lookup.includes(canonical))mentions.push({text:norm(alias),kind:'value',table:t.name,column:c.name,value:canonical,confidence:0.95,via:'synonym'});
 }
 return finish(question,corrected,corrections,dedupe(mentions),catalog);
}

// Adds database lookups for identifier-like tokens (hostnames, CVE IDs, ticket numbers) that are too
// numerous to keep in memory.
export async function ground(question:string,catalog:Catalog):Promise<Grounding>{
 const g=groundSync(question,catalog);
 const tokens=[...new Set([...question.matchAll(/'([^']{2,60})'|"([^"]{2,60})"|\b([A-Za-z]+[-_][A-Za-z0-9-_]*\d[A-Za-z0-9-_]*|[A-Za-z]*\d+[A-Za-z]+[A-Za-z0-9-]*)\b|\b([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,2} \d+)\b/g)].map(m=>m[1]||m[2]||m[3]||m[4]))].slice(0,6);
 // Multi-word names ("Payments 1", "Identity 8") in columns too large to keep in memory.
 const shape=(s:string)=>s.replace(/[A-Za-z]/g,'a').replace(/\d/g,'9').replace(/a+/g,'a').replace(/9+/g,'9');
 const lookups:Promise<void>[]=[];const candidates:NonNullable<Grounding['missingIdentifiers']>=[];
 for(const token of tokens){
  if(g.mentions.some(m=>m.kind==='value'&&m.value?.toLowerCase()===token.toLowerCase()))continue;
  for(const t of catalog.tables)for(const c of t.columns){
   if(!c.type.includes('VARCHAR')||c.values.length||c.lookup.length&&!c.lookup.some(v=>String(v).toLowerCase()===token.toLowerCase()))continue;
   if(!c.representatives.some(r=>typeof r==='string'&&shape(r)===shape(token)))continue;
   const prefix=(v:string)=>v.replace(/\d+/g,'9').toLowerCase();
   const same=c.representatives.find(r=>typeof r==='string'&&prefix(r)===prefix(token));
   if(same!==undefined)candidates.push({token,table:t.name,column:c.name,example:String(same)});
   lookups.push(catalog.db.query(`SELECT ${identifier(c.name)} AS v FROM ${identifier(t.name)} WHERE lower(${identifier(c.name)})=lower(${sqlLiteral(token)}) LIMIT 1`,1).then(r=>{
    if(r.rows.length)g.mentions.push({text:token,kind:'value',table:t.name,column:c.name,value:String(r.rows[0].v),confidence:1,via:'lookup'});
   }).catch(()=>{}));
  }
 }
 await Promise.all(lookups);
 const result=finish(question,g.normalized,g.corrections,dedupe(g.mentions),catalog);
 // Only code-like identifiers ("SRV-00003", "host-00010"), never multi-word names, count as missing.
 const missing=candidates.filter(c=>/^[A-Za-z]+[-_]?\d[\w-]*$/.test(c.token)&&!result.mentions.some(m=>m.kind==='value'&&m.value?.toLowerCase()===c.token.toLowerCase()));
 // Report each token against the table that owns it (primary key) rather than a table that references it.
 const rank=(m:{table:string;column:string})=>catalog.table(m.table).primaryKey===m.column?0:1;
 const byToken=[...new Map([...missing].sort((a,b)=>rank(b)-rank(a)).map(m=>[m.token,m])).values()];
 return byToken.length?{...result,missingIdentifiers:byToken}:result;
}

function dedupe(mentions:Mention[]){
 const seen=new Map<string,Mention>();
 for(const m of mentions){const key=[m.kind,m.table,m.column,m.value].join('|');const prior=seen.get(key);if(!prior||m.confidence>prior.confidence)seen.set(key,m);}
 let list=[...seen.values()];
 // A shorter partial match inside a longer exact phrase of another value is noise.
 list=list.filter(m=>!(m.kind==='value'&&m.via==='partial'&&list.some(o=>o!==m&&o.kind==='value'&&o.confidence>m.confidence&&o.text.includes(m.text))));
 return list;
}

function finish(question:string,normalizedQuestion:string,corrections:{from:string;to:string}[],mentions:Mention[],catalog:Catalog):Grounding{
 const n=norm(normalizedQuestion);
 // A column word inside a table phrase ("os" in "os upgrades") is part of the table's name.
 const tablePhrases=mentions.filter(m=>m.kind==='table'&&m.text.includes(' ')).map(m=>' '+m.text+' ');
 mentions=mentions.filter(m=>!(m.kind==='column'&&!m.text.includes(' ')&&tablePhrases.some(p=>p.includes(' '+m.text+' '))));
 // "country" inside "headquarters country": the longer column phrase wins.
 const longColumns=mentions.filter(m=>m.kind==='column'&&m.text.includes(' ')&&m.confidence>=0.9).map(m=>' '+m.text+' ');
 mentions=mentions.filter(m=>!(m.kind==='column'&&!m.text.includes(' ')&&longColumns.some(p=>p.includes(' '+m.text+' '))));
 // A table word inside a stored value phrase ("services" in "Shared Services") is part of the value.
 const valuePhrases=mentions.filter(m=>m.kind==='value'&&m.text.includes(' ')).map(m=>' '+m.text+' ');
 mentions=mentions.filter(m=>!(m.kind==='table'&&valuePhrases.some(p=>p.includes(' '+m.text+' '))&&!mentions.some(o=>o.kind==='table'&&o.table===m.table&&o!==m&&!valuePhrases.some(p=>p.includes(' '+o.text+' ')))));
 // Bare numbers ("7 days", "top 5") are quantities unless a matching column word sits next to them ("version 7").
 const qWords=words(normalizedQuestion);
 mentions=mentions.filter(m=>{
  if(m.kind!=='value'||!/^\d+(\.\d+)?$/.test(String(m.value)))return true;
  const i=qWords.indexOf(norm(m.text));if(i<0)return false;
  const near=[qWords[i-1],qWords[i-2],qWords[i+1]].filter(Boolean) as string[];
  return near.some(w=>m.column!.split('_').includes(w)||m.column!.split('_').includes(singular(w)));
 });
 // One phrase, several columns of the same table ("failed" -> status / restore_test_status): keep the
 // column whose own words appear in the question, else the plainest (shortest) column.
 mentions=mentions.filter(m=>{
  if(m.kind!=='value')return true;
  const peers=mentions.filter(o=>o.kind==='value'&&o.text===m.text&&o.table===m.table&&o.value===m.value);
  if(peers.length<2)return true;
  const named=(x:Mention)=>{const parts=x.column!.split('_').filter(w=>w.length>2&&w!==norm(x.text)&&!/^(status|date|type|code|level|flag|name)$/.test(w));return parts.length>0&&parts.every(w=>qWords.includes(w));};
  const best=[...peers].sort((a,b)=>Number(named(b))-Number(named(a))||a.column!.length-b.column!.length)[0];
  return m===best;
 });
 // An inflected guess for a column that already has an exact value ("extended support") is noise.
 mentions=mentions.filter(m=>!(m.kind==='value'&&m.via==='partial'&&mentions.some(o=>o!==m&&o.kind==='value'&&o.via!=='partial'&&o.table===m.table&&o.column===m.column)));
 // A word that names a column ("platform") is that column, not an inflected value ("Platforms").
 const columnWords=new Set(mentions.filter(m=>m.kind==='column'&&m.confidence>=0.9).map(m=>m.text));
 mentions=mentions.filter(m=>!(m.kind==='value'&&m.via==='partial'&&columnWords.has(m.text)));
 // A word inside a longer column phrase ("customer" in "customer impact") is not a separate value.
 const columnPhrases=mentions.filter(m=>m.kind==='column'&&m.confidence>=0.8&&m.text.includes(' ')).map(m=>' '+m.text+' ');
 mentions=mentions.filter(m=>!(m.kind==='value'&&!m.text.includes(' ')&&columnPhrases.some(p=>p.includes(' '+m.text+' '))));
 const tableHits=new Set(mentions.filter(m=>m.kind==='table').map(m=>m.table));
 // A word that names a table is a value only when the value's own table is also mentioned
 // ("backup incidents" vs "backup counts").
 const tableTexts=new Set(mentions.filter(m=>m.kind==='table').map(m=>singular(m.text)));
 // ...and even then only when it directly modifies that table ("backup incidents"), not "a failed backup and a major incident".
 const qn=' '+norm(normalizedQuestion)+' ';
 mentions=mentions.filter(m=>{
  if(m.kind!=='value'||!tableTexts.has(singular(m.text)))return true;
  if(!tableHits.has(m.table))return false;
  const own=mentions.filter(o=>o.kind==='table'&&o.table===m.table).map(o=>norm(o.text));
  return own.some(t=>qn.includes(' '+norm(m.text)+' '+t+' '));
 });
 // A verb-like value ("servers running tier 1 apps") followed by another mention is an action, not a state.
 mentions=mentions.filter(m=>{
  if(m.kind!=='value'||!/ing$/.test(m.text)||m.text.includes(' '))return true;
  const after=qn.split(' '+norm(m.text)+' ')[1]||'';
  const next=after.trim().split(' ').slice(0,3).join(' ');
  return !mentions.some(o=>o!==m&&o.table!==m.table&&(o.kind==='value'||o.kind==='table')&&next.startsWith(norm(o.text).split(' ')[0]));
 });
 // "resolved last month": with a time expression, a word naming a date column means that date, not a status value.
 if(/\b(day|days|week|weeks|month|months|quarter|year|years|since|before|after|between|ago|today|yesterday|\d{4}-\d{2})\b/i.test(normalizedQuestion)){
  const dateWords=new Set(mentions.filter(m=>m.kind==='column'&&/DATE|TIME/.test(catalog.tables.find(t=>t.name===m.table)?.columns.find(c=>c.name===m.column)?.type||'')).map(m=>m.text));
  mentions=mentions.filter(m=>!(m.kind==='value'&&dateWords.has(m.text)));
 }
 // A value present in several tables belongs to the explicitly mentioned one when possible.
 mentions=mentions.filter(m=>{
  if(m.kind!=='value')return true;
  const peers=mentions.filter(o=>o.kind==='value'&&o.value===m.value&&o.text===m.text);
  if(peers.length<=1)return true;
  const preferred=peers.filter(o=>tableHits.has(o.table));
  return preferred.length?preferred.includes(m):true;
 });
 const score=new Map<string,number>();const bump=(t:string,s:number)=>score.set(t,(score.get(t)||0)+s);
 for(const m of mentions){
  if(m.kind==='table')bump(m.table,5);
  else if(m.kind==='value')bump(m.table,3*m.confidence/Math.max(1,mentions.filter(o=>o.kind==='value'&&o.text===m.text).length));
  else{const owners=mentions.filter(o=>o.kind==='column'&&o.text===m.text).length;bump(m.table,(owners===1?2:0.5)*m.confidence);}
 }
 // "status" with one table in scope: the single column whose last word it is (e.g. evergreen_status).
 const scoped=[...score].filter(([,v])=>v>=1).map(([t])=>t);
 if(scoped.length===1){
  const t=catalog.table(scoped[0]);
  for(const w of words(n))if(w.length>=4&&!/^(day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|time|date)$/.test(w)&&!mentions.some(m=>m.kind==='column'&&m.table===t.name&&words(m.text).includes(w))){
   let cols=t.columns.filter(c=>c.name.split('_').length>1&&c.name.split('_').at(-1)===w&&!/_id$/.test(c.name));
   // Several candidates: the one named after the table itself (evergreening -> evergreen_status).
   if(cols.length>1){const own=cols.filter(c=>norm(t.name).startsWith(c.name.split('_')[0])||c.name.split('_')[0].startsWith(singular(norm(t.name))));if(own.length===1)cols=own;}
   if(cols.length===1&&!t.columns.some(c=>c.name===w)&&!mentions.some(m=>m.kind==='column'&&m.table===t.name&&m.column===cols[0].name)){mentions=mentions.filter(m=>!(m.kind==='column'&&m.text===w&&m.table!==t.name));mentions.push({text:w,kind:'column',table:t.name,column:cols[0].name,confidence:0.8,via:'partial'});}
  }
 }
 const explained=new Set(mentions.flatMap(m=>words(m.text)));
 const unknownTerms=words(normalizedQuestion).filter(w=>w.length>2&&!/^\d+$/.test(w)&&!explained.has(w)&&!explained.has(singular(w))&&!QUESTION_WORDS.has(w)&&!COMMON.has(w));
 let chosen=[...score].filter(([,s])=>s>=1).sort((a,b)=>b[1]-a[1]).map(([t])=>t);
 if(!chosen.length){
  // Fall back to description/column word overlap for loosely phrased questions.
  const loose=catalog.tables.filter(t=>!catalog.isReferenceTable(t.name)).map(t=>({t:t.name,s:words(n).filter(w=>w.length>3&&(words(t.description).includes(w)||t.columns.some(c=>words(c.name).includes(singular(w))))).length})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s);
  chosen=loose.slice(0,2).map(x=>x.t);
 }
 // A value right next to a table word ("the Europe estate", "estate Europe") belongs to that table.
 {
  const qn2=' '+norm(normalizedQuestion)+' ';
  const tableWordsOf=(t:string)=>mentions.filter(o=>o.kind==='table'&&o.table===t).map(o=>norm(o.text));
  const adjacent=(m:Mention)=>tableWordsOf(m.table).some(w=>qn2.includes(' '+norm(m.text)+' '+w+' ')||qn2.includes(' '+w+' '+norm(m.text)+' '));
  mentions=mentions.filter(m=>{
   if(m.kind!=='value')return true;
   const peers=mentions.filter(o=>o.kind==='value'&&o.text===m.text&&o!==m);
   if(!peers.length)return true;
   return adjacent(m)||!peers.some(adjacent);
  });
 }
 // Weak value matches (inflections, or ordinary words like "quarterly"/"planning") only count when their
 // table is otherwise in the question; in long sentences they are usually just words.
 const contextTables=new Set(mentions.filter(m=>m.kind==='table'||(m.kind==='column'&&m.confidence>=0.9)).map(m=>m.table));
 const upperCode=(m:Mention)=>/^[A-Z0-9]{2,4}$/.test(m.text);
 mentions=mentions.filter(m=>!(m.kind==='value'&&!upperCode(m)&&(m.via==='partial'||COMMON.has(norm(m.text))||/ly$|ing$/.test(norm(m.text)))&&!contextTables.has(m.table)&&contextTables.size>0));
 // An inflected ordinary word ("planning" ~ Planned) must sit next to its table's word to count.
 const qw=words(normalizedQuestion);
 mentions=mentions.filter(m=>{
  if(m.kind!=='value'||m.via!=='partial'||!COMMON.has(norm(m.text)))return true;
  const i=qw.indexOf(norm(m.text));
  const near=[...qw.slice(Math.max(0,i-3),i),...qw.slice(i+1,i+3)];
  return mentions.some(o=>o.kind==='table'&&o.table===m.table&&near.some(w=>norm(o.text).split(' ').includes(w)));
 });
 // Negated mentions: "non-production", "did not breach SLA", "excluding Windows", "other than Test".
 const raw=' '+normalizedQuestion.toLowerCase().replace(/[^a-z0-9-]+/g,' ')+' ';
 for(const m of mentions){
  if(m.kind==='table')continue;
  const first=norm(m.text).split(' ')[0];
  const i=raw.search(new RegExp('[ -]'+first.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b'));if(i<0)continue;
  const before=raw.slice(Math.max(0,i-30),i+1);
  if(/(\bnon-?\s?$)|\b(not|no|never|excluding|except|without|other than|isn't|aren't|wasn't|weren't|didn't|doesn't|don't|haven't|hasn't)\s+(?:\w+\s+){0,1}$/.test(before))m.negated=true;
 }
 return {question,normalized:normalizedQuestion,corrections,mentions,unknownTerms,tables:catalog.connect(chosen),definitions:definitionsFor(normalizedQuestion,catalog)};
}

// Questions without any database grounding: vague ("the bad ones") vs. about absent data ("salaries").
export function groundingGap(g:Grounding){
 if(g.tables.length)return null;
 const content=words(g.normalized).filter(w=>!QUESTION_WORDS.has(w)&&!COMMON.has(w)||VAGUE.has(w));
 // Keyboard mashing or gibberish ("asdfghjkl") is a request to clarify, not a question about absent data.
 const gibberish=(w:string)=>w.length>=5&&(w.match(/[aeiouy]/g)||[]).length/w.length<0.25;
 return content.every(w=>VAGUE.has(w)||gibberish(w))?'vague':'absent';
}
// The question's main noun ("what is the revenue of...", "list employees in...") when it matches nothing
// in the database: answering anyway would mean guessing.
export function unknownSubject(g:Grounding){
 const m=norm(g.normalized).match(/^(?:(?:what|whats|what s)\s+(?:is|are|was|were)?\s*|show(?: me)?\s+|list\s+|give me\s+|how much\s+|tell me\s+)(?:the\s+|all\s+|our\s+|total\s+|average\s+)*(\w+)/);
 // "revenue by month": an unknown word heading a breakdown is the subject too.
 const head=m?.[1]||(g.mentions.some(x=>x.kind==='table')?undefined:norm(g.normalized).match(/^(?:(?:the|our|total|average)\s+)*(\w+)\s+(?:by|per|over|trend)\b/)?.[1]);
 return head&&g.unknownTerms.includes(head)?head:undefined;
}

export function describeMentions(g:Grounding){
 return g.mentions.filter(m=>m.kind==='value').map(m=>`"${m.text}" means ${m.table}.${m.column} = '${m.value}'${m.confidence<0.9?' (likely)':''}`);
}
export type {Table};
