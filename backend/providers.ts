// LLM providers. The harness talks to one small interface so any model can be plugged in:
// local Ollama, or any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, vLLM, TGI, LM Studio,
// LiteLLM and most enterprise gateways in front of self-hosted GPUs).
import {config} from './config.js';

export class BudgetError extends Error{constructor(){super('Request time budget exhausted; narrow the question or use a larger model.');}}
export class UnavailableError extends Error{}

export type ToolCall={id?:string;function:{name:string;arguments:Record<string,unknown>}};
export type ChatMessage={role:'system'|'user'|'assistant'|'tool';content:string;tool_calls?:ToolCall[];tool_name?:string;tool_call_id?:string};
export type ToolSpec={type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}};
export type CompletionRequest={model:string;messages:ChatMessage[];tools?:ToolSpec[];jsonSchema?:Record<string,unknown>;think:boolean;temperature:number;seed:number;maxTokens:number;numCtx:number;timeoutMs:number};
export type Completion={content:string;thinking?:string;toolCalls:ToolCall[];doneReason?:string;promptTokens?:number;genTokens?:number;genSeconds?:number;promptSeconds?:number};
export type ModelInfo={name:string;parameters?:string;family?:string;sizeGb?:number};
export type ModelDescription={paramsB?:number;contextLength?:number;capabilities?:string[]};
export interface Provider{
 name:string;
 complete(req:CompletionRequest):Promise<Completion>;
 listModels():Promise<ModelInfo[]>;
 describe(model:string):Promise<ModelDescription>;
 online():Promise<boolean>;
}

// Enterprise endpoints are shared and sometimes busy: rate limits (429), gateway hiccups (502/503/504)
// and dropped connections are retried with exponential backoff and jitter, honouring Retry-After, but
// never beyond this call's time budget. Client errors (400/401/404) are returned immediately.
const RETRYABLE=new Set([408,425,429,500,502,503,504]);
export const retryStats={retries:0};
async function request(url:string,init:RequestInit,timeoutMs:number,label:string){
 const deadline=Date.now()+Math.max(1,timeoutMs);let attempt=0;let lastError='';
 for(;;){
  const remaining=deadline-Date.now();
  if(remaining<=0)throw new Error(`Model call took longer than ${Math.round(timeoutMs/1000)}s${lastError?` (last error: ${lastError})`:''}; the endpoint may be overloaded or too slow for the request budget.`);
  let r:Response|undefined;
  try{r=await fetch(url,{...init,signal:AbortSignal.timeout(remaining)});}
  catch(e){
   const message=e instanceof Error?e.message:String(e);
   if(e instanceof Error&&(e.name==='TimeoutError'||/timeout|aborted/i.test(message)))throw new Error(`Model call took longer than ${Math.round(timeoutMs/1000)}s; the endpoint may be overloaded or too slow for the request budget.`);
   // Connection refused on the first try means the endpoint is down; resets mid-way are retried.
   if(attempt===0&&/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message+String((e as {cause?:unknown}).cause||'')))throw new UnavailableError(`${label} unavailable (${message}).`);
   lastError=message;
  }
  if(r&&!RETRYABLE.has(r.status))return r;
  if(r)lastError=`HTTP ${r.status}`;
  if(++attempt>config.llm.retries){if(r)return r;throw new UnavailableError(`${label} unavailable after ${attempt} attempts (${lastError}).`);}
  const retryAfter=Number(r?.headers.get('retry-after'));
  const wait=Math.min(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:500*2**(attempt-1)*(0.75+Math.random()*0.5),Math.max(0,deadline-Date.now()-250),20000);
  retryStats.retries++;
  await new Promise(res=>setTimeout(res,wait));
 }
}
let callSeq=0;const callId=()=>'call_'+(++callSeq).toString(36);

// ---------------------------------------------------------------------------------------------
export class OllamaProvider implements Provider{
 name='ollama';
 constructor(private url:string){}
 async complete(req:CompletionRequest):Promise<Completion>{
  const body:Record<string,unknown>={model:req.model,stream:false,keep_alive:'30m',messages:req.messages.map(m=>({role:m.role,content:m.content,...(m.tool_calls?{tool_calls:m.tool_calls.map(c=>({function:c.function}))}:{}),...(m.tool_name?{tool_name:m.tool_name}:{})})),
   options:{temperature:req.temperature,seed:req.seed,num_ctx:req.numCtx,num_predict:req.maxTokens,repeat_penalty:req.think?1:1.1}};
  if(req.jsonSchema)body.format=req.jsonSchema;
  if(req.tools?.length)body.tools=req.tools;
  if((await this.describe(req.model)).capabilities?.includes('thinking'))body.think=req.think;
  const r=await request(this.url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},req.timeoutMs,'Local Ollama');
  if(!r.ok)throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0,300)}`);
  const j=await r.json() as {message:{content:string;thinking?:string;tool_calls?:{function:{name:string;arguments:Record<string,unknown>|string}}[]};done_reason?:string;eval_count?:number;prompt_eval_count?:number;eval_duration?:number;prompt_eval_duration?:number};
  return {content:j.message.content||'',thinking:j.message.thinking,toolCalls:(j.message.tool_calls||[]).map(c=>({id:callId(),function:{name:c.function.name,arguments:parseArgs(c.function.arguments)}})),doneReason:j.done_reason,
   promptTokens:j.prompt_eval_count,genTokens:j.eval_count,genSeconds:j.eval_duration?j.eval_duration/1e9:undefined,promptSeconds:j.prompt_eval_duration?j.prompt_eval_duration/1e9:undefined};
 }
 async listModels(){
  const r=await fetch(this.url+'/api/tags',{signal:AbortSignal.timeout(3000)}).then(x=>x.json() as Promise<{models:{name:string;size:number;details?:{parameter_size?:string;family?:string}}[]}>).catch(()=>({models:[]}));
  return r.models.filter(m=>!/embed/i.test(m.name)&&!/(?:[:\-])cloud$/i.test(m.name)).map(m=>({name:m.name,parameters:m.details?.parameter_size||'',family:m.details?.family||'',sizeGb:Math.round(m.size/1e8)/10}));
 }
 private described=new Map<string,Promise<ModelDescription>>();
 describe(model:string){
  if(!this.described.has(model))this.described.set(model,(async()=>{
   try{
    const r=await fetch(this.url+'/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model}),signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw new Error('show '+r.status);
    const j=await r.json() as {details?:{parameter_size?:string};capabilities?:string[];model_info?:Record<string,unknown>};
    if(!j.details&&!j.capabilities)throw new Error('no metadata');
    const info=j.model_info||{};const count=Number(info['general.parameter_count']);
    const ctxKey=Object.keys(info).find(k=>k.endsWith('.context_length'));
    return {paramsB:Number.isFinite(count)&&count>0?count/1e9:parseSize(j.details?.parameter_size),contextLength:ctxKey?Number(info[ctxKey]):undefined,capabilities:j.capabilities};
   }catch{this.described.delete(model);return {};}
  })());
  return this.described.get(model)!;
 }
 async online(){try{return (await fetch(this.url+'/api/tags',{signal:AbortSignal.timeout(2500)})).ok;}catch{return false;}}
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible chat completions. Structured output degrades gracefully per model:
// json_schema -> json_object -> prompt-only JSON, remembered after the first rejection.
type JsonMode='json_schema'|'json_object'|'prompt';
export class OpenAICompatibleProvider implements Provider{
 name='openai';
 private jsonMode=new Map<string,JsonMode>();
 constructor(private baseUrl:string,private apiKey:string,private headers:Record<string,string>,private defaultMode:JsonMode|'auto',private reasoning:string){}
 private auth(){return {'Content-Type':'application/json',...(this.apiKey?{Authorization:'Bearer '+this.apiKey}:{}),...this.headers};}
 async complete(req:CompletionRequest):Promise<Completion>{
  let mode:JsonMode=this.jsonMode.get(req.model)||(this.defaultMode==='auto'?'json_schema':this.defaultMode);
  for(let attempt=0;attempt<3;attempt++){
   const messages=req.messages.map(m=>m.role==='tool'?{role:'tool',content:m.content,tool_call_id:m.tool_call_id||'call_unknown'}:
    m.tool_calls?{role:m.role,content:m.content||null,tool_calls:m.tool_calls.map(c=>({id:c.id||callId(),type:'function',function:{name:c.function.name,arguments:JSON.stringify(c.function.arguments)}}))}:{role:m.role,content:m.content});
   if(req.jsonSchema&&mode!=='json_schema'){const sys=messages.find(m=>m.role==='system') as {content:string}|undefined;const hint=`\nRespond with one JSON object matching this JSON schema: ${JSON.stringify(req.jsonSchema)}`;if(sys)sys.content+=hint;else messages.unshift({role:'system',content:hint.trim()});}
   const body:Record<string,unknown>={model:req.model,messages,temperature:req.temperature,max_tokens:req.maxTokens,seed:req.seed};
   if(req.tools?.length)body.tools=req.tools;
   if(req.jsonSchema&&mode==='json_schema')body.response_format={type:'json_schema',json_schema:{name:'response',schema:req.jsonSchema,strict:false}};
   if(req.jsonSchema&&mode==='json_object')body.response_format={type:'json_object'};
   if(req.think&&this.reasoning==='effort')body.reasoning_effort='medium';
   if(this.reasoning==='chat_template')body.chat_template_kwargs={enable_thinking:req.think};
   const started=performance.now();
   const r=await request(this.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:this.auth(),body:JSON.stringify(body)},req.timeoutMs,'LLM endpoint');
   if(!r.ok){
    const text=(await r.text()).slice(0,400);
    // Endpoint does not support this structured-output mode: fall back and remember.
    if(req.jsonSchema&&(r.status===400||r.status===422)&&mode!=='prompt'&&/response_format|json_schema|json_object|guided|schema/i.test(text)){mode=mode==='json_schema'?'json_object':'prompt';this.jsonMode.set(req.model,mode);continue;}
    if(r.status===401||r.status===403)throw new UnavailableError(`LLM endpoint rejected the credentials (HTTP ${r.status}). Check LLM_API_KEY.`);
    if(r.status===404)throw new UnavailableError(`LLM endpoint or model not found (HTTP 404): ${text}`);
    throw new Error(`LLM HTTP ${r.status}: ${text}`);
   }
   this.jsonMode.set(req.model,mode);
   const j=await r.json() as {choices:{message:{content:string|null;reasoning_content?:string;tool_calls?:{id:string;function:{name:string;arguments:string|Record<string,unknown>}}[]};finish_reason?:string}[];usage?:{prompt_tokens?:number;completion_tokens?:number}};
   const choice=j.choices?.[0];if(!choice)throw new Error('LLM returned no choices');
   const seconds=(performance.now()-started)/1000;
   return {content:choice.message.content||'',thinking:choice.message.reasoning_content,toolCalls:(choice.message.tool_calls||[]).map(c=>({id:c.id,function:{name:c.function.name,arguments:parseArgs(c.function.arguments)}})),
    doneReason:choice.finish_reason==='length'?'length':choice.finish_reason,promptTokens:j.usage?.prompt_tokens,genTokens:j.usage?.completion_tokens,genSeconds:j.usage?.completion_tokens?seconds:undefined};
  }
  throw new Error('LLM endpoint rejected every structured-output mode');
 }
 async listModels(){
  try{const r=await fetch(this.baseUrl.replace(/\/$/,'')+'/models',{headers:this.auth(),signal:AbortSignal.timeout(4000)});if(!r.ok)throw new Error();const j=await r.json() as {data?:{id:string}[]};return (j.data||[]).map(m=>({name:m.id}));}
  catch{return [{name:config.model}];}
 }
 // Remote APIs rarely expose size or capabilities: use explicit configuration, then the model name.
 async describe(model:string):Promise<ModelDescription>{
  return {paramsB:config.llm.paramsB||undefined,contextLength:config.llm.contextLength||undefined,capabilities:config.llm.capabilities.length?config.llm.capabilities:undefined};
 }
 async online(){try{const r=await fetch(this.baseUrl.replace(/\/$/,'')+'/models',{headers:this.auth(),signal:AbortSignal.timeout(4000)});return r.status<500;}catch{return false;}}
}

function parseArgs(a:Record<string,unknown>|string|undefined):Record<string,unknown>{
 if(!a)return {};if(typeof a!=='string')return a;
 try{return JSON.parse(a);}catch{const m=a.match(/\{[\s\S]*\}/);try{return m?JSON.parse(m[0]):{};}catch{return {};}}
}
export const parseSize=(s:string|undefined)=>{const m=s?.match(/([\d.]+)\s*([KMBT])/i);if(!m)return NaN;const n=Number(m[1]),u=m[2].toUpperCase();return u==='T'?n*1000:u==='B'?n:u==='M'?n/1000:n/1e6;};

let active:Provider|undefined;
export function provider():Provider{
 if(!active)active=config.llm.provider==='openai'
  ?new OpenAICompatibleProvider(config.llm.baseUrl,config.llm.apiKey,config.llm.headers,config.llm.jsonMode,config.llm.reasoning)
  :new OllamaProvider(config.ollamaUrl);
 return active;
}
export function setProvider(p:Provider|undefined){active=p;}
