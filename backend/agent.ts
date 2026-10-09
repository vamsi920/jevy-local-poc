import {resolveContract,requestedLimit,compileContract,verifyContract} from './contracts.js';
import {calendarPeriods,periodComparisonSQL} from './calendar.js';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {Catalog} from './catalog.js';
import {config} from './config.js';
import {Executor} from './executor.js';
import {model,chat as defaultChat,BudgetError,UnavailableError,latencyOf,speedOf,type Model,type Chat} from './llm.js';
import {getProfile,type Profile} from './model-profile.js';
import {ground,groundSync,groundingGap,unknownSubject,norm,type Grounding} from './grounding.js';
import {solveSQL,type Scope} from './solver.js';
import {chartRequest,buildChart,validateChart,ordinalOrder,type ChartRequest,type ChartSpec} from './chart.js';
import {labelColumn,eventDateColumn} from './draft.js';
import {answerShape,overview,recordDossier,plainJoke,JOKE,LISTING,definitionTerm,defineTerm,EXPLAIN,explainQueries} from './shapes.js';
import {toolLoop} from './loop.js';
import {composeAnswer,templateAnswer} from './answer.js';
import {metadataRows,runSQL,toEvidence,findValues} from './tools.js';
import {draftSQL} from './draft.js';
import {identifier,sqlLiteral} from './db.js';
import type {State,Trace,Answer,Evidence,TurnMemory} from './types.js';

export const emptyState=():State=>({lastQuestion:'',intent:'',selectedIds:[],previousSql:[],filters:[],timeRange:'',concepts:[],turns:[]});

// ---- deterministic routing -------------------------------------------------------------
const WRITE_SQL=/\b(delete\s+from|drop\s+(table|view|schema|database)|truncate(\s+table)?\s+\w|insert\s+into|update\s+\w+\s+set|alter\s+table|create\s+(or\s+replace\s+)?(table|view|index|schema)|copy\s+\w+\s+(to|from)\b|attach\s+'|detach\s+\w|export\s+database|install\s+\w|pragma\s+\w)/i;
const WRITE_VERB=/^(?:please\s+|now\s+|then\s+|can you\s+|could you\s+|go\s+(?:ahead\s+and\s+)?)?(delete|drop|truncate|insert|update|alter|create|grant|revoke|remove|erase|wipe|purge|modify|change|rename|overwrite|deduplicate|copy|export|attach|install|write to)\b/i;
// Nouns that follow these verbs in read questions ("restore test results", "change history").
const READ_NOUN=/^\W*(?:\w+\s+)?(test|tests|results?|status|statuses|history|log|logs|counts?|rate|rates|breakdown|trend|requests?|tickets?|records?|stats|summary|window|date|dates)\b/i;
export function isWriteRequest(question:string){
 if(WRITE_SQL.test(question))return true;
 if(/\b(run|execute)\s+(delete|drop|update|insert|alter|truncate|copy|create)\b/i.test(question))return true;
 return question.split(/[.;!?\n]|\band then\b/i).some(s=>{const t=s.trim();const m=t.match(WRITE_VERB);return Boolean(m)&&!READ_NOUN.test(t.slice(m!.index!+m![0].length));});
}
const CHITCHAT=/^\s*(hi|hello|hey|yo|hiya|good (morning|afternoon|evening)|thanks|thank you|thx|cheers|ok|okay|cool|great|nice|who are you|what are you|what can you do|help|how does this work)\b[\s!.?]*$/i;
const METADATA=/\b(what|which|list|show|describe|tell me about)\b[^?]*\b(tables?|columns?|fields?|schema|datasets?|data sources?)\b|\bwhat (data|information) (do you|do we|is|are|can)\b|\bwhat can i ask\b/i;
const CONTINUATION=/^\s*(and|what about|how about|now|only|just|but|or|then|ok so|so|same for|same but|also|instead|for those|of those|of these|among them|among those)\b/i;
const ANAPHORA=/\b(they|them|those|these|same|above|previous|earlier|instead|of them|each of them)\b/i;
// "servers ... their latest backup": a possessive after the question's own subject is not a follow-up.
const POSSESSIVE=/\b(their|its)\b/i;
const ENTITY_REF=/\b(they|them|their|those|these|it|its|each of them|of them|that one|the above|those ones)\b/i;
// Questions that usually need several queries: comparisons, multiple measures, mixed analyses.
const COMPOUND=/\b(compare|comparison|versus|vs\.?|difference between|ratio of|both .* and|as well as|along with|and also|respectively|each of|relative to|compared to)\b|\b(how many|average|total|count)\b.*\band\b.*\b(how many|average|total|count|max|min|percent)\b/i;
const CREATIVE=/\b(song|poem|poetry|rap|ballad|lyrics|sonnet|haiku|limerick)\b/i;

// Split a request into separately answerable intents at "and/then/also" or "?"/";" boundaries, only where the
// next part starts a new request (a verb or question word). Plain lists ("servers and incidents") stay whole.
const INTENT_START='show|list|give|tell|find|get|what|how|which|who|when|where|summari[sz]e|describe|plot|chart|graph|draw|compare|count|explain|make|bring|display|pull|break down|rank';
export function splitIntents(question:string):string[]{
 const parts=question.split(new RegExp(`\\s*[,;]?\\s+(?:and(?:\\s+(?:then|also))?|then|also|plus)\\s+(?=(?:${INTENT_START})\\b)|[?;.]\\s+(?=(?:${INTENT_START}|and)\\b)`,'i')).map(p=>p.replace(/^and\s+/i,'').trim()).filter(Boolean);
 if(parts.length<2||parts.length>4||parts.some(p=>p.split(/\s+/).length<2))return [question];
 // "what OS does host-00042 run and which application is it on": a later data part that points back with a
 // pronoun is one question about one entity; keep it whole (only jokes/summaries "about them" split).
 // Plural references ("which applications do they belong to") are fine: later parts run as follow-ups in the same conversation.
 if(parts.slice(1).some(p=>/\b(it|its)\b/i.test(p)&&!JOKE.test(p)&&!/\b(summary|summari[sz]e|overview|describe)\b/i.test(p)))return [question];
 return parts;
}
export function splitQuestions(question:string):string[]{
 // Split only into independent questions that each start with a question word.
 const parts=question.split(/\?\s+(?=\S)|;\s+|\s*,?\s+\band\s+(?=(?:how many|how much|what|which|who|when|where)\b)|\s*,\s+(?=(?:how many|how much|what is|what are|which)\b)/i).map(s=>s.trim()).filter(s=>s.length>3);
 if(parts.length<2||parts.length>4||parts.some(p=>/\b(it|its|they|them|their|those|these)\b/i.test(p)||!/^(how|what|which|who|when|where|is|are|do|does|did|count)\b/i.test(p)))return [question];
 return parts;
}

// Coarse reasoning phases for the UI's thinking timeline.
export type Phase='understand'|'explore'|'query'|'verify'|'answer';
export function phaseOf(message:string):Phase{
 if(/^Model call: /.test(message))return /answer/i.test(message)?'answer':/review/i.test(message)?'verify':/SQL|Agent|candidate|repair/i.test(message)?'query':/Planning|Schema/i.test(message)?'explore':'understand';
 if(/^(Chart requested|Charting the previous|Checking current|Interpreted|Resolving)/.test(message))return 'understand';
 if(/^(Writing|Answered|Refused|Building chart|Chart skipped)|answer/i.test(message))return 'answer';
 if(/^Using verified operator|completed —|completed -|rows?$/i.test(message))return 'query';
 if(/review|disagree|differed|agree|Verified|validat/i.test(message))return 'verify';
 if(/SQL|candidate|repair|Running q|query|operator|Counted|Computed|Split into|Agent loop|failed/i.test(message))return 'query';
 if(/table|schema|Looking up|Inspecting|Relevant|No table/i.test(message))return 'explore';
 return 'understand';
}

// Budget grows with the endpoint's measured call latency (slow enterprise gateways) so questions are
// not cut off mid-reasoning; REQUEST_TIMEOUT_MS is the hard ceiling.
function adaptiveBudget(profile:Profile){
 const lat=latencyOf(profile.model);if(!lat)return profile.budgetMs;
 const expectedCalls=profile.toolLoop?profile.maxToolSteps+4:profile.candidates*(profile.repairs+1)+3;
 return Math.min(config.requestTimeout,Math.max(profile.budgetMs,Math.round(lat*expectedCalls*1.3)));
}
type Session={state:State;at:number};
export class Agent {
 sessions=new Map<string,Session>();busy=new Set<string>();
 executor:Executor;
 constructor(public catalog:Catalog,public llm:Model=model,public chat:Chat=defaultChat,public profileOverride?:Profile){this.executor=new Executor(catalog,llm);}

 // A short question naming fields that exist only outside the previous turn's tables ("average downtime by
 // priority" after a vulnerabilities question) starts a new topic rather than refining the last one.
 private async ownsColumns(g:Grounding,last:TurnMemory|undefined){
  if(!last)return false;
  // Only a new measure counts ("average downtime"); a bare grouping ("by country") still refines the last turn.
  if(!/\b(average|avg|mean|total|sum|max|maximum|min|minimum|median)\b/i.test(g.normalized))return false;
  const numeric=(m:Grounding['mentions'][number])=>/INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL/.test(this.catalog.table(m.table).columns.find(c=>c.name===m.column)?.type||'');
  const cols=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.6&&numeric(m));if(!cols.length)return false;
  const previous=new Set((await ground(last.standalone,this.catalog)).tables);
  return cols.some(m=>!previous.has(m.table)&&!g.mentions.some(o=>o.kind==='column'&&o.text===m.text&&previous.has(o.table)));
 }
 restore(id:string,state:State){if(!this.sessions.has(id))this.sessions.set(id,{state,at:Date.now()});}
 // A request that mixes intents ("summarize open incidents and show the top 5 servers with most
 // incidents", "give me a summary of backups and tell me a joke about them") is answered part by part,
 // in order, in the same conversation (so "them" in a later part can refer to an earlier one), and merged.
 async ask(question:string,sessionId:string=randomUUID(),notify:(event:unknown)=>void=()=>{},model?:string):Promise<Answer>{
  const parts=splitIntents(question);
  if(parts.length<2)return this.askOne(question,sessionId,notify,model);
  notify({type:'progress',message:`Split into ${parts.length} requests: ${parts.map(p=>`“${p}”`).join(', ')}`,at:0,phase:'understand'});
  const answers:Answer[]=[];
  for(const [i,part] of parts.entries()){
   // Non-data parts ("tell me a joke about them") name the earlier subject explicitly.
   let text=part;
   if(i>0&&/\b(them|they|it|those|these|their)\b/i.test(part)&&(JOKE.test(part)||/\b(summary|summari[sz]e|overview|describe)\b/i.test(part))){
    const subject=groundSync(parts[0],this.catalog).mentions.find(m=>m.kind==='table')?.table;
    if(subject)text=part.replace(/\b(them|they|it|those|these|their)\b/i,subject);
   }
   answers.push(await this.askOne(text,sessionId,notify,model));
  }
  const merged=answers.map((a,i)=>`**${parts[i].replace(/^\w/,c=>c.toUpperCase())}**\n\n${a.text}`).join('\n\n');
  const last=answers.at(-1)!;
  const evidence=answers.flatMap((a,i)=>a.evidence.map(e=>({...e,stepId:`p${i+1}_${e.stepId}`})));
  const trace={...last.trace,question,events:answers.flatMap(a=>a.trace.events),llm:answers.flatMap(a=>a.trace.llm),totalMs:answers.reduce((n,a)=>n+a.trace.totalMs,0),driver:'multi:'+answers.map(a=>a.trace.driver||'?').join('+')};
  const status=answers.every(a=>a.status==='answered')?'answered':answers.some(a=>a.status==='answered')?'answered':last.status;
  return {...last,status,text:merged,evidence,trace,presentation:answers.some(a=>a.presentation==='prose')||answers.length>1?'prose':last.presentation,chart:answers.find(a=>a.chart)?.chart&&{...answers.find(a=>a.chart)!.chart!,sourceStepIds:answers.find(a=>a.chart)!.chart!.sourceStepIds.map(id=>`p${answers.findIndex(a=>a.chart)+1}_${id}`)}};
 }
 private async askOne(question:string,sessionId:string,notify:(event:unknown)=>void,model?:string):Promise<Answer>{
  if(this.busy.has(sessionId))throw new Error('A request is already running in this conversation.');
  this.busy.add(sessionId);const start=performance.now();
  let state=this.sessions.get(sessionId)?.state||emptyState();
  const profile=this.profileOverride||await getProfile(model);
  const trace:Trace={model:model||undefined,deadlineMs:Date.now()+adaptiveBudget(profile),question,intent:'',schema:null,plans:[],events:[],evidence:[],llm:[],retries:0,totalMs:0,profile:{model:profile.model,tier:profile.tier,paramsB:Math.round(profile.paramsB*100)/100,numCtx:profile.numCtx,candidates:profile.candidates,toolLoop:profile.toolLoop,budgetMs:profile.budgetMs}};
  const emit=(message:string)=>{const event={message,at:Math.round(performance.now()-start),phase:phaseOf(message)};trace.events.push(event);notify({type:'progress',...event});};
  // Every model call shows up in the live trace as it starts (functions are dropped when the answer is saved).
  trace.notify=emit;
  let chartReq:ChartRequest={wanted:false,question,chartOnly:false};
  const chartFor=(status:Answer['status'],evidence:Evidence[]):ChartSpec|undefined=>{
   if(status!=='answered'||!evidence.length)return undefined;
   // Overviews and record dossiers are multi-part answers; chart them only when a chart was asked for.
   if(String(trace.driver||'').startsWith('shape:')&&!chartReq.wanted)return undefined;
   const spec=buildChart(evidence,chartReq,trace.dataQuestion||question,this.catalog.referenceDate||undefined,question);
   if(!spec)return undefined;
   const problems=validateChart(spec,evidence);
   if(problems.length){emit('Chart skipped: '+problems.join('; '));return undefined;}
   // Unrequested charts only where they add something (breakdowns and trends, not single figures).
   if(!chartReq.wanted&&(spec.type==='kpi'||(spec.data.length<2&&spec.type!=='gauge')))return undefined;
   emit(`Building chart: ${spec.type} of ${spec.data.length} point${spec.data.length===1?'':'s'}`);
   return spec;
  };
  // An overview is a small dashboard: one chart per breakdown, each choosing its own form.
  // Breakdowns (mix_<column>) of an overview from shapes.ts each become a chart.
  const overviewCharts=(evidence:Evidence[])=>{
   const specs=evidence.filter(e=>e.stepId.startsWith('mix_')&&e.rows.length>1).map(e=>buildChart([e],{wanted:false,question:e.objective,chartOnly:false},e.objective,this.catalog.referenceDate||undefined,e.objective)).filter((c):c is ChartSpec=>Boolean(c)&&c!.type!=='kpi'&&validateChart(c!,evidence).length===0);
   // A dashboard reads better with varied forms: no form more than twice, switching to another valid one.
   const used=new Map<string,number>();
   return specs.map(spec=>{
    const options=[spec.type,...spec.alternatives.filter(t=>t!=='pie')];
    const pick=options.find(t=>!used.get(t))||options.find(t=>(used.get(t)||0)<2)||spec.type;
    used.set(pick,(used.get(pick)||0)+1);
    if(pick===spec.type)return spec;
    const key=spec.series[0].key;
    const ordered=Boolean(ordinalOrder(spec.data.map(d=>String(d[spec.x.field]))));
    const data=!ordered&&(pick==='bar'||pick==='donut'||pick==='radial'||pick==='treemap')?[...spec.data].sort((a,b)=>Number(b[key])-Number(a[key])):spec.data;
    return {...spec,type:pick,data:pick==='radial'||pick==='donut'?data.slice(0,8):data};
   });
  };
  const finish=(status:Answer['status'],text:string,evidence:Evidence[]=[],newState=state):Answer=>{
   if(trace.driver==='shape:overview'&&status==='answered'){const all=overviewCharts(evidence);emit(`Building ${all.length} charts: ${all.map(c=>c.type).join(', ')}`);trace.totalMs=performance.now()-start;this.save(sessionId,newState);return {sessionId,status,text,evidence,presentation:'prose',chart:all[0],charts:all.slice(1),trace,state:newState};}
   const chart=chartFor(status,evidence);trace.totalMs=performance.now()-start;this.save(sessionId,newState);return {sessionId,status,text,evidence,presentation:/^(shape:|conversation)/.test(String(trace.driver||''))?'prose':presentation(evidence),chart,trace,state:newState};};
  try{
   emit('Checking current schema and data profile');await this.catalog.ensureFresh();
   trace.sourceRevision=this.catalog.db.revision;trace.schemaVersion=this.catalog.version;
   if(state.schemaVersion!==undefined&&state.schemaVersion!==this.catalog.version)state=emptyState();
   const turns=state.turns||[];

   // 1. Deterministic routes that never need a model.
   // "create a chart of ..." is a presentation request, not a write; check the wording without the chart part.
   const preChart=chartRequest(question);
   if(isWriteRequest(preChart.wanted&&!preChart.chartOnly?preChart.question:question)&&!(preChart.wanted&&preChart.chartOnly)){emit('Refused: write or export request');return finish('incomplete','I can only read this database. I can’t change, delete, export or create data — but I can answer questions about it.');}
   // "why?" / "how did you get that": explain the previous answer from its recorded queries.
   if(EXPLAIN.test(question)&&turns.length&&question.split(/\s+/).length<=12){trace.driver='conversation';emit('Explaining the previous answer');const last=turns.at(-1)!;return finish('answered',explainQueries(last.question,last.sql,last.summary),[],state);}
   if(CHITCHAT.test(question)){trace.driver='conversation';return finish('answered',`Hi! Ask me anything about this database — counts, breakdowns, comparisons, lookups or trends. It has ${metadataRows(this.catalog).map(r=>(r as {table:string}).table).join(', ')}. For example: “${this.example()}”`);}
   const creative=CREATIVE.test(question)?question:'';
   let dataQuestion=creative?question.split(/\s+and\s+(?:then\s+)?(?:give|write|compose|make|turn|create)\b/i)[0]:question;
   // Chart wording ("as a pie chart", "plot ...") is presentation, not data; the data pipeline sees the rest.
   chartReq=chartRequest(dataQuestion);
   if(chartReq.wanted){
    const previous=turns.at(-1);
    if(chartReq.chartOnly&&previous){dataQuestion=previous.standalone;emit('Charting the previous result: '+previous.standalone);}
    else if(!chartReq.chartOnly){
     dataQuestion=chartReq.question;
     // A bare field ("pie of incident priority", "histogram of cpu cores") charts its distribution.
     if(!/\b(by|per|each|every|over|vs|versus|against|trend|how many|average|avg|mean|total|sum|top|most|least|which|what|list)\b/i.test(dataQuestion)&&!/\b(count|number) of\b/i.test(dataQuestion)){
      const g0=await ground(dataQuestion,this.catalog);const cols=g0.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.8&&!/_id$/.test(m.column!)&&g0.tables.includes(m.table));
      const tables=[...new Set(cols.map(m=>m.table))];
      if(cols.length&&tables.length===1&&!g0.mentions.some(m=>m.kind==='value'))dataQuestion=`${tables[0]} by ${cols[0].column!.replace(/_/g,' ')}`;
     }
     chartReq={...chartReq,question:dataQuestion};
     emit(`Chart requested${chartReq.type?' ('+chartReq.type+')':''}; data question: `+dataQuestion);
    }
   }
   // "cumulative incidents per month": the data is the per-period count; the chart draws the running total.
   if(/\b(cumulative|running total of|running count of)\b/i.test(dataQuestion)&&/\b(per|by|each|every) (day|week|month|quarter|year)\b|\b(daily|weekly|monthly|quarterly|yearly)\b|\bover time\b/i.test(dataQuestion)){
    dataQuestion=dataQuestion.replace(/\b(cumulative|running total of|running count of)\s*/i,'').replace(/\bover time\b/i,'per month');
    if(!chartReq.wanted)chartReq={wanted:true,question:dataQuestion,chartOnly:false};
    emit('Cumulative view requested; counting per period and charting the running total');
   }
   // "how are open incidents distributed across priorities" is a breakdown: "open incidents by priorities".
   dataQuestion=dataQuestion.replace(/^\s*how (?:are|is) (?:the )?(.+?) (?:distributed|spread|split|broken down|divided) (?:across|by|over|among|between|per) (?:the |all |different )?(.+?)\s*\?*\s*$/i,'$1 by $2');
   if(METADATA.test(dataQuestion)){
    const g=await ground(dataQuestion,this.catalog);
    const named=g.mentions.filter(m=>m.kind==='table').map(m=>m.table);
    const single=named.length===1&&/\b(columns?|fields?|schema|describe)\b/i.test(dataQuestion)?named:undefined;
    const rows=metadataRows(this.catalog,single);
    const evidence:Evidence[]=[{stepId:'catalog',objective:single?`Columns of ${single[0]}`:'Tables in this database',tool:'catalog',rows,rowCount:rows.length,truncated:false,durationMs:0,repairs:0}];
    emit('Answered from the live schema catalog');
    const text=single?`${single[0]} has ${rows.length} columns: ${rows.map(r=>(r as {column:string}).column).join(', ')}.`:`This database has ${rows.length} tables: ${rows.map(r=>`${(r as {table:string}).table} (${Number((r as {rows:number}).rows).toLocaleString('en-US')} rows)`).join(', ')}.`;
    return finish('answered',text,evidence);
   }

   // 2. Conversation context: rewrite follow-ups into standalone questions.
   const last=turns.at(-1);
   let grounding=await ground(dataQuestion,this.catalog);
   // A joke with nothing from the data to joke about is not a follow-up and needs no query.
   if(JOKE.test(dataQuestion)&&!grounding.mentions.some(m=>m.kind==='table')&&!ENTITY_REF.test(dataQuestion)){
    trace.driver='conversation';
    emit('Not a data question; answering directly');
    return finish('answered',`${plainJoke(question)}\n\nFor real numbers, ask about ${metadataRows(this.catalog).map(r=>(r as {table:string}).table).join(', ')} — for example “${this.example()}”.`);
   }
   // "what is evergreening" / "what does cvss score mean" / "what is P1": a definition, not a query.
   const definition=definitionTerm(dataQuestion,grounding);
   if(definition){trace.driver='conversation';emit(`Defining “${definition.term}” from the schema`);const d=await defineTerm(this.catalog,definition.mention);return finish('answered',d.text,d.evidence,this.remember(state,question,dataQuestion,d.evidence,d.text));}
   // The user's own wording decides whether its subject exists, before any follow-up rewrite.
   const ownSubject=unknownSubject(grounding);
   let followup=false,scope:Scope|undefined;
   const ownEntity=grounding.mentions.some(m=>m.kind==='value'&&m.via==='lookup');
   // "any vulnerability ... a history of it": a pronoun after the question's own subject refers back
   // inside the same question, so it does not make the question a follow-up.
   const lowered=dataQuestion.toLowerCase();
   const firstPronoun=lowered.search(/\b(it|its|they|them|their|those|these|that|this|same|previous|above)\b/);
   // Only a singular "it/its" refers back inside the question; "they/those" still point at earlier results.
   const pluralRef=/\b(they|them|their|those|these|same|previous|above)\b/.test(lowered);
   const firstSubject=Math.min(...grounding.mentions.filter(m=>m.kind==='table'||(m.kind==='value'&&m.via==='lookup')).map(m=>{const i=lowered.indexOf(m.text.toLowerCase());return i<0?Infinity:i;}),Infinity);
   const selfContained=!pluralRef&&firstSubject<Infinity&&(firstPronoun<0||firstSubject<firstPronoun);
   const isFollowup=Boolean(last)&&(CONTINUATION.test(dataQuestion)||!grounding.tables.length||(!selfContained&&((!grounding.mentions.some(m=>m.kind==='table')&&/\b(that|this|it|them|those)\b/i.test(dataQuestion))||(ANAPHORA.test(dataQuestion)&&!ownEntity)||(/\bit\b/i.test(dataQuestion)&&!grounding.mentions.some(m=>m.kind==='value'))))||(POSSESSIVE.test(dataQuestion)&&!grounding.mentions.some(m=>m.kind==='table'))||(dataQuestion.split(/\s+/).length<=4&&!grounding.mentions.some(m=>m.kind==='table')&&!(await this.ownsColumns(grounding,last))));
   if(last&&isFollowup){
    followup=true;emit('Resolving follow-up against the previous question');
    const standalone=await this.rewrite(dataQuestion,last,grounding,profile,trace);
    if(ENTITY_REF.test(dataQuestion)&&last.ids.length&&last.entityKey&&last.entityTable)scope={table:last.entityTable,key:last.entityKey,ids:last.ids};
    dataQuestion=standalone;grounding=await ground(standalone,this.catalog);
    if(scope&&!grounding.tables.includes(scope.table))grounding={...grounding,tables:this.catalog.connect([scope.table,...grounding.tables])};
    emit('Interpreted as: '+standalone);
   }
   trace.intent=dataQuestion;trace.dataQuestion=dataQuestion;trace.standalone=dataQuestion;trace.recordSummary=Boolean(creative);
   trace.grounding={corrections:grounding.corrections,tables:grounding.tables,mentions:grounding.mentions.map(m=>`${m.text} → ${m.table}${m.column?'.'+m.column:''}${m.value?` = '${m.value}'`:''} (${m.via})`),unknown:grounding.unknownTerms};
   trace.schema={tables:grounding.tables,definitions:grounding.definitions};
   if(grounding.corrections.length)emit('Interpreted spelling: '+grounding.corrections.map(c=>`${c.from} → ${c.to}`).join(', '));
   emit(grounding.tables.length?'Relevant tables: '+grounding.tables.join(', '):'No table matched the question');

   // 3b. One stated value, several possible subjects ("how many are critical": incidents or vulnerabilities?)
   // and no table named: ask with the count for each option instead of guessing.
   if(!followup&&!scope&&!grounding.mentions.some(m=>m.kind==='table')){
    // Only category values ("Critical") can mean different things; an ID shared by a table and the tables that
    // reference it ("APP-005" in applications and servers) is one entity.
    const isKey=(c:string)=>this.catalog.tables.some(t=>t.primaryKey===c)||/(^|_)id$/.test(c);
    const strong=grounding.mentions.filter(m=>m.kind==='value'&&m.confidence>=0.9&&m.via!=='lookup'&&!isKey(m.column!)&&(this.catalog.table(m.table).columns.find(c=>c.name===m.column)?.values.length||0)>0);
    const owners=[...new Map(strong.map(m=>[m.table,m])).values()];
    if(owners.length>1&&new Set(strong.map(m=>norm(m.text))).size===1){
     const counts=await Promise.all(owners.map(async m=>({m,n:Number(Object.values((await this.catalog.db.query(`SELECT count(*) AS n FROM ${identifier(m.table)} WHERE ${identifier(m.column!)} = ${sqlLiteral(m.value!)}`,1)).rows[0]||{})[0]??0)})));
     trace.driver='conversation';emit(`“${strong[0].text}” fits ${owners.length} tables; asking which one`);
     return finish('clarification',`“${strong[0].value}” appears in more than one place — which did you mean?\n\n${counts.map(({m,n})=>`- **${m.table}** with ${m.column!.replace(/_/g,' ')} ${m.value}: ${n.toLocaleString('en-US')}`).join('\n')}\n\nFor example: “how many ${m0(counts)} are ${String(strong[0].value).toLowerCase()}”.`);
    }
   }
   // 4a. Answer shape. Summaries, single-record deep dives and jokes are not "find a query" problems:
   // they get a fixed plan (several small aggregate/lookup queries in parallel, merged), so a
   // query that merely runs can never stand in for them.
   const shape=answerShape(dataQuestion,grounding,this.catalog);
   if(!scope&&shape.table&&shape.kind!=='query'){
    trace.driver='shape:'+shape.kind;
    if(shape.kind==='record'){
     // An identifier that is not unique (a CVE on many findings) describes a group: profile that group instead.
     const owner=this.catalog.table(shape.table);
     if(shape.id&&owner.primaryKey!==shape.id.column){
      const n=Number(Object.values((await this.catalog.db.query(`SELECT count(*) AS n FROM ${identifier(owner.name)} WHERE ${identifier(shape.id.column!)} = ${sqlLiteral(shape.id.value!)}`,1)).rows[0]||{})[0]??0);
      if(n>1){trace.driver='shape:overview';const group=await overview(this.catalog,shape.table,grounding,emit);return finish('answered',group.text,group.evidence,this.remember(state,question,dataQuestion,group.evidence.slice(0,1),group.text));}
     }
     const dossier=await recordDossier(this.catalog,shape.table,grounding,shape.id,emit);
     return finish('answered',dossier.text,dossier.evidence,this.remember(state,question,dataQuestion,dossier.evidence.slice(0,1),dossier.text));
    }
    const profile_=await overview(this.catalog,shape.table,grounding,emit);
    let text=profile_.text;
    if(shape.kind==='creative')text=(await this.joke(shape.table,trace,emit))+'\n\nThe actual numbers:\n'+text;
    return finish('answered',text,profile_.evidence,this.remember(state,question,dataQuestion,profile_.evidence.slice(0,1),text));
   }
   // 3. Nothing in the database matches.
   // The main noun matches nothing in the data ("revenue", "employees"): say so instead of guessing.
   const missingSubject=followup?ownSubject:unknownSubject(grounding);
   if(missingSubject){
    const near=await findValues(this.catalog,missingSubject);
    if(!near.some(n=>n.score>=0.85)){emit(`No data about "${missingSubject}" found`);return finish('incomplete',`This database doesn't have anything about “${missingSubject}”. It contains ${metadataRows(this.catalog).map(r=>(r as {table:string}).table).join(', ')} — try asking about those.`);}
   }
   // A named record that does not exist ("host-00010" when hostnames look like host-0000010): report it,
   // with the stored format, instead of letting a model guess at a different column or record.
   if(grounding.missingIdentifiers?.length){
    const m=grounding.missingIdentifiers[0];
    const sql=`SELECT count(*) AS matching_records FROM ${identifier(m.table)} WHERE ${identifier(m.column)} = ${sqlLiteral(m.token)}`;
    const result=await this.catalog.db.query(sql);
    emit(`No ${m.table} record has ${m.column} = '${m.token}'`);trace.driver='operator';
    return finish('answered',`No ${m.table} record has ${m.column.replace(/_/g,' ')} “${m.token}” — 0 matching records, so there is nothing to report for it. Stored values look like “${m.example}”; check the identifier and ask again.`,
     [{stepId:'missing-identifier',objective:`Check that ${m.token} exists`,tool:'run_sql',sql,...result,durationMs:0,repairs:0}]);
   }
   const gap=groundingGap(grounding);
   if(gap&&!followup){
    const tables=metadataRows(this.catalog).map(r=>(r as {table:string}).table).join(', ');
    if(gap==='vague')return finish('clarification',`Could you be more specific? Tell me what you’d like to look at — for example “${this.example()}”. Available data: ${tables}.`);
    return finish('incomplete',`I couldn’t find anything about ${grounding.unknownTerms.slice(0,3).map(t=>`“${t}”`).join(', ')} in this database. It contains: ${tables}.`);
   }
   // Values the follow-up replaced (e.g. Critical -> High) are no longer allowed filters.
   const replacedColumns=new Set(grounding.mentions.filter(m=>m.kind==='value').map(m=>m.table+'.'+m.column));
   const previousValues=followup&&last?(await ground(last.standalone,this.catalog)).mentions.filter(m=>m.kind==='value'&&replacedColumns.has(m.table+'.'+m.column)&&!grounding.mentions.some(n=>n.value===m.value)).map(m=>m.value!):[];
   const allowedLiterals=[...(scope?.ids||[]),...(followup&&last?last.literals.filter(l=>!previousValues.includes(l)):[])];
   const previous=followup&&last?{question:last.standalone,sql:last.sql,summary:last.summary}:undefined;

   // 4. Verified deterministic operators for common shapes (no model SQL needed).
   let evidence=await this.fastPath(dataQuestion,grounding,scope,trace,emit);
   let draft:string|undefined;

   // 5. Model-driven solving: tool loop for capable models, structured self-consistency otherwise.
   if(!evidence){
    // Adapt to measured speed: a tool loop needs several long-prompt calls, so slow hardware gets
    // the compact structured strategy (single candidate, no review) instead of timing out.
    let strategy=profile;
    const speed=speedOf(profile.model);
    if(speed){
     const remaining=(trace.deadlineMs!-Date.now())/1000;
     const promptTokens=this.catalog.schemaText(grounding.tables.length?grounding.tables:[]).length/3.5+900;
     const loopStep=promptTokens/speed.promptTps+350/speed.genTps;
     const sqlCall=promptTokens*0.7/speed.promptTps+150/speed.genTps;
     if(profile.toolLoop&&loopStep*4>remaining*0.6){strategy={...strategy,toolLoop:false};emit(`This model runs at ~${Math.round(speed.genTps)} tokens/s here; using the compact strategy`);}
     if(sqlCall*(strategy.candidates+2)>remaining*0.8)strategy={...strategy,candidates:1,review:false,repairs:Math.min(strategy.repairs,1)};
     trace.profile={...(trace.profile as object),measuredTps:Math.round(speed.genTps*10)/10,strategy:{toolLoop:strategy.toolLoop,candidates:strategy.candidates,review:strategy.review}};
    }
    if(strategy.toolLoop){
     trace.driver='tool-loop';emit(`Agent loop with ${profile.model} (${profile.tier} tier)`);
     try{
      // The loop may use at most ~60% of what is left, so a structured fallback can still answer.
      const fullDeadline=trace.deadlineMs!;trace.deadlineMs=Date.now()+Math.round((fullDeadline-Date.now())*0.6);
      let result;
      try{result=await toolLoop(this.catalog,this.chat,strategy,{question:dataQuestion,grounding,previous,scope,allowedLiterals,followup},trace,emit);}
      catch(e){if(!(e instanceof BudgetError))throw e;result={evidence:[] as Evidence[],answer:undefined,steps:0};emit('Agent loop ran out of its time share; switching to structured solving');}
      finally{trace.deadlineMs=fullDeadline;}
      if(result.evidence.some(e=>!e.error)){evidence=result.evidence;draft=result.answer;
       // The loop runs guards leniently; if its cited queries ignored something the question asked
       // for and a fully grounded draft exists, the draft is the safer answer.
       const flagged=result.evidence.filter(e=>!e.error).every(e=>(e.warnings||[]).some(w=>/not requested|filter missing|not grounded|not a stored value|does not read|names "/.test(w)));
       const grounded=!followup&&!scope&&flagged?draftSQL(dataQuestion,grounding,this.catalog):null;
       if(grounded){const o=await runSQL(this.catalog,grounded.sql,{question:dataQuestion,grounding,allowedLiterals,followup});if(o.ok){emit('Agent result ignored part of the question; using the grounded query instead');evidence=[toEvidence('grounded',grounded.explain,o)];draft=undefined;}}
      }
      else emit('Agent loop found no usable result; switching to structured solving');
     }catch(e){if(e instanceof BudgetError||e instanceof UnavailableError)throw e;emit('Agent loop failed ('+(e instanceof Error?e.message:String(e)).slice(0,80)+'); switching to structured solving');}
    }
    if(!evidence){
     trace.driver=trace.driver?trace.driver+'+structured':'structured';
     let parts=followup?[dataQuestion]:splitQuestions(dataQuestion);
     // "counts of open critical vulnerabilities, P1 incidents and failed backups": one count per listed item.
     if(parts.length===1&&!followup){const items=await this.enumeration(dataQuestion);if(items.length>1){parts=items;emit(`Split the list into ${items.length} counts`);}}
     // Planner sub-agent: compound analytical questions are decomposed into independent grounded
     // sub-questions that are solved in parallel and merged in the final answer.
     if(parts.length===1&&!scope&&!draftSQL(dataQuestion,grounding,this.catalog)&&COMPOUND.test(dataQuestion)){
      const planned=await this.plan(dataQuestion,grounding,trace).catch(e=>{if(e instanceof BudgetError||e instanceof UnavailableError)throw e;return [] as string[];});
      if(planned.length>1){parts=planned;emit(`Planned ${planned.length} sub-questions: ${planned.join(' | ').slice(0,220)}`);}
     }
     if(parts.length>1)emit(`Split into ${parts.length} sub-questions solved in parallel`);
     evidence=await Promise.all(parts.map(async(part,i)=>{
      const g=parts.length>1?await ground(part,this.catalog):grounding;
      return solveSQL(this.catalog,this.llm,strategy,{question:part,grounding:g.tables.length?g:grounding,previous:previous&&{question:previous.question,sql:previous.sql},scope,allowedLiterals,followup},trace,emit,parts.length>1?`part${i+1}`:'answer');
     }));
    }
   }
   if(trace.sourceRevision!==this.catalog.db.revision)throw new Error('Dataset changed during execution. Ask again against the refreshed data.');
   trace.evidence=[...trace.evidence.filter(e=>!evidence!.includes(e)),...evidence];
   const usable=evidence.filter(e=>!e.error);
   if(!usable.length){
    const reason=evidence.find(e=>e.error)?.error||'no query succeeded';
    // Keep the attempted question in memory so a rephrased follow-up builds on it.
    return finish('incomplete',`I couldn’t build a reliable query for this (${reason.slice(0,200)}). Try rephrasing or naming the field you mean.`,[],this.remember(state,question,dataQuestion,[],'(no verified answer)'));
   }

   // 5b. A raw row dump only answers a question that asked for rows. Otherwise the query found
   // "some data" rather than the answer: profile the subject instead of presenting the dump.
   const dump=usable.length===1&&(usable[0].totalRows??usable[0].rowCount)>50&&!/\b(group by|count\s*\(|sum\s*\(|avg\s*\(|min\s*\(|max\s*\(|distinct)\b/i.test(usable[0].sql||'');
   if(dump&&!LISTING.test(dataQuestion)&&!scope&&(shape.table||grounding.tables[0])){
    const subject=shape.table||grounding.tables[0];
    emit('The best query only returned raw rows, which does not answer this; profiling '+subject+' instead');
    const profile_=await overview(this.catalog,subject,grounding,emit);
    const text=`I wasn’t sure which figure you wanted, so here is an overview of ${subject}:\n\n${profile_.text}\n\nAsk for a specific count, breakdown or record for more detail.`;
    return finish('answered',text,profile_.evidence,this.remember(state,question,dataQuestion,profile_.evidence.slice(0,1),text));
   }

   // 6. Answer: model prose verified against the rows, or a deterministic template.
   emit('Writing the answer from verified results');
   const notes=[...grounding.corrections.map(c=>`Interpreted "${c.from}" as "${c.to}"`),...usable.flatMap(e=>e.warnings||[])];
   const composed=await composeAnswer(dataQuestion,usable,this.llm,trace,{rows:profile.rowsForModel,notes,draft,templateForTables:profile.tier==='tiny',knownValues:this.catalog.categoryValues()});
   trace.answerSource=composed.source;
   let text=composed.text;
   if(followup&&dataQuestion!==question)text+=`\n\n_Interpreted as: ${dataQuestion}_`;
   if(creative)text+=await this.creative(creative,usable,trace,emit);
   const newState=this.remember(state,question,dataQuestion,usable,text);
   return finish('answered',text,usable,newState);
  }catch(e){
   const message=e instanceof Error?e.message:String(e);trace.error=message;emit('Stopped: '+message.slice(0,200));
   const partial=trace.evidence.filter(x=>!x.error&&x.tool==='run_sql');
   if(e instanceof BudgetError&&partial.length)return finish('answered',templateAnswer(partial)+'\n\n_The time budget ran out before every check finished; these results come from the last successful query._',partial);
   return finish(e instanceof UnavailableError||message.includes('Ollama')?'unavailable':'incomplete',message,partial);
  }finally{this.busy.delete(sessionId);}
 }

 // Decompose into 2-4 self-contained sub-questions. Each must ground in the schema and may only use
 // filter values the user actually mentioned, so a weak planner cannot invent scope.
 private async plan(question:string,g:Grounding,trace:Trace):Promise<string[]>{
  const tables=g.tables.map(t=>`${t}: ${this.catalog.table(t).columns.map(c=>c.name).slice(0,25).join(', ')}`);
  const out=await this.llm(z.object({subQuestions:z.array(z.string().min(5).max(220)).min(1).max(4)}),'Planning',
   'Split the question into 2-4 independent, self-contained database questions whose answers together answer it (for example one count per compared group, or one question per measure). Each sub-question must repeat every filter it needs. If the question is already a single query, return it unchanged as the only item. Do not answer.',
   {question,tables},trace,{maxTokens:400});
  const allowed=new Set(g.mentions.filter(m=>m.kind==='value').map(m=>m.value));
  const groupingAsked=/\b(per|each|by|breakdown|break down|group)\b/i.test(question);
  const valid:string[]=[];
  for(const q of out.subQuestions.map(x=>x.trim()).filter(Boolean)){
   const sg=await ground(q,this.catalog);
   if(!sg.tables.length||sg.unknownTerms.length>1)return [];
   if(sg.mentions.some(m=>m.kind==='value'&&!allowed.has(m.value)))return [];
   if(!groupingAsked&&/\b(per|each|by|for every)\b/i.test(q))return [];
   valid.push(q);
  }
  return valid.length>1?[...new Set(valid)]:[];
 }

 private async enumeration(question:string):Promise<string[]>{
  // Only explicit lists ("counts of A, B and C"); "servers that have A and B" is one combined condition.
  const m=question.match(/\b(?:counts?|numbers?|totals?)\s+of\s+(?:the\s+)?(.+?)[?.!]*$/i);if(!m)return [];
  if(/\b(have|has|had|with|that|which|where|whose|both)\b/i.test(m[1]))return [];
  const items=m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map(x=>x.trim()).filter(x=>x.length>2);
  if(items.length<2||items.length>6)return [];
  const out:string[]=[];
  for(const item of items){const g=await ground(item,this.catalog);if(!g.mentions.some(x=>x.kind==='table')||g.unknownTerms.length)return [];out.push(`how many ${item}`);}
  return out;
 }

 private example(){const t=this.catalog.tables.find(x=>!this.catalog.isReferenceTable(x.name)&&x.columns.some(c=>c.values.length>1));const c=t?.columns.find(c=>c.values.length>1);return t&&c?`How many ${t.name} are there per ${c.name.replaceAll('_',' ')}?`:'How many rows are in each table?';}

 // Standalone rewrite of a follow-up. Deterministic merge first; the model may refine it.
 private async rewrite(message:string,last:TurnMemory,g:Grounding,profile:Profile,trace:Trace){
  let merged=last.standalone.replace(/[?.!\s]+$/,'');
  const prev=await ground(last.standalone,this.catalog);
  const newValues=g.mentions.filter(x=>x.kind==='value');
  for(const m of newValues){
   const old=prev.mentions.find(p=>p.kind==='value'&&p.table===m.table&&p.column===m.column);
   if(old)merged=merged.replace(new RegExp('\\b'+old.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i'),m.text);
  }
  const allReplaced=newValues.length>0&&[...new Set(newValues.map(m=>m.text))].every(text=>newValues.some(m=>m.text===text&&prev.mentions.some(p=>p.kind==='value'&&p.table===m.table&&p.column===m.column)));
  const rest=message.replace(/^\s*(and|what about|how about|now|only|just|but|ok so|so|same for|for)\b/i,'').replace(/[?.!]+$/,'').trim();
  const entityRef=ENTITY_REF.test(message)&&last.ids.length&&last.entityTable;
  // Exact substitutions and narrowings ("of those, only production") need no model call.
  const narrowing=/\b(of those|of these|of them|among them|among those|only|just|that are|which are)\b/i.test(message);
  const newTexts=[...new Set(newValues.map(m=>m.text))];
  if(allReplaced)return merged+'?';
  // "break that down by environment" / "split it per region": add the grouping to the previous question.
  const by=message.replace(/\b(instead|please|then|now)\b/gi,' ').replace(/\s+/g,' ').trim().match(/\b(?:by|per|across|for each)\s+[\w\s]+?$/i);
  if(by&&!newTexts.length&&!entityRef){
   const phrase=by[0].replace(/[?.!]+$/,'').trim();
   // "...by priority instead": replace the earlier grouping rather than adding a second one.
   const replaced=merged.replace(/\b(?:by|per|across|for each)\s+[\w\s]+$/i,phrase);
   return `${/\binstead\b/i.test(message)||replaced!==merged&&/\b(by|per)\b/i.test(merged)?replaced:merged+' '+phrase}?`;
  }
  // "what about vulnerabilities?": same question about another table — swap the measured table's word.
  const newTables=g.mentions.filter(m=>m.kind==='table'&&!prev.mentions.some(p=>p.kind==='table'&&p.table===m.table));
  if(newTables.length===1&&!newValues.length&&!entityRef&&/^\s*(what about|how about|and|same for|now|and for)\b/i.test(message)){
   const prevTables=prev.mentions.filter(p=>p.kind==='table');
   const n=norm(last.standalone);
   const target=[...prevTables].sort((a,b)=>n.indexOf(norm(b.text))-n.indexOf(norm(a.text)))[0];
   if(target)return merged.replace(new RegExp('\\b'+target.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\w*','i'),newTables[0].text)+'?';
  }
  if(narrowing&&newTexts.length&&!entityRef)return `${merged} that are ${newTexts.join(' and ')}?`;
  const deterministic=allReplaced?merged+'?':entityRef?`${rest.replace(ENTITY_REF,`the ${last.ids.length} previously listed ${last.entityTable}`)}?`:`${merged}, ${rest}?`;
  try{
   const out=await this.llm(z.object({standalone:z.string().min(3).max(400)}),'Follow-up rewrite','Rewrite the latest user message as ONE standalone question about the database. Keep every filter, entity and measure from the previous question that still applies, and apply the changes in the latest message (a new value replaces the old value of the same kind). If the message refers to the previous results ("they", "those", "them"), write "the previously listed <entities>". Do not answer.',{previousQuestion:last.standalone,previousResult:last.summary,latestMessage:message},trace,{think:profile.tier!=='tiny'&&profile.thinking,maxTokens:300});
   const candidate=out.standalone.trim();
   const cg=await ground(candidate,this.catalog);
   // Accept only if the rewrite keeps every value the user just mentioned and still grounds.
   const keeps=[...new Set(newValues.map(m=>m.text))].every(text=>newValues.some(m=>m.text===text&&cg.mentions.some(x=>x.value===m.value)));
   const dropsReplaced=newValues.every(m=>!cg.mentions.some(x=>x.kind==='value'&&x.table===m.table&&x.column===m.column&&x.value!==m.value&&!newValues.some(n=>n.value===x.value)));
   // The rewrite must also keep every earlier filter the user did not replace ("break that down by environment").
   const replacedCols=new Set(newValues.map(m=>m.table+'.'+m.column));
   // New columns the user just named ("by environment") must survive the rewrite.
   const keepsColumns=g.mentions.filter(m=>m.kind==='column'&&m.confidence>=0.9).every(m=>cg.mentions.some(x=>x.kind==='column'&&x.column===m.column));
   const keepsPrevious=prev.mentions.filter(p=>p.kind==='value'&&p.confidence>=0.9&&!replacedCols.has(p.table+'.'+p.column)).every(p=>cg.mentions.some(x=>x.kind==='value'&&x.value===p.value));
   if(cg.tables.length&&keeps&&keepsPrevious&&keepsColumns&&dropsReplaced&&!/[<>]/.test(candidate)&&candidate.split(/\s+/).length>=3&&norm(candidate)!==norm(last.standalone))return candidate;
  }catch(e){if(e instanceof BudgetError||e instanceof UnavailableError)throw e;}
  return deterministic;
 }

 private async fastPath(question:string,g:Grounding,scope:Scope|undefined,trace:Trace,emit:(m:string)=>void):Promise<Evidence[]|undefined>{
  try{
   const valueTables=new Set(g.mentions.filter(m=>m.kind==='value').map(m=>m.table));
   if(!/\b(average|avg|mean|sum|total|max|maximum|min|minimum|percent|percentage|ratio|fraction|share|median|highest|lowest|most|least|top|bottom|distinct|unique|never|without|last|recent|this|since)\b/i.test(question)||requestedLimit(question)){
    const contract=resolveContract(question,this.catalog,scope?.ids||[]);
    if(contract&&[...valueTables].every(t=>t===contract.baseTable||(contract.kind==='latest_related'&&t===contract.relatedTable))){
     emit('Using verified operator: '+contract.kind.replace('_',' '));
     const plan=compileContract(contract,this.catalog);trace.plans.push(plan);
     trace.checklist=plan.steps.map(s=>({id:s.id,objective:s.objective,dependencies:s.dependencies,status:'pending'}));
     await this.executor.execute(plan,trace,emptyState(),emit);
     const result=verifyContract(contract,trace.evidence);trace.driver='operator';
     return [result];
    }
   }
   // Follow-up on listed records: "which applications do they belong to?" maps each selected record to
   // the parent record it references (one row per selected record, so the mapping stays visible).
   if(scope?.ids.length&&/\b(which|what|list|show)\b/i.test(question)&&!/\b(how many|count|number of|average|avg|total|sum|max|min|most|least|top)\b/i.test(question)&&!g.mentions.some(m=>m.kind==='value'&&!scope.ids.includes(String(m.value)))){
    const base=this.catalog.table(scope.table);
    const named=[...new Set(g.mentions.filter(m=>m.kind==='table'&&m.table!==base.name).map(m=>m.table))].map(n=>this.catalog.table(n));
    const parent=named.length===1&&named[0].primaryKey&&base.relationships.includes(`${base.name}.${named[0].primaryKey} = ${named[0].name}.${named[0].primaryKey}`)?named[0]:undefined;
    if(parent){
     const fk=identifier(parent.primaryKey!),label=labelColumn(parent)||parent.primaryKey!;
     const sql=`SELECT s.${identifier(scope.key)}, p.${identifier(label)} FROM ${identifier(base.name)} s LEFT JOIN ${identifier(parent.name)} p ON s.${fk} = p.${fk} WHERE s.${identifier(scope.key)} IN (${scope.ids.map(sqlLiteral).join(', ')}) ORDER BY s.${identifier(scope.key)}`;
     const result=await this.catalog.db.query(sql);
     emit(`Looked up the ${parent.name} of the ${scope.ids.length} selected ${base.name}`);trace.driver='operator';
     return [{stepId:'related-parent',objective:`${parent.name} of the selected ${base.name}`,tool:'run_sql',sql,...result,durationMs:0,repairs:0}];
    }
   }
   // Anti-join: "how many servers have never had a failed backup" / "servers without incidents".
   if(/\b(never|without|no|none|not have|don't have|do not have)\b/i.test(question)&&/\b(how many|count|number of|which|list)\b/i.test(question)&&!scope){
    const named=[...new Set(g.mentions.filter(m=>m.kind==='table').map(m=>m.table))];
    if(named.length===2){
     const pair=named.map(n=>this.catalog.table(n));
     const references=(from:typeof pair[number],to:typeof pair[number])=>Boolean(to.primaryKey)&&from.relationships.includes(`${from.name}.${to.primaryKey} = ${to.name}.${to.primaryKey}`);
     const [parent,child]=references(pair[1],pair[0])?pair:[pair[1],pair[0]];
     const link=parent.primaryKey&&child.relationships.find(r=>r===`${child.name}.${parent.primaryKey} = ${parent.name}.${parent.primaryKey}`);
     const byValue=new Map<string,typeof g.mentions>();for(const m of g.mentions.filter(m=>m.kind==='value'&&m.confidence>=0.85)){const k=m.text+'|'+m.value;byValue.set(k,[...(byValue.get(k)||[]),m]);}
     const childValues=[...byValue.values()].map(list=>[...list].sort((a,b)=>a.column!.length-b.column!.length)[0]);
     if(link&&childValues.every(m=>m.table===child.name)&&new Set(childValues.map(m=>m.column)).size===childValues.length){
      const key=identifier(parent.primaryKey!);
      const cond=childValues.map(m=>` AND c.${identifier(m.column!)} = ${sqlLiteral(m.value)}`).join('');
      const listing=/\b(which|list|show)\b/i.test(question)&&!/\bhow many|count|number of\b/i.test(question);
      const sql=`SELECT ${listing?`p.${key}`:`count(*) AS ${parent.name}_count`} FROM ${identifier(parent.name)} p WHERE NOT EXISTS (SELECT 1 FROM ${identifier(child.name)} c WHERE c.${key} = p.${key}${cond})${listing?` ORDER BY p.${key}`:''}`;
      const result=await this.catalog.db.query(sql);
      emit(`Counted ${parent.name} with no matching ${child.name}${cond?' where'+cond.slice(4):''}`);trace.driver='operator';
      return [{stepId:'anti-join',objective:`${parent.name} without matching ${child.name}`,tool:'run_sql',sql,...result,durationMs:0,repairs:0}];
     }
    }
   }
   // Share of rows meeting one grounded condition ("what percentage of servers are unsupported").
   if(/\b(percent|percentage|share|fraction|proportion)\b/i.test(question)&&!scope&&!/\b(by|per|each|every)\b/i.test(question)){
    const named=[...new Set(g.mentions.filter(m=>m.kind==='table').map(m=>m.table))];
    const base=named.length===1?named[0]:g.tables.length===1?g.tables[0]:undefined;
    if(base){
     const table=this.catalog.table(base);
     const conditions=[...g.mentions.filter(m=>m.kind==='value'&&m.table===base&&m.confidence>=0.9).map(m=>`${identifier(m.column!)} = ${sqlLiteral(m.value)}`),
      ...g.mentions.filter(m=>m.kind==='column'&&m.table===base&&m.confidence>=0.9&&table.columns.find(c=>c.name===m.column)?.type==='BOOLEAN').map(m=>identifier(m.column!))];
     const otherTables=g.mentions.some(m=>m.kind==='value'&&m.table!==base);
     if(conditions.length===1&&!otherTables){
      const cond=conditions[0];
      const sql=`SELECT count(*) FILTER (WHERE ${cond}) AS matching_${base}, count(*) AS total_${base}, round(100.0 * count(*) FILTER (WHERE ${cond}) / count(*), 2) AS percentage FROM ${identifier(base)}`;
      const result=await this.catalog.db.query(sql);
      emit(`Computed share of ${base} where ${cond}`);trace.driver='operator';
      return [{stepId:'share',objective:`Share of ${base} where ${cond}`,tool:'run_sql',sql,...result,durationMs:0,repairs:0}];
     }
    }
   }
   const periods=calendarPeriods(question);
   const dateMentions=g.mentions.filter(m=>m.kind==='column'&&m.column&&/DATE|TIME/.test(this.catalog.table(m.table).columns.find(c=>c.name===m.column)?.type||''));
   const tables=g.tables.filter(t=>!this.catalog.isReferenceTable(t));
   const calendarTable=tables.length===1?this.catalog.table(tables[0]):undefined;
   // Filters the calendar operator can apply itself: stored values and boolean flags on the same table.
   const filterable=(m:Grounding['mentions'][number])=>m.table===calendarTable?.name&&m.confidence>=0.9&&(m.kind==='value'||(m.kind==='column'&&calendarTable!.columns.find(c=>c.name===m.column)?.type==='BOOLEAN'));
   const otherMentions=g.mentions.filter(m=>(m.kind==='value'||(m.kind==='column'&&!dateMentions.includes(m)))&&!filterable(m)&&!(m.kind==='column'&&m.confidence<0.9));
   const where=g.mentions.filter(filterable).map(m=>m.kind==='value'?`${identifier(m.column!)} = ${sqlLiteral(m.value)}`:identifier(m.column!));
   if(periods.length&&calendarTable&&!otherMentions.length&&!g.unknownTerms.length&&!scope&&this.catalog.referenceDate){
    const table=calendarTable;const dates=table.columns.filter(c=>/DATE|TIMESTAMP/.test(c.type));
    const column=dateMentions.find(m=>m.table===table.name)?.column||dates.find(c=>/created|opened|start|discovered/.test(c.name))?.name||(dates.length===1?dates[0].name:undefined);
    if(column){
     const sql=periodComparisonSQL(table.name,column,periods,this.catalog.referenceDate,[...new Set(where)].join(' AND '));const result=await this.catalog.db.query(sql);
     emit(`Counted ${table.name} by calendar period on ${column}${where.length?' where '+where.join(' AND '):''} (reference date ${this.catalog.referenceDate})`);trace.driver='calendar';
     return [{stepId:'calendar',objective:`${table.name} per calendar period by ${column}`,tool:'run_sql',sql,...result,durationMs:0,repairs:0}];
    }
   }
  }catch(e){emit('Operator path skipped: '+(e instanceof Error?e.message:String(e)).slice(0,100));trace.evidence=[];trace.plans=[];}
  return undefined;
 }

 // A one-line joke about the subject. It may not contain numbers or names: facts are added separately
 // from verified queries, so the joke cannot misstate the data.
 private async joke(subject:string,trace:Trace,emit:(m:string)=>void){
  emit('Writing a light-hearted line (facts come from the queries, not the joke)');
  try{
   const out=await this.llm(z.object({joke:z.string().min(5).max(300)}),'Joke','Write one short, clean, workplace-friendly joke about the given IT topic. No numbers, names, identifiers or claims about specific data.',{topic:subject.replace(/_/g,' ')},{...trace,deadlineMs:Math.min(trace.deadlineMs||Infinity,Date.now()+15000)},{temperature:0.8,maxTokens:120});
   const j=out.joke.trim();
   if(!/\d/.test(j)&&j.split(/\s+/).length>=5)return j;
  }catch(e){if(e instanceof UnavailableError)throw e;}
  return plainJoke(subject);
 }
 private async creative(instructions:string,evidence:Evidence[],trace:Trace,emit:(m:string)=>void){
  if(!evidence.some(e=>e.rows.length))return '';
  emit('Writing around verified records');
  try{
   const prose=await this.llm(z.object({intro:z.string().max(700),refrain:z.string().max(700),outro:z.string().max(700)}),'Creative writing','Write poetic connecting lines for the requested style. Return intro, refrain and outro. Do not include names, identifiers, numbers, technical properties or claims about records: database facts will be inserted separately.',{instructions},{...trace,deadlineMs:Math.min(trace.deadlineMs!,Date.now()+15000)});
   const facts=evidence.flatMap(e=>e.rows).slice(0,10).map(r=>Object.entries(r).map(([k,v])=>`${k}: ${String(v)}`).join(' · '));
   return '\n\n'+[prose.intro,...facts.flatMap(f=>[f,prose.refrain]),prose.outro].join('\n');
  }catch{return '\n\nCreative writing could not finish within its budget; verified records are shown below.';}
 }

 private remember(state:State,question:string,standalone:string,evidence:Evidence[],text:string):State{
  // Entity scope for "they/those": primary key of the queried base table present in the results.
  let entityKey:string|undefined,entityTable:string|undefined,ids:string[]=[];
  for(const e of evidence){
   const cols=Object.keys(e.rows[0]||{});
   const keyed=this.catalog.tables.filter(t=>t.primaryKey&&cols.includes(t.primaryKey));
   const fromTable=keyed.find(t=>new RegExp('FROM\\s+"?'+t.name+'"?\\b','i').test(e.sql||''))||keyed[0];
   if(fromTable){entityKey=fromTable.primaryKey;entityTable=fromTable.name;ids=[...new Set(e.rows.map(r=>String(r[entityKey!])))].slice(0,200);break;}
  }
  const literals=[...new Set(evidence.flatMap(e=>[...(e.sql||'').matchAll(/'((?:''|[^'])*)'/g)].map(m=>m[1].replaceAll("''","'"))))].slice(0,50);
  const memory:TurnMemory={question,standalone,sql:evidence.map(e=>e.sql||'').filter(Boolean),summary:text.slice(0,300),entityKey,entityTable,ids,literals};
  return {...state,lastQuestion:question,intent:standalone,selectedIds:ids,previousSql:memory.sql,turns:[...(state.turns||[]),memory].slice(-3)};
 }

 save(id:string,state:State){state.schemaVersion=this.catalog.version;this.sessions.set(id,{state,at:Date.now()});for(const [key,value]of this.sessions)if(Date.now()-value.at>3600000)this.sessions.delete(key);if(this.sessions.size>100)this.sessions.delete(this.sessions.keys().next().value!);}
}

const m0=(counts:{m:{table:string}}[])=>counts[0].m.table;
function presentation(evidence:Evidence[]):Answer['presentation']{
 const e=evidence.at(-1);if(!e)return 'table';
 return e.rows.length===1&&Object.keys(e.rows[0]||{}).length<=3?'metrics':'table';
}
