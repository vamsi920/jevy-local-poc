import {Catalog} from './catalog.js';import {sqlLiteral} from './db.js';
import {numericConditions} from './numeric.js';
import {groundSync,editDistance,isCommonWord,phraseInText,norm,type Grounding} from './grounding.js';
type Node=Record<string,any>;
const signature=(v:unknown):string=>JSON.stringify(v,(_k,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([k])=>!['alias','query_location'].includes(k))):value);
const walk=(node:unknown,fn:(n:Node,parent?:Node,key?:string)=>void,parent?:Node,key?:string)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(v=>walk(v,fn,parent,key));return;}fn(node as Node,parent,key);for(const [k,v] of Object.entries(node))if(v&&typeof v==='object')walk(v,fn,node as Node,k);};
async function parse(sql:string,catalog:Catalog){const ast=JSON.parse(String((await catalog.db.query(`SELECT json_serialize_sql(${sqlLiteral(sql)}) ast`)).rows[0].ast));if(ast.error)throw new Error('SQL parser: '+(ast.error_message||JSON.stringify(ast)));return ast;}
async function expression(sql:string,catalog:Catalog){return (await parse('SELECT '+sql,catalog)).statements[0].node.select_list[0] as Node;}
async function deparse(ast:unknown,catalog:Catalog){walk(ast,n=>{if(Object.hasOwn(n,'query_location'))n.query_location=0;});return String((await catalog.db.query(`SELECT json_deserialize_sql(${sqlLiteral(JSON.stringify(ast))}) AS normalized_sql`)).rows[0].normalized_sql);}
const baseTables=(from:Node|undefined)=>{const out:{name:string;alias:string}[]=[];const collect=(t:Node)=>{if(!t)return;if(t.type==='BASE_TABLE')out.push({name:t.table_name,alias:t.alias||t.table_name});if(t.left)collect(t.left);if(t.right)collect(t.right);};if(from)collect(from);return out;};
const AGGREGATES=['count','count_star','sum','avg','max','min','median','mode','quantile_cont','stddev'];

// Human-readable verified join chain connecting tables, e.g. for hints and prompts.
export function joinPath(catalog:Catalog,tables:string[]){
 const names=catalog.connect(tables);
 const links=catalog.tables.flatMap(t=>t.relationships).filter(r=>r.split(' = ').every(p=>names.includes(p.split('.')[0])));
 return links.length?links.join(' AND '):'no verified relationship';
}
export type GuardOptions={grounding?:Grounding;allowedLiterals?:string[]};
export async function normalizeSQL(sql:string,catalog:Catalog,question='',allowTemporalScope=false,options:GuardOptions={}){
 const ast=await parse(sql,catalog);
 if(ast.statements?.length!==1)throw new Error('Exactly one SELECT statement is required');
 const notes:string[]=[];
 const grounding=options.grounding||groundSync(question,catalog);
 const root=ast.statements[0].node;
 const sourceTables=catalog.tables.filter(t=>new RegExp('\\b'+t.name+'\\b','i').test(sql));
 // An aggregate divided by itself is always 1 (100%): a share needs the total, e.g. sum(count(*)) OVER ().
 if(/\b((?:count|sum)\s*\((?:\*|[\w."]+)\))\s*(?:\*\s*1(?:00)?(?:\.0+)?\s*)?\/\s*(?:nullif\s*\(\s*)?\1/i.test(sql.replace(/\s+/g,' ')))throw new Error('This divides an aggregate by itself, which is always 1 (100%). For each group\'s share, divide by the overall total: count(*) * 100.0 / sum(count(*)) OVER ().');
 // Pattern filters (LIKE '%open%') must use a word the user actually wrote, not a fragment of another
 // word ("opensl" -> '%open%') — otherwise they quietly drop rows.
 if(question)for(const m of sql.matchAll(/(?:NOT\s+)?(?:I?LIKE|~~\*?|SIMILAR TO)\s+'([^']*)'/gi)){
  const core=m[1].replace(/[%_]+/g,' ').trim();if(!core)continue;
  const allowed=(options.allowedLiterals||[]).some(l=>l.toLowerCase().includes(core.toLowerCase()));
  if(!allowed&&!phraseInText(question,core)&&!phraseInText(grounding.normalized,core))throw new Error(`Pattern filter '${m[1]}' is not something the question asks for. Remove it; filter only on what the user asked.`);
 }

 // 1. Relative dates must use the dataset reference date, never the host clock.
 if(catalog.referenceDate){
  const dateNode=await expression(`DATE '${catalog.referenceDate}'`,catalog),tsNode=await expression(`TIMESTAMP '${catalog.referenceDate} 00:00:00'`,catalog);
  let replaced=false;
  walk(root,(n,parent,key)=>{
   if(!parent||!key)return;
   const clockColumn=n.class==='COLUMN_REF'&&n.column_names?.length===1&&['current_date','current_timestamp','now','today','localtimestamp'].includes(String(n.column_names[0]).toLowerCase())&&!sourceTables.some(t=>t.columns.some(c=>c.name===n.column_names[0]));
   const clockFunction=n.class==='FUNCTION'&&!n.children?.length&&['now','today','current_date','current_timestamp','get_current_timestamp','get_current_date','localtimestamp','transaction_timestamp'].includes(String(n.function_name).toLowerCase());
   if(!clockColumn&&!clockFunction)return;
   const name=String(clockColumn?n.column_names[0]:n.function_name).toLowerCase();
   const replacement=structuredClone(/date|today/.test(name)?dateNode:tsNode);replacement.alias=n.alias||'';
   if(Array.isArray(parent[key]))parent[key][parent[key].indexOf(n)]=replacement;else parent[key]=replacement;replaced=true;
  });
  if(replaced)notes.push(`Replaced host clock with dataset reference date ${catalog.referenceDate}.`);
 }

 // 2. Join conditions without an equality get the verified relationship.
 const joinFixes:Node[]=[];
 walk(root,n=>{if(n.type==='JOIN'&&n.condition&&!n.using_columns?.length&&['COLUMN_REF','CONSTANT'].includes(n.condition.class))joinFixes.push(n);});
 for(const join of joinFixes){
  const left=baseTables(join.left),right=baseTables(join.right);let fixed=false;
  for(const r of right)for(const l of left){
   const rel=catalog.tables.flatMap(t=>t.relationships).find(x=>{const [a,b]=x.split(' = ');const ta=a.split('.')[0],tb=b.split('.')[0];return (ta===r.name&&tb===l.name)||(ta===l.name&&tb===r.name);});
   if(rel&&!fixed){const key=rel.split(' = ')[0].split('.')[1];join.condition=await expression(`"${l.alias}"."${key}" = "${r.alias}"."${key}"`,catalog);fixed=true;}
  }
  if(!fixed)throw new Error(`JOIN ${right.map(r=>r.name).join(',')} has no equality condition and no verified relationship to ${left.map(l=>l.name).join(',')}. Join only through: ${catalog.tables.flatMap(t=>t.relationships).join('; ')}`);
  notes.push('Rebuilt join condition from verified relationship.');
 }

 // 2b. Equality joins must follow verified relationships (same key on both sides).
 const relationships=catalog.tables.flatMap(t=>t.relationships).map(r=>r.split(' = ').map(x=>x.split('.')));
 const badJoins:Node[]=[];
 walk(root,n=>{
  if(n.type!=='JOIN'||!n.condition||n.using_columns?.length)return;
  const aliasMap=new Map([...baseTables(n.left),...baseTables(n.right)].map(t=>[t.alias.toLowerCase(),t.name]));
  walk(n.condition,c=>{
   if(c.class!=='COMPARISON'||c.type!=='COMPARE_EQUAL'||c.left?.class!=='COLUMN_REF'||c.right?.class!=='COLUMN_REF')return;
   const side=(x:Node)=>{const parts=x.column_names as string[];const column=parts.at(-1)!;const table=parts.length>1?aliasMap.get(parts.at(-2)!.toLowerCase()):undefined;return {table,column};};
   const a=side(c.left),b=side(c.right);
   if(!a.table||!b.table||a.table===b.table)return;
   const known=catalog.tables.some(t=>t.name===a.table)&&catalog.tables.some(t=>t.name===b.table);
   if(!known)return;
   const ok=relationships.some(([[t1,c1],[t2,c2]])=>(t1===a.table&&c1===a.column&&t2===b.table&&c2===b.column)||(t1===b.table&&c1===b.column&&t2===a.table&&c2===a.column))||(a.column===b.column&&catalog.table(a.table).columns.some(x=>x.name===a.column)&&catalog.table(b.table).columns.some(x=>x.name===b.column));
   if(!ok)badJoins.push({n,a,b});
  });
 });
 for(const bad of badJoins as {n:Node;a:{table:string;column:string};b:{table:string;column:string}}[]){
  const direct=catalog.tables.flatMap(t=>t.relationships).find(x=>{const [l,r]=x.split(' = ');const tl=l.split('.')[0],tr=r.split('.')[0];return (tl===bad.a.table&&tr===bad.b.table)||(tl===bad.b.table&&tr===bad.a.table);});
  if(direct){
   const key=direct.split(' = ')[0].split('.')[1];
   const aliasOf=(table:string)=>[...baseTables(bad.n.left),...baseTables(bad.n.right)].find(t=>t.name===table)!.alias;
   bad.n.condition=await expression(`"${aliasOf(bad.a.table)}"."${key}" = "${aliasOf(bad.b.table)}"."${key}"`,catalog);
   notes.push(`Corrected join ${bad.a.table}.${bad.a.column} = ${bad.b.table}.${bad.b.column} to the verified key ${key}.`);
  }else{const rebuilt=await rebuildJoins(await deparse(ast,catalog),catalog);if(rebuilt)return normalizeSQL(rebuilt,catalog,question,allowTemporalScope,options);throw new Error(`Invalid join ${bad.a.table}.${bad.a.column} = ${bad.b.table}.${bad.b.column}: these columns are not related. Join path: ${joinPath(catalog,[bad.a.table,bad.b.table])}.`);}
 }

 walk(root,n=>{
  if(Object.hasOwn(n,'query_location'))n.query_location=0;
  // Map literal aliases (e.g. 'Prod' -> 'Production') to stored values of that column.
  if(n.class==='COMPARISON'&&n.left?.class==='COLUMN_REF'&&n.right?.class==='CONSTANT'&&typeof n.right.value?.value==='string'){
   const column=n.left.column_names?.at(-1),literal=n.right.value.value;
   const owners=sourceTables.filter(t=>t.columns.some(c=>c.name===column));
   if(owners.length&&!owners.some(t=>t.columns.find(c=>c.name===column)!.values.includes(literal))){
    const canonical=new Set(groundSync(literal,catalog).mentions.filter(m=>m.kind==='value'&&m.column===column&&owners.some(t=>t.name===m.table)&&m.confidence>=0.9).map(m=>m.value!));
    if(canonical.size===1){n.right.value.value=[...canonical][0];notes.push('Resolved categorical alias against observed stored values.');}
   }
  }
  if(n.class==='FUNCTION'&&n.function_name?.toLowerCase()==='date_sub'&&n.children?.length===2){n.function_name='-';n.is_operator=true;notes.push('Translated two-argument date subtraction to DuckDB interval arithmetic.');}
  if(n.type==='SELECT_NODE'){
   const original=n.select_list||[];
   const missing=(n.group_expressions||[]).filter((g:Node)=>g.class!=='CONSTANT'&&!original.some((s:Node)=>signature(s)===signature(g)||(g.class==='COLUMN_REF'&&s.class==='COLUMN_REF'&&s.column_names?.at(-1)===g.column_names?.at(-1))));
   if(missing.length){n.select_list=[...missing,...original];notes.push('Projected grouping dimensions so counts retain category labels.');for(const modifier of n.modifiers||[])if(modifier.type==='ORDER_MODIFIER')for(const order of modifier.orders||[]){const v=order.expression?.value;if(order.expression?.class==='CONSTANT'&&typeof v?.value==='number')v.value+=missing.length;}}
   const tables=baseTables(n.from_table).map(t=>t.name);
   const rootTable=tables[0];const rootKey=rootTable&&catalog.tables.find(t=>t.name===rootTable)?.primaryKey;
   const fanout=rootKey&&catalog.tables.some(t=>tables.includes(t.name)&&t.relationships.some(r=>r.endsWith(' = '+rootTable+'.'+rootKey)));
   for(const expr of original){if(expr.class!=='FUNCTION')continue;const fn=expr.function_name?.toLowerCase();const col=expr.children?.[0]?.column_names;
    if(fanout&&fn==='count_star'&&!(n.group_expressions||[]).length)throw new Error(`A child join multiplies ${rootTable} rows. Use count(DISTINCT ${rootTable}.${rootKey}) or EXISTS instead of count(*).`);
    if(fn==='count'&&expr.distinct&&col&&(n.group_expressions||[]).some((g:Node)=>g.class==='COLUMN_REF'&&g.column_names?.at(-1)===col.at(-1))){notes.push('Distinct count of the grouping key is always 1; counted rows per group instead.');expr.function_name='count_star';expr.children=[];expr.distinct=false;}
   }
  }
 });

 // 2c. Grouping by an entity ID: also show its human-readable name.
 if(root.type==='SELECT_NODE'&&root.group_expressions?.length){
  const from=baseTables(root.from_table);
  for(const g of [...root.group_expressions] as Node[]){
   if(g.class!=='COLUMN_REF')continue;const col=g.column_names.at(-1);
   const owner=from.find(t=>(g.column_names.length===1||g.column_names[0].toLowerCase()===t.alias.toLowerCase())&&catalog.tables.find(x=>x.name===t.name)?.primaryKey===col);
   if(!owner)continue;
   const table=catalog.table(owner.name);
   const label=table.columns.find(c=>c.type==='VARCHAR'&&c.name!==col&&/(^|_)(name|title|hostname)$/.test(c.name));
   if(!label||(root.select_list as Node[]).some(e=>e.class==='COLUMN_REF'&&e.column_names.at(-1)===label.name))continue;
   const ref=await expression(`"${owner.alias}"."${label.name}"`,catalog);
   const at=((root.select_list as Node[]).findIndex(e=>signature({...e,alias:''})===signature({...g,alias:''}))+1)||0;
   root.select_list=[...root.select_list.slice(0,at),ref,...root.select_list.slice(at)];
   // Positional ORDER BY references after the inserted column shift by one.
   for(const modifier of root.modifiers||[])if(modifier.type==='ORDER_MODIFIER')for(const order of modifier.orders||[]){const v=order.expression?.value;if(order.expression?.class==='CONSTANT'&&typeof v?.value==='number'&&v.value>at)v.value+=1;}
   root.group_expressions=[...root.group_expressions,structuredClone(ref)];const index=root.group_expressions.length-1;root.group_sets=(root.group_sets?.length?root.group_sets:[[]]).map((set:number[])=>[...set,index]);
   notes.push(`Added ${label.name} so grouped results are readable.`);
  }
 }

 // 3. Random sampling requests get database random ordering and the requested cardinality.
 if(/\brandom(?:ly)?\b/i.test(question)&&root.type==='SELECT_NODE'&&!root.group_expressions?.length&&!root.select_list?.some((e:Node)=>e.class==='FUNCTION'&&AGGREGATES.includes(e.function_name?.toLowerCase()))){
  const fragment=await parse('SELECT 1 ORDER BY random()',catalog);
  root.modifiers=[...fragment.statements[0].node.modifiers,...(root.modifiers||[]).filter((m:Node)=>m.type!=='ORDER_MODIFIER')];
  const cardinality=question.match(/\b(?:pick|give(?: me)?|show|select|return|sample|choose|list)\s+(?:the\s+|me\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if(cardinality){const k=Number(cardinality[1])||(['one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(cardinality[1].toLowerCase())+1);if(k>0&&k<=200){const limitFragment=await parse('SELECT 1 LIMIT '+k,catalog);root.modifiers=[...root.modifiers.filter((m:Node)=>m.type!=='LIMIT_MODIFIER'),...limitFragment.statements[0].node.modifiers];}}
  notes.push('Enforced requested random sampling with database random ordering.');
 }

 // 4. Date predicates nobody asked for silently empty results.
 // Columns used in WHERE; date columns count only when compared to values (IS NULL is not a time range).
 const whereColumns=new Set<string>();const nullChecked=new Set<string>();
 walk(root.where_clause,n=>{if(n.class==='OPERATOR'&&/IS_NULL|IS_NOT_NULL/.test(n.type))walk(n.children,x=>{if(x.class==='COLUMN_REF')nullChecked.add(x.column_names.at(-1));});});
 walk(root.where_clause,n=>{if(n.class==='COMPARISON'||n.class==='BETWEEN'||(n.class==='OPERATOR'&&/IN$/.test(n.type)))walk(n,x=>{if(x.class==='COLUMN_REF')whereColumns.add(x.column_names.at(-1));});});
 for(const c of nullChecked)if(!whereColumns.has(c))whereColumns.delete(c);
 const dateFields=new Set(sourceTables.flatMap(t=>t.columns.filter(c=>/DATE|TIMESTAMP/.test(c.type)).map(c=>c.name)));
 const requestedTime=/\b(overdue|due|late|expired|expiring|deadline|day|days|week|weeks|month|months|quarter|year|years|date|dates|time|today|yesterday|recent|recently|latest|earliest|oldest|newest|before|after|since|between|created|resolved|discovered|updated|started|finished|due|ago|last|past|this|current|currently|overdue|expired|expiring|until|during|when|age|old)\b|\d{4}-\d{2}|\b(19|20)\d{2}\b/i.test(question)||[...dateFields].some(c=>question.toLowerCase().includes(c.replaceAll('_',' '))||question.toLowerCase().includes(c));
 if(!allowTemporalScope&&question&&!requestedTime&&[...whereColumns].some(c=>dateFields.has(c))){
  if([...whereColumns].every(c=>dateFields.has(c))&&!nullChecked.size){root.where_clause=null;notes.push('Removed temporal restriction absent from the original request.');}
  else throw new Error('Unrequested date restriction: the question has no time scope. Remove the date predicate and keep only requested filters.');
 }

 // 5. Every string filter must trace back to the question, its grounding or conversation scope.
 const predicates:{column:string;value:string;negated:boolean}[]=[];
 walk(root,n=>{
  if(n.class==='COMPARISON'&&['COMPARE_EQUAL','COMPARE_NOTEQUAL'].includes(n.type)&&n.left?.class==='COLUMN_REF'&&n.right?.class==='CONSTANT'&&typeof n.right.value?.value==='string')predicates.push({column:n.left.column_names.at(-1),value:n.right.value.value,negated:n.type==='COMPARE_NOTEQUAL'});
  if(n.class==='OPERATOR'&&['COMPARE_IN','COMPARE_NOT_IN'].includes(n.type)&&n.children?.[0]?.class==='COLUMN_REF')for(const child of n.children.slice(1))if(child.class==='CONSTANT'&&typeof child.value?.value==='string')predicates.push({column:n.children[0].column_names.at(-1),value:child.value.value,negated:n.type==='COMPARE_NOT_IN'});
 });
 const negation=/\b(not|non|except|excluding|exclude|other than|without|besides|isn'?t|aren'?t|never)\b|\bno\s/i.test(question);
 for(const p of predicates)if(p.negated&&!negation&&grounding.mentions.some(m=>m.kind==='value'&&m.value===p.value))throw new Error(`The question asks for ${p.column} = '${p.value}', but the query excludes it (!= / NOT IN). Use = '${p.value}'.`);
 if(question){
  const allowed=new Set((options.allowedLiterals||[]).map(v=>v.toLowerCase()));
  const mentioned=new Set(grounding.mentions.filter(m=>m.value).map(m=>m.value!.toLowerCase()));
  for(const p of predicates){
   const literal=p.value;const lower=literal.toLowerCase();
   // An identifier compared against a column whose values look different ("SRV-00001" vs EVG-...) matches nothing.
   const idShape=(v:string)=>/^[A-Za-z]+[-_]?\d[\w-]*$/.test(v)?v.replace(/\d+/g,'9').toUpperCase():'';
   if(idShape(literal)){
    const col=sourceTables.map(t=>t.columns.find(c=>c.name===p.column)).find(Boolean);
    const reps=(col?.representatives||[]).filter((r):r is string=>typeof r==='string');
    if(col&&reps.length&&reps.every(r=>idShape(r))&&!col.values.map(String).includes(literal)&&reps.every(r=>idShape(r)!==idShape(literal))){
     const home=sourceTables.flatMap(t=>t.columns.filter(c=>c!==col&&(c.representatives||[]).some(r=>typeof r==='string'&&idShape(r)===idShape(literal))).map(c=>t.name+'.'+c.name));
     throw new Error(`'${literal}' does not look like a ${p.column} value (e.g. '${reps[0]}').${home.length?` It looks like ${home.slice(0,3).join(', ')}; filter that column instead.`:''}`);
    }
   }
   if(/^\d{4}-\d{2}-\d{2}/.test(literal)||allowed.has(lower)||mentioned.has(lower))continue;
   const owners=sourceTables.map(t=>({t,c:t.columns.find(c=>c.name===p.column)})).filter(x=>x.c);
   if(!owners.length)continue;
   const known=owners.flatMap(o=>[...o.c!.values,...o.c!.lookup]).map(String);
   // Value lists profiled from a sample (very large tables) are not complete; absence proves nothing.
   const complete=owners.every(o=>(o.c!.values.length||o.c!.lookup.length)&&!o.c!.sampled);
   const stored=known.includes(literal);
   const inQuestion=phraseInText(grounding.normalized,literal)||phraseInText(question,literal);
   if(stored&&inQuestion)continue;
   // "opened" describes an event (creation), not the stored status 'Open'.
   const mapping=grounding.unknownTerms.filter(t=>!(t.startsWith(lower)&&/^(ed|d|ing|s|es)$/.test(t.slice(lower.length))));
   // "unresolved"/"non-production" negate the value; using it would answer the opposite question.
   if(grounding.unknownTerms.some(t=>/^(un|non|in|dis|im)-?/.test(t)&&t.replace(/^(un|non|in|dis|im)-?/,'').startsWith(lower.slice(0,Math.max(4,lower.length-2))))&&!predicates.some(o=>o.column===p.column&&o.value===literal&&o.negated))throw new Error(`The question negates "${literal}" (e.g. "un${lower}"): use ${p.column} <> '${literal}' or the matching NULL/other statuses, not = '${literal}'.`);
   // A column the user already constrained ("partially succeeded" -> Partial) gets no extra guessed values.
   if(stored&&predicates.some(o=>o.column===p.column&&o.value!==literal&&mentioned.has(o.value.toLowerCase())))throw new Error(`Filter ${p.column} = '${literal}' was not requested; the question asks only for ${p.column} = '${predicates.find(o=>o.column===p.column&&mentioned.has(o.value.toLowerCase()))!.value}'.`);
   // Guessing that an unknown word means a stored value is only plausible for proper nouns the user
   // capitalised ("Germany" -> DE); for ordinary words ("negative downtime") it invents a filter.
   const capitalised=(t:string)=>new RegExp('\\b'+t.charAt(0).toUpperCase()+t.slice(1)+'\\b').test(question);
   const describes=(t:string)=>grounding.mentions.some(m=>m.kind==='column'&&new RegExp('\\b'+t+'\\s+'+norm(m.text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(norm(question)));
   const plainWords=mapping.filter(describes);
   if(stored&&plainWords.length&&!mapping.some(capitalised))throw new Error(`Filter ${p.column} = '${literal}' was not requested by the question. Remove it; filter only on what the user asked.`);
   if(stored&&mapping.length){notes.push(`Assumed ${mapping.map(t=>`"${t}"`).join(', ')} means ${p.column} = '${literal}'.`);continue;} // plausible mapping of a user term (e.g. Germany -> DE)
   if(stored)throw new Error(`Filter ${p.column} = '${literal}' was not requested by the question. Remove it; filter only on what the user asked.`);
   const elsewhere=catalog.tables.flatMap(t=>t.columns.filter(c=>c.values.includes(literal)||c.lookup.includes(literal)).map(c=>t.name+'.'+c.name)).filter(x=>!owners.some(o=>x===o.t.name+'.'+p.column));
   if(complete&&!stored&&(elsewhere.length||catalog.tables.some(t=>norm(t.name).startsWith(norm(literal)))))throw new Error(`'${literal}' is not a value of ${owners.map(o=>o.t.name).join('/')}.${p.column} (stored values: ${known.slice(0,16).join(', ')}).${elsewhere.length?` It is stored in ${elsewhere.slice(0,3).join(', ')}.`:''} Use the right column or drop the filter.`);
   if(inQuestion)continue;
   if(complete)throw new Error(`'${literal}' is not a stored value of ${owners.map(o=>o.t.name).join('/')}.${p.column} and is not in the question. Stored values: ${known.slice(0,16).join(', ')}${known.length>16?', …':''}.`);
   if(!grounding.unknownTerms.length)throw new Error(`Filter ${p.column} = '${literal}' is not grounded in the question. Do not invent literal values.`);
  }
  // 6. Explicitly requested values must be applied (or grouped on).
  const sqlText=sql.toLowerCase();
  const grouped=new Set<string>();walk(root,n=>{if(n.type==='SELECT_NODE')for(const g of n.group_expressions||[])if(g.class==='COLUMN_REF')grouped.add(g.column_names.at(-1));});
  // Common words ("high", "low", "open") count as requested values when they modify a table or column name.
  const nouns=grounding.mentions.filter(m=>m.kind!=='value').map(m=>m.text);
  const modifies=(text:string)=>nouns.some(n=>new RegExp('\\b'+text+'\\s+(?:\\w+\\s+)?'+n.split(' ')[0]+'|\\b'+n.split(' ').at(-1)+'\\s+(?:is\\s+|are\\s+|=\\s*)?'+text+'\\b','i').test(grounding.normalized));
  const strong=grounding.mentions.filter(m=>m.kind==='value'&&!m.negated&&(m.confidence>=0.9&&m.via!=='partial'||m.via==='partial'&&m.confidence>=0.85)&&(!isCommonWord(m.text)||modifies(m.text))&&sourceTables.some(t=>t.name===m.table));
  // A requested value on a table the query never reads ("high severity" answered from servers only).
  const outside=grounding.mentions.filter(m=>m.kind==='value'&&!m.negated&&m.confidence>=0.9&&m.via!=='partial'&&(!isCommonWord(m.text)||modifies(m.text)));
  for(const m of outside){
   if(/^\d+(\.\d+)?$/.test(m.value!))continue; // bare numbers in questions are usually counts or days
   if(grounding.mentions.some(o=>o.kind==='value'&&o.text===m.text&&sourceTables.some(t=>t.name===o.table)))continue;
   if(sourceTables.some(t=>t.columns.some(c=>c.values.includes(m.value)||c.lookup.includes(m.value))))continue;
   if(options.allowedLiterals?.some(l=>l.toLowerCase()===m.value!.toLowerCase()))continue;
   throw new Error(`The question asks for ${m.table}.${m.column} = '${m.value}' ("${m.text}") but the query does not read ${m.table}. Join path: ${joinPath(catalog,[m.table,...sourceTables.map(t=>t.name)])}.`);
  }
  for(const m of strong){
   const peers=strong.filter(o=>o.text===m.text);
   if(peers.length>1)continue; // same word matches several columns in scope: the model decides
   const val=m.value!;
   const applied=predicates.some(p=>p.column===m.column&&p.value===val&&!p.negated)||!predicates.some(p=>p.column===m.column&&p.value===val)&&sqlText.includes("'"+val.toLowerCase().replaceAll("'","''")+"'")||grouped.has(m.column!);
   if(!applied)throw new Error(`Explicit requested categorical filter missing: ${m.table}.${m.column} = '${val}' (user said "${m.text}").`);
  }
  // 6b. Boolean attributes the question names (e.g. "internet exposed") must be used.
  for(const m of grounding.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.9&&sourceTables.some(t=>t.name===m.table))){
   const column=catalog.table(m.table).columns.find(c=>c.name===m.column);
   if(column?.type!=='BOOLEAN')continue;
   // Must be a condition (WHERE/HAVING/FILTER/CASE) or a grouping, not merely selected or counted.
   let conditioned=false;walk({w:root.where_clause,h:root.having,g:root.group_expressions},n=>{if(n.class==='COLUMN_REF'&&n.column_names.at(-1)===m.column)conditioned=true;});
   walk(root.select_list,n=>{if((n.filter||n.class==='CASE')&&JSON.stringify(n.filter||n).includes('"'+m.column+'"'))conditioned=true;});
   walk(root.cte_map,n=>{if(n.where_clause&&JSON.stringify(n.where_clause).includes('"'+m.column+'"'))conditioned=true;});
   if(!conditioned&&!/\b(by|per|each|breakdown|split|versus|vs)\b/i.test(question))throw new Error(`The question asks for "${m.text}": filter on boolean column ${m.table}.${m.column} (WHERE ${m.column}).`);
  }
  // 6b2. count(DISTINCT <category or flag>) counts categories, not records, unless the user asks for distinct kinds.
  if(!/\b(distinct|different|unique|kinds?|types?|variety|how many \w+ (values|categories|options))\b/i.test(question))walk(root.select_list,n=>{
   if(n.class!=='FUNCTION'||n.function_name?.toLowerCase()!=='count'||!n.distinct||n.children?.[0]?.class!=='COLUMN_REF')return;
   const col=n.children[0].column_names.at(-1);const def=sourceTables.flatMap(t=>t.columns).find(c=>c.name===col);
   if(def&&(def.type==='BOOLEAN'||(def.values.length>0&&def.values.length<=16&&!catalog.tables.some(t=>t.primaryKey===col))))throw new Error(`count(DISTINCT ${col}) counts the number of ${col} categories, not records. Count rows with count(*) and filter WHERE ${def.type==='BOOLEAN'?col:col+" = '<value>'"}.`);
  });
  // 6c. Counting distinct keys of an entity the user never mentioned counts the wrong thing
  // ("applications with the most vulnerabilities" counts vulnerability rows, not distinct servers).
  if(root.type==='SELECT_NODE'){
   const fromTables=baseTables(root.from_table).map(t=>t.name);
   const tableMentions=new Set(grounding.mentions.filter(m=>m.kind==='table').map(m=>m.table));
   const measured=fromTables.filter(t=>tableMentions.has(t));
   for(const e of root.select_list as Node[]){
    if(e.class!=='FUNCTION'||e.function_name?.toLowerCase()!=='count'||!e.distinct||e.children?.[0]?.class!=='COLUMN_REF')continue;
    const key=e.children[0].column_names.at(-1);
    const owner=catalog.tables.find(t=>t.primaryKey===key);
    if(!owner||tableMentions.has(owner.name)||!measured.length)continue;
    const child=measured.find(t=>t!==owner.name&&catalog.table(t).relationships.some(r=>r.endsWith(' = '+owner.name+'.'+key)));
    if(child){const pk=catalog.table(child).primaryKey;const alias=baseTables(root.from_table).find(t=>t.name===child)!.alias;
     if(pk){e.children=[{class:'COLUMN_REF',type:'COLUMN_REF',alias:'',query_location:0,column_names:[alias,pk]}];notes.push(`The question counts ${child}; counted distinct ${child}.${pk} instead of distinct ${owner.name}.`);}
     else throw new Error(`The question counts ${child}, not distinct ${owner.name}. Use count(*) of ${child} rows.`);}
   }
  }
  // 6f. count(DISTINCT x) where x is fixed to one value is always 1.
  walk(root,n=>{
   if(n.type!=='SELECT_NODE')return;
   const fixed=new Set<string>();walk(n.where_clause,c=>{if(c.class==='COMPARISON'&&c.type==='COMPARE_EQUAL'&&c.left?.class==='COLUMN_REF'&&c.right?.class==='CONSTANT')fixed.add(c.left.column_names.at(-1));});
   for(const e of (n.select_list||[]) as Node[])if(e.class==='FUNCTION'&&e.function_name?.toLowerCase()==='count'&&e.distinct&&e.children?.[0]?.class==='COLUMN_REF'&&fixed.has(e.children[0].column_names.at(-1))){notes.push(`count(DISTINCT ${e.children[0].column_names.at(-1)}) is always 1 when that column is fixed; counted matching rows instead.`);e.function_name='count_star';e.children=[];e.distinct=false;}
  });
  // 6g. Proper nouns the user named (e.g. "Antarctica") must be used as a filter, even if no row matches.
  const properNouns=grounding.unknownTerms.filter(t=>new RegExp('(?<![.?!]\\s)(?<!^)\\b'+t.charAt(0).toUpperCase()+t.slice(1)+'\\b').test(question.trim()));
  for(const noun of properNouns)if(!sql.toLowerCase().includes(noun.toLowerCase())&&!notes.some(x=>x.startsWith('Assumed')))throw new Error(`The question names "${noun}" but the query ignores it. Filter the column that would hold it (e.g. WHERE column = '${noun.charAt(0).toUpperCase()+noun.slice(1)}'); an empty result is a valid answer.`);
  // 6h. A table the user explicitly asked about must be part of the query.
  const usedTables=new Set<string>();walk(root,n=>{if(n.type==='BASE_TABLE')usedTables.add(n.table_name.toLowerCase());});
  const askedTables=[...new Set(grounding.mentions.filter(m=>m.kind==='table'&&m.confidence>=1).map(m=>m.table))];
  // A one-to-one extension table (unique foreign key to the asked table) stands in for it.
  const oneToOne=(asked:string)=>catalog.tables.some(t=>usedTables.has(t.name.toLowerCase())&&t.relationships.some(r=>{const [l,rr]=r.split(' = ');if(!rr.startsWith(asked+'.'))return false;const col=t.columns.find(c=>c.name===l.split('.')[1]);return col?.profile?.distinctCount===t.rowCount;}));
  const missingTables=askedTables.filter(t=>!usedTables.has(t.toLowerCase())&&!oneToOne(t));
  if(missingTables.length&&usedTables.size&&!options.allowedLiterals?.length)throw new Error(`The question is about ${missingTables.join(', ')} but the query does not read ${missingTables.length>1?'those tables':'that table'}. Join path: ${joinPath(catalog,[...missingTables,...[...usedTables].filter(t=>catalog.tables.some(x=>x.name===t))])}.`);
  // 6i. Contradictory bounds on one date column (x >= d AND x < d) can never match.
  const bounds=new Map<string,{lo?:string;hi?:string}>();
  walk(root.where_clause,n=>{
   if(n.class!=='COMPARISON'||n.left?.class!=='COLUMN_REF')return;
   const text=JSON.stringify(n.right);if(/COLUMN_REF|INTERVAL|to_days|date_trunc|"function_name":"[-+]"/.test(text))return;
   const date=text.match(/\d{4}-\d{2}-\d{2}/)?.[0];if(!date)return;const col=n.left.column_names.at(-1);const b=bounds.get(col)||{};
   if(['COMPARE_GREATERTHANOREQUALTO','COMPARE_GREATERTHAN'].includes(n.type))b.lo=!b.lo||date>b.lo?date:b.lo;
   if(['COMPARE_LESSTHAN','COMPARE_LESSTHANOREQUALTO'].includes(n.type))b.hi=!b.hi||date<b.hi?date:b.hi;
   bounds.set(col,b);
  });
  for(const [col,b] of bounds)if(b.lo&&b.hi&&b.lo>=b.hi)throw new Error(`Date filter ${col} vs ${b.lo} excludes all data: the range ${b.lo} .. ${b.hi} is empty.`);
  // 6j. "oldest/earliest" means min(date), "latest/newest/most recent" means max(date).
  const wantsMin=/\b(oldest|earliest|first)\b/i.test(question),wantsMax=/\b(newest|latest|most recent|last)\b/i.test(question);
  if(wantsMin!==wantsMax&&root.type==='SELECT_NODE')for(const e of root.select_list as Node[]){
   if(e.class!=='FUNCTION'||!['min','max'].includes(e.function_name?.toLowerCase())||e.children?.[0]?.class!=='COLUMN_REF')continue;
   if(!dateFields.has(e.children[0].column_names.at(-1)))continue;
   const want=wantsMin?'min':'max';if(e.function_name.toLowerCase()!==want){notes.push(`Used ${want}() for "${wantsMin?'oldest/earliest':'latest/newest'}".`);e.function_name=want;}
  }
  // 6n. Requested filters on different columns are combined with AND unless the user said "or".
  if(!/\b(or|either|any of)\b/i.test(question)){
   const requested=new Set(grounding.mentions.filter(m=>m.kind==='value').map(m=>String(m.value)));
   walk(root.where_clause,n=>{
    if(n.class!=='CONJUNCTION'||n.type!=='CONJUNCTION_OR')return;
    const cols=new Set<string>();let allRequested=true;
    for(const c of n.children||[]){if(c.class==='COMPARISON'&&c.left?.class==='COLUMN_REF'&&c.right?.class==='CONSTANT'){cols.add(c.left.column_names.at(-1));if(!requested.has(String(c.right.value?.value)))allRequested=false;}else allRequested=false;}
    if(allRequested&&cols.size===(n.children||[]).length&&cols.size>1){n.type='CONJUNCTION_AND';notes.push('Combined requested filters with AND (the question did not say "or").');}
   });
  }
  // 6c2. "how many <X> ..." counts X rows, not distinct keys of another table.
  {
   const n=norm(grounding.normalized);let lead=n.match(/\b(?:how many|number of|count of|count|total number of)\s+(?:\w+\s+){0,3}?/);
   // "failed backups on servers in London": a leading noun phrase is what is counted.
   if(!lead&&grounding.mentions.some(m=>m.kind==='table'&&n.indexOf(norm(m.text))>=0&&n.indexOf(norm(m.text))<=n.split(' ').slice(0,3).join(' ').length))lead=n.match(/^/);
   if(lead&&root.type==='SELECT_NODE'&&!(root.group_expressions||[]).length){
    const start=n.indexOf(lead[0]);
    const first=grounding.mentions.filter(m=>m.kind==='table'&&n.indexOf(norm(m.text))>=start).sort((a,b)=>n.indexOf(norm(a.text))-n.indexOf(norm(b.text)))[0];
    if(first&&n.indexOf(norm(first.text))-start<=lead[0].length+25){
     const measured=catalog.table(first.table);
     walk(root.select_list,e=>{
      if(e.class!=='FUNCTION'||e.function_name?.toLowerCase()!=='count'||!e.distinct||e.children?.[0]?.class!=='COLUMN_REF')return;
      const key=e.children[0].column_names.at(-1);const owner=catalog.tables.find(t=>t.primaryKey===key);
      if(owner&&owner.name!==measured.name&&baseTables(root.from_table).some(t=>t.name===measured.name))throw new Error(`The question counts ${measured.name} ("how many ${first.text}"), not distinct ${owner.name}. Use count(*) of ${measured.name}${measured.primaryKey?` or count(DISTINCT ${measured.name}.${measured.primaryKey})`:''}.`);
     });
    }
   }
  }
  // 6p. "last/past/next N days|weeks|months" must use exactly that window around the reference date.
  if(catalog.referenceDate){
   const w=question.match(/\b(last|past|previous|next|coming|within the (?:last|next))\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|thirty|ninety)\s+(day|days|week|weeks|month|months|year|years)\b/i);
   if(w){
    const words:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,twelve:12,thirty:30,ninety:90};
    const k=Number(w[2])||words[w[2].toLowerCase()];const unit=w[3].toLowerCase().replace(/s$/,'');
    const days=unit==='day'?k:unit==='week'?7*k:0;
    const ref=new Date(catalog.referenceDate+'T00:00:00Z');const forward=/next|coming/i.test(w[1]);
    const boundary=days?new Date(ref.getTime()+(forward?1:-1)*days*86400000).toISOString().slice(0,10):'';
    const text=JSON.stringify(root);
    const intervalOk=new RegExp(`"value":${k}\\b[^}]*\\}[^\\]]*?to_${unit}s|to_${unit}s"[^\\]]*?"value":${k}\\b|INTERVAL[^\\]]*${k}`,'i').test(text)||new RegExp(`to_${unit}s[\\s\\S]{0,200}?"value":${k}[,}]`,'i').test(text)||new RegExp(`"value":"${k} ${unit}`,'i').test(text);
    const literalOk=boundary&&text.includes(boundary);
    const calendarOk=/month|quarter|year/.test(unit)&&/date_trunc/.test(text)&&new RegExp(`"value":(${k}|${k-1})\\b`).test(text);
    if(!intervalOk&&!literalOk&&!calendarOk)throw new Error(`The question asks for the ${w[1]} ${k} ${w[3]}: use ${forward?`col >= DATE '${catalog.referenceDate}' AND col < DATE '${catalog.referenceDate}' + INTERVAL ${k} ${unit.toUpperCase()}`:`col >= DATE '${catalog.referenceDate}' - INTERVAL ${k} ${unit.toUpperCase()}`}.`);
   }
  }
  // 6r. Listing an entity's ID when the user asked about that entity: show its name too.
  if(root.type==='SELECT_NODE'&&!(root.group_expressions||[]).length){
   const named=new Set(grounding.mentions.filter(m=>m.kind==='table').map(m=>m.table));
   for(const e of root.select_list as Node[]){
    if(e.class!=='COLUMN_REF')continue;const col=e.column_names.at(-1);
    const owner=catalog.tables.find(t=>t.primaryKey===col&&named.has(t.name));if(!owner)continue;
    // Only foreign keys: the ID of the queried table itself identifies its rows.
    if(baseTables(root.from_table)[0]?.name===owner.name)continue;
    const label=owner.columns.find(c=>c.type==='VARCHAR'&&c.name!==col&&/(^|_)(name|title|hostname)$/.test(c.name));
    if(label&&!(root.select_list as Node[]).some(x=>x.class==='COLUMN_REF'&&x.column_names.at(-1)===label.name))throw new Error(`The question asks about ${owner.name}: select ${owner.name}.${label.name} (join ${owner.name} if needed) instead of only ${col}.`);
   }
  }
  // 6s. Two different values for one column joined by AND can never match.
  {
   const eq=new Map<string,Set<string>>();
   const collect=(n:Node|null)=>{if(!n)return;if(n.class==='CONJUNCTION'&&n.type==='CONJUNCTION_AND'){(n.children||[]).forEach(collect);return;}
    if(n.class==='COMPARISON'&&n.type==='COMPARE_EQUAL'&&n.left?.class==='COLUMN_REF'&&n.right?.class==='CONSTANT'){const k=n.left.column_names.join('.');eq.set(k,new Set([...(eq.get(k)||[]),String(n.right.value?.value)]));}};
   collect(root.where_clause);
   for(const [col,vals] of eq)if(vals.size>1)throw new Error(`${col} cannot equal both ${[...vals].map(v=>`'${v}'`).join(' and ')}. Use only the value the question asks for${/\b(or|either)\b/i.test(question)?' or IN (...) for alternatives':''}.`);
  }
  // 6t. Numeric thresholds the user stated ("more than 100 cpu cores") must be applied as written.
  for(const cond of numericConditions(grounding,catalog)){
   if(!sourceTables.some(t=>t.name===cond.table))continue;
   let ok=false;
   walk(root,n=>{
    if(n.class==='COMPARISON'&&n.left?.class==='COLUMN_REF'&&n.left.column_names.at(-1)===cond.column&&n.right?.class==='CONSTANT'&&Number(n.right.value?.value)===cond.value){
     const op={COMPARE_GREATERTHAN:'>',COMPARE_GREATERTHANOREQUALTO:'>=',COMPARE_LESSTHAN:'<',COMPARE_LESSTHANOREQUALTO:'<=',COMPARE_EQUAL:'='}[n.type as string];
     if(op===cond.op)ok=true;
    }
    if(n.class==='BETWEEN'&&n.input?.column_names?.at(-1)===cond.column)ok=true;
   });
   if(!ok)throw new Error(`The question asks for ${cond.column} ${cond.op} ${cond.value} ("${cond.text}"): add WHERE ${cond.column} ${cond.op} ${cond.value}.`);
  }
  // 6d. Two result columns computing the same aggregate cannot compare groups.
  if(root.type==='SELECT_NODE'){
   const aggs=(root.select_list as Node[]).filter(e=>e.class==='FUNCTION'&&AGGREGATES.includes(e.function_name?.toLowerCase())).map(e=>signature({...e,alias:''}));
   if(aggs.length!==new Set(aggs).size)throw new Error('Several result columns compute the identical aggregate. To compare groups, GROUP BY the compared column (with WHERE column IN (...)) or use count(*) FILTER (WHERE ...) per group.');
  }
  // 6e. Date filters entirely outside the stored range return nothing by construction.
  const ranges=new Map(sourceTables.flatMap(t=>t.columns.filter(c=>/DATE|TIMESTAMP/.test(c.type)&&c.profile?.min!==undefined).map(c=>[c.name,c.profile!] as const)));
  walk(root.where_clause,n=>{
   if(n.class!=='COMPARISON'||n.left?.class!=='COLUMN_REF')return;
   const col=n.left.column_names.at(-1);const range=ranges.get(col);if(!range)return;
   let hasColumn=false;walk(n.right,x=>{if(x.class==='COLUMN_REF')hasColumn=true;});if(hasColumn)return;
   const text=JSON.stringify(n.right);if(/INTERVAL|to_days|to_months|to_years|date_trunc|"function_name":"[-+]"/.test(text))return;
   const date=text.match(/\d{4}-\d{2}-\d{2}/)?.[0];if(!date)return;
   // Comparisons against "today" (the reference date) are the user's own window; an empty answer is valid.
   if(date===catalog.referenceDate)return;
   const min=String(range.min).slice(0,10),max=String(range.max).slice(0,10);
   if(n.type==='COMPARE_EQUAL'&&(date>max||date<min.slice(0,10))||(n.type==='COMPARE_GREATERTHANOREQUALTO'&&date>max)||(n.type==='COMPARE_GREATERTHAN'&&date>=max)||(n.type==='COMPARE_LESSTHAN'&&date<=min)||(n.type==='COMPARE_LESSTHANOREQUALTO'&&date<min))throw new Error(`Date filter ${col} vs ${date} excludes all data (${col} ranges ${min} .. ${max}). Remove it or use the requested period.`);
  });
  // 6k. Superlatives and totals need an aggregate ("which estate has the most servers", "total disk").
  if(root.type==='SELECT_NODE'){
   let hasAggregate=false;walk({s:root.select_list,m:root.modifiers,h:root.having},n=>{if(n.class==='FUNCTION'&&AGGREGATES.includes(n.function_name?.toLowerCase()))hasAggregate=true;});
   let innerAggregate=false;walk(root.from_table,n=>{if(n.class==='FUNCTION'&&AGGREGATES.includes(n.function_name?.toLowerCase()))innerAggregate=true;});walk(root.cte_map,n=>{if(n.class==='FUNCTION'&&AGGREGATES.includes(n.function_name?.toLowerCase()))innerAggregate=true;});
   const countable=/(?<!\bat )\b(most|least|fewest|highest number|lowest number|top \d+|top|biggest|largest|smallest)\b/i.test(question)&&grounding.mentions.some(m=>m.kind==='table');
   const total=/\b(total|sum of|combined|altogether|average|avg|mean)\b/i.test(question);
   if(!hasAggregate&&!innerAggregate&&!/\b(oldest|newest|earliest|latest|first|last)\b/i.test(question)){
    if(countable)throw new Error('The question ranks by a quantity ("most/top/least"): compute it with count(*) or another aggregate, GROUP BY the label, ORDER BY the aggregate DESC and LIMIT.');
    if(total)throw new Error('The question asks for a total/average: use sum(), avg() or count() instead of listing rows.');
   }
  }
  // 6m. "fewest/least/lowest" must sort the measure ascending, "most/highest/top" descending.
  const wantAsc=/(?<!\bat )\b(fewest|least|lowest|smallest|minimum|bottom)\b/i.test(question),wantDesc=/(?<!\bat )\b(most|highest|largest|biggest|maximum|top)\b/i.test(question);
  if(wantAsc!==wantDesc&&root.type==='SELECT_NODE'){
   const aliases=new Set((root.select_list as Node[]).filter(e=>e.class==='FUNCTION'&&AGGREGATES.includes(e.function_name?.toLowerCase())&&e.alias).map(e=>e.alias.toLowerCase()));
   const isAgg=(x:Node)=>(x.class==='FUNCTION'&&AGGREGATES.includes(x.function_name?.toLowerCase()))||(x.class==='COLUMN_REF'&&x.column_names.length===1&&aliases.has(String(x.column_names[0]).toLowerCase()))||(x.class==='CONSTANT'&&typeof x.value?.value==='number'&&(()=>{const e=(root.select_list as Node[])[x.value.value-1];return e?.class==='FUNCTION'&&AGGREGATES.includes(e.function_name?.toLowerCase());})());
   for(const m of root.modifiers||[])if(m.type==='ORDER_MODIFIER')for(const o of m.orders||[]){
    if(!isAgg(o.expression))continue;const want=wantAsc?'ASCENDING':'DESCENDING';
    if(o.type!==want&&!(want==='ASCENDING'&&o.type==='ORDER_DEFAULT')){o.type=want;notes.push(`Sorted ${wantAsc?'ascending for "fewest/least"':'descending for "most/top"'}.`);}
   }
  }
  // 6o. "X by <column>" / "breakdown by <column>": the result must be grouped by that column.
  {
   const n=norm(grounding.normalized).replace(/^(?:(?:show|give|get)\s+(?:me\s+)?(?:the\s+|a\s+)?)?(.+?)\s+(breakdown|distribution|split|mix)$/,'$2 by $1');const by=n.match(/\b(?:by|per|each|across)\s+(?:the\s+)?/);
   if(by&&root.type==='SELECT_NODE'){
    const after=n.indexOf(by[0])+by[0].length;
    const at=(t:string)=>{const w=norm(t).split(' ');const i=n.indexOf(norm(t));return i>=0?i:n.search(new RegExp('\\b'+w.at(-1)+'\\b'));};
    const tableNamed=new Set(grounding.mentions.filter(m=>m.kind==='table').map(m=>m.table));
    const tableWords=new Set(grounding.mentions.filter(m=>m.kind==='table').map(m=>m.text));
    const target=grounding.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.6&&!tableWords.has(m.text)&&at(m.text)>=after&&sourceTables.some(t=>t.name===m.table)&&!/_id$/.test(m.column!)).sort((a,b)=>at(a.text)-at(b.text)||b.confidence-a.confidence||Number(tableNamed.has(b.table))-Number(tableNamed.has(a.table)))[0];
    const sameName=target?grounding.mentions.filter(m=>m.kind==='column'&&m.column===target.column&&m.text===target.text):[];
    const owner=sameName.length>1?(sameName.find(m=>tableNamed.has(m.table))||target):target;
    // "per server" (normalisation) vs "by server operating system" (an attribute of the table).
    // "average memory per server in Production": "per <table>" not followed by one of its attributes normalises.
    const tableAtBy=grounding.mentions.find(m=>m.kind==='table'&&n.indexOf(norm(m.text))===after);
    const nextWord=tableAtBy?n.slice(after+norm(tableAtBy.text).length).trim().split(' ')[0]:'';
    const measuredSelf=(!target&&grounding.mentions.some(m=>m.kind==='table'&&n.indexOf(norm(m.text))>=after))||(tableAtBy!==undefined&&!grounding.mentions.some(c=>c.kind==='column'&&c.table===tableAtBy.table&&!/_id$/.test(c.column!)&&norm(c.text).split(' ')[0]===nextWord));
    if(target&&!measuredSelf){
     const fromTables=baseTables(root.from_table);
     const tableOf=(x:Node)=>x.column_names.length>1?fromTables.find(t=>t.alias.toLowerCase()===String(x.column_names[0]).toLowerCase())?.name:undefined;
     let grouped=false;walk(root.group_expressions,x=>{if(x.class==='COLUMN_REF'&&x.column_names.at(-1)===target.column){const t=tableOf(x);if(!t||t===owner!.table||sameName.length<2)grouped=true;else throw new Error(`Group by ${owner!.table}.${target.column} (the question says "${target.text}" of ${owner!.table}), not ${t}.${target.column}.`);}});
     (root.group_expressions||[]).forEach((g:Node)=>{if(g.class==='CONSTANT'&&typeof g.value?.value==='number'){const e=(root.select_list as Node[])[g.value.value-1];if(e?.class==='COLUMN_REF'&&e.column_names.at(-1)===target.column)grouped=true;}});
     if(!grouped)throw new Error(`The question asks for a breakdown by ${target.column}: SELECT ${target.column}, count(*) ... GROUP BY ${target.column}.`);
     // Extra grouping columns the user did not ask for split the answer into the wrong groups.
     const mentionedCols=new Set(grounding.mentions.filter(m=>m.column).map(m=>m.column));
     const extra=(root.group_expressions as Node[]).map(g=>g.class==='CONSTANT'&&typeof g.value?.value==='number'?(root.select_list as Node[])[g.value.value-1]:g).filter(g=>g?.class==='COLUMN_REF'&&!mentionedCols.has(g.column_names.at(-1))&&!catalog.tables.some(t=>t.primaryKey===g.column_names.at(-1))&&!/(^|_)(name|title|hostname)$/.test(g.column_names.at(-1)));
     if(extra.length)throw new Error(`Group only by ${target.column}; remove ${extra.map(g=>g.column_names.at(-1)).join(', ')} from GROUP BY (not requested).`);
    }
   }
  }
  // 6q. "which <X> has the most ..." names a label: the answer must be grouped by it.
  // Only when a label is named before the superlative ("which estate has the most", not "what is the largest disk").
  if(root.type==='SELECT_NODE'&&/^\s*(which|what)\s+(?!is\b|are\b|was\b|were\b)\w+(?:\s+\w+)?\s+(has|have|had|is|are|with|gets?|sees?|shows?)\b/i.test(question)&&/\b(most|least|fewest|highest|lowest|top|biggest|largest)\b/i.test(question)&&!(root.group_expressions||[]).length){
   let aggregate=false;walk(root.select_list,n=>{if(n.class==='FUNCTION'&&AGGREGATES.includes(n.function_name?.toLowerCase()))aggregate=true;});
   const columnOnly=(root.select_list as Node[]).every(e=>e.class==='FUNCTION');
   if(aggregate&&columnOnly)throw new Error('The question asks "which ... most": return the label with its measure — SELECT label, count(*) ... GROUP BY label ORDER BY count(*) DESC LIMIT 1.');
  }
  // 6l. count(DISTINCT T.key) inside groups of T's own label is always 1.
  if(root.type==='SELECT_NODE'&&(root.group_expressions||[]).length){
   const from=baseTables(root.from_table);
   const groupRefs=(root.group_expressions as Node[]).map(g=>g.class==='CONSTANT'&&typeof g.value?.value==='number'?(root.select_list as Node[])[g.value.value-1]:g).filter(Boolean);
   const groupTables=new Set(groupRefs.filter(g=>g.class==='COLUMN_REF').map(g=>{const parts=g.column_names as string[];if(parts.length>1)return from.find(t=>t.alias.toLowerCase()===parts[0].toLowerCase())?.name;return from.find(t=>catalog.tables.find(x=>x.name===t.name)?.columns.some(c=>c.name===parts[0]))?.name;}).filter(Boolean));
   for(const e of root.select_list as Node[]){
    if(e.class!=='FUNCTION'||e.function_name?.toLowerCase()!=='count'||!e.distinct||e.children?.[0]?.class!=='COLUMN_REF')continue;
    const key=e.children[0].column_names.at(-1);const owner=catalog.tables.find(t=>t.primaryKey===key&&groupTables.has(t.name));
    if(owner&&groupTables.size===1)throw new Error(`count(DISTINCT ${key}) per ${owner.name} group is always 1. Count the related rows instead (count(*) or count(DISTINCT <child>.<key>)).`);
   }
  }
  // 7. "by X"/"per X"/"each X" requires X labels in grouped output.
  const projected=(root.select_list||[]) as Node[];const lower=question.toLowerCase();
  // 7a. The requested grouping field lives in a table the query never reads ("average downtime by environment"
  // grouped by priority): join that table instead of grouping by something else.
  if(projected.some(e=>e.class==='FUNCTION'&&AGGREGATES.includes(e.function_name?.toLowerCase()))&&root.type==='SELECT_NODE'){
   for(const m of grounding.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.9&&!/_id$/.test(m.column!))){
    if(!new RegExp('\\b(?:by|each|per|every)\\s+(?:the\\s+)?'+norm(m.text)+'\\b').test(norm(question)))continue;
    if(sourceTables.some(t=>t.columns.some(c=>c.name===m.column)))continue;
    throw new Error(`The question groups by ${m.table}.${m.column}, but the query does not read ${m.table}. Join path: ${joinPath(catalog,[...sourceTables.map(t=>t.name),m.table])}. GROUP BY ${m.table}.${m.column}.`);
   }
  }
  if(projected.some(e=>e.class==='FUNCTION'&&AGGREGATES.includes(e.function_name?.toLowerCase()))&&!projected.some(e=>e.class==='STAR')&&root.type==='SELECT_NODE'&&!root.from_table?.subquery)
   for(const t of sourceTables)for(const column of t.columns){
    if(column.values.length<2)continue;
    const label=column.name.replaceAll('_',' ');
    if(new RegExp('\\b(?:by|each|per|every)\\s+(?:the\\s+)?'+label+'\\b').test(lower)&&!projected.some(e=>e.class==='COLUMN_REF'&&e.column_names?.at(-1)===column.name))throw new Error('Requested category '+column.name+' is missing from the result. GROUP BY '+column.name+' and project its labels.');
   }
 }
 if(!notes.length)return {sql,notes};
 return {sql:await deparse(ast,catalog),notes};
}

// Join synthesis: rebuild a SELECT's FROM clause from verified relationships, adding bridge tables
// and any table referenced by qualifier but never joined. Non-key ON predicates move to WHERE.
export async function rebuildJoins(sql:string,catalog:Catalog,extraTables:string[]=[]):Promise<string|null>{
 const ast=await parse(sql,catalog);const node=ast.statements[0].node as Node;
 const target=node.type==='SELECT_NODE'?node:null;if(!target||!target.from_table)return null;
 if(!['BASE_TABLE','JOIN'].includes(target.from_table.type))return null;
 const present=baseTables(target.from_table);if(!present.length)return null;
 const aliases=new Map(present.map(t=>[t.alias.toLowerCase(),t]));
 const tableNames=new Set(catalog.tables.map(t=>t.name.toLowerCase()));
 const want=[...present];
 walk({s:target.select_list,w:target.where_clause,g:target.group_expressions,h:target.having,m:target.modifiers,j:target.from_table},n=>{
  if(n.class==='COLUMN_REF'&&n.column_names?.length===2){const q=String(n.column_names[0]).toLowerCase();if(!aliases.has(q)&&tableNames.has(q)){const t={name:catalog.table(q).name,alias:q};aliases.set(q,t);want.push(t);}}
 });
 for(const extra of extraTables)if(!want.some(t=>t.name===extra)){const t={name:extra,alias:extra};aliases.set(extra,t);want.push(t);}
 // Keep non-equality ON predicates by moving them into WHERE.
 const moved:Node[]=[];
 walk(target.from_table,n=>{if(n.type==='JOIN'&&n.condition){const parts=n.condition.class==='CONJUNCTION'&&n.condition.type==='CONJUNCTION_AND'?n.condition.children:[n.condition];for(const c of parts)if(!(c.class==='COMPARISON'&&c.left?.class==='COLUMN_REF'&&c.right?.class==='COLUMN_REF'))moved.push(c);}});
 const names=catalog.connect(want.map(t=>t.name));
 for(const n of names)if(!want.some(t=>t.name===n))want.push({name:n,alias:n});
 const edges=catalog.tables.flatMap(t=>t.relationships).map(r=>r.split(' = ').map(x=>x.split('.')));
 const joined=[want[0]];const clauses:string[]=[];let guard=0;
 while(joined.length<want.length&&guard++<20){
  for(const t of want){
   if(joined.includes(t))continue;
   const link=edges.find(([[a],[b]])=>(a===t.name&&joined.some(j=>j.name===b))||(b===t.name&&joined.some(j=>j.name===a)));
   if(!link)continue;
   const [[a,key],[b]]=link;const other=joined.find(j=>j.name===(a===t.name?b:a))!;
   clauses.push(`JOIN "${t.name}" AS "${t.alias}" ON "${other.alias}"."${key}" = "${t.alias}"."${key}"`);joined.push(t);
  }
 }
 if(joined.length<want.length)return null;
 const fromSql=`SELECT 1 FROM "${want[0].name}" AS "${want[0].alias}" ${clauses.join(' ')}`;
 const fresh=(await parse(fromSql,catalog)).statements[0].node;
 target.from_table=fresh.from_table;
 if(moved.length){
  const conj={class:'CONJUNCTION',type:'CONJUNCTION_AND',alias:'',query_location:0,children:[...(target.where_clause?[target.where_clause]:[]),...moved]};
  target.where_clause=conj.children.length===1?conj.children[0]:conj;
 }
 return deparse(ast,catalog);
}

// Adds a missing requested equality filter to the SELECT that reads the table.
export async function injectFilter(sql:string,catalog:Catalog,table:string,column:string,value:string|true){
 const ast=await parse(sql,catalog);let done=false;
 const targets:Node[]=[];walk(ast.statements[0].node,n=>{if(n.type==='SELECT_NODE'&&baseTables(n.from_table).some(t=>t.name===table))targets.push(n);});
 const target=targets[0];if(!target)return null;
 const alias=baseTables(target.from_table).find(t=>t.name===table)!.alias;
 const cond=await expression(value===true?`"${alias}"."${column}"`:`"${alias}"."${column}" = ${sqlLiteral(value)}`,catalog);
 target.where_clause=target.where_clause?{class:'CONJUNCTION',type:'CONJUNCTION_AND',alias:'',query_location:0,children:[target.where_clause,cond]}:cond;done=true;
 return done?deparse(ast,catalog):null;
}

// Deterministic repair of common mechanical SQL errors before spending a model call, plus
// precise hints for the model when the fix needs judgement.
export async function autoRepair(sql:string,error:string,catalog:Catalog):Promise<{sql?:string;hint:string}>{
 const missingFilter=error.match(/Explicit requested categorical filter missing: (\w+)\.(\w+) = '((?:[^']|'')*)'/);
 if(missingFilter){try{const fixed=await injectFilter(sql,catalog,missingFilter[1],missingFilter[2],missingFilter[3].replaceAll("''","'"));if(fixed)return {sql:fixed,hint:`Added requested filter ${missingFilter[1]}.${missingFilter[2]} = '${missingFilter[3]}'.`};}catch{}}
 const missingBoolean=error.match(/filter on boolean column (\w+)\.(\w+)/);
 if(missingBoolean){try{const fixed=await injectFilter(sql,catalog,missingBoolean[1],missingBoolean[2],true);if(fixed)return {sql:fixed,hint:`Added requested condition ${missingBoolean[2]}.`};}catch{}}
 const emptyDate=error.match(/Date filter (\w+) vs (\d{4}-\d{2}-\d{2}) excludes all data/);
 if(emptyDate){try{
  const ast=await parse(sql,catalog);let removed=false;
  const prune=(n:Node|null):Node|null=>{if(!n)return n;
   if(n.class==='CONJUNCTION'&&n.type==='CONJUNCTION_AND'){n.children=n.children.map(prune).filter(Boolean);return n.children.length?n.children.length===1?n.children[0]:n:null;}
   if(n.class==='COMPARISON'&&n.left?.class==='COLUMN_REF'&&n.left.column_names.at(-1)===emptyDate[1]&&/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(n.right))&&!/INTERVAL|to_days|date_trunc/.test(JSON.stringify(n.right))){removed=true;return null;}
   return n;};
  walk(ast.statements[0].node,n=>{if(n.type==='SELECT_NODE')n.where_clause=prune(n.where_clause);});
  if(removed)return {sql:await deparse(ast,catalog),hint:`Removed date filter on ${emptyDate[1]} that excluded all data.`};
 }catch{}}
 const ambiguous=error.match(/Ambiguous reference to column name "([^"]+)" \(use: "([^"]+)"/);
 if(ambiguous){
  try{
   const ast=await parse(sql,catalog);const column=ambiguous[1];
   const candidates=[...error.matchAll(/"([^"]+)\.([^"]+)"/g)].map(m=>m[1]);
   let changed=false;
   walk(ast.statements[0].node,n=>{
    if(n.type!=='SELECT_NODE')return;
    const tables=baseTables(n.from_table);const preferred=tables.find(t=>candidates.includes(t.alias))?.alias||candidates[0];
    walk({s:n.select_list,w:n.where_clause,g:n.group_expressions,h:n.having,m:n.modifiers},c=>{if(c.class==='COLUMN_REF'&&c.column_names?.length===1&&c.column_names[0]===column){c.column_names=[preferred,column];changed=true;}});
   });
   if(changed)return {sql:await deparse(ast,catalog),hint:`Qualified ambiguous column ${column}.`};
  }catch{}
  return {hint:`Qualify the column with its table alias, e.g. ${ambiguous[2]}.`};
 }
 const missingRef=error.match(/Referenced table "([^"]+)" not found/);
 if(missingRef){try{const rebuilt=await rebuildJoins(sql,catalog);if(rebuilt&&rebuilt!==sql)return {sql:rebuilt,hint:`Joined ${missingRef[1]} through verified relationships.`};}catch{}
  return {hint:`Table ${missingRef[1]} is used but not joined. Join path: ${joinPath(catalog,[...new Set([...catalog.tables.filter(t=>new RegExp('\\b'+t.name+'\\b','i').test(sql)).map(t=>t.name)])])}.`};}
 const allColumns=catalog.tables.flatMap(t=>t.columns.map(c=>({table:t.name,column:c.name})));
 const missingColumn=error.match(/Referenced column "([^"]+)" not found/)||error.match(/does not have a column named "([^"]+)"/)||error.match(/column "([^"]+)" (?:not found|does not exist)/i);
 if(missingColumn){
  const name=missingColumn[1].toLowerCase();
  const exact=allColumns.filter(c=>c.column===name);
  const used=catalog.tables.filter(t=>new RegExp('\\b'+t.name+'\\b','i').test(sql)).map(t=>t.name);
  if(exact.length===1&&!used.includes(exact[0].table)&&used.length){try{const rebuilt=await rebuildJoins(sql,catalog,[exact[0].table]);if(rebuilt&&rebuilt!==sql)return {sql:rebuilt,hint:`Joined ${exact[0].table} for column ${name}.`};}catch{}}
  const near=allColumns.map(c=>({...c,d:editDistance(name,c.column,3)})).filter(c=>c.d<=3).sort((a,b)=>a.d-b.d).slice(0,4);
  const rels=catalog.tables.flatMap(t=>t.relationships).join('; ');
  return {hint:exact.length?`Column ${name} lives in ${exact.map(c=>c.table).join(', ')}. Join that table (verified joins: ${rels}) or use its own columns.`:near.length?`No column ${name}. Closest: ${near.map(c=>c.table+'.'+c.column).join(', ')}.`:`No column ${name} exists. Use only columns from the schema.`};
 }
 const missingTable=error.match(/Table with name ([^\s!]+) does not exist/);
 if(missingTable){const name=missingTable[1].replaceAll('"','').toLowerCase();const near=catalog.tables.map(t=>({t:t.name,d:editDistance(name,t.name,4)})).sort((a,b)=>a.d-b.d).slice(0,3);return {hint:`No table ${name}. Tables: ${catalog.tables.map(t=>t.name).join(', ')}. Closest: ${near.map(x=>x.t).join(', ')}.`};}
 if(/Cannot compare values of type (DATE|TIMESTAMP)|Could not convert string .* to (DATE|TIMESTAMP)|No function matches.*(DATE|TIMESTAMP|INTERVAL)/i.test(error))return {hint:`Use DuckDB date syntax: DATE '${catalog.referenceDate||'YYYY-MM-DD'}' - INTERVAL 30 DAY, date_trunc('month', DATE '...'), date_diff('day', a, b). Compare DATE/TIMESTAMP columns only with dates.`};
 const fn=error.match(/Scalar Function with name ([a-z_]+) does not exist/i)||error.match(/Function with name ([a-z_]+) does not exist/i);
 if(fn)return {hint:`DuckDB has no ${fn[1]}(). Use date_diff('day',a,b), date_trunc('month',d), d - INTERVAL 7 DAY, strftime(d,'%Y-%m'), extract(year FROM d), count(*) FILTER (WHERE ...).`};
 if(/must appear in the GROUP BY clause|must be part of an aggregate/i.test(error))return {hint:'Every selected non-aggregated column must be in GROUP BY, or wrap it in an aggregate such as any_value().'};
 if(/Conversion Error|Could not convert/i.test(error))return {hint:'A comparison mixes types. Compare columns only with literals of their own type (booleans with true/false, numbers unquoted).'};
 return {hint:''};
}
export {norm};
