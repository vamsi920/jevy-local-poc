// Conversation history in its own writable DuckDB file. The analytics database stays read-only.
import {DuckDBInstance,type DuckDBConnection} from '@duckdb/node-api';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {Answer,State} from './types.js';

export type ConversationSummary={id:string;title:string;model:string;createdAt:string;updatedAt:string;messages:number};
export type StoredMessage={seq:number;role:'user'|'assistant';content:string;answer?:Answer;createdAt:string;model?:string};

export class ChatStore{
 private queue:Promise<unknown>=Promise.resolve();
 private constructor(private instance:DuckDBInstance,private connection:DuckDBConnection){}
 static async open(path:string){
  await mkdir(dirname(path),{recursive:true});
  const instance=await DuckDBInstance.create(path);const connection=await instance.connect();
  await connection.run(`CREATE TABLE IF NOT EXISTS conversations(id VARCHAR PRIMARY KEY,title VARCHAR NOT NULL,model VARCHAR,state_json VARCHAR,created_at TIMESTAMP NOT NULL DEFAULT timezone('UTC', now()),updated_at TIMESTAMP NOT NULL DEFAULT timezone('UTC', now()))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS messages(conversation_id VARCHAR NOT NULL,seq INTEGER NOT NULL,role VARCHAR NOT NULL,content VARCHAR NOT NULL,answer_json VARCHAR,model VARCHAR,created_at TIMESTAMP NOT NULL DEFAULT timezone('UTC', now()),PRIMARY KEY(conversation_id,seq))`);
  return new ChatStore(instance,connection);
 }
 // Serialise writes on the single connection.
 private run<T>(fn:()=>Promise<T>):Promise<T>{const next=this.queue.then(fn,fn);this.queue=next.catch(()=>{});return next;}
 private async rows(sql:string,values:(string|number|null)[]=[]){const r=await this.connection.runAndReadAll(sql,values);return r.getRowObjectsJson() as Record<string,unknown>[];}

 list(limit=200):Promise<ConversationSummary[]>{return this.run(async()=>(await this.rows(`SELECT c.id,c.title,coalesce(c.model,'') model,strftime(c.created_at,'%Y-%m-%dT%H:%M:%SZ') created_at,strftime(c.updated_at,'%Y-%m-%dT%H:%M:%SZ') updated_at,(SELECT count(*) FROM messages m WHERE m.conversation_id=c.id) n FROM conversations c ORDER BY c.updated_at DESC LIMIT ${Math.min(500,Math.max(1,limit))}`)).map(r=>({id:String(r.id),title:String(r.title),model:String(r.model),createdAt:String(r.created_at),updatedAt:String(r.updated_at),messages:Number(r.n)})));}

 get(id:string){return this.run(async()=>{
  const conv=(await this.rows(`SELECT id,title,coalesce(model,'') model,state_json FROM conversations WHERE id=$1`,[id]))[0];
  if(!conv)return null;
  const messages=(await this.rows(`SELECT seq,role,content,answer_json,model,strftime(created_at,'%Y-%m-%dT%H:%M:%SZ') created_at FROM messages WHERE conversation_id=$1 ORDER BY seq`,[id])).map(r=>({seq:Number(r.seq),role:r.role as 'user'|'assistant',content:String(r.content),answer:r.answer_json?JSON.parse(String(r.answer_json)) as Answer:undefined,model:r.model?String(r.model):undefined,createdAt:String(r.created_at)}));
  return {id:String(conv.id),title:String(conv.title),model:String(conv.model),state:conv.state_json?JSON.parse(String(conv.state_json)) as State:undefined,messages};
 });}

 state(id:string){return this.run(async()=>{const r=(await this.rows(`SELECT state_json FROM conversations WHERE id=$1`,[id]))[0];return r?.state_json?JSON.parse(String(r.state_json)) as State:undefined;});}

 // One user question and the assistant's answer, plus the agent's conversation memory.
 append(id:string,question:string,answer:Answer,model:string){return this.run(async()=>{
  const title=question.replace(/\s+/g,' ').trim().slice(0,80);
  await this.connection.run(`INSERT INTO conversations(id,title,model,state_json,created_at,updated_at) VALUES ($1,$2,$3,$4,timezone('UTC', now()),timezone('UTC', now())) ON CONFLICT (id) DO UPDATE SET model=excluded.model,state_json=excluded.state_json,updated_at=timezone('UTC', now())`,[id,title,model,JSON.stringify(answer.state)]);
  const next=Number((await this.rows(`SELECT coalesce(max(seq),0)+1 n FROM messages WHERE conversation_id=$1`,[id]))[0].n);
  await this.connection.run(`INSERT INTO messages(conversation_id,seq,role,content,model,created_at) VALUES ($1,$2,'user',$3,$4,timezone('UTC', now()))`,[id,next,question,model]);
  // Keep stored traces bounded: drop bulky candidate lists but keep everything the UI shows.
  const slim={...answer,trace:{...answer.trace,candidates:answer.trace.candidates?.slice(0,12)}};
  await this.connection.run(`INSERT INTO messages(conversation_id,seq,role,content,answer_json,model,created_at) VALUES ($1,$2,'assistant',$3,$4,$5,timezone('UTC', now()))`,[id,next+1,answer.text,JSON.stringify(slim),model]);
 });}

 rename(id:string,title:string){return this.run(()=>this.connection.run(`UPDATE conversations SET title=$2 WHERE id=$1`,[id,title.slice(0,120)]));}
 remove(id:string){return this.run(async()=>{await this.connection.run(`DELETE FROM messages WHERE conversation_id=$1`,[id]);await this.connection.run(`DELETE FROM conversations WHERE id=$1`,[id]);});}
 close(){this.connection.closeSync();this.instance.closeSync();}
}
