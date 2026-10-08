// Test-only OpenAI-compatible gateway in front of local Ollama, mimicking an enterprise LLM API:
// bearer auth, /v1/models, /v1/chat/completions with response_format and tools, and no Ollama-specific
// knobs (no `think`, no num_ctx). Usage:
//   GATEWAY_PORT=8787 GATEWAY_KEY=test npx tsx scripts/openai-gateway.ts
//   LLM_PROVIDER=openai LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=test LLM_MODEL=qwen3:0.6b npm run battery
import express from 'express';
const port=Number(process.env.GATEWAY_PORT||8787),key=process.env.GATEWAY_KEY||'',ollama=process.env.OLLAMA_URL||'http://127.0.0.1:11434';
const app=express();app.use(express.json({limit:'4mb'}));
app.use((req,res,next)=>{if(key&&req.headers.authorization!=='Bearer '+key)return res.status(401).json({error:{message:'invalid api key'}});next();});
app.get('/v1/models',async(_req,res)=>{const j=await fetch(ollama+'/api/tags').then(r=>r.json()) as {models:{name:string}[]};res.json({object:'list',data:j.models.map(m=>({id:m.name,object:'model'}))});});
app.post('/v1/chat/completions',async(req,res)=>{
 const b=req.body;
 const messages=(b.messages||[]).map((m:any)=>({role:m.role,content:m.content??'',...(m.tool_calls?{tool_calls:m.tool_calls.map((c:any)=>({function:{name:c.function.name,arguments:JSON.parse(c.function.arguments||'{}')}}))}:{})}));
 const body:any={model:b.model,stream:false,messages,options:{temperature:b.temperature??0.7,num_predict:b.max_tokens??1024,seed:b.seed,num_ctx:8192},think:false};
 if(b.tools)body.tools=b.tools;
 if(b.response_format?.type==='json_schema')body.format=b.response_format.json_schema.schema;else if(b.response_format?.type==='json_object')body.format='json';
 const r=await fetch(ollama+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(!r.ok)return res.status(r.status).json({error:{message:await r.text()}});
 const j=await r.json() as any;
 res.json({id:'chatcmpl-'+Date.now(),object:'chat.completion',model:b.model,choices:[{index:0,finish_reason:j.done_reason==='length'?'length':j.message.tool_calls?'tool_calls':'stop',
  message:{role:'assistant',content:j.message.content||null,...(j.message.tool_calls?{tool_calls:j.message.tool_calls.map((c:any,i:number)=>({id:`call_${Date.now()}_${i}`,type:'function',function:{name:c.function.name,arguments:JSON.stringify(c.function.arguments)}}))}:{})}}],
  usage:{prompt_tokens:j.prompt_eval_count||0,completion_tokens:j.eval_count||0,total_tokens:(j.prompt_eval_count||0)+(j.eval_count||0)}});
});
app.listen(port,'127.0.0.1',()=>console.log(`OpenAI-compatible test gateway http://127.0.0.1:${port}/v1 -> ${ollama}`));
