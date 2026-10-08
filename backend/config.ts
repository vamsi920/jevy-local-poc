import 'dotenv/config';
import { resolve } from 'node:path';
// LLM_PROVIDER=ollama (default, local) or openai (any OpenAI-compatible endpoint: OpenAI, Azure,
// vLLM, TGI, LiteLLM, enterprise gateways). Data sent to a remote endpoint includes schema
// summaries and query results, so only point it at an endpoint approved for that data.
const providerName=(process.env.LLM_PROVIDER||'ollama').toLowerCase();
if(!['ollama','openai'].includes(providerName))throw new Error('LLM_PROVIDER must be ollama or openai.');
const local = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
if (providerName==='ollama'&&(!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || local.protocol !== 'http:')) throw new Error('OLLAMA_URL must be a local HTTP address.');
const modelName=process.env.LLM_MODEL||process.env.OLLAMA_MODEL||'qwen3:0.6b';
if (providerName==='ollama'&&/(?:[:\-])cloud$/i.test(modelName)) throw new Error('Ollama cloud models are disabled; choose a downloaded local model.');
if (providerName==='openai'&&!process.env.LLM_BASE_URL) throw new Error('LLM_BASE_URL is required when LLM_PROVIDER=openai (e.g. https://gateway.example.com/v1).');
const tier = process.env.AGENT_TIER;
if (tier && !['tiny','small','large'].includes(tier)) throw new Error('AGENT_TIER must be tiny, small or large.');
const jsonMode=(process.env.LLM_JSON_MODE||'auto') as 'auto'|'json_schema'|'json_object'|'prompt';
if(!['auto','json_schema','json_object','prompt'].includes(jsonMode))throw new Error('LLM_JSON_MODE must be auto, json_schema, json_object or prompt.');
let headers:Record<string,string>={};
try{headers=process.env.LLM_HEADERS?JSON.parse(process.env.LLM_HEADERS):{};}catch{throw new Error('LLM_HEADERS must be a JSON object of extra HTTP headers.');}
export const config = {
 // Full schema re-profile + notes re-learn interval (default daily). A changed database file is
 // detected within minutes regardless (cheap file check), and triggers an immediate rebuild.
 schemaRefreshMs: Math.max(1000,Number(process.env.SCHEMA_REFRESH_MS||86400000)),
 schemaChangeCheckMs: Math.max(1000,Number(process.env.SCHEMA_CHANGE_CHECK_MS||300000)),
 ollamaUrl: local.origin,
 model: modelName,
 llm:{
  provider:providerName as 'ollama'|'openai',
  baseUrl:process.env.LLM_BASE_URL||'',
  apiKey:process.env.LLM_API_KEY||'',
  headers,
  jsonMode,
  // How to request reasoning from a remote model: none | effort (reasoning_effort) | chat_template (vLLM enable_thinking).
  reasoning:(process.env.LLM_REASONING||'none').toLowerCase(),
  // Remote endpoints rarely report these; set them so the harness picks the right strategy tier.
  paramsB:Number(process.env.LLM_PARAMS_B||0),
  contextLength:Number(process.env.LLM_CONTEXT_LENGTH||0),
  capabilities:(process.env.LLM_CAPABILITIES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean),
  // Upper bound on parallel model calls (candidates, sub-questions); match the endpoint's capacity.
  concurrency:Math.max(1,Number(process.env.LLM_CONCURRENCY||4)),
 },
 port: Number(process.env.BACKEND_PORT || 3001),
 dbPath: resolve(process.env.DB_PATH || './data/jevy.duckdb'),
 chatDbPath: resolve(process.env.CHAT_DB_PATH || './data/chat-history.duckdb'),
 semanticPath: resolve(process.env.SEMANTIC_PATH || './data/semantic.json'),
 notesPath: resolve(process.env.SCHEMA_NOTES_PATH || './data/schema-notes.json'),
 seed: Number(process.env.SEED || 42),
 asOf: process.env.DATA_AS_OF || '2026-10-07',
 maxRows: Number(process.env.MAX_ROWS || 200),
 sqlTimeout: Number(process.env.SQL_TIMEOUT_MS || 10000),
 // Hard ceiling for one question. The model profile picks a smaller adaptive budget below this.
 requestTimeout: Math.min(180000, Number(process.env.REQUEST_TIMEOUT_MS || 180000)),
 llmTimeout: Number(process.env.LLM_TIMEOUT_MS || 90000),
 agentTier: tier as 'tiny'|'small'|'large'|undefined,
};
