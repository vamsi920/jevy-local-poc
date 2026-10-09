import 'dotenv/config';
import {spawn,type ChildProcess} from 'node:child_process';
const children:ChildProcess[]=[];
const url=process.env.OLLAMA_URL||'http://127.0.0.1:11434';
try {await fetch(url+'/api/tags',{signal:AbortSignal.timeout(5000)});}catch{
 const ollama=spawn('ollama',['serve'],{stdio:'inherit',env:{...process.env,OLLAMA_NO_CLOUD:'1',OLLAMA_HOST:url}});
 ollama.on('error',()=>console.log('Ollama not installed. Install: brew install ollama; then ollama pull '+(process.env.OLLAMA_MODEL||'qwen3:0.6b')));children.push(ollama);
}
// The backend restarts itself when backend code changes, so the chat never runs stale logic.
for(const [cmd,args]of [['node',['--watch-path=backend','--watch-preserve-output','--import','tsx','backend/server.ts']],['node',['node_modules/vite/bin/vite.js','--config','frontend/vite.config.ts']]] as const)children.push(spawn(cmd,[...args],{stdio:'inherit'}));
let stopping=false;
const stop=(exitCode=0)=>{if(stopping)return;stopping=true;children.forEach(c=>c.kill('SIGTERM'));process.exitCode=exitCode;};
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());children.slice(-2).forEach(c=>c.on('exit',code=>{if(!stopping)stop(code||0);}));
console.log(`Jevy chat: http://127.0.0.1:${process.env.FRONTEND_PORT||5173}\nBackend: http://127.0.0.1:${process.env.BACKEND_PORT||3001}\nLocal only. Pull missing model with: ollama pull ${process.env.OLLAMA_MODEL||'qwen3:0.6b'}`);
