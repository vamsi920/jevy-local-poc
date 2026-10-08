import React,{useState} from 'react';
import type {Conversation} from './api';

function group(c:Conversation){
 const d=new Date(c.updatedAt);const now=new Date();const day=86400000;
 const start=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
 if(d.getTime()>=start)return 'Today';if(d.getTime()>=start-day)return 'Yesterday';if(d.getTime()>=start-7*day)return 'Previous 7 days';if(d.getTime()>=start-30*day)return 'Previous 30 days';return 'Older';
}

export function Sidebar({conversations,activeId,collapsed,mobileOpen,busyId,onToggle,onNew,onOpen,onRename,onDelete,onCloseMobile,debug,onDebug}:{
 conversations:Conversation[];activeId?:string;collapsed:boolean;mobileOpen:boolean;busyId?:string;
 onToggle:()=>void;onNew:()=>void;onOpen:(id:string)=>void;onRename:(id:string,title:string)=>void;onDelete:(id:string)=>void;onCloseMobile:()=>void;debug:boolean;onDebug:()=>void;
}){
 const [query,setQuery]=useState('');const [editing,setEditing]=useState<string>();const [draft,setDraft]=useState('');const [confirm,setConfirm]=useState<string>();
 const shown=conversations.filter(c=>c.title.toLowerCase().includes(query.toLowerCase()));
 const groups=[...new Set(shown.map(group))];
 return <>
  <div className={'scrim'+(mobileOpen?' show':'')} onClick={onCloseMobile} aria-hidden="true"/>
  <aside className={'sidebar'+(collapsed?' collapsed':'')+(mobileOpen?' mobile-open':'')} aria-label="Conversations">
   <div className="side-top">
    <div className="brand"><span className="brandmark">j</span><span className="brand-name">jevy</span></div>
    <button className="icon-btn collapse" onClick={onToggle} aria-label={collapsed?'Expand sidebar':'Collapse sidebar'} title={collapsed?'Expand':'Collapse'}><svg viewBox="0 0 20 20" width="18" height="18"><rect x="2.5" y="3.5" width="15" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M7.5 4v12" stroke="currentColor" strokeWidth="1.5"/></svg></button>
   </div>
   <button className="new-chat" onClick={onNew} title="Start a new conversation"><span className="plus">+</span><span className="label">New conversation</span></button>
   <div className="search"><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search conversations" aria-label="Search conversations"/></div>
   <nav className="history">
    {!conversations.length&&<p className="history-empty">Your conversations will appear here.</p>}
    {groups.map(g=><div key={g} className="history-group"><h3>{g}</h3><ul>{shown.filter(c=>group(c)===g).map(c=><li key={c.id} className={(c.id===activeId?'active ':'')+(confirm===c.id?'confirming':'')}>
     {editing===c.id?<form onSubmit={e=>{e.preventDefault();if(draft.trim())onRename(c.id,draft.trim());setEditing(undefined);}}><input autoFocus value={draft} onChange={e=>setDraft(e.target.value)} onBlur={()=>setEditing(undefined)} aria-label="Conversation title"/></form>:
      confirm===c.id?<div className="confirm"><span>Delete this conversation?</span><button onClick={()=>{onDelete(c.id);setConfirm(undefined);}}>Delete</button><button onClick={()=>setConfirm(undefined)}>Cancel</button></div>:
      <><button className="conv" onClick={()=>onOpen(c.id)} title={c.title}>{busyId===c.id&&<span className="mini-orb"/>}<span>{c.title}</span></button>
       <span className="row-actions"><button aria-label="Rename" title="Rename" onClick={()=>{setEditing(c.id);setDraft(c.title);}}>✎</button><button aria-label="Delete" title="Delete" onClick={()=>setConfirm(c.id)}>×</button></span></>}
    </li>)}</ul></div>)}
   </nav>
   <div className="side-bottom">
    <button className={'toggle'+(debug?' on':'')} aria-pressed={debug} onClick={onDebug}><span className="label">Developer trace</span><span className="switch"/></button>
    <p className="local-note">Runs on this machine · history saved in DuckDB</p>
   </div>
  </aside>
 </>;
}
