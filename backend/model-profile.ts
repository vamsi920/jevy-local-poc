import {config} from './config.js';
import {totalmem} from 'node:os';
import {provider,parseSize,setProvider} from './providers.js';

// The harness adapts its strategy to the model it is given instead of hardcoding one model's limits.
export type Tier='tiny'|'small'|'large';
export type Profile={
 model:string;
 paramsB:number;           // billions of parameters (estimated when Ollama does not report them)
 contextLength:number;     // model's trained context
 thinking:boolean;         // supports Ollama `think`
 tools:boolean;            // supports native tool calling
 tier:Tier;
 numCtx:number;            // context window we request
 candidates:number;        // parallel SQL candidates for self-consistency
 repairs:number;           // repair rounds per SQL candidate
 review:boolean;           // run semantic SQL review
 toolLoop:boolean;         // use native tool-calling agent loop
 maxToolSteps:number;
 rowsForModel:number;      // result rows shown to the model per query
 budgetMs:number;          // adaptive request budget
 thinkTokens:number;       // output ceiling when reasoning is enabled
};

export function tierFor(paramsB:number):Tier{return paramsB<2?'tiny':paramsB<14?'small':'large';}

export function buildProfile(model:string,paramsB:number,contextLength:number,capabilities:string[]):Profile{
 const tier=config.agentTier||tierFor(paramsB);
 const thinking=capabilities.includes('thinking');
 const tools=capabilities.includes('tools');
 // KV cache grows with context; low-memory machines get a smaller window so models still load.
 const memoryGb=totalmem()/2**30;
 const want=Math.min(tier==='tiny'?8192:tier==='small'?16384:32768,memoryGb<=8?8192:memoryGb<=16?16384:65536);
 const base={tiny:{candidates:3,repairs:2,review:false,maxToolSteps:0,rowsForModel:15,budgetMs:120000,thinkTokens:1536},
  small:{candidates:2,repairs:2,review:true,maxToolSteps:10,rowsForModel:30,budgetMs:150000,thinkTokens:3072},
  large:{candidates:1,repairs:3,review:true,maxToolSteps:14,rowsForModel:60,budgetMs:180000,thinkTokens:4096}}[tier];
 return {model,paramsB,contextLength,thinking,tools,tier,numCtx:Math.min(want,contextLength||want),...base,
  toolLoop:tools&&tier!=='tiny',budgetMs:Math.min(base.budgetMs,config.requestTimeout)};
}

const cache=new Map<string,Promise<Profile>>();
// Size, context and capabilities come from the provider (Ollama reports them; remote endpoints use
// LLM_PARAMS_B / LLM_CONTEXT_LENGTH / LLM_CAPABILITIES), falling back to the model name.
export function getProfile(model=config.model):Promise<Profile>{
 const hit=cache.get(model);if(hit)return hit;
 const profile=(async()=>{
  const d=await provider().describe(model).catch(()=>({} as Awaited<ReturnType<ReturnType<typeof provider>['describe']>>));
  if(!d.paramsB&&!d.capabilities)cache.delete(model);
  return buildProfile(model,d.paramsB&&Number.isFinite(d.paramsB)?d.paramsB:guessParams(model),d.contextLength||32768,d.capabilities||guessCapabilities(model));
 })();
 cache.set(model,profile);
 return profile;
}
export function resetProfile(){cache.clear();setProvider(undefined);}
// "qwen3:0.6b", "Llama-3.1-70B-Instruct", "gpt-oss-20b": find a size token anywhere in the name.
function guessParams(model:string){const m=model.match(/(?:^|[:\-_/ ])(\d+(?:\.\d+)?)\s*([bm])(?=$|[\-_:./ ])/i);const p=m?parseSize(m[1]+m[2].toUpperCase()):NaN;return Number.isFinite(p)?p:/gpt-4|gpt-5|claude|gemini|sonnet|opus/i.test(model)?100:7;}
function guessCapabilities(model:string){return ['completion',...(provider().name==='ollama'&&/qwen3|deepseek-r1|gpt-oss|magistral|qwq/i.test(model)?['thinking']:[]),...(/qwen|llama-?3\.[1-9]|mistral|mixtral|gpt|granite|command-r|hermes|claude|gemini|phi-?4/i.test(model)?['tools']:[])];}
