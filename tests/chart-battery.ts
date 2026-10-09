// Chart battery: npx tsx tests/chart-battery.ts  (env: CHART_FILTER=id,id, CHART_OUTPUT=path)
// Checks the chart type, that every plotted value equals an independent oracle, and that no chart
// is attached when none makes sense.
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Database} from '../backend/db.js';
import {Catalog} from '../backend/catalog.js';
import {Agent} from '../backend/agent.js';
import {config} from '../backend/config.js';
import {validateChart,type ChartSpec} from '../backend/chart.js';
import {chartCases,type ChartCase} from './chart-cases.js';
import type {Answer} from '../backend/types.js';

const filter=process.env.CHART_FILTER?.split(',');
const cases=chartCases.filter(c=>!filter||filter.includes(c.id));
const db=await Database.open(),catalog=await new Catalog(db).build(),agent=new Agent(catalog);
const label=(v:unknown)=>v===null||v===undefined?'(none)':typeof v==='boolean'?(v?'Yes':'No'):/^\d{4}-\d{2}-\d{2}/.test(String(v))?String(v).slice(0,10):String(v);
const close=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-6,Math.abs(b)*1e-6);

async function check(c:ChartCase,a:Answer):Promise<string>{
 const spec=a.chart;
 if(c.status==='not-answered')return a.status==='answered'&&spec?'answered with a chart although the data does not exist':'';
 if(a.status!=='answered')return 'status '+a.status+': '+a.text.slice(0,120);
 if(c.noChart)return spec?`unexpected ${spec.type} chart`:'';
 if(c.dashboard){
  const all=[...(spec?[spec]:[]),...(a.charts||[])];
  for(const s of all){const p=validateChart(s,a.evidence);if(p.length)return `${s.title}: ${p.join('; ')}`;
   // Every dashboard value must equal its breakdown query's count.
   const src=a.evidence.find(e=>s.sourceStepIds.includes(e.stepId))!;const col=s.x.field;const key=s.series[0].key;
   for(const d of s.data){if(/^Other\b/.test(String(d[col])))continue;const r=src.rows.find(r=>label(r[col])===String(d[col]));if(!r||!close(Number(d[key]),Number(r[key])))return `${s.title}: ${d[col]} ${d[key]} not in its query result`;}}
  const types=new Set(all.map(s=>s.type));
  return all.length<3?`only ${all.length} charts`:types.size<3?`only ${types.size} chart forms (${[...types]})`:'';
 }
 if(!spec)return 'no chart';
 const problems=validateChart(spec,a.evidence);if(problems.length)return 'invalid: '+problems.join('; ');
 if(c.types&&!c.types.includes(spec.type))return `type ${spec.type}, expected ${c.types.join('|')}`;
 if(c.points!==undefined&&spec.data.length!==c.points)return `${spec.data.length} points, expected ${c.points}`;
 if(!c.oracle)return '';
 const rows=(await db.query(c.oracle,1000)).rows;const cols=Object.keys(rows[0]||{});
 return compare(spec,rows.map(r=>cols.map(k=>r[k])));
}
function compare(spec:ChartSpec,rows:unknown[][]):string{
 const width=rows[0]?.length||0;
 if(spec.type==='kpi'){const want=Number(rows[0][width-1]);return spec.series.some(s=>close(Number(spec.data[0]?.[s.key]),want))?'':`figure ${spec.series.map(s=>spec.data[0]?.[s.key])} != ${want}`;}
 if(width===1){const want=rows.map(r=>Number(r[0])).sort((x,y)=>x-y);const got=spec.data.map(d=>Number(d[spec.series[0].key])).sort((x,y)=>x-y);return want.length===got.length&&want.every((w,i)=>close(got[i],w))?'':`values ${got} != ${want}`;}
 // Two-field oracles may list the fields in either order; the chart decides which one is the axis.
 const orient=(swap:boolean)=>{const m=new Map<string,number>();for(const r of rows)m.set(width===3?(swap?label(r[1])+'|'+label(r[0]):label(r[0])+'|'+label(r[1])):label(r[0]),Number(r[width-1]));return m;};
 const firstX=label(spec.data[0]?.[spec.x.field]);
 const expected=width===3&&![...orient(false).keys()].some(k=>k.startsWith(firstX+'|'))?orient(true):orient(false);
 let matched=0;const wrong:string[]=[];
 for(const d of spec.data){
  const x=label(d[spec.x.field]);if(/^Other\b/.test(x))continue;
  for(const s of spec.series){
   if(/^Other\b/.test(s.label))continue;
   const key=width===3?x+'|'+s.key:x;const got=d[s.key];
   const want=expected.get(key);
   if(want===undefined){if(width===3&&Number(got)===0)continue;wrong.push(`${key}: not in oracle`);continue;}
   if(!close(Number(got),want))wrong.push(`${key}: ${got} != ${want}`);else matched++;
  }
 }
 if(wrong.length)return wrong.slice(0,3).join('; ');
 const plotted=spec.data.filter(d=>!/^Other\b/.test(label(d[spec.x.field]))).length;
 return matched>=Math.min(plotted,expected.size)?'':`only ${matched} values matched`;
}

const results:{id:string;category:string;ok:boolean;problem:string;type?:string;points?:number;ms:number;calls:number;question:string}[]=[];
for(const c of cases){
 let session:string|undefined;let a:Answer|undefined;const t0=Date.now();let calls=0;
 try{for(const q of c.turns){a=await agent.ask(q,session);session=a.sessionId;calls+=a.trace.llm.length;}}catch(e){results.push({id:c.id,category:c.category,ok:false,problem:'error '+(e as Error).message,ms:Date.now()-t0,calls,question:c.turns.join(' → ')});continue;}
 const problem=await check(c,a!);
 results.push({id:c.id,category:c.category,ok:!problem,problem,type:a!.charts?.length?[a!.chart?.type,...a!.charts.map(x=>x.type)].join('+'):a!.chart?.type,points:a!.chart?.data.length,ms:Date.now()-t0,calls,question:c.turns.join(' → ')});
 const r=results.at(-1)!;
 console.log(`${r.ok?'PASS':'FAIL'} ${c.id.padEnd(4)} ${(r.type||'-').padEnd(8)} ${String(r.points??'').padStart(3)} ${(r.ms/1000).toFixed(1).padStart(5)}s ${String(calls).padStart(2)} calls  ${r.question.slice(0,70)}${r.ok?'':'  ← '+problem}`);
}
const passed=results.filter(r=>r.ok).length;
const forms=[...new Set(results.flatMap(r=>(r.type||'').split('+')).filter(Boolean))];
console.log(`Chart forms produced across the battery (${forms.length}): ${forms.join(', ')}`);
const summary={model:config.model,date:new Date().toISOString(),n:results.length,passed,meanLatencyS:Math.round(results.reduce((s,r)=>s+r.ms,0)/Math.max(1,results.length)/100)/10,failures:results.filter(r=>!r.ok).map(r=>r.id)};
if(process.env.CHART_OUTPUT){await mkdir(dirname(process.env.CHART_OUTPUT),{recursive:true});await writeFile(process.env.CHART_OUTPUT,JSON.stringify({summary,results},null,1));}
console.log(JSON.stringify(summary));
db.close();
