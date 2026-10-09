import { z } from 'zod';
import {config} from './config.js';
import {getProfile} from './model-profile.js';
import {provider,BudgetError,UnavailableError,type ChatMessage,type ToolCall,type ToolSpec,type Completion} from './providers.js';
import type {Trace} from './types.js';
export {BudgetError,UnavailableError};
export type {ChatMessage,ToolCall,ToolSpec};

export async function health(){
 const p=provider();
 try{
  if(!await p.online())throw new Error('offline');
  const models=(await p.listModels()).map(m=>m.name);
  return {online:true,provider:p.name,model:config.model,ready:p.name!=='ollama'||models.includes(config.model),models};
 }catch{return {online:false,provider:p.name,model:config.model,ready:false,models:[] as string[]};}
}

export type CallOptions={think?:boolean;temperature?:number;seed?:number;maxTokens?:number};
export type Model = <T>(schema:z.ZodType<T>,purpose:string,system:string,input:unknown,trace:Trace,options?:CallOptions)=>Promise<T>;

// Some reasoning models ignore think:false and emit their reasoning inline, sometimes with only a
// closing </think> tag. Keep just the text after the reasoning.
export const stripReasoning=(text:string)=>{const t=text.replace(/<think>[\s\S]*?<\/think>/g,'');const close=t.lastIndexOf('</think>');return (close>=0?t.slice(close+8):t).trim();};
// Small models wrap JSON in fences, prepend prose or leak <think> blocks. Recover the first balanced object.
export function extractJSON(text:string):unknown{
 const cleaned=stripReasoning(text).replace(/```(?:json)?/gi,'').trim();
 try{return JSON.parse(cleaned);}catch{}
 const start=cleaned.indexOf('{');if(start<0)throw new Error('No JSON object in model output');
 let depth=0,inString=false,escaped=false;
 for(let i=start;i<cleaned.length;i++){
  const ch=cleaned[i];
  if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}
  if(ch==='"')inString=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0)return JSON.parse(cleaned.slice(start,i+1));
 }
 throw new Error('Unterminated JSON object in model output');
}

// Measured throughput per model (exponential moving average), so strategy can adapt to real
// speed rather than parameter count alone.
const speeds=new Map<string,{promptTps:number;genTps:number;samples:number}>();
export function speedOf(model:string){return speeds.get(model);}
function recordSpeed(model:string,c:Completion){
 if(!c.genTokens||!c.genSeconds)return;
 const gen=c.genTokens/c.genSeconds,prompt=c.promptTokens&&c.promptSeconds&&c.promptTokens>50?c.promptTokens/c.promptSeconds:undefined;
 const old=speeds.get(model);const a=old?0.4:1;
 speeds.set(model,{genTps:old?old.genTps*(1-a)+gen*a:gen,promptTps:prompt?(old?old.promptTps*(1-a)+prompt*a:prompt):(old?.promptTps||400),samples:(old?.samples||0)+1});
}
// Wall-clock latency per model call (network + queueing + generation), used to size request budgets
// for slower remote endpoints.
const latencies=new Map<string,number>();
export function latencyOf(model:string){return latencies.get(model);}
function recordLatency(model:string,ms:number){const old=latencies.get(model);latencies.set(model,old===undefined?ms:old*0.7+ms*0.3);}
function remainingMs(trace:Trace){const remaining=(trace.deadlineMs||Date.now()+config.llmTimeout)-Date.now();if(remaining<=0)throw new BudgetError();return remaining;}

// Bounded parallelism: candidates and sub-questions fan out, but never beyond what the endpoint can serve.
let running=0;const waiting:(()=>void)[]=[];
async function slot<T>(fn:()=>Promise<T>):Promise<T>{
 if(running>=config.llm.concurrency)await new Promise<void>(r=>waiting.push(r));
 running++;try{return await fn();}finally{running--;waiting.shift()?.();}
}
async function complete(req:Parameters<ReturnType<typeof provider>['complete']>[0],trace:Trace){
 const started=Date.now();
 try{const c=await slot(()=>provider().complete({...req,timeoutMs:Math.min(config.llmTimeout,remainingMs(trace))}));recordSpeed(req.model,c);recordLatency(req.model,Date.now()-started);return c;}
 catch(e){if(trace.deadlineMs&&Date.now()>=trace.deadlineMs-50&&!(e instanceof UnavailableError))throw new BudgetError();throw e;}
}

export const model:Model=async(schema,purpose,system,input,trace,options={})=>{
 const modelName=trace.model||config.model;
 const profile=await getProfile(modelName);
 const thinking=Boolean(options.think)&&profile.thinking;
 const responseSchema=z.toJSONSchema(schema) as Record<string,unknown>;
 trace.notify?.(`Model call: ${purpose}`);
 let feedback='';let maxTokens=options.maxTokens||(thinking?profile.thinkTokens:900);
 for(let attempt=0;attempt<2;attempt++){
  remainingMs(trace);
  const start=performance.now();
  try{
   const c=await complete({model:modelName,jsonSchema:responseSchema,think:thinking,temperature:options.temperature??0,seed:options.seed??config.seed,numCtx:profile.numCtx,maxTokens,timeoutMs:0,
    messages:[{role:'system',content:system+'\nReturn only the final JSON matching the response schema.'+(profile.thinking&&!thinking&&provider().name==='ollama'?' /no_think':'')},{role:'user',content:JSON.stringify(input)+feedback}]},trace);
   try{
    const answer=schema.parse(extractJSON(c.content));
    trace.llm.push({purpose,durationMs:performance.now()-start,thinking,tokens:c.genTokens,promptTokens:c.promptTokens});return answer;
   }catch(e){
    if(c.doneReason==='length')maxTokens=Math.min(maxTokens*2,8192);
    throw e;
   }
  }catch(e){
   if(e instanceof BudgetError||e instanceof UnavailableError){trace.llm.push({purpose,durationMs:performance.now()-start,error:e.message});throw e;}
   const message=e instanceof Error?e.message:String(e);
   trace.llm.push({purpose,durationMs:performance.now()-start,error:message});
   feedback='\nPrevious output failed validation: '+message.slice(0,300)+'. Return valid JSON only.';
   if(attempt===1)throw new Error(`${purpose}: invalid model output after two attempts: ${message.slice(0,300)}`);
  }
 }
 throw new Error('unreachable');
};

// Native tool calling for agent-loop drivers.
export type Chat=(messages:ChatMessage[],tools:ToolSpec[],purpose:string,trace:Trace,options?:CallOptions)=>Promise<{content:string;toolCalls:ToolCall[]}>;
export const chat:Chat=async(messages,tools,purpose,trace,options={})=>{
 const modelName=trace.model||config.model;
 const profile=await getProfile(modelName);
 const thinking=Boolean(options.think)&&profile.thinking;
 const start=performance.now();
 trace.notify?.(`Model call: ${purpose}`);
 try{
  const c=await complete({model:modelName,messages,tools,think:thinking,temperature:options.temperature??0,seed:options.seed??config.seed,numCtx:profile.numCtx,maxTokens:options.maxTokens||(thinking?profile.thinkTokens+1024:1536),timeoutMs:0},trace);
  trace.llm.push({purpose,durationMs:performance.now()-start,thinking,tokens:c.genTokens,promptTokens:c.promptTokens});
  return {content:stripReasoning(c.content||''),toolCalls:c.toolCalls};
 }catch(e){trace.llm.push({purpose,durationMs:performance.now()-start,error:e instanceof Error?e.message:String(e)});throw e;}
};

// Loads a model and samples its speed so the first real question is not slowed by loading.
export async function warm(modelName:string){
 const profile=await getProfile(modelName);
 const filler='Columns: '+Array.from({length:60},(_,i)=>`field_${i} VARCHAR`).join(', ');
 const start=Date.now();
 const c=await provider().complete({model:modelName,messages:[{role:'user',content:filler+'\nReply with the word ready.'+(profile.thinking&&provider().name==='ollama'?' /no_think':'')}],think:false,temperature:0,seed:config.seed,maxTokens:24,numCtx:profile.numCtx,timeoutMs:240000});
 recordSpeed(modelName,c);
 return {ms:Date.now()-start,speed:speeds.get(modelName)};
}
