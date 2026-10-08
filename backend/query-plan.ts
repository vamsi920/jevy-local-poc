import {z} from 'zod';
import {Catalog} from './catalog.js';
import {identifier,sqlLiteral} from './db.js';
import {groundSync} from './grounding.js';
export const queryPlanSchema=z.object({
 table:z.string(),
 select:z.array(z.object({column:z.string(),aggregate:z.enum(['none','count','count_distinct','sum','avg','min','max'])})).min(1).max(12),
 filters:z.array(z.object({column:z.string(),operator:z.enum(['eq','ne','gt','gte','lt','lte','contains','in']),values:z.array(z.union([z.string(),z.number(),z.boolean()])).min(1).max(200)})).max(12),
 groupBy:z.array(z.string()).max(6),
 orderBy:z.array(z.object({column:z.string(),direction:z.enum(['asc','desc'])})).max(3),
 random:z.boolean(),limit:z.number().int().min(1).max(200),
 // SQL remains an escape hatch for window functions and other operations outside this algebra.
 advancedSql:z.string()
});
export function scopedQuerySchema(catalog:Catalog,request:string){
 const context=catalog.context(request);
 const tables=catalog.retrieve(request).tables.map(t=>({...t,columns:t.columns.filter(c=>context.tables.find(x=>x.table===t.name)!.columns.split(', ').some(x=>x.split(':')[0]===c.name))}));
 const names=tables.map(t=>t.name) as [string,...string[]];
 const columns=['*',...tables.flatMap(t=>t.columns.map(c=>t.name+'.'+c.name))] as [string,...string[]];
 const column=z.enum(columns);
 const advancedSql=context.tables.some(t=>/DATE|TIMESTAMP/.test(t.columns))?z.string().regex(/^(?:\s*(?:SELECT|WITH)\b[\s\S]*|\s*)$/i):z.literal('');
 const entities=['*',...tables.filter(t=>t.primaryKey).map(t=>t.name+'.'+t.primaryKey)] as [string,...string[]];
 return z.object({result:z.enum(['count','rows','group','sum','avg','min','max','advanced']),table:z.enum(names),entity:z.enum(entities),columns:z.array(column).max(12),groupBy:z.array(column).max(6),filters:z.array(z.object({column,operator:z.enum(['eq','ne','gt','gte','lt','lte','contains','in']),values:z.array(z.union([z.string(),z.number(),z.boolean()])).min(1).max(200)})).max(12),orderBy:z.array(z.object({column,direction:z.enum(['asc','desc'])})).max(3),limit:z.number().int().min(1).max(200),random:z.boolean(),advancedSql});
}
export function relationalPlan(p:z.infer<ReturnType<typeof scopedQuerySchema>>):QueryPlan{
 const {result,entity,columns,...rest}=p;
 let select:QueryPlan['select'];
 if(result==='count'||result==='group')select=[{column:entity,aggregate:entity==='*'?'count':'count_distinct'}];
 else if(result==='rows')select=columns.map(column=>({column,aggregate:'none'}));
 else if(result==='advanced')select=[{column:'*',aggregate:'count'}];
 else select=columns.map(column=>({column,aggregate:result}));
 if(!select.length)throw new Error('Requested rows or numeric measures require columns');
 return {...rest,select};
}
export type QueryPlan=z.infer<typeof queryPlanSchema>;
export function compileQuery(p:QueryPlan,catalog:Catalog,requestForGrounding=''){
 // Group dimensions must appear in evidence, even when the model omits projection.
 p={...p,select:[...p.groupBy.filter(column=>!p.select.some(s=>s.column===column&&s.aggregate==='none')).map(column=>({column,aggregate:'none' as const})),...p.select]};
 if(p.select.some(s=>s.aggregate==='count_distinct'&&p.groupBy.includes(s.column)))throw new Error('Counting distinct values of the grouping key yields one per group. Count entity IDs instead.');
 if(p.advancedSql.trim())throw new Error('Advanced SQL must use the separately validated SQL path');
 catalog.table(p.table);
 const needed=new Set([p.table]);
 const ref=(column:string)=>{
  if(column==='*')return '*';
  const parts=column.includes('.')?column.split('.'):[p.table,column];if(parts.length!==2)throw new Error('Column must be table.column: '+column);
  const [table,name]=parts;const t=catalog.table(table);
  if(!t.columns.some(c=>c.name===name))throw new Error('Unknown column '+column);
  needed.add(table);return identifier(table)+'.'+identifier(name);
 };
 for(const s of p.select)if(s.aggregate==='count_distinct'&&p.filters.some(f=>f.column===s.column&&f.operator==='eq'))throw new Error('Distinct count of a column fixed to one value is trivial. Count requested entity IDs or rows instead.');
 const selected=p.select.map((s,index)=>{const col=ref(s.column);if(col==='*'&&s.aggregate!=='count')throw new Error('Only count accepts *');const expr=s.aggregate==='none'?col:s.aggregate==='count_distinct'?`count(DISTINCT ${col})`:`${s.aggregate}(${col})`;return `${expr} AS ${identifier(s.aggregate==='none'?s.column.split('.').at(-1)!:s.aggregate+'_'+index)}`;});
 if(p.groupBy.includes(p.table+'.'+catalog.table(p.table).primaryKey)&&p.select.some(s=>['count','count_distinct'].includes(s.aggregate))&&p.select.filter(s=>s.aggregate!=='none').every(s=>s.column==='*'||s.column.startsWith(p.table+'.')))throw new Error('Counting base entities must not group by their own unique ID. Use groupBy [] for total count.');
 const groups=p.groupBy.map(ref);
 if(p.select.some(s=>s.aggregate!=='none'))for(const s of p.select)if(s.aggregate==='none'&&!p.groupBy.includes(s.column))throw new Error('Every non-aggregate selection must be grouped');
 for(const f of groundedFilters(catalog,p.table,requestForGrounding))if(!p.filters.some(x=>x.column===f.column&&x.values.includes(f.values[0])))throw new Error('Requested categorical filter missing: '+JSON.stringify(f));
 const predicates=p.filters.map(f=>{const col=ref(f.column);if(col==='*')throw new Error('Filter requires column');const vals=f.values.map(sqlLiteral);if(f.operator==='in')return `${col} IN (${vals.join(',')})`;if(vals.length!==1)throw new Error('Comparison needs one value');if(f.operator==='contains')return `${col} ILIKE ${sqlLiteral('%'+String(f.values[0])+'%')}`;return `${col} ${{eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='}[f.operator]} ${vals[0]}`;});
 const ordering=p.orderBy.map(o=>{const index=p.select.findIndex(s=>s.column===o.column);return (index>=0?String(index+1):ref(o.column))+' '+o.direction.toUpperCase();});
 // Build joins only from catalog relationships whose uniqueness and orphan checks passed.
 const edges=catalog.tables.flatMap(t=>t.relationships).map(r=>{const [left,right]=r.split(' = ');return {left,right,a:left.split('.')[0],b:right.split('.')[0]};});
 const joined=new Set([p.table]);const joins:string[]=[];
 for(const target of needed){if(joined.has(target))continue;const queue=[{name:target,path:[] as typeof edges}];const seen=new Set<string>();let path:typeof edges|undefined;
  while(queue.length){const current=queue.shift()!;if(joined.has(current.name)){path=current.path;break;}if(seen.has(current.name))continue;seen.add(current.name);for(const edge of edges)if(edge.a===current.name||edge.b===current.name)queue.push({name:edge.a===current.name?edge.b:edge.a,path:[edge,...current.path]});}
  if(!path)throw new Error('No verified join path to '+target);
  for(const edge of path){const next=joined.has(edge.a)?edge.b:edge.a;if(joined.has(next))continue;joins.push(`JOIN ${identifier(next)} ON ${edge.left.split('.').map(identifier).join('.')} = ${edge.right.split('.').map(identifier).join('.')}`);joined.add(next);}
 }
 // Joining a one-to-many child changes counts. Require explicit distinct root IDs.
 if(joined.size>1&&p.select.some(s=>s.aggregate==='count'&&(s.column==='*'||s.column.startsWith(p.table+'.')))&&edges.some(e=>joined.has(e.a)&&joined.has(e.b)&&e.b===p.table))throw new Error('Child joins require count_distinct on the requested entity ID');
 return `SELECT ${selected.join(', ')} FROM ${identifier(p.table)} ${joins.join(' ')}${predicates.length?' WHERE '+predicates.join(' AND '):''}${groups.length?' GROUP BY '+groups.join(', '):''}${p.random?' ORDER BY random()':ordering.length?' ORDER BY '+ordering.join(', '):''} LIMIT ${p.limit}`;
}

export function groundedFilters(catalog:Catalog,table:string,request:string):QueryPlan['filters']{
 // Delegates to the generic grounding layer (synonyms, acronyms, typos, learned aliases).
 const byColumn=new Map<string,Set<string>>();
 for(const m of groundSync(request,catalog).mentions)if(m.kind==='value'&&m.table===table&&m.confidence>=0.9&&m.column){const set=byColumn.get(m.column)||new Set();set.add(m.value!);byColumn.set(m.column,set);}
 return [...byColumn].filter(([,v])=>v.size===1).map(([column,v])=>({column:table+'.'+column,operator:'eq' as const,values:[[...v][0]]}));
}
