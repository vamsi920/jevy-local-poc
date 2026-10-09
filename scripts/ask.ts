// Ask the agent from the CLI: npx tsx scripts/ask.ts "question" ["follow-up" ...]  (one conversation)
import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';import {Agent} from '../backend/agent.js';import {warm} from '../backend/llm.js';import {config} from '../backend/config.js';
const db=await Database.open();const catalog=await new Catalog(db).build();const agent=new Agent(catalog);let session:string|undefined;
if(process.env.WARM){const w=await warm(config.model);console.log('warmed',config.model,w.ms+'ms',w.speed);}
for(const q of process.argv.slice(2)){
 const a=await agent.ask(q,session);session=a.sessionId;
 console.log(`\n### ${q}\n[${a.status}] ${(a.trace.totalMs/1000).toFixed(1)}s, ${a.trace.llm.length} calls, driver=${a.trace.driver} answer=${a.trace.answerSource}\n${a.text}`);
 for(const e of a.evidence)console.log('  SQL:',(e.sql||'').replace(/\s+/g,' ').slice(0,300),'| rows',e.rowCount,JSON.stringify(e.rows.slice(0,3)).slice(0,200));
 if(a.chart)console.log(`  CHART: ${a.chart.type} "${a.chart.title}" x=${a.chart.x.field}(${a.chart.x.kind}) series=${a.chart.series.map(s=>s.key).join('|')} points=${a.chart.data.length}${a.chart.note?' note: '+a.chart.note:''} ${JSON.stringify(a.chart.data.slice(0,3)).slice(0,160)}`);
 for(const c of a.charts||[])console.log(`  +CHART: ${c.type} "${c.title}" points=${c.data.length}`);
 if(process.env.VERBOSE)console.log(a.trace.events.map(e=>'   · '+e.message).join('\n'),'\n',JSON.stringify(a.trace.candidates,null,0)?.slice(0,3000),'\n',JSON.stringify(a.trace.answerCheck||''));
}
db.close();
