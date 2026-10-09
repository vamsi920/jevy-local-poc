import {stat} from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from './config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Row } from './types.js';
export function sqlLiteral(v:unknown):string { if(v===null || v===undefined)return 'NULL'; if(typeof v==='number'&&Number.isFinite(v)) return String(v); return "'"+String(v).replaceAll("'","''")+"'"; }
export function identifier(v:string) { if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v))throw new Error('Invalid identifier'); return '"'+v+'"'; }
export class Database {
 revision=0;private stamp='';private reopening?:Promise<boolean>;private active=0;private retired:DuckDBInstance[]=[];
 private constructor(public instance:DuckDBInstance,public path:string){}
 private async fileStamp(){const s=await stat(this.path);return [s.dev,s.ino,s.size,s.mtimeMs].join(':');}
 async reopenIfChanged(){if(this.reopening)return this.reopening;this.reopening=(async()=>{const stamp=await this.fileStamp();if(stamp===this.stamp)return false;const replacement=await Database.open(this.path);this.retired.push(this.instance);this.instance=replacement.instance;this.stamp=replacement.stamp;this.revision++;this.releaseRetired();return true;})().finally(()=>{this.reopening=undefined;});return this.reopening;}
 private releaseRetired(){if(!this.active){for(const old of this.retired)old.closeSync();this.retired=[];}}
 static async open(path=config.dbPath) { const db=new Database(await DuckDBInstance.create(path,{temp_directory:join(tmpdir(),'jevy-duckdb-spill'),access_mode:'READ_ONLY',enable_external_access:'false',allow_unsigned_extensions:'false',autoinstall_known_extensions:'false',autoload_known_extensions:'false',threads:String(config.dbThreads),memory_limit:config.dbMemoryLimit}),path);db.stamp=await db.fileStamp();return db; }
 async query(sql:string, maxRows=config.maxRows, opts:{timeoutMs?:number}={}) {
  this.active++;let c;try{c=await this.instance.connect();}catch(e){this.active--;this.releaseRetired();throw e;} let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   const extracted=await c.extractStatements(sql);
   if(extracted.count!==1)throw new Error('Only one SQL statement is allowed.');
   const prepared=await extracted.prepare(0);
   if(String(prepared.statementType)!=='1' && String(prepared.statementType)!=='SELECT')throw new Error('Only SELECT or WITH ... SELECT is allowed.');
   prepared.destroySync();
   const timeoutMs=opts.timeoutMs||config.sqlTimeout;let timedOut=false;
   timer=setTimeout(()=>{timedOut=true;c.interrupt();},timeoutMs);
   // A wrapper caps materialization, while the underlying query retains aggregate semantics.
   await c.run(`SELECT setseed(${(config.seed%1000)/1000})`);
   let reader;
   try{reader=await c.runAndReadAll(`SELECT * FROM (${sql.trim().replace(/;\s*$/,'')}) AS jevy_result LIMIT ${maxRows+1}`);}
   catch(e){if(timedOut)throw new Error(`Query exceeded ${Math.round(timeoutMs/1000)}s (SQL_TIMEOUT_MS). Aggregate in SQL (count/sum/GROUP BY) or add filters instead of scanning raw rows.`);throw e;}
   const all=reader.getRowObjectsJson() as Row[];
   const raw=reader.getRowObjects();
   for(let i=0;i<all.length;i++)for(const [key,value]of Object.entries(raw[i]))if(typeof value==='bigint' && value<=BigInt(Number.MAX_SAFE_INTEGER) && value>=BigInt(Number.MIN_SAFE_INTEGER))all[i][key]=Number(value);
   return {rows:all.slice(0,maxRows),rowCount:Math.min(all.length,maxRows),truncated:all.length>maxRows};
  } finally { if(timer)clearTimeout(timer);c.closeSync();this.active--;this.releaseRetired(); }
 }
 close(){this.instance.closeSync();for(const old of this.retired)old.closeSync();this.retired=[];}
}
