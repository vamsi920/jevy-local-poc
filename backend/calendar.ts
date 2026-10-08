import {identifier,sqlLiteral} from './db.js';
export type CalendarPeriod={unit:'day'|'week'|'month'|'quarter'|'year';offset:number};
// Compile schema-validated calendar primitives, never question-specific SQL.
export function periodComparisonSQL(table:string,dateColumn:string,periods:CalendarPeriod[]=[{unit:'month',offset:0},{unit:'month',offset:-1}],referenceDate='',where=''){
 const source=referenceDate&&/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)?`(SELECT DATE '${referenceDate}' AS as_of) reference_date`:'dataset_info';
 if(!periods.length||periods.length>8)throw new Error('Specify 1–8 calendar periods');
 const t=identifier(table),d=identifier(dateColumn);
 const parts=periods.map(({unit,offset},i)=>{
  if(!['day','week','month','quarter','year'].includes(unit)||!Number.isInteger(offset)||Math.abs(offset)>120)throw new Error('Invalid calendar period');
  const start=`date_trunc('${unit}',as_of)+INTERVAL '${offset} ${unit}'`;
  return `SELECT ${i} ordinal,${sqlLiteral(`${unit}:${offset}`)} period,(${start})::DATE period_start,(${start}+INTERVAL '1 ${unit}')::DATE period_end FROM ${source}`;
 });
 const result=`WITH periods AS (${parts.join(' UNION ALL ')}) SELECT p.period,p.period_start,p.period_end,count(t.${d}) count FROM periods p LEFT JOIN ${where?`(SELECT * FROM ${t} WHERE ${where})`:t} t ON t.${d}>=p.period_start AND t.${d}<p.period_end GROUP BY p.ordinal,p.period,p.period_start,p.period_end ORDER BY p.ordinal`;
 return periods.length===1?`SELECT count FROM (${result}) calendar_count`:result;
}

// Relative-calendar vocabulary maps to typed operators; table/schema resolution is separate.
export function calendarPeriods(question:string):CalendarPeriod[]{
 if(!/\b(compare|count|counts|number|how many|total)\b/i.test(question)||/\b(distinct|sum|average|rolling|days|weeks|months|years|through|since)\b/i.test(question))return [];
 return [...question.matchAll(/\b(this|current|last|previous|next)\s+(?:calendar\s+)?(day|week|month|quarter|year)\b/gi)].map(m=>({unit:m[2].toLowerCase() as CalendarPeriod['unit'],offset:/last|previous/i.test(m[1])?-1:/next/i.test(m[1])?1:0}));
}
