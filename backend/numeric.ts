// Numeric conditions stated in the question ("more than 100 cpu cores", "64 GB memory", "cvss above 9").
// Parsed once from grounding so the grounded draft can apply them and the SQL guard can demand them.
import type {Catalog} from './catalog.js';
import {norm,type Grounding,type Mention} from './grounding.js';

export type NumericCondition={table:string;column:string;op:'>'|'>='|'<'|'<='|'=';value:number;text:string};
const OPS:[RegExp,NumericCondition['op']][]=[
 [/^(more than|greater than|over|above|exceeding|higher than|bigger than|larger than|>)$/,'>'],
 [/^(at least|no less than|minimum of|min of|>=)$/,'>='],
 [/^(less than|fewer than|under|below|lower than|smaller than|<)$/,'<'],
 [/^(at most|no more than|up to|maximum of|max of|<=)$/,'<='],
 [/^(exactly|equal to|equals|of|=|with|having|is)$/,'='],
];
const OP_WORDS='more than|greater than|over|above|exceeding|higher than|bigger than|larger than|at least|no less than|minimum of|min of|less than|fewer than|under|below|lower than|smaller than|at most|no more than|up to|maximum of|max of|exactly|equal to|equals|of|with|having|is';
const UNITS='gb|tb|mb|gib|minutes?|mins?|hours?|cores?|percent|%|points?';
const opOf=(w:string|undefined):NumericCondition['op']=>{if(!w)return '=';for(const [re,op] of OPS)if(re.test(w.trim()))return op;return '=';};

export function numericConditions(g:Grounding,catalog:Catalog):NumericCondition[]{
 const text=norm(g.normalized);const out:NumericCondition[]=[];
 const numeric=(m:Mention)=>/INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL/.test(catalog.table(m.table).columns.find(c=>c.name===m.column)?.type||'');
 const cols=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.6&&numeric(m)&&g.tables.includes(m.table));
 const seen=new Set<string>();
 for(const m of cols){
  const key=m.table+'.'+m.column;if(seen.has(key))continue;
  const col=norm(m.text).split(' ').map(w=>w.replace(/s$/,'')+'s?').join('\\s+');
  // "<op> <n> [unit] [of] <column>"  e.g. "more than 100 cpu cores", "64 gb memory"
  const pre=text.match(new RegExp(`(?:\\b(${OP_WORDS})\\s+)?(\\d+(?:\\.\\d+)?)\\s*(?:${UNITS})?\\s+(?:of\\s+)?(?:\\w+\\s+)?${col}\\b`));
  // "<column> [is] <op> <n>"  e.g. "cvss score above 9", "downtime over 120 minutes"
  const post=text.match(new RegExp(`\\b${col}\\s+(?:is\\s+|are\\s+|of\\s+)?(?:(${OP_WORDS})\\s+)?(\\d+(?:\\.\\d+)?)\\b`));
  // "negative downtime", "zero cost", "positive cvss": sign words are thresholds too.
  const sign=text.match(new RegExp(`\\b(negative|zero|positive|non zero|nonzero)\\s+(?:\\w+\\s+)?${col}\\b`));
  if(!pre&&!post&&sign){seen.add(key);out.push({table:m.table,column:m.column!,op:sign[1]==='negative'?'<':sign[1]==='zero'?'=':'>',value:0,text:sign[0]});continue;}
  const hit=pre||post;if(!hit)continue;
  // "in the last 7 days" is a time window, not a value of a *_days column.
  const before=text.slice(0,text.indexOf(hit[0])).trim().split(' ').at(-1)||'';
  if(/^(last|past|next|within|coming|previous)$/.test(before)||/^(last|past|next|within)\b/.test(hit[0]))continue;
  seen.add(key);out.push({table:m.table,column:m.column!,op:opOf(hit[1]),value:Number(hit[2]),text:hit[0]});
 }
 return out;
}

// Numbers the question uses for something else: top N, time windows, identifiers, codes like P1/Tier 1.
export function unexplainedNumbers(g:Grounding,used:string[]):string[]{
 let text=norm(g.normalized);
 for(const u of used)text=text.replace(norm(u),' ');
 // Longest mentions first, so "host 00010" is removed before its table word "host".
 for(const m of [...g.mentions].sort((a,b)=>b.text.length-a.text.length))text=text.replace(norm(m.text),' ');
 text=text.replace(/\b(top|bottom|first|last|past|next|the|which|what|show|list|give me|find)\s+\d+\b/g,' ').replace(/\b\d+\s+(day|days|week|weeks|month|months|year|years|hours?)\b/g,' ');
 return text.match(/\b\d+(?:\.\d+)?\b/g)||[];
}
