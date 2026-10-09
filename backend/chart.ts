// Chart contract: a typed, validated description of a chart built from executed query results.
// The chart type is chosen deterministically from the result's shape (and the user's wording when they
// ask for a specific type), so every model size gets the same correct chart and no number in a chart is
// ever produced by a model: data points are copied from the evidence rows.
import {z} from 'zod';
import type {Evidence,Row} from './types.js';

export const CHART_TYPES=['kpi','gauge','bar','column','line','area','stackedarea','stacked','percent','grouped','pie','donut','treemap','radial','radar','heatmap','scatter'] as const;
export type ChartType=typeof CHART_TYPES[number];
export const chartSpecSchema=z.object({
 type:z.enum(CHART_TYPES),
 title:z.string().max(160),
 subtitle:z.string().max(240).optional(),
 x:z.object({field:z.string(),label:z.string(),kind:z.enum(['category','time','number'])}),
 series:z.array(z.object({key:z.string(),label:z.string()})).min(1).max(9),
 y:z.object({label:z.string(),format:z.enum(['integer','decimal','percent'])}),
 data:z.array(z.record(z.string(),z.union([z.string(),z.number(),z.null()]))).max(400),
 requested:z.boolean(),
 // Other forms that show the same data correctly (the UI offers them under "View as").
 alternatives:z.array(z.enum(CHART_TYPES)).default([]),
 // Counts and sums add up to a whole (pie, treemap, stacking are valid); averages and maxima do not.
 additive:z.boolean().default(true),
 intent:z.string().optional(),
 note:z.string().max(240).optional(),
 sourceStepIds:z.array(z.string()),
});
export type ChartSpec=z.infer<typeof chartSpecSchema>;

// ---------- 1. What the user asked for ----------
export type ChartRequest={wanted:boolean;type?:ChartType;horizontal?:boolean;question:string;chartOnly:boolean};
const CHART_WORDS=/\b(charts?|graphs?|plots?|plotted|plotting|visuali[sz]e|visuali[sz]ation|diagram|histogram|pie|donut|doughnut|sparkline|tree ?map|heat ?map|gauge)\b/i;
const TYPE_WORDS:[RegExp,ChartType][]=[
 [/\btree ?map\b/i,'treemap'],[/\bheat ?map\b/i,'heatmap'],[/\b(radar|spider|web)\s+(chart|graph|plot)\b|\bradar\b/i,'radar'],[/\bradial\b/i,'radial'],[/\b(gauge|meter|dial)\b/i,'gauge'],
 [/(?:^|\s)100 ?%|\bpercent(age)? stacked\b|\bnormali[sz]ed stacked\b/i,'percent'],[/\bstacked area\b/i,'stackedarea'],
 [/\b(donut|doughnut|ring)\b/i,'donut'],[/\bpie\b/i,'pie'],[/\bscatter\b/i,'scatter'],
 [/\bstacked\b/i,'stacked'],[/\b(grouped|side[- ]by[- ]side|clustered)\b/i,'grouped'],
 [/\barea\b(?=\s+(chart|graph|plot))/i,'area'],[/\b(line|trend ?line)\s+(chart|graph|plot)\b|\bline\b(?=\s*$)/i,'line'],
 [/\bcolumns?\s+(chart|graph)\b/i,'column'],[/\b(bars?|histogram)\b/i,'bar'],
];
// Removes the presentation wording so the data pipeline sees only the data question:
// "show me a pie chart of servers by os" -> "servers by os".
// Common misspellings of chart vocabulary, normalised before parsing.
const CHART_TYPOS:[RegExp,string][]=[[/\b(chrt|cahrt|chatr|chrat|chart's)\b/gi,'chart'],[/\b(grpah|garph|graoh|grap|grahp)\b/gi,'graph'],[/\b(plto|polt)\b/gi,'plot'],[/\b(histogarm|histagram|histrogram)\b/gi,'histogram'],[/\b(visualzie|visulaize|visualse|vizualize)\b/gi,'visualize'],[/\b(doughnut)\b/gi,'donut']];
export function chartRequest(question:string):ChartRequest{
 for(const [re,w] of CHART_TYPOS)question=question.replace(re,w);
 const wanted=CHART_WORDS.test(question)||/\b(as|in|into) an? (bar|line|area|column|pie|donut|stacked|grouped)\b/i.test(question)||/\bvisual(ly)?\b/i.test(question);
 if(!wanted)return {wanted:false,question,chartOnly:false};
 let type:ChartType|undefined;for(const [re,t] of TYPE_WORDS)if(re.test(question)){type=t;break;}
 const horizontal=/\bhorizontal\b/i.test(question);
 const kinds='(?:horizontal |vertical )?(?:100 ?% |percent(?:age)? |normali[sz]ed )?(?:stacked |grouped |clustered |side[- ]by[- ]side )?(?:bar|column|line|area|pie|donut|doughnut|scatter|trend|radar|spider|radial|gauge)?\\s*';
 const noun='(?:charts?|graphs?|plots?|diagram|histogram|visuali[sz]ation|pie|donut|doughnut|tree ?map|heat ?map|gauge)';
 const verbs='(?:show|give|draw|make|create|build|render|generate|plot|chart|graph|visuali[sz]e|display|put|turn|convert)';
 let q=question
  .replace(new RegExp(`[,;]?\\s*(?:and |then )?(?:plot|chart|graph|visuali[sz]e|draw) (?:it|that|this|them|those)\\b`,'gi'),' ')
  .replace(new RegExp(`\\b(?:as|in|into|using|with|on) (?:an? |the )?${kinds}${noun}\\b`,'gi'),' ')
  .replace(new RegExp(`\\b(?:can you |could you |please |pls )*${verbs}(?: me| us)?(?: an?| the)? ${kinds}${noun}\\s*(?:of|for|showing|with|on|about|that shows|to show|comparing)?\\s*`,'gi'),' ')
  .replace(new RegExp(`\\b(?:an?|the) ${kinds}${noun}(?: (?:of|for|showing))?\\b`,'gi'),' ')
  .replace(new RegExp(`\\b${kinds}${noun}(?: (?:of|for|showing))?\\b`,'gi'),' ')
  .replace(/^\s*(?:can you |could you |please |pls )*(?:plot|chart|graph|visuali[sz]e|draw)(?: me| us)?(?: the| a| an)?\s+/i,' ')
  .replace(/\b(visually)\b/gi,' ')
  .replace(/\s+([?.!,])/g,'$1').replace(/\s{2,}/g,' ').trim().replace(/^(?:of|for|me|showing|and|with)\s+/i,'').replace(/^[,.;:]+\s*/,'').replace(/[,;:]+$/,'').trim();
 const chartOnly=!q||/^(?:(?:can you |could you |please )?(?:make|turn|show|display|put|convert|render|draw|give me|redo|do)\s+)?(?:it|that|this|those|these|them|the same|same|the (?:above|previous|last) (?:result|results|answer|data|one)|(?:that|this|the) (?:result|results|answer|data|breakdown|table))?\s*(?:instead|too|also|please|now|again)?[?.!]*$/i.test(q);
 return {wanted:true,type,horizontal,question:chartOnly?question:q,chartOnly};
}

// ---------- 2. Result shape ----------
type ColumnKind='number'|'time'|'category';
const TIME_NAME=/(^|_)(date|day|week|month|year|quarter|period|time|timestamp|hour|bucket)(_|$)|_(at|on)$/i;
const TIME_VALUE=/^\d{4}(-\d{2}(-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?)?|-Q[1-4]|-W\d{2})$/;
const isNum=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)||typeof v==='bigint';
export function columnKind(rows:Row[],column:string):ColumnKind{
 const values=rows.map(r=>r[column]).filter(v=>v!==null&&v!==undefined);
 if(!values.length)return 'category';
 if(values.every(v=>typeof v==='string'&&TIME_VALUE.test(v)))return 'time';
 if(values.every(isNum))return TIME_NAME.test(column)&&/year/i.test(column)&&values.every(v=>Number(v)>1900&&Number(v)<2200)?'time':'number';
 return 'category';
}
const ACRONYMS=/\b(os|cpu|cve|cvss|sla|gb|tb|mb|rto|rpo|ram|ip|id|p[1-4])\b/gi;
const label=(c:string)=>c.replace(/^avg_/,'average_').replace(/^sum_/,'total_').replace(/^(max|min)_/,'$1imum_').replace(/^count_star\(\)$/,'count').replace(/^avg\((\w+)\)$/i,'average $1').replace(/^sum\((\w+)\)$/i,'total $1').replace(/^(max|min)\((\w+)\)$/i,'$1 $2').replace(/^record_count$/,'count').replace(/[_()"*]+/g,' ').replace(/\s+/g,' ').trim().replace(ACRONYMS,w=>w.toUpperCase()).replace(/^./,s=>s.toUpperCase());
const num=(v:unknown)=>v===null||v===undefined?null:Number(v);
const text=(v:unknown)=>v===null||v===undefined?'(none)':typeof v==='boolean'?(v?'Yes':'No'):String(v);
function yFormat(rows:Row[],cols:string[]):ChartSpec['y']['format']{
 if(cols.some(c=>/(pct|percent|percentage|share|ratio|rate)/i.test(c)))return 'percent';
 return rows.every(r=>cols.every(c=>r[c]===null||Number.isInteger(Number(r[c]))))?'integer':'decimal';
}
const MAX_SERIES=8,MAX_CATEGORIES=30,MAX_PIE=7;

// ---------- 3. Building the chart ----------
// A time bucket that ends after the data's reference date is still filling up; its dip is not a trend.
function partialPeriodNote(spec:ChartSpec,referenceDate?:string){
 if(spec.x.kind!=='time'||!referenceDate||!spec.data.length)return undefined;
 const unit=spec.x.field.match(/day|week|month|quarter|year/)?.[0];if(!unit)return undefined;
 const last=String(spec.data.at(-1)![spec.x.field]).slice(0,10);const start=new Date(last+'T00:00:00Z');if(Number.isNaN(start.getTime()))return undefined;
 const end=new Date(start);
 if(unit==='day')end.setUTCDate(end.getUTCDate()+1);else if(unit==='week')end.setUTCDate(end.getUTCDate()+7);else if(unit==='month')end.setUTCMonth(end.getUTCMonth()+1);else if(unit==='quarter')end.setUTCMonth(end.getUTCMonth()+3);else end.setUTCFullYear(end.getUTCFullYear()+1);
 const ref=new Date(referenceDate.slice(0,10)+'T00:00:00Z');
 return ref.getTime()>=start.getTime()&&ref.getTime()<end.getTime()-86400000?`The last ${unit} (from ${last}) is incomplete — data runs to ${referenceDate.slice(0,10)}.`:undefined;
}
// ---------- 3b. What the question is trying to show ----------
// The same rows can be drawn many ways; the user's wording says which reading matters.
export type ChartIntent='share'|'rank'|'compare'|'trend'|'distribution'|'cumulative'|'profile'|'correlation';
export function chartIntent(q:string):ChartIntent|undefined{
 const t=q.toLowerCase();
 if(/\b(cumulative|running total|so far|to date|accumulated)\b/.test(t))return 'cumulative';
 if(/\b(share|proportion|percent(age)?s?|composition|make ?up|made up|split|mix|fraction|part of|portion|breakdown of (the )?total|how .* (is|are) divided)\b/.test(t))return 'share';
 if(/\b(correlat\w*|relationship between|relate to|against each other)\b/.test(t))return 'correlation';
 if(/\b(top|bottom|most|least|fewest|highest|lowest|largest|smallest|biggest|rank\w*|leaders?|worst|best)\b/.test(t))return 'rank';
 if(/\b(compare|comparison|compared|vs|versus|difference between|side by side)\b/.test(t))return 'compare';
 if(/\b(profile|across (all|several|multiple) (metrics|measures)|scorecard)\b/.test(t))return 'profile';
 if(/\b(trend|over time|growth|history|timeline|per (day|week|month|quarter|year)|daily|weekly|monthly|quarterly|yearly)\b/.test(t))return 'trend';
 if(/\b(distribution|distributed|histogram|spread|range of)\b/.test(t))return 'distribution';
 return undefined;
}
const NON_ADDITIVE=/(^|_|\()(avg|average|mean|median|max|maximum|min|minimum|rate|ratio|pct|percent|percentage|share|score|cvss)(_|\(|\)|$)/i;
// Set per chart from the user's wording: "average size by type" is never a part of a whole, whatever the column is called.
let askedNonAdditive=false;
// Shares that add up to the whole (≈100% or ≈1) are parts of a whole even though each is a percentage.
const sumsToWhole=(col:string,rows:Row[])=>{const t=rows.reduce((s,r)=>s+(Number(r[col])||0),0);return Math.abs(t-100)<=1.5||Math.abs(t-1)<=0.015;};
const additiveMeasure=(col:string,rows:Row[])=>!askedNonAdditive&&rows.every(r=>r[col]===null||Number(r[col])>=0)&&(!NON_ADDITIVE.test(col)||(/(pct|percent|percentage|share)/i.test(col)&&sumsToWhole(col,rows)));

export function buildChart(evidence:Evidence[],request:ChartRequest,question:string,referenceDate?:string,userWording?:string):ChartSpec|undefined{
 const usable=evidence.filter(e=>!e.error&&e.tool!=='catalog'&&e.rows.length);
 if(!usable.length)return undefined;
 const title=titleOf(request.wanted?request.question:question);
 const wording=[userWording,request.wanted?request.question:'',question].filter(Boolean).join(' ');
 const intent=chartIntent(wording);
 askedNonAdditive=/\b(average|avg|mean|median|max|maximum|min|minimum|highest|lowest|longest|shortest|largest|smallest)\b/i.test(wording)&&!/\b(how many|number of|count)\b/i.test(wording);
 let spec:ChartSpec|undefined;
 // Several single-number results (comparisons, "counts of X, Y and Z") become one chart.
 if(usable.length>1&&usable.every(e=>e.rows.length===1&&Object.values(e.rows[0]).filter(isNum).length===1)){
  const data=usable.map(e=>{const v=Object.values(e.rows[0]).find(isNum);return {label:shortObjective(e.objective),value:num(v)};});
  spec={type:'column',title,intent,x:{field:'label',label:'',kind:'category'},series:[{key:'value',label:'Value'}],y:{label:'Value',format:data.every(d=>Number.isInteger(d.value))?'integer':'decimal'},data,requested:request.wanted,additive:false,alternatives:['column','bar'],sourceStepIds:usable.map(e=>e.stepId)};
  if(intent==='rank')spec={...spec,type:'bar',data:[...data].sort((a,b)=>Number(b.value)-Number(a.value))};
 }else{
  const e=[...usable].sort((a,b)=>b.rows.length-a.rows.length)[0];
  spec=fromRows(e,title,request.wanted,intent);
 }
 if(!spec)return undefined;
 const out=applyRequest(spec,request);
 const partial=partialPeriodNote(out,referenceDate);
 return partial?{...out,note:joinNotes(out.note,partial)}:out;
}

type Base={title:string;requested:boolean;sourceStepIds:string[];intent?:string};
function fromRows(e:Evidence,title:string,requested:boolean,intent?:ChartIntent):ChartSpec|undefined{
 const rows=e.rows;const columns=Object.keys(rows[0]);
 const kinds=Object.fromEntries(columns.map(c=>[c,columnKind(rows,c)])) as Record<string,ColumnKind>;
 // Identifier-like columns (*_id) are labels, never measures.
 const numbers=columns.filter(c=>kinds[c]==='number'&&!/(^|_)id$/i.test(c));
 const times=columns.filter(c=>kinds[c]==='time');
 const cats=columns.filter(c=>kinds[c]==='category'||(kinds[c]==='number'&&/(^|_)id$/i.test(c)));
 // A percentage computed from a count in the same row is derived: chart the count (shares are shown anyway).
 const derivedPct=rows.length>1&&numbers.length>1&&numbers.some(c=>/count|^n$|total/i.test(c))?numbers.filter(c=>/(pct|percent|percentage|share)/i.test(c)):[];
 for(const d of derivedPct)numbers.splice(numbers.indexOf(d),1);
 const base:Base={title,requested,sourceStepIds:[e.stepId],intent};
 const truncNote=e.truncated?`Showing the first ${rows.length.toLocaleString('en-US')} rows of ${(e.totalRows??e.rowCount).toLocaleString('en-US')}.`:undefined;
 // One row: a figure — or a gauge when it is a share of a whole.
 if(rows.length===1&&numbers.length>=1&&!times.length){
  const pct=numbers.find(c=>/(pct|percent|percentage|share|ratio|rate)/i.test(c));
  const gaugeValue=pct!==undefined?Number(rows[0][pct]):NaN;
  const asGauge=pct!==undefined&&Number.isFinite(gaugeValue)&&gaugeValue>=0&&gaugeValue<=100;
  return {...base,type:asGauge?'gauge':'kpi',x:{field:cats[0]||'label',label:cats[0]?label(cats[0]):'',kind:'category'},series:(asGauge?[pct!,...numbers.filter(n=>n!==pct)]:numbers).slice(0,4).map(c=>({key:c,label:label(c)})),y:{label:label(pct||numbers[0]),format:asGauge?'percent':yFormat(rows,numbers)},data:[Object.fromEntries(columns.map(c=>[c,kinds[c]==='number'?num(rows[0][c]):text(rows[0][c])]))],additive:false,alternatives:asGauge?['gauge','kpi']:[]};
 }
 if(!numbers.length)return undefined;
 if(times.length)return timeChart(base,rows,times[0],cats[0],numbers,intent,truncNote);
 if(cats.length>=2&&numbers.length===1&&rows.length<=MAX_CATEGORIES*MAX_SERIES)return twoCategoryChart(base,rows,cats[0],cats[1],numbers[0],intent,truncNote);
 if(cats.length>=1)return categoryChart(base,rows,cats[0],numbers,intent,truncNote);
 // A numeric field with its row counts ("servers by cpu cores", a histogram): ordered columns.
 const countLike=numbers.filter(c=>/(^|_)(count|records?|n|total|frequency)(_|$)|count/i.test(c));
 if(numbers.length===2&&countLike.length===1){
  const x=numbers.find(c=>c!==countLike[0])!;const m=countLike[0];
  const data=[...rows].sort((a,b)=>Number(a[x])-Number(b[x])).map(r=>({[x]:text(r[x]),[m]:num(r[m])}));
  const capped=capCategories(data,x,[m]);
  return {...base,type:'column',subtitle:`${label(m)} by ${label(x).toLowerCase()}`,x:{field:x,label:label(x),kind:'category'},series:[{key:m,label:label(m)}],y:{label:label(m),format:yFormat(rows,[m])},data:capped.data,note:joinNotes(truncNote,capped.note),additive:true,alternatives:['column','line','area']};
 }
 // Two measures and no labels: one against the other.
 if(numbers.length>=2){
  const [a,b]=numbers;
  return {...base,type:'scatter',subtitle:`${label(b)} against ${label(a)}`,x:{field:a,label:label(a),kind:'number'},series:[{key:b,label:label(b)}],y:{label:label(b),format:yFormat(rows,[b])},data:rows.map(r=>({[a]:num(r[a]),[b]:num(r[b])})),note:truncNote,additive:false,alternatives:['scatter']};
 }
 return undefined;
}

// Time on the x axis: area for one measure, lines per category, stacked area for composition over time,
// a running total for "cumulative", columns when there are only a couple of periods.
function timeChart(base:Base,rows:Row[],t:string,cat:string|undefined,numbers:string[],intent:ChartIntent|undefined,truncNote?:string):ChartSpec{
 const sorted=[...rows].sort((a,b)=>String(a[t]).localeCompare(String(b[t])));
 const measure=numbers[0];const additive=additiveMeasure(measure,rows);
 if(cat){
  const pivot=pivotRows(sorted,t,cat,measure);
  const few=pivot.data.length<=3;
  const type:ChartType=few?'grouped':intent==='share'&&additive?'stackedarea':'line';
  return {...base,type,subtitle:`${label(measure)} by ${label(t).toLowerCase()}, split by ${label(cat).toLowerCase()}`,x:{field:t,label:label(t),kind:'time'},series:pivot.series,y:{label:label(measure),format:yFormat(rows,[measure])},data:pivot.data,note:joinNotes(truncNote,pivot.note),additive,
   alternatives:additive?['line','stackedarea','stacked','percent','grouped','heatmap']:['line','grouped','heatmap']};
 }
 const ms=comparable(rows,numbers).slice(0,MAX_SERIES);
 let data=sorted.map(r=>Object.fromEntries([[t,text(r[t])],...ms.map(c=>[c,num(r[c])])])) as Record<string,string|number|null>[];
 let series=ms.map(c=>({key:c,label:label(c)}));let note=truncNote;
 if(intent==='cumulative'&&ms.length===1&&additive){
  let run=0;const key='cumulative_'+ms[0];
  data=data.map(d=>{run+=Number(d[ms[0]])||0;return {...d,[key]:run};});
  series=[{key,label:'Cumulative '+label(ms[0]).toLowerCase()}];note=joinNotes(note,'Running total of the per-period values.');
  if(!/cumulative|running/i.test(base.title))base={...base,title:'Cumulative '+base.title.charAt(0).toLowerCase()+base.title.slice(1)};
 }
 const type:ChartType=data.length<=3?'column':intent==='cumulative'||ms.length>1?'line':'area';
 return {...base,type,subtitle:`${series.map(s=>s.label).join(', ')} by ${label(t).toLowerCase()}`,x:{field:t,label:label(t),kind:'time'},series,y:{label:series.length===1?series[0].label:'Value',format:yFormat(rows,ms)},data,note,additive,alternatives:['area','line','column']};
}

// Two categories and one measure: stacked (default), 100% stacked for shares, grouped to compare,
// a heatmap when both sides have many values.
function twoCategoryChart(base:Base,rows:Row[],c1:string,c2:string,measure:string,intent:ChartIntent|undefined,truncNote?:string):ChartSpec{
 const [a,b]=distinctCount(rows,c1)>=distinctCount(rows,c2)?[c1,c2]:[c2,c1];
 const pivot=pivotRows(rows,a,b,measure);
 const capped=capCategories(ordinalSort(pivot.data,a),a,pivot.series.map(s=>s.key));
 const additive=additiveMeasure(measure,rows);
 const big=capped.data.length>=5&&pivot.series.length>=4;
 const type:ChartType=!additive?(big?'heatmap':'grouped'):intent==='share'?'percent':intent==='compare'?'grouped':big?'heatmap':'stacked';
 return {...base,type,subtitle:`${label(measure)} by ${label(a).toLowerCase()} and ${label(b).toLowerCase()}`,x:{field:a,label:label(a),kind:'category'},series:pivot.series,y:{label:label(measure),format:yFormat(rows,[measure])},data:capped.data,note:joinNotes(truncNote,pivot.note,capped.note),additive,
  alternatives:additive?['stacked','percent','grouped','heatmap']:['grouped','heatmap']};
}

// One category and measure(s).
function categoryChart(base:Base,rows:Row[],x:string,numbers:string[],intent:ChartIntent|undefined,truncNote?:string):ChartSpec{
 const measures=comparable(rows,numbers).slice(0,MAX_SERIES);
 const all=rows.map(r=>Object.fromEntries([[x,text(r[x])],...measures.map(c=>[c,num(r[c])])])) as Record<string,string|number|null>[];
 const ordinal=Boolean(ordinalOrder(all.map(d=>String(d[x]))));
 const leftOut=measures.length<numbers.length?`${numbers.filter(n=>!measures.includes(n)).map(label).join(', ')} left out (different scale).`:undefined;
 const subtitle=`${measures.map(label).join(', ')} by ${label(x).toLowerCase()}`;
 const y={label:measures.length===1?label(measures[0]):'Value',format:yFormat(rows,measures)};
 if(measures.length>1){
  // Several comparable measures per category: a radar profile when there are enough axes.
  const radar=measures.length>=3&&all.length>=2&&all.length<=8;
  const capped=capCategories(ordinalSort(all,x),x,measures);
  return {...base,type:radar&&(intent==='profile'||intent==='compare'||measures.length>=4)?'radar':'grouped',subtitle,x:{field:x,label:label(x),kind:'category'},series:measures.map(c=>({key:c,label:label(c)})),y,data:capped.data,note:joinNotes(truncNote,capped.note,leftOut),additive:false,alternatives:radar?['grouped','radar','bar']:['grouped','bar']};
 }
 const m=measures[0];const additive=additiveMeasure(m,rows);
 const n=all.length;
 const longLabels=all.some(d=>String(d[x]).length>14);
 // Many categories of a whole: a treemap keeps every one visible.
 if(additive&&n>MAX_CATEGORIES)return {...base,type:'treemap',subtitle,x:{field:x,label:label(x),kind:'category'},series:[{key:m,label:label(m)}],y,data:[...all].sort((a,b)=>Number(b[m])-Number(a[m])).slice(0,120),note:joinNotes(truncNote,n>120?`Showing the 120 largest of ${n}.`:undefined),additive,alternatives:['treemap','bar']};
 const capped=capCategories(ordinalSort(all,x),x,[m]);
 const ranked=[...capped.data].sort((a,b)=>Number(b[m])-Number(a[m]));
 let type:ChartType;let data=capped.data;
 if(intent==='rank'){type='bar';data=ranked;}
 else if(intent==='share'&&additive)type=n<=7?'donut':'treemap';
 else if(ordinal||intent==='compare'||intent==='distribution')type=n>12||longLabels?'bar':'column';
 else if(additive&&n>=2&&n<=5)type='donut';
 else if(n>12||longLabels){type='bar';data=ranked;}
 else type='column';
 const alternatives:ChartType[]=additive?['column','bar','donut','pie','treemap',...(n<=8?['radial' as ChartType]:[])]:['column','bar',...(n>=3&&n<=12?['radial' as ChartType]:[])];
 return {...base,type,subtitle,x:{field:x,label:label(x),kind:'category'},series:[{key:m,label:label(m)}],y,data:type==='donut'?[...data].sort((a,b)=>Number(b[m])-Number(a[m])):data,note:joinNotes(truncNote,capped.note),additive,alternatives};
}

function applyRequest(spec:ChartSpec,req:ChartRequest):ChartSpec{
 const withAlt=(s:ChartSpec,t:ChartType)=>({...s,type:t,alternatives:s.alternatives.includes(t)?s.alternatives:[t,...s.alternatives]});
 const fallback=(why:string)=>({...spec,note:joinNotes(spec.note,why)});
 if(!req.type)return req.horizontal&&spec.type==='column'?{...spec,type:'bar'}:spec;
 const want=req.type;const one=spec.series.length===1;
 if(spec.type==='kpi'||spec.type==='gauge')return want==='gauge'&&spec.alternatives.includes('gauge')?{...spec,type:'gauge'}:fallback(`The result is a single value, so it is shown as a figure rather than a ${want} chart.`);
 if(want==='pie'||want==='donut'||want==='treemap'){
  if(!one||spec.x.kind!=='category'||spec.data.some(d=>Number(d[spec.series[0].key])<0))return fallback(`A ${want} chart needs one non-negative measure split into categories; shown as a ${spec.type} chart instead.`);
  if(!spec.additive)return fallback(`A ${want} chart shows parts of a whole, but ${spec.y.label.toLowerCase()} values do not add up to a total; shown as a ${spec.type} chart instead.`);
  return want==='treemap'?withAlt(spec,'treemap'):withAlt(foldPie(spec),want);
 }
 if(want==='radial')return one&&spec.x.kind==='category'&&spec.data.length<=12?withAlt(spec,'radial'):fallback('A radial chart needs up to 12 categories and one measure; shown as a '+spec.type+' chart instead.');
 if(want==='radar')return spec.series.length>=3&&spec.data.length<=10?withAlt(spec,'radar'):fallback('A radar chart needs three or more measures per category; shown as a '+spec.type+' chart instead.');
 if(want==='heatmap')return spec.series.length>1&&spec.x.kind!=='number'?withAlt(spec,'heatmap'):fallback('A heatmap needs two dimensions; shown as a '+spec.type+' chart instead.');
 if(want==='percent'||want==='stackedarea'){
  if(spec.series.length<2||!spec.additive)return fallback(`A ${want==='percent'?'100% stacked':'stacked area'} chart needs several parts that add up to a whole; shown as a ${spec.type} chart instead.`);
  return withAlt(spec,want==='stackedarea'&&spec.x.kind!=='time'?'stacked':want);
 }
 if(want==='gauge')return fallback('A gauge needs a single percentage; shown as a '+spec.type+' chart instead.');
 if(want==='scatter'&&spec.x.kind!=='number')return fallback('A scatter plot needs two numeric measures; shown as a '+spec.type+' chart instead.');
 if(want==='stacked'||want==='grouped')return spec.series.length>1?(want==='stacked'&&!spec.additive?fallback('These values do not add up, so they are shown side by side instead of stacked.'):withAlt(spec,want)):withAlt(spec,spec.x.kind==='time'?spec.type:'column');
 if(want==='bar'&&spec.type==='treemap'){const capped=capCategories(spec.data,spec.x.field,[spec.series[0].key]);return withAlt({...spec,data:capped.data,note:joinNotes(spec.note,capped.note)},'bar');}
 if(want==='bar')return withAlt(spec,spec.x.kind==='time'?'column':req.horizontal||spec.type==='bar'||spec.type==='treemap'?'bar':spec.series.length>1&&spec.type==='stacked'?'stacked':spec.series.length>1?'grouped':'column');
 if(want==='column')return withAlt(spec,spec.series.length>1?(spec.type==='stacked'?'stacked':'grouped'):'column');
 if(want==='line'||want==='area')return withAlt(spec,want);
 return spec;
}

// ---------- helpers ----------
// Ordered categories keep their natural order on an axis (Critical → Low, P1 → P4, Mon → Sun).
const SEVERITY=['critical','very high','high','medium','moderate','low','very low','info','informational','none'];
const DAYS=['mon','tue','wed','thu','fri','sat','sun'],MONTH_NAMES=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export function ordinalOrder(values:string[]):((a:string,b:string)=>number)|undefined{
 const lower=values.map(v=>v.toLowerCase().trim());
 if(lower.every(v=>SEVERITY.includes(v)))return (a,b)=>SEVERITY.indexOf(a.toLowerCase().trim())-SEVERITY.indexOf(b.toLowerCase().trim());
 if(lower.every(v=>/^(p|sev|tier|level|priority|severity|t)\s*-?\s*\d+$/.test(v)))return (a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]);
 if(lower.every(v=>/^-?\d+(\.\d+)?$/.test(v)))return (a,b)=>Number(a)-Number(b);
 // Same prefix with a number ("ops-2", "ops-10", "Tier 3"): natural order.
 const pre=lower.map(v=>v.match(/^(.*?)(\d+)$/));
 if(pre.every(m=>m&&m[1]===pre[0]![1]))return (a,b)=>Number(a.match(/(\d+)$/)![1])-Number(b.match(/(\d+)$/)![1]);
 if(lower.every(v=>DAYS.includes(v.slice(0,3))))return (a,b)=>DAYS.indexOf(a.toLowerCase().slice(0,3))-DAYS.indexOf(b.toLowerCase().slice(0,3));
 if(lower.every(v=>MONTH_NAMES.includes(v.slice(0,3))))return (a,b)=>MONTH_NAMES.indexOf(a.toLowerCase().slice(0,3))-MONTH_NAMES.indexOf(b.toLowerCase().slice(0,3));
 return undefined;
}
function ordinalSort(data:Record<string,string|number|null>[],x:string){
 const cmp=ordinalOrder(data.map(d=>String(d[x])));
 return cmp?[...data].sort((a,b)=>cmp(String(a[x]),String(b[x]))):data;
}

function pivotRows(rows:Row[],xField:string,seriesField:string,measure:string){
 const totals=new Map<string,number>();
 for(const r of rows){const s=text(r[seriesField]);totals.set(s,(totals.get(s)||0)+Math.abs(Number(r[measure])||0));}
 const ranked=[...totals.entries()].sort((a,b)=>b[1]-a[1]).map(([s])=>s);
 const ordinal=ranked.length<=MAX_SERIES?ordinalOrder(ranked):undefined;if(ordinal)ranked.sort(ordinal);
 const keep=new Set(ranked.length>MAX_SERIES?ranked.slice(0,MAX_SERIES-1):ranked);
 const byX=new Map<string,Record<string,string|number|null>>();
 for(const r of rows){
  const x=text(r[xField]);const s=keep.has(text(r[seriesField]))?text(r[seriesField]):'Other';
  const row=byX.get(x)||{[xField]:x};row[s]=(Number(row[s])||0)+(Number(r[measure])||0);byX.set(x,row);
 }
 const names=[...ranked.filter(s=>keep.has(s)),...(ranked.length>keep.size?['Other']:[])];
 const data=[...byX.values()].map(row=>{for(const n of names)if(row[n]===undefined)row[n]=0;return row;});
 return {data,series:names.map(n=>({key:n,label:n})),note:ranked.length>keep.size?`${ranked.length-keep.size} smaller groups combined into “Other”.`:undefined};
}
function capCategories(data:Record<string,string|number|null>[],x:string,keys:string[]){
 if(data.length<=MAX_CATEGORIES)return {data,note:undefined as string|undefined};
 const total=(d:Record<string,string|number|null>)=>keys.reduce((s,k)=>s+Math.abs(Number(d[k])||0),0);
 const sorted=[...data].sort((a,b)=>total(b)-total(a));
 return {data:sorted.slice(0,MAX_CATEGORIES),note:`Showing the ${MAX_CATEGORIES} largest of ${data.length} ${label(x).toLowerCase()} values.`};
}
function foldPie(spec:ChartSpec):ChartSpec{
 const k=spec.series[0].key;const x=spec.x.field;
 const sorted=[...spec.data].sort((a,b)=>Number(b[k])-Number(a[k]));
 if(sorted.length<=MAX_PIE)return {...spec,data:sorted};
 const rest=sorted.slice(MAX_PIE-1);
 return {...spec,data:[...sorted.slice(0,MAX_PIE-1),{[x]:`Other (${rest.length})`,[k]:rest.reduce((s,d)=>s+Number(d[k]||0),0)}],note:joinNotes(spec.note,`${rest.length} smaller slices combined into “Other”.`)};
}
function comparable(rows:Row[],numbers:string[]){
 if(numbers.length<=1)return numbers;
 const scale=(c:string)=>Math.max(...rows.map(r=>Math.abs(Number(r[c])||0)),1e-9);
 const first=scale(numbers[0]);
 return numbers.filter(c=>{const r=scale(c)/first;return r>=0.1&&r<=10;});
}
const distinctCount=(rows:Row[],c:string)=>new Set(rows.map(r=>text(r[c]))).size;
const joinNotes=(...notes:(string|undefined)[])=>notes.filter(Boolean).join(' ')||undefined;
function shortObjective(o:string){return o.replace(/^(count|number|total) of /i,'').replace(/\s+/g,' ').trim().slice(0,48);}
export function titleOf(q:string){
 const t=q.trim().replace(/[?.!]+$/,'').replace(/^(?:please |can you |could you )?(?:show|give|get|list|tell|display|find)(?: me| us)?(?: the| a)?\s+/i,'').replace(/^what (?:is|are) (?:the )?/i,'').replace(/^how many /i,'Number of ').replace(/\s+/g,' ');
 const fixed=t.replace(/^(?:the|a|an)\s+/i,'').replace(/\b(cves|ids)\b/gi,w=>w.toLowerCase()==='cves'?'CVEs':'IDs').replace(ACRONYMS,w=>w.toUpperCase());
 return (fixed.charAt(0).toUpperCase()+fixed.slice(1)).slice(0,120);
}
// Every plotted value must be a value that exists in the evidence rows (same numbers, same labels).
export function validateChart(spec:ChartSpec,evidence:Evidence[]):string[]{
 const problems:string[]=[];
 const parsed=chartSpecSchema.safeParse(spec);if(!parsed.success)return ['invalid chart spec: '+parsed.error.message.slice(0,200)];
 if(!spec.data.length)problems.push('no data points');
 for(const d of spec.data)for(const s of spec.series)if(d[s.key]!==null&&d[s.key]!==undefined&&typeof d[s.key]!=='number'&&spec.type!=='kpi')problems.push(`non-numeric value for ${s.key}`);
 const source=evidence.filter(e=>spec.sourceStepIds.includes(e.stepId));
 if(!source.length)problems.push('chart has no source evidence');
 return [...new Set(problems)];
}
