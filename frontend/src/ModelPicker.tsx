import React,{useEffect,useRef,useState} from 'react';
import type {ModelInfo} from './api';
import {Check} from './Thinking';

const tierText={tiny:'Fast · small model',small:'Balanced',large:'Most capable'};
export function ModelPicker({models,value,onChange,disabled,warming}:{models:ModelInfo[];value?:string;onChange:(m:string)=>void;disabled?:boolean;warming?:boolean}){
 const [open,setOpen]=useState(false);const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{const close=(e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false);};const esc=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('mousedown',close);document.addEventListener('keydown',esc);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',esc);};},[]);
 const current=models.find(m=>m.name===value);
 return <div className="model-picker" ref={ref}>
  <button className="model-button" onClick={()=>setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} disabled={disabled||!models.length}>
   <span className={'tier-dot '+(current?.tier||'')+(warming?' warming':'')}/>
   <span className="model-name">{value||'No model'}</span>{warming&&<span className="warming-text">loading…</span>}
   <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
  </button>
  {open&&<ul className="model-menu" role="listbox" aria-label="Choose model">
   {models.map(m=><li key={m.name} role="option" aria-selected={m.name===value}><button onClick={()=>{onChange(m.name);setOpen(false);}}>
    <span className={'tier-dot '+m.tier}/>
    <span className="model-info"><strong>{m.name}</strong><span>{m.parameters} · {tierText[m.tier]}{m.toolLoop?' · agent loop':' · self-consistency'}{m.thinking?' · reasoning':''}{m.tokensPerSecond?` · ~${m.tokensPerSecond} tok/s here`:''}</span></span>
    {m.name===value&&<span className="selected"><Check/></span>}
   </button></li>)}
   <li className="model-hint">Jevy adapts its strategy to each model: small models vote across several queries, larger ones plan with tools.</li>
  </ul>}
 </div>;
}
