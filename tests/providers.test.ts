// OpenAI-compatible provider: enterprise gateways, vLLM, TGI, Azure/OpenAI.
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {OpenAICompatibleProvider} from '../backend/providers.js';
const original=globalThis.fetch;afterEach(()=>{globalThis.fetch=original;});
const req={model:'corp-llm',messages:[{role:'system' as const,content:'sys'},{role:'user' as const,content:'q'}],jsonSchema:{type:'object',properties:{sql:{type:'string'}}},think:false,temperature:0,seed:1,maxTokens:100,numCtx:8192,timeoutMs:5000};

test('sends bearer auth, custom headers and json_schema response format',async()=>{
 const seen:{url:string;headers:Record<string,string>;body:any}[]=[];
 globalThis.fetch=async(url,init)=>{seen.push({url:String(url),headers:init?.headers as Record<string,string>,body:JSON.parse(String(init?.body))});return new Response(JSON.stringify({choices:[{message:{content:'{"sql":"SELECT 1"}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}));};
 const p=new OpenAICompatibleProvider('https://gw.example.com/v1/','secret',{'X-Tenant':'acme'},'auto','none');
 const c=await p.complete(req);
 assert.equal(c.content,'{"sql":"SELECT 1"}');assert.equal(seen[0].url,'https://gw.example.com/v1/chat/completions');
 assert.equal(seen[0].headers.Authorization,'Bearer secret');assert.equal(seen[0].headers['X-Tenant'],'acme');
 assert.equal(seen[0].body.response_format.type,'json_schema');assert.equal(c.genTokens,5);
});
test('falls back from json_schema to json_object to prompt-only JSON and remembers it',async()=>{
 const modes:string[]=[];
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));modes.push(body.response_format?.type||'prompt');
  if(body.response_format)return new Response('{"error":"response_format is not supported"}',{status:400});
  assert.match(body.messages[0].content,/JSON schema/);return new Response(JSON.stringify({choices:[{message:{content:'{"sql":"SELECT 2"}'}}]}));};
 const p=new OpenAICompatibleProvider('http://h/v1','',{},'auto','none');
 assert.equal((await p.complete(req)).content,'{"sql":"SELECT 2"}');assert.deepEqual(modes,['json_schema','json_object','prompt']);
 await p.complete(req);assert.equal(modes.at(-1),'prompt');assert.equal(modes.length,4);
});
test('tool calls round-trip with ids and string arguments',async()=>{
 let body:any;
 globalThis.fetch=async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'abc',type:'function',function:{name:'run_sql',arguments:'{"sql":"SELECT 3","purpose":"x"}'}}]}}]}));};
 const p=new OpenAICompatibleProvider('http://h/v1','',{},'auto','none');
 const c=await p.complete({...req,jsonSchema:undefined,tools:[{type:'function',function:{name:'run_sql',description:'',parameters:{}}}],
  messages:[{role:'user',content:'q'},{role:'assistant',content:'',tool_calls:[{id:'prev',function:{name:'describe_table',arguments:{table:'t'}}}]},{role:'tool',content:'{}',tool_call_id:'prev',tool_name:'describe_table'}]});
 assert.deepEqual(c.toolCalls[0],{id:'abc',function:{name:'run_sql',arguments:{sql:'SELECT 3',purpose:'x'}}});
 assert.equal(body.messages[1].tool_calls[0].function.arguments,'{"table":"t"}');assert.equal(body.messages[2].tool_call_id,'prev');
});
test('credential errors are reported as unavailable, not retried as bad output',async()=>{
 globalThis.fetch=async()=>new Response('denied',{status:401});
 await assert.rejects(new OpenAICompatibleProvider('http://h/v1','bad',{},'auto','none').complete(req),/credentials/);
});
test('rate limits and gateway errors are retried with backoff, honouring Retry-After',async()=>{
 let calls=0;
 globalThis.fetch=async()=>{calls++;if(calls===1)return new Response('busy',{status:429,headers:{'Retry-After':'0'}});if(calls===2)return new Response('bad gateway',{status:502});return new Response(JSON.stringify({choices:[{message:{content:'{"sql":"SELECT 9"}'}}]}));};
 const c=await new OpenAICompatibleProvider('http://h/v1','',{},'auto','none').complete({...req,timeoutMs:20000});
 assert.equal(c.content,'{"sql":"SELECT 9"}');assert.equal(calls,3);
});
test('client errors are not retried',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{"error":"bad request: context too long"}',{status:400});};
 await assert.rejects(new OpenAICompatibleProvider('http://h/v1','',{},'prompt','none').complete({...req,jsonSchema:undefined}),/HTTP 400/);assert.equal(calls,1);
});
