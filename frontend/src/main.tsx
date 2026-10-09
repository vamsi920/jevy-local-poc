/// <reference types="vite/client" />
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api,storage,type Conversation,type Health,type ModelInfo,type Turn} from './api';
import {Sidebar} from './Sidebar';
import {ModelPicker} from './ModelPicker';
import {Trace} from './Thinking';
import {AnswerView} from './Answer';
import './style.css';

let seq=0;const uid=()=>`t${Date.now()}-${seq++}`;

function App(){
 const [health,setHealth]=useState<Health>();
 const [models,setModels]=useState<ModelInfo[]>([]);
 const [model,setModel]=useState<string>(storage.get('model',''));
 const [conversations,setConversations]=useState<Conversation[]>([]);
 const [activeId,setActiveId]=useState<string>();
 const [title,setTitle]=useState('New conversation');
 const [turns,setTurns]=useState<Turn[]>([]);
 const [busy,setBusy]=useState(false);
 const [input,setInput]=useState('');
 const [suggestions,setSuggestions]=useState<string[]>([]);
 const [collapsed,setCollapsed]=useState(storage.get('sidebar','open')==='collapsed');
 const [mobileOpen,setMobileOpen]=useState(false);
 const [debug,setDebug]=useState(storage.get('debug','off')==='on');
 const [loading,setLoading]=useState(false);
 const end=useRef<HTMLDivElement>(null);const abort=useRef<AbortController|undefined>(undefined);const textarea=useRef<HTMLTextAreaElement>(null);
 const activeRef=useRef<string|undefined>(undefined);activeRef.current=activeId;

 const refreshHistory=useCallback(()=>api.conversations().then(r=>setConversations(r.conversations)).catch(()=>{}),[]);
 useEffect(()=>{
  const loadModels=()=>api.models().then(r=>{if(!r.models.length)return;setModels(r.models);setModel(m=>r.models.some(x=>x.name===m)?m:r.models.some(x=>x.name===r.default)?r.default:r.models[0]?.name||'');}).catch(()=>{});
  // A busy model server can miss the first listing; keep asking until models arrive.
  const ping=()=>api.health().then(h=>{setHealth(h);setModels(ms=>{if(!ms.length)loadModels();return ms;});}).catch(()=>setHealth(undefined));ping();loadModels();const id=setInterval(ping,15000);
  api.suggestions().then(r=>setSuggestions(r.suggestions)).catch(()=>{});
  refreshHistory();return()=>clearInterval(id);
 },[refreshHistory]);
 const [warming,setWarming]=useState<string>();
 // Load the chosen model in the background so the first question doesn't pay the loading time.
 useEffect(()=>{if(!model)return;storage.set('model',model);setWarming(model);
  api.warm(model).then(r=>setModels(ms=>ms.map(m=>m.name===model?{...m,tokensPerSecond:r.tokensPerSecond}:m))).catch(()=>{}).finally(()=>setWarming(w=>w===model?undefined:w));
 },[model]);
 useEffect(()=>{storage.set('sidebar',collapsed?'collapsed':'open');},[collapsed]);
 useEffect(()=>{storage.set('debug',debug?'on':'off');},[debug]);
 useEffect(()=>{end.current?.scrollIntoView({behavior:'smooth',block:'end'});},[turns.length,turns.at(-1)?.events.length,turns.at(-1)?.answer]);
 useEffect(()=>{const t=textarea.current;if(!t)return;t.style.height='auto';if(input)requestAnimationFrame(()=>{t.style.height=Math.min(t.scrollHeight,180)+'px';});},[input]);

 function newConversation(){if(busy)abort.current?.abort();setActiveId(undefined);setTurns([]);setTitle('New conversation');setMobileOpen(false);setTimeout(()=>textarea.current?.focus(),50);}
 async function openConversation(id:string){
  if(id===activeId){setMobileOpen(false);return;}
  setLoading(true);setMobileOpen(false);
  try{
   const c=await api.conversation(id);
   const restored:Turn[]=[];
   for(const m of c.messages){if(m.role==='user')restored.push({id:uid(),question:m.content,events:[],model:m.model,startedAt:0});else if(restored.length){const t=restored.at(-1)!;t.answer=m.answer;t.events=m.answer?.trace.events||[];}}
   setActiveId(id);setTitle(c.title);setTurns(restored);if(c.model&&models.some(x=>x.name===c.model))setModel(c.model);
  }catch(e){alert(e instanceof Error?e.message:String(e));}finally{setLoading(false);}
 }
 async function send(question=input){
  const q=question.trim();if(busy||!q)return;
  setInput('');setBusy(true);
  const turn:Turn={id:uid(),question:q,events:[],model,startedAt:Date.now()};
  setTurns(t=>[...t,turn]);if(!activeId)setTitle(q.slice(0,80));
  const patch=(fn:(t:Turn)=>Turn)=>setTurns(ts=>ts.map(x=>x.id===turn.id?fn(x):x));
  const controller=new AbortController();abort.current=controller;
  try{
   const answer=await api.ask({question:q,sessionId:activeId,model:model||undefined},{
    start:e=>{if(!activeRef.current){setActiveId(e.sessionId);activeRef.current=e.sessionId;const now=new Date().toISOString();setConversations(cs=>cs.some(c=>c.id===e.sessionId)?cs:[{id:e.sessionId,title:q.slice(0,80),model:e.model,createdAt:now,updatedAt:now,messages:0},...cs]);}},
    progress:e=>patch(t=>({...t,events:[...t.events,e]})),
   },controller.signal);
   patch(t=>({...t,answer,fresh:true}));
  }catch(e){const aborted=(e as Error).name==='AbortError';patch(t=>({...t,error:aborted?'Stopped. You can ask again.':e instanceof Error?e.message:String(e)}));}
  finally{setBusy(false);abort.current=undefined;refreshHistory();}
 }
 async function rename(id:string,t:string){await api.rename(id,t).catch(()=>{});if(id===activeId)setTitle(t);refreshHistory();}
 async function remove(id:string){try{await api.remove(id);if(id===activeId)newConversation();refreshHistory();}catch(e){alert(e instanceof Error?e.message:String(e));}}

 const offline=!health?'Connecting to the local service…':!health.online?'Ollama is offline — start it with: ollama serve':!models.length&&!health.models.length?'No model available — check the model server.':'';
 return <div className={'app'+(collapsed?' side-collapsed':'')}>
  <Sidebar conversations={conversations} activeId={activeId} collapsed={collapsed} mobileOpen={mobileOpen} busyId={busy?activeId:undefined}
   onToggle={()=>setCollapsed(!collapsed)} onNew={newConversation} onOpen={openConversation} onRename={rename} onDelete={remove} onCloseMobile={()=>setMobileOpen(false)} debug={debug} onDebug={()=>setDebug(!debug)}/>
  <main>
   <header className="topbar">
    <button className="icon-btn menu" onClick={()=>setMobileOpen(true)} aria-label="Open conversations"><svg viewBox="0 0 20 20" width="20" height="20"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg></button>
    <h1 className="title" title={title}>{title}</h1>
    <ModelPicker models={models} value={model} onChange={setModel} disabled={busy} warming={warming===model}/>
    <span className={'status '+(health?.online&&models.length?'ok':'warn')} title={offline||'Local model service ready'}><i/></span>
   </header>
   <div className={'stage'+(turns.length?'':' empty')}>
    {loading&&<div className="loading-bar"/>}
    {!turns.length?<div className="welcome">
     <div className="welcome-orb" aria-hidden="true"><i/><i/><i/></div>
     <h2>What would you like to know?</h2>
     <p>Ask in plain language. Jevy explores the database, runs and checks the queries, and answers with the evidence.</p>
     {suggestions.length>0&&<div className="suggestions">{suggestions.map((s,i)=><button key={s} style={{animationDelay:`${120+i*70}ms`}} onClick={()=>send(s)} disabled={busy||!!offline}>{s}</button>)}</div>}
    </div>:<div className="thread">
     {turns.map((t,i)=><article className="turn" key={t.id}>
      <div className="user-msg"><p>{t.question}</p></div>
      <div className="assistant">
       <div className="avatar" aria-hidden="true">j</div>
       <div className="assistant-body">
        <Trace events={t.events} live={!t.answer&&!t.error} startedAt={t.startedAt} totalMs={t.answer?.trace.totalMs} calls={t.answer?.trace.llm.length} retries={t.answer?.trace.retries} model={t.model}/>
        {t.answer?<AnswerView answer={t.answer} fresh={!!t.fresh} model={t.model} debug={debug} onRetry={()=>send(t.question)}/>:
         t.error?<div className="error-card"><strong>Something went wrong</strong><p>{t.error}</p><button onClick={()=>send(t.question)} disabled={busy}>Try again</button></div>:null}
       </div>
      </div>
      {i===turns.length-1&&<div ref={end}/>}
     </article>)}
    </div>}
   </div>
   <footer className="composer-wrap">
    {offline&&<div className="notice">{offline}</div>}
    <form className="composer" onSubmit={e=>{e.preventDefault();send();}}>
     <textarea ref={textarea} rows={1} value={input} placeholder={turns.length?'Ask a follow-up…':'Ask anything about your data…'} aria-label="Message" onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}/>
     {busy?<button type="button" className="send stop" onClick={()=>abort.current?.abort()} aria-label="Stop"><span/></button>:
      <button type="submit" className="send" disabled={!input.trim()||!!offline} aria-label="Send"><svg viewBox="0 0 20 20" width="18" height="18"><path d="M10 15V5M5.5 9.5L10 5l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
    </form>
    <p className="footnote">Answers come from read-only queries on your local DuckDB. Check the SQL for important decisions.</p>
   </footer>
  </main>
 </div>;
}
const container=document.getElementById('root')!;
const root=(import.meta.hot?.data.root||createRoot(container));
if(import.meta.hot)import.meta.hot.data.root=root;
root.render(<App/>);
