import {test} from 'node:test';import assert from 'node:assert/strict';
import {chartRequest,buildChart,validateChart,ordinalOrder,titleOf} from '../backend/chart.js';
import type {Evidence,Row} from '../backend/types.js';

const ev=(rows:Row[],stepId='answer'):Evidence=>({stepId,objective:'o',tool:'run_sql',sql:'SELECT 1',rows,rowCount:rows.length,truncated:false,durationMs:0,repairs:0});
const none=chartRequest('plain question');

test('chart wording is separated from the data question',()=>{
 const cases:[string,string,string|undefined][]=[
  ['show me a pie chart of servers by os','servers by os','pie'],
  ['bar chart of open vulnerabilities by severity','open vulnerabilities by severity','bar'],
  ['servers by environment as a donut chart','servers by environment','donut'],
  ['how many servers per country, chart it','how many servers per country',undefined],
  ['pie chrt of servrs by enviroment','servrs by enviroment','pie'],
  ['plot incidents per month','incidents per month',undefined],
 ];
 for(const [q,data,type] of cases){const r=chartRequest(q);assert.ok(r.wanted,q);assert.equal(r.question,data,q);assert.equal(r.type,type,q);assert.equal(r.chartOnly,false,q);}
 for(const q of ['make that a bar chart','show it as a line chart','turn this into a donut','chart it'])assert.ok(chartRequest(q).chartOnly,q);
 assert.equal(chartRequest('how many servers are there').wanted,false);
});

test('result shape picks the chart form',()=>{
 const cat=buildChart([ev([{os:'Linux',n:3},{os:'Windows',n:2}])],none,'servers by os')!;
 assert.equal(cat.type,'donut');assert.deepEqual(cat.data,[{os:'Linux',n:3},{os:'Windows',n:2}]);assert.ok(cat.alternatives.includes('column'));
 const time=buildChart([ev([{month_start:'2026-07-01',n:5},{month_start:'2026-06-01',n:4}])],none,'incidents per month')!;
 assert.equal(time.type,'column');// two periods read better as columns than as a lineassert.equal(time.x.kind,'time');assert.equal(time.data[0].month_start,'2026-06-01');
 const two=buildChart([ev([{env:'Prod',os:'A',n:1},{env:'Prod',os:'B',n:2},{env:'Test',os:'A',n:3}])],none,'q')!;
 assert.equal(two.type,'stacked');assert.equal(two.series.length,2);
 const kpi=buildChart([ev([{servers_count:4000}])],chartRequest('chart the number of servers'),'q')!;
 assert.equal(kpi.type,'kpi');
 const hist=buildChart([ev([{cpu_cores:8,servers_count:2},{cpu_cores:2,servers_count:5}])],none,'q')!;
 assert.equal(hist.type,'column');assert.deepEqual(hist.data.map(d=>d.cpu_cores),['2','8']);
 const multi=buildChart([ev([{a:3}],'s1'),ev([{b:7}],'s2')],none,'q')!;
 assert.equal(multi.type,'column');assert.deepEqual(multi.data.map(d=>d.value),[3,7]);
});

test('requested types are honoured only when the data supports them',()=>{
 const rows=[{os:'A',n:1},{os:'B',n:2}];
 assert.equal(buildChart([ev(rows)],chartRequest('pie chart of x'),'q')!.type,'pie');
 assert.equal(buildChart([ev(rows)],chartRequest('horizontal bar chart of x'),'q')!.type,'bar');
 const neg=buildChart([ev([{os:'A',n:-1},{os:'B',n:2}])],chartRequest('pie chart of x'),'q')!;
 assert.notEqual(neg.type,'pie');assert.match(neg.note||'',/non-negative/);
});

test('pies fold small slices; many categories are capped with a note',()=>{
 const rows=Array.from({length:12},(_,i)=>({k:'c'+i,n:100-i}));
 const pie=buildChart([ev(rows)],chartRequest('pie chart of x'),'q')!;
 assert.equal(pie.data.length,7);assert.match(String(pie.data.at(-1)!.k),/^Other/);
 assert.equal(pie.data.reduce((s,d)=>s+Number(d.n),0),rows.reduce((s,r)=>s+r.n,0));
 const many=buildChart([ev(Array.from({length:45},(_,i)=>({k:'c'+i,n:i})))],none,'q')!;
 assert.equal(many.type,'treemap');assert.equal(many.data.length,45);
 const avgMany=buildChart([ev(Array.from({length:45},(_,i)=>({k:'c'+i,avg_x:i+0.5})))],none,'q')!;
 assert.equal(avgMany.data.length,30);assert.match(avgMany.note||'',/30 largest of 45/);
});

test('ordered categories keep their natural order',()=>{
 const sev=buildChart([ev([{severity:'Low',n:1},{severity:'Critical',n:2},{severity:'Medium',n:3},{severity:'High',n:4}])],none,'q')!;
 assert.deepEqual(sev.data.map(d=>d.severity),['Critical','High','Medium','Low']);
 assert.ok(ordinalOrder(['P3','P1','P2']));assert.equal(ordinalOrder(['London','Paris']),undefined);
});

test('chart values come only from evidence and the spec validates',()=>{
 const e=ev([{os:'A',n:1},{os:'B',n:2}]);const spec=buildChart([e],none,'q')!;
 assert.deepEqual(validateChart(spec,[e]),[]);
 assert.ok(validateChart({...spec,sourceStepIds:['missing']},[e]).length);
 assert.equal(buildChart([ev([])],none,'q'),undefined);
 assert.equal(titleOf('show me the number of servers by os?'),'Number of servers by OS');
});

test('the intent of the question changes the chart form for the same rows',()=>{
 const rows=[{env:'Prod',n:40},{env:'Test',n:30},{env:'Dev',n:20},{env:'Stage',n:10},{env:'DR',n:5},{env:'Lab',n:2},{env:'QA',n:1},{env:'UAT',n:1}];
 assert.equal(buildChart([ev(rows)],none,'servers by environment')!.type,'column');
 assert.equal(buildChart([ev(rows)],none,'share of servers by environment')!.type,'treemap');
 const ranked=buildChart([ev(rows)],none,'top environments by servers')!;assert.equal(ranked.type,'bar');assert.equal(ranked.data[0].env,'Prod');
 const two=[{a:'X',b:'P',n:1},{a:'X',b:'Q',n:2},{a:'Y',b:'P',n:3},{a:'Y',b:'Q',n:4}];
 assert.equal(buildChart([ev(two)],none,'q by a and b')!.type,'stacked');
 assert.equal(buildChart([ev(two)],none,'percentage split of q by a and b')!.type,'percent');
 assert.equal(buildChart([ev(two)],none,'compare q by a and b')!.type,'grouped');
 const time=[{month_start:'2026-01-01',n:1},{month_start:'2026-02-01',n:2},{month_start:'2026-03-01',n:3},{month_start:'2026-04-01',n:4}];
 const cum=buildChart([ev(time)],none,'cumulative q per month')!;assert.equal(cum.type,'line');assert.deepEqual(cum.data.map(d=>d.cumulative_n),[1,3,6,10]);
 const gauge=buildChart([ev([{percentage:33.2,matching:3,total:9}])],none,'what percentage of x')!;assert.equal(gauge.type,'gauge');
 const radar=buildChart([ev([{os:'A',avg_a:1,avg_b:2,avg_c:3,avg_d:2},{os:'B',avg_a:2,avg_b:1,avg_c:2,avg_d:3}])],none,'profile by os')!;assert.equal(radar.type,'radar');
 const avg=buildChart([ev([{p:'P1',avg_downtime:5},{p:'P2',avg_downtime:6}])],chartRequest('pie chart of average downtime by p'),'q')!;
 assert.notEqual(avg.type,'pie');assert.match(avg.note||'',/do not add up/);
});
