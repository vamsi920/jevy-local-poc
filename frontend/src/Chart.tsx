import React,{useMemo,useState} from 'react';
import {ResponsiveContainer,BarChart,Bar,LineChart,Line,AreaChart,Area,PieChart,Pie,Cell,ScatterChart,Scatter,XAxis,YAxis,ZAxis,CartesianGrid,Tooltip,Legend,LabelList,Treemap,RadialBarChart,RadialBar,RadarChart,Radar,PolarGrid,PolarAngleAxis,PolarRadiusAxis} from 'recharts';
import type {ChartType} from '../../backend/chart';
import type {ChartSpec} from '../../backend/chart';

// Categorical slots in fixed order (validated for colour-vision deficiency on a white surface).
// Three slots sit under 3:1 contrast, so every chart ships legends/labels and a table view.
export const SERIES=['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#4a3aa7','#e34948'];
const OTHER='#b4b2a9';
const colorOf=(name:string,i:number)=>/^Other\b/.test(name)?OTHER:SERIES[i%SERIES.length];
const INK='#0b0b0b',INK2='#52514e',MUTED='#898781',GRID='#ecebe6',AXIS='#c3c2b7';

type Datum=Record<string,string|number|null>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TipProps={active?:boolean;payload?:readonly any[];label?:any};
const compact=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1});
export function formatValue(v:unknown,format:ChartSpec['y']['format'],short=false){
 if(v===null||v===undefined||v==='')return '—';
 const n=Number(v);if(!Number.isFinite(n))return String(v);
 if(format==='percent'){const p=Math.abs(n)<=1&&!Number.isInteger(n)?n*100:n;return p.toLocaleString('en-US',{maximumFractionDigits:1})+'%';}
 if(short&&Math.abs(n)>=10000)return compact.format(n);
 return n.toLocaleString('en-US',{maximumFractionDigits:format==='integer'?0:2});
}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatTime(v:unknown,all:Datum[],field:string){
 const s=String(v);const m=s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);if(!m)return s;
 const days=all.map(d=>String(d[field]).slice(8,10));
 const monthly=all.length>1&&days.every(d=>d==='01'||d==='');
 return monthly||!m[3]?`${MONTHS[Number(m[2])-1]} ${m[1].slice(2)}`:`${MONTHS[Number(m[2])-1]} ${Number(m[3])}`;
}

function TooltipCard({active,payload,label,spec}:{active?:boolean;payload?:{name:string;value:number;color:string;payload:Datum;dataKey:string}[];label?:string|number;spec:ChartSpec}){
 if(!active||!payload?.length)return null;
 const title=spec.type==='pie'||spec.type==='donut'?String(payload[0].payload[spec.x.field]):spec.x.kind==='time'?formatTime(label,spec.data,spec.x.field):spec.type==='scatter'?`${spec.x.label}: ${formatValue(payload[0].payload[spec.x.field],'decimal')}`:String(label??'');
 const total=spec.type==='stacked'||spec.type==='stackedarea'||spec.type==='percent'?payload.reduce((s,p)=>s+(Number(p.payload[p.dataKey])||0),0):undefined;
 const share=(v:number)=>spec.type==='percent'&&total?` · ${(v/total*100).toFixed(1)}%`:'';
 const rows=spec.type==='scatter'?payload.filter(p=>p.dataKey!==spec.x.field):payload;
 return <div className="chart-tip">
  <div className="chart-tip-title">{title}</div>
  {rows.map(p=><div key={p.dataKey+p.name} className="chart-tip-row"><i style={{background:p.color||(p.payload as {fill?:string}).fill}}/><span>{spec.series.length>1||spec.type==='pie'||spec.type==='donut'?p.name:spec.y.label}</span><strong>{formatValue(p.payload[p.dataKey]??p.value,spec.y.format)}{share(Number(p.payload[p.dataKey]))}</strong></div>)}
  {total!==undefined&&rows.length>1&&<div className="chart-tip-row total"><i/><span>Total</span><strong>{formatValue(total,spec.y.format)}</strong></div>}
 </div>;
}

const axisProps={tickLine:false,axisLine:false,tick:{fill:MUTED,fontSize:11.5},tickMargin:8} as const;

function Plot({spec}:{spec:ChartSpec}){
 const data=spec.data as Datum[];
 const multi=spec.series.length>1;
 const xTick=(v:unknown)=>spec.x.kind==='time'?formatTime(v,data,spec.x.field):String(v).length>16?String(v).slice(0,15)+'…':String(v);
 const yTick=(v:unknown)=>formatValue(v,spec.y.format,true);
 const tip=<Tooltip content={<TooltipCard spec={spec}/>} cursor={spec.type==='line'||spec.type==='area'?{stroke:AXIS,strokeWidth:1,strokeDasharray:'3 3'}:{fill:'#2a78d60d'}} wrapperStyle={{outline:'none'}} isAnimationActive={false}/>;
 // Our own legend, in series order (matching stack order and colour slots).
 const legend=multi?<Legend verticalAlign="top" align="left" height={34} content={()=><ul className="chart-legend">{spec.series.map((s,i)=><li key={s.key}><i style={{background:colorOf(s.label,i)}}/>{s.label}</li>)}</ul>}/>:null;
 const grid=<CartesianGrid vertical={false} stroke={GRID}/>;
 const anim={isAnimationActive:true,animationDuration:750,animationEasing:'ease-out' as const};
 const margin={top:8,right:12,left:4,bottom:4};
 switch(spec.type){
  case 'bar':{
   const h=Math.max(220,data.length*30+(multi?70:40));
   return <ResponsiveContainer width="100%" height={h}><BarChart data={data} layout="vertical" margin={{...margin,right:28}} barCategoryGap={6}>
    <CartesianGrid horizontal={false} stroke={GRID}/>
    <XAxis type="number" {...axisProps} tickFormatter={yTick}/>
    <YAxis type="category" dataKey={spec.x.field} {...axisProps} width={Math.min(170,Math.max(60,...data.map(d=>xTick(d[spec.x.field]).length*6.6)))} tickFormatter={xTick} interval={0}/>
    {tip}{legend}
    {spec.series.map((s,i)=><Bar key={s.key} dataKey={s.key} name={s.label} fill={colorOf(s.label,i)} radius={[0,4,4,0]} maxBarSize={22} {...anim} animationBegin={i*80}>{!multi&&data.length<=20&&<LabelList dataKey={s.key} position="right" formatter={(v:unknown)=>formatValue(v,spec.y.format,true)} style={{fill:INK2,fontSize:11}}/>}</Bar>)}
   </BarChart></ResponsiveContainer>;
  }
  case 'column':case 'grouped':case 'stacked':case 'percent':{
   const stacked=spec.type==='stacked'||spec.type==='percent';const percent=spec.type==='percent';
   const many=data.length>10;
   return <ResponsiveContainer width="100%" height={many?340:300}><BarChart data={data} margin={margin} barGap={2} barCategoryGap={data.length>16?'12%':'22%'} stackOffset={percent?'expand':undefined}>
    {grid}
    <XAxis dataKey={spec.x.field} {...axisProps} tickFormatter={xTick} interval={many?'preserveStartEnd':0} angle={many?-30:0} textAnchor={many?'end':'middle'} height={many?62:30} axisLine={{stroke:AXIS}}/>
    <YAxis {...axisProps} tickFormatter={percent?(v:number)=>Math.round(v*100)+'%':yTick} width={52}/>
    {tip}{legend}
    {spec.series.map((s,i)=><Bar key={s.key} dataKey={s.key} name={s.label} fill={colorOf(s.label,i)} stackId={stacked?'a':undefined} radius={stacked?(i===spec.series.length-1?[4,4,0,0]:[0,0,0,0]):[4,4,0,0]} stroke={stacked?'#fff':undefined} strokeWidth={stacked?1:0} maxBarSize={56} {...anim} animationBegin={i*70}/>)}
   </BarChart></ResponsiveContainer>;
  }
  case 'line':
   return <ResponsiveContainer width="100%" height={300}><LineChart data={data} margin={margin}>
    {grid}
    <XAxis dataKey={spec.x.field} {...axisProps} tickFormatter={xTick} axisLine={{stroke:AXIS}} minTickGap={24}/>
    <YAxis {...axisProps} tickFormatter={yTick} width={52}/>
    {tip}{legend}
    {spec.series.map((s,i)=><Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={colorOf(s.label,i)} strokeWidth={2} dot={data.length<=14?{r:3.5,strokeWidth:2,fill:'#fff'}:false} activeDot={{r:5,stroke:'#fff',strokeWidth:2}} connectNulls {...anim} animationDuration={900} animationBegin={i*90}/>)}
   </LineChart></ResponsiveContainer>;
  case 'area':
   return <ResponsiveContainer width="100%" height={300}><AreaChart data={data} margin={margin}>
    <defs>{spec.series.map((s,i)=><linearGradient key={s.key} id={'fill-'+i} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colorOf(s.label,i)} stopOpacity={0.22}/><stop offset="100%" stopColor={colorOf(s.label,i)} stopOpacity={0.02}/></linearGradient>)}</defs>
    {grid}
    <XAxis dataKey={spec.x.field} {...axisProps} tickFormatter={xTick} axisLine={{stroke:AXIS}} minTickGap={24}/>
    <YAxis {...axisProps} tickFormatter={yTick} width={52}/>
    {tip}{legend}
    {spec.series.map((s,i)=><Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={colorOf(s.label,i)} strokeWidth={2} fill={`url(#fill-${i})`} dot={data.length<=14?{r:3.5,strokeWidth:2,fill:'#fff'}:false} activeDot={{r:5,stroke:'#fff',strokeWidth:2}} {...anim} animationDuration={900}/>)}
   </AreaChart></ResponsiveContainer>;
  case 'pie':case 'donut':{
   const key=spec.series[0].key;const total=data.reduce((s,d)=>s+(Number(d[key])||0),0);
   return <div className="pie-layout">
    <div className="pie-plot">
     <ResponsiveContainer width="100%" height={260}><PieChart>
      {tip}
      <Pie data={data} dataKey={key} nameKey={spec.x.field} innerRadius={spec.type==='donut'?'62%':0} outerRadius="92%" paddingAngle={spec.type==='donut'?1.5:0} stroke="#fff" strokeWidth={2} startAngle={90} endAngle={-270} {...anim} animationDuration={800}>
       {data.map((d,i)=><Cell key={i} fill={colorOf(String(d[spec.x.field]),i)}/>)}
      </Pie>
     </PieChart></ResponsiveContainer>
     {spec.type==='donut'&&<div className="donut-center"><strong>{formatValue(total,spec.y.format,true)}</strong><span>total</span></div>}
    </div>
    <ul className="pie-legend">{data.map((d,i)=><li key={i} style={{animationDelay:`${200+i*60}ms`}}><i style={{background:colorOf(String(d[spec.x.field]),i)}}/><span>{String(d[spec.x.field])}</span><strong>{formatValue(d[key],spec.y.format)}</strong><em>{total?((Number(d[key])/total)*100).toFixed(1)+'%':''}</em></li>)}</ul>
   </div>;
  }
  case 'stackedarea':
   return <ResponsiveContainer width="100%" height={300}><AreaChart data={data} margin={margin}>
    {grid}
    <XAxis dataKey={spec.x.field} {...axisProps} tickFormatter={xTick} axisLine={{stroke:AXIS}} minTickGap={24}/>
    <YAxis {...axisProps} tickFormatter={yTick} width={52}/>
    {tip}{legend}
    {spec.series.map((s,i)=><Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stackId="a" stroke={colorOf(s.label,i)} strokeWidth={1.5} fill={colorOf(s.label,i)} fillOpacity={0.78} {...anim} animationDuration={900} animationBegin={i*80}/>)}
   </AreaChart></ResponsiveContainer>;
  case 'treemap':{
   const key=spec.series[0].key;const values=data.map(d=>Number(d[key])||0);const max=Math.max(...values,1),min=Math.min(...values,0);
   const nodes=data.map(d=>({name:String(d[spec.x.field]),size:Number(d[key])||0}));
   return <ResponsiveContainer width="100%" height={320}><Treemap data={nodes} dataKey="size" nameKey="name" stroke="#fff" isAnimationActive animationDuration={700} content={<TreemapCell max={max} min={min} count={nodes.length} format={spec.y.format}/>}>
    <Tooltip content={({active,payload}:TipProps)=>active&&payload?.length?<div className="chart-tip"><div className="chart-tip-title">{payload[0].payload.name}</div><div className="chart-tip-row"><i style={{background:SERIES[0]}}/><span>{spec.y.label}</span><strong>{formatValue(payload[0].payload.size,spec.y.format)}</strong></div></div>:null} wrapperStyle={{outline:'none'}} isAnimationActive={false}/>
   </Treemap></ResponsiveContainer>;
  }
  case 'radial':{
   const key=spec.series[0].key;const max=Math.max(...data.map(d=>Number(d[key])||0),1);
   const rows=data.map((d,i)=>({name:String(d[spec.x.field]),value:Number(d[key])||0,fill:colorOf(String(d[spec.x.field]),i)}));
   return <div className="pie-layout">
    <div className="pie-plot"><ResponsiveContainer width="100%" height={270}><RadialBarChart data={[...rows].reverse()} innerRadius="28%" outerRadius="96%" startAngle={90} endAngle={-270} barCategoryGap="22%">
     <PolarAngleAxis type="number" domain={[0,max*1.05]} tick={false} axisLine={false}/>
     <PolarRadiusAxis type="category" dataKey="name" tick={false} axisLine={false}/>
     <RadialBar dataKey="value" background={{fill:'#f1f1ee'}} cornerRadius={8} {...anim} animationDuration={900}/>
     <Tooltip content={({active,payload}:TipProps)=>active&&payload?.length?<div className="chart-tip"><div className="chart-tip-title">{payload[0].payload.name}</div><div className="chart-tip-row"><i style={{background:payload[0].payload.fill}}/><span>{spec.y.label}</span><strong>{formatValue(payload[0].payload.value,spec.y.format)}</strong></div></div>:null} isAnimationActive={false}/>
    </RadialBarChart></ResponsiveContainer></div>
    <ul className="pie-legend">{rows.map((r,i)=><li key={i} style={{animationDelay:`${200+i*60}ms`}}><i style={{background:r.fill}}/><span>{r.name}</span><strong>{formatValue(r.value,spec.y.format)}</strong><em/></li>)}</ul>
   </div>;
  }
  case 'radar':{
   // Axes are the measures; one outline per category (measures share one scale by construction).
   const cats=data.map(d=>String(d[spec.x.field]));
   const rows=spec.series.map(s=>Object.fromEntries([['measure',s.label],...data.map(d=>[String(d[spec.x.field]),Number(d[s.key])||0])]));
   return <ResponsiveContainer width="100%" height={330}><RadarChart data={rows} outerRadius="72%" margin={{top:10,right:30,left:30,bottom:10}}>
    <PolarGrid stroke={GRID}/>
    <PolarAngleAxis dataKey="measure" tick={{fill:INK2,fontSize:11.5}}/>
    <PolarRadiusAxis tick={{fill:MUTED,fontSize:10}} tickFormatter={yTick} axisLine={false}/>
    <Legend verticalAlign="top" align="left" height={30} content={()=><ul className="chart-legend">{cats.map((c,i)=><li key={c}><i style={{background:colorOf(c,i)}}/>{c}</li>)}</ul>}/>
    <Tooltip content={({active,payload,label}:TipProps)=>active&&payload?.length?<div className="chart-tip"><div className="chart-tip-title">{label}</div>{payload.map(p=><div key={p.name} className="chart-tip-row"><i style={{background:p.color}}/><span>{p.name}</span><strong>{formatValue(p.value,spec.y.format)}</strong></div>)}</div>:null} isAnimationActive={false}/>
    {cats.map((c,i)=><Radar key={c} name={c} dataKey={c} stroke={colorOf(c,i)} fill={colorOf(c,i)} fillOpacity={0.12} strokeWidth={2} dot={{r:3,fill:'#fff',strokeWidth:2}} {...anim} animationDuration={800}/>)}
   </RadarChart></ResponsiveContainer>;
  }
  case 'heatmap':return <Heatmap spec={spec}/>;
  case 'gauge':return <Gauge spec={spec}/>;
  case 'scatter':
   return <ResponsiveContainer width="100%" height={300}><ScatterChart margin={margin}>
    <CartesianGrid stroke={GRID}/>
    <XAxis type="number" dataKey={spec.x.field} name={spec.x.label} {...axisProps} tickFormatter={yTick} axisLine={{stroke:AXIS}}/>
    <YAxis type="number" dataKey={spec.series[0].key} name={spec.y.label} {...axisProps} tickFormatter={yTick} width={52}/>
    <ZAxis range={[36,36]}/>
    {tip}
    <Scatter data={data} fill={SERIES[0]} fillOpacity={0.7} stroke="#fff" strokeWidth={1} {...anim}/>
   </ScatterChart></ResponsiveContainer>;
  default:return null;
 }
}

// Sequential blue ramp (light → dark) for magnitude; text flips to white on dark cells.
const RAMP=['#e6f0fc','#cde2fb','#b7d3f6','#9ec5f4','#86b6ef','#6da7ec','#5598e7','#3987e5','#2a78d6','#256abf','#1c5cab','#184f95'];
const rampOf=(v:number,min:number,max:number)=>{const t=max>min?(v-min)/(max-min):1;const i=Math.min(RAMP.length-1,Math.max(0,Math.round(t*(RAMP.length-1))));return {bg:RAMP[i],ink:i>=7?'#fff':INK};};

const lum=(hex:string)=>{const n=parseInt(hex.slice(1),16);return (0.299*(n>>16&255)+0.587*(n>>8&255)+0.114*(n&255))/255;};
function TreemapCell(props:{x?:number;y?:number;width?:number;height?:number;name?:string;size?:number;depth?:number;index?:number;max:number;min:number;count:number;format:ChartSpec['y']['format']}){
 const {x=0,y=0,width=0,height=0,name,size,depth,index=0,max,min,count,format}=props;
 if(depth!==1)return null;
 // Up to 8 tiles: one categorical colour each (identity); more: one blue ramp by size (magnitude).
 const cat=count<=8?colorOf(String(name),index):undefined;
 const {bg,ink}=cat?{bg:cat,ink:lum(cat)>0.6?INK:'#fff'}:rampOf(Number(size)||0,Math.max(0,min),max);
 const roomy=width>64&&height>34;
 return <g><rect x={x} y={y} width={width} height={height} rx={4} fill={bg} stroke="#fff" strokeWidth={2}/>
  {roomy&&<text x={x+8} y={y+18} fill={ink} fontSize={11.5} fontWeight={600}>{String(name).length*6.5>width-12?String(name).slice(0,Math.max(3,Math.floor((width-16)/6.8)))+'…':name}</text>}
  {roomy&&height>48&&<text x={x+8} y={y+34} fill={ink} fontSize={11} opacity={0.85}>{formatValue(size,format,true)}</text>}</g>;
}

function Heatmap({spec}:{spec:ChartSpec}){
 const values=spec.data.flatMap(d=>spec.series.map(s=>Number(d[s.key])||0));
 const min=Math.min(...values),max=Math.max(...values);
 return <div className="heatmap" style={{gridTemplateColumns:`minmax(90px,max-content) repeat(${spec.series.length},minmax(54px,1fr))`}}>
  <span className="hm-corner">{spec.x.label}</span>
  {spec.series.map(s=><span key={s.key} className="hm-col">{s.label}</span>)}
  {spec.data.map((d,r)=><React.Fragment key={r}>
   <span className="hm-row">{String(d[spec.x.field])}</span>
   {spec.series.map((s,c)=>{const v=Number(d[s.key])||0;const {bg,ink}=rampOf(v,min,max);return <span key={s.key} className="hm-cell" title={`${d[spec.x.field]} · ${s.label}: ${formatValue(v,spec.y.format)}`} style={{background:bg,color:ink,animationDelay:`${(r*spec.series.length+c)*12}ms`}}>{formatValue(v,spec.y.format,true)}</span>;})}
  </React.Fragment>)}
  <div className="hm-scale" style={{gridColumn:`1 / span ${spec.series.length+1}`}}><span>{formatValue(min,spec.y.format,true)}</span><i style={{background:`linear-gradient(90deg,${RAMP[0]},${RAMP.at(-1)})`}}/><span>{formatValue(max,spec.y.format,true)}</span></div>
 </div>;
}

function Gauge({spec}:{spec:ChartSpec}){
 const d=spec.data[0]||{};const key=spec.series[0].key;let v=Number(d[key])||0;if(v<=1&&!Number.isInteger(v))v*=100;
 const pct=Math.max(0,Math.min(100,v));const r=80,cx=100,cy=96,len=Math.PI*r;
 const rest=spec.series.slice(1);
 return <div className="gauge">
  <svg viewBox="0 0 200 112" width="260" height="146" role="img" aria-label={`${spec.y.label}: ${pct.toFixed(1)}%`}>
   <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke="#ecebe6" strokeWidth={14} strokeLinecap="round"/>
   <path className="gauge-arc" d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={SERIES[0]} strokeWidth={14} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len*(1-pct/100)}/>
   <text x={cx} y={cy-14} textAnchor="middle" fontSize={30} fontWeight={650} fill={INK}>{pct.toLocaleString('en-US',{maximumFractionDigits:1})}%</text>
   <text x={cx} y={cy+4} textAnchor="middle" fontSize={11} fill={MUTED}>{spec.y.label}</text>
  </svg>
  {rest.length>0&&<div className="gauge-facts">{rest.map(s=><div key={s.key}><span>{s.label}</span><strong>{formatValue(d[s.key],'integer')}</strong></div>)}</div>}
 </div>;
}

function Kpis({spec}:{spec:ChartSpec}){
 const d=spec.data[0]||{};
 return <div className="kpis">{spec.series.map((s,i)=><div className="kpi" key={s.key} style={{animationDelay:`${i*80}ms`}}><span>{s.label}</span><strong>{formatValue(d[s.key],spec.y.format)}</strong></div>)}</div>;
}

function DataTable({spec}:{spec:ChartSpec}){
 const cols=[spec.x.field,...spec.series.map(s=>s.key)].filter((c,i,a)=>a.indexOf(c)===i);
 const head=(c:string)=>c===spec.x.field?spec.x.label||'Label':spec.series.find(s=>s.key===c)?.label||c;
 return <div className="table-wrap chart-table" tabIndex={0}><table><thead><tr>{cols.map(c=><th key={c}>{head(c)}</th>)}</tr></thead>
  <tbody>{spec.data.map((d,i)=><tr key={i}>{cols.map(c=><td key={c} className={c===spec.x.field?undefined:'num'}>{c===spec.x.field?(spec.x.kind==='time'?formatTime(d[c],spec.data,c):String(d[c]??'—')):formatValue(d[c],spec.y.format)}</td>)}</tr>)}</tbody></table></div>;
}

// The full query result behind the chart (the chart itself may fold small groups into "Other").
const head=(c:string)=>c.replace(/^count_star\(\)$/,'count').replace(/^record_count$/,'count').replace(/[_()"*]+/g,' ').replace(/\s+/g,' ').trim();
function RawTable({rows}:{rows:Record<string,unknown>[]}){
 const cols=Object.keys(rows[0]||{});
 return <div className="table-wrap chart-table" tabIndex={0}><table><thead><tr>{cols.map(c=><th key={c}>{head(c)}</th>)}</tr></thead>
  <tbody>{rows.map((r,i)=><tr key={i}>{cols.map(c=><td key={c} className={typeof r[c]==='number'?'num':undefined}>{typeof r[c]==='number'?formatValue(r[c],Number.isInteger(r[c])?'integer':'decimal'):r[c]===null||r[c]===undefined?'—':String(r[c])}</td>)}</tr>)}</tbody></table></div>;
}

function toCSV(spec:ChartSpec){
 const cols=[spec.x.field,...spec.series.map(s=>s.key)].filter((c,i,a)=>a.indexOf(c)===i);
 const esc=(v:unknown)=>{const s=v===null||v===undefined?'':String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
 return [cols.map(esc).join(','),...spec.data.map(d=>cols.map(c=>esc(d[c])).join(','))].join('\n');
}

const TYPE_NAMES:Record<ChartType,string>={kpi:'Figure',gauge:'Gauge',bar:'Bars',column:'Columns',line:'Line',area:'Area',stackedarea:'Stacked area',stacked:'Stacked',percent:'100% stacked',grouped:'Grouped',pie:'Pie',donut:'Donut',treemap:'Treemap',radial:'Radial',radar:'Radar',heatmap:'Heatmap',scatter:'Scatter'};
// Re-shapes the same data for another chart form (no new numbers: only ordering and folding small slices).
function asType(spec:ChartSpec,type:ChartType):ChartSpec{
 if(type===spec.type)return spec;
 const key=spec.series[0]?.key;
 if((type==='pie'||type==='donut'||type==='radial')&&key){
  const sorted=[...spec.data].sort((a,b)=>Number(b[key])-Number(a[key]));
  const cap=type==='radial'?8:7;
  if(sorted.length<=cap)return {...spec,type,data:sorted};
  const rest=sorted.slice(cap-1);
  return {...spec,type,data:[...sorted.slice(0,cap-1),{[spec.x.field]:`Other (${rest.length})`,[key]:rest.reduce((t,d)=>t+(Number(d[key])||0),0)}]};
 }
 if(type==='bar'&&spec.series.length===1&&spec.x.kind==='category'&&key&&!/^(column)$/.test(spec.type))return {...spec,type,data:[...spec.data].sort((a,b)=>Number(b[key])-Number(a[key]))};
 return {...spec,type};
}

export function ChartCard({spec,sql,rows,index=0,compact=false}:{spec:ChartSpec;sql?:string;rows?:Record<string,unknown>[];index?:number;compact?:boolean}){
 const [view,setView]=useState<'chart'|'table'|'sql'>('chart');
 const [type,setType]=useState<ChartType>(spec.type);
 const shown=useMemo(()=>asType(spec,type),[spec,type]);
 const kpi=shown.type==='kpi';
 const options=[...new Set([spec.type,...(spec.alternatives||[])])];
 const tabs=useMemo(()=>[['chart',kpi?'Figure':'Chart'],['table','Table'],...(sql?[['sql','SQL']]:[])] as [typeof view,string][],[kpi,sql]);
 function download(){
  const blob=new Blob([toCSV(spec)],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=(spec.title||'chart').replace(/[^\w-]+/g,'-').toLowerCase().slice(0,60)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
 }
 return <figure className={'chart-card'+(compact?' compact':'')} style={{animationDelay:`${120+index*110}ms`}}>
  <header className="chart-head">
   <div className="chart-titles"><figcaption>{spec.title}</figcaption>{spec.subtitle&&<p>{spec.subtitle}</p>}</div>
   <div className="chart-tools">
    <div className="seg" role="tablist">{tabs.map(([id,text])=><button key={id} role="tab" aria-selected={view===id} className={view===id?'on':''} onClick={()=>setView(id)}>{text}</button>)}</div>
    <button className="chart-icon" onClick={download} title="Download data as CSV" aria-label="Download data as CSV"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
   </div>
  </header>
  {view==='chart'&&options.length>1&&<div className="view-as" role="radiogroup" aria-label="View as">
   <span>View as</span>{options.map(t=><button key={t} role="radio" aria-checked={type===t} className={type===t?'on':''} onClick={()=>setType(t)}>{TYPE_NAMES[t]}</button>)}
  </div>}
  <div className="chart-body" key={view+type}>
   {view==='chart'?(kpi?<Kpis spec={shown}/>:<Plot spec={shown}/>):view==='table'?(rows?.length?<RawTable rows={rows}/>:<DataTable spec={spec}/>):<pre className="sql">{sql}</pre>}
  </div>
  {spec.note&&<p className="chart-note">{spec.note}</p>}
 </figure>;
}
