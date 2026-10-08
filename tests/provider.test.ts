import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {model,extractJSON} from '../backend/llm.js';
import {buildProfile,resetProfile} from '../backend/model-profile.js';
import type {Trace} from '../backend/types.js';
const trace=():Trace=>({question:'',intent:'',schema:null,plans:[],events:[],evidence:[],llm:[],retries:0,totalMs:0});
const original=globalThis.fetch;
// Mock Ollama: /api/show describes the model, /api/chat records request bodies.
function mockOllama(capabilities:string[],params:string,reply:(body:Record<string,any>)=>unknown){
 const bodies:Record<string,any>[]=[];
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/api/show'))return new Response(JSON.stringify({details:{parameter_size:params},capabilities,model_info:{'qwen3.context_length':40960}}));
  const body=JSON.parse(String(options?.body));bodies.push(body);return new Response(JSON.stringify(reply(body)));
 };
 return bodies;
}
beforeEach(()=>resetProfile());afterEach(()=>{globalThis.fetch=original;resetProfile();});

test('structured provider enforces its response schema and sizes context from the model profile',async()=>{
 const schema=z.object({decision:z.enum(['rows','count'])});
 const bodies=mockOllama(['completion','tools','thinking'],'751.63M',()=>({message:{content:'{"decision":"rows"}'}}));
 const t=trace();assert.deepEqual(await model(schema,'Contract','Choose',{question:'List'},t),{decision:'rows'});
 assert.deepEqual(bodies[0].format,z.toJSONSchema(schema));assert.equal(bodies[0].options.num_ctx,8192);assert.equal(bodies[0].think,false);assert.equal(t.llm.length,1);
});
test('requested reasoning uses a larger output budget and never leaks reasoning text',async()=>{
 const bodies=mockOllama(['completion','thinking'],'751.63M',()=>({message:{content:'{"sql":"SELECT 1"}',thinking:'private'},eval_count:42}));
 const t=trace();assert.deepEqual(await model(z.object({sql:z.string()}),'SQL reasoning','Write SQL',{},t,{think:true}),{sql:'SELECT 1'});
 assert.equal(bodies[0].think,true);assert.equal(bodies[0].options.num_predict,1536);assert.ok(!bodies[0].messages[0].content.includes('/no_think'));
 assert.ok(!JSON.stringify(t).includes('private'));
});
test('think is never sent to models without the thinking capability',async()=>{
 const bodies=mockOllama(['completion','tools'],'494.03M',()=>({message:{content:'{"sql":"SELECT 1"}'}}));
 await model(z.object({sql:z.string()}),'SQL reasoning','Write SQL',{},trace(),{think:true});
 assert.equal(Object.hasOwn(bodies[0],'think'),false);assert.ok(!bodies[0].messages[0].content.includes('/no_think'));
});
test('fenced or chatty JSON from small models is recovered',async()=>{
 mockOllama(['completion'],'0.5B',()=>({message:{content:'Sure! ```json\n{"sql":"SELECT 2"}\n``` hope this helps'}}));
 assert.deepEqual(await model(z.object({sql:z.string()}),'SQL','Write SQL',{},trace()),{sql:'SELECT 2'});
 assert.deepEqual(extractJSON('<think>x</think>{"a":{"b":"}"}} trailing'),{a:{b:'}'}});
 assert.deepEqual(extractJSON('Okay, the user wants {"sql":"no"} hmm\n</think>\n{"sql":"SELECT 4"}'),{sql:'SELECT 4'});
});
test('invalid output is retried once with validation feedback',async()=>{
 let n=0;const bodies=mockOllama(['completion'],'0.5B',()=>({message:{content:n++?'{"sql":"SELECT 3"}':'{"query":1}'}}));
 assert.deepEqual(await model(z.object({sql:z.string()}),'SQL','Write SQL',{},trace()),{sql:'SELECT 3'});
 assert.match(bodies[1].messages[1].content,/failed validation/);
});
test('expired request budget prevents another provider call',async()=>{
 mockOllama(['completion'],'0.5B',()=>{throw new Error('should not be called');});
 const t:Trace={...trace(),deadlineMs:Date.now()-1};
 await assert.rejects(model(z.object({sql:z.string()}),'SQL repair','Repair',{},t),/time budget exhausted/);
 assert.equal(t.llm.length,0);
});
test('model size selects the strategy tier',()=>{
 const tiny=buildProfile('a',0.6,40960,['completion','tools','thinking']),small=buildProfile('b',8,40960,['completion','tools']),large=buildProfile('c',32,131072,['completion','tools']);
 assert.equal(tiny.tier,'tiny');assert.equal(tiny.toolLoop,false);assert.ok(tiny.candidates>small.candidates);
 assert.equal(small.tier,'small');assert.equal(small.toolLoop,true);assert.equal(small.thinking,false);
 assert.equal(large.tier,'large');assert.ok(large.numCtx>=small.numCtx);assert.ok(large.maxToolSteps>=small.maxToolSteps);
 assert.equal(buildProfile('d',8,40960,['completion']).toolLoop,false);
});
