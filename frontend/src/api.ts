import type {Answer} from '../../backend/types';
export type {Answer,Evidence} from '../../backend/types';

export type ModelInfo={tokensPerSecond?:number;name:string;parameters:string;family:string;sizeGb:number;tier:'tiny'|'small'|'large';toolLoop:boolean;thinking:boolean};
export type Conversation={id:string;title:string;model:string;createdAt:string;updatedAt:string;messages:number};
export type ProgressEvent={message:string;at:number;phase?:string};
export type Turn={id:string;question:string;answer?:Answer;events:ProgressEvent[];error?:string;model?:string;startedAt:number;fresh?:boolean};
export type Health={online:boolean;ready:boolean;model:string;models:string[]};

const json=async<T>(r:Response):Promise<T>=>{if(!r.ok)throw new Error(((await r.json().catch(()=>({}))) as {error?:string}).error||`Request failed (${r.status})`);return r.json() as Promise<T>;};
export const api={
 health:()=>fetch('/api/health').then(r=>json<Health>(r)),
 models:()=>fetch('/api/models').then(r=>json<{default:string;models:ModelInfo[]}>(r)),
 warm:(model:string)=>fetch('/api/models/warm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})}).then(r=>json<{ok:boolean;ms:number;tokensPerSecond?:number}>(r)),
 suggestions:()=>fetch('/api/suggestions').then(r=>json<{suggestions:string[]}>(r)),
 conversations:()=>fetch('/api/conversations').then(r=>json<{conversations:Conversation[]}>(r)),
 conversation:(id:string)=>fetch('/api/conversations/'+encodeURIComponent(id)).then(r=>json<{id:string;title:string;model:string;messages:{seq:number;role:'user'|'assistant';content:string;answer?:Answer;model?:string;createdAt:string}[]}>(r)),
 rename:(id:string,title:string)=>fetch('/api/conversations/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})}).then(r=>json<{ok:boolean}>(r)),
 remove:(id:string)=>fetch('/api/conversations/'+encodeURIComponent(id),{method:'DELETE'}).then(r=>json<{ok:boolean}>(r)),
 // Streams NDJSON progress events, then the final answer.
 async ask(body:{question:string;sessionId?:string;model?:string},on:{start?:(e:{sessionId:string;model:string})=>void;progress:(e:ProgressEvent)=>void},signal?:AbortSignal):Promise<Answer>{
  const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  if(!r.ok)throw new Error(((await r.json().catch(()=>({}))) as {error?:string}).error||'Request failed');
  const reader=r.body!.getReader();const decoder=new TextDecoder();let buffer='';
  while(true){
   const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let n;
   while((n=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
    if(event.type==='start')on.start?.(event);else if(event.type==='progress')on.progress(event);else if(event.type==='result')return event.answer as Answer;else if(event.type==='error')throw new Error(event.error);}
  }
  throw new Error('The connection closed before an answer arrived.');
 },
};

export const storage={
 get(key:string,fallback:string){try{return localStorage.getItem('jevy.'+key)??fallback;}catch{return fallback;}},
 set(key:string,value:string){try{localStorage.setItem('jevy.'+key,value);}catch{/* private mode */}},
};
