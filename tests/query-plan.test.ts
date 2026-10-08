import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../backend/db.js';
import {Catalog} from '../backend/catalog.js';
import {compileQuery,groundedFilters,type QueryPlan} from '../backend/query-plan.js';
let db:Database,catalog:Catalog;
before(async()=>{db=await Database.open();catalog=await new Catalog(db).build();});after(()=>db.close());
const plan=(changes:Partial<QueryPlan>={}):QueryPlan=>({table:'servers',select:[{column:'*',aggregate:'count'}],filters:[],groupBy:[],orderBy:[],random:false,limit:200,advancedSql:'',...changes});
test('typed count compiles requested filters and yields fresh exact count',async()=>{const sql=compileQuery(plan({filters:[{column:'servers.environment',operator:'eq',values:['Production']}]}),catalog);assert.equal((await db.query(sql)).rows[0].count_0,970);});
test('compiler rejects imaginary fields before database execution',()=>assert.throws(()=>compileQuery(plan({filters:[{column:'servers.imaginary',operator:'eq',values:['x']}]}),catalog),/Unknown column/));
test('compiler escapes values, including SQL-looking content',async()=>{const sql=compileQuery(plan({filters:[{column:'servers.country',operator:'eq',values:["US'; DELETE FROM servers; --"]}]}),catalog);assert.equal((await db.query(sql)).rows[0].count_0,0);});
test('compiler builds verified join path without model-written ON clauses',async()=>{const sql=compileQuery(plan({select:[{column:'servers.server_id',aggregate:'none'},{column:'applications.application_name',aggregate:'none'}],filters:[{column:'servers.server_id',operator:'eq',values:['SRV-00001']}]}),catalog);assert.equal((await db.query(sql)).rows.length,1);assert.match(sql,/JOIN "applications"/);});
test('compiler rejects child-join entity count inflation',()=>assert.throws(()=>compileQuery(plan({filters:[{column:'vulnerabilities.status',operator:'eq',values:['Open']}]}),catalog),/count_distinct/));
test('distinct entity count across verified child joins executes',async()=>{const sql=compileQuery(plan({select:[{column:'servers.server_id',aggregate:'count_distinct'}],filters:[{column:'vulnerabilities.status',operator:'eq',values:['Open']}]}),catalog);const oracle=await db.query("SELECT count(DISTINCT server_id) n FROM vulnerabilities WHERE status='Open'");assert.equal((await db.query(sql)).rows[0].count_distinct_0,oracle.rows[0].n);});
test('grouped aggregates preserve requested grouping',async()=>{const sql=compileQuery(plan({select:[{column:'servers.country',aggregate:'none'},{column:'*',aggregate:'count'}],groupBy:['servers.country'],orderBy:[{column:'servers.country',direction:'asc'}]}),catalog);assert.equal((await db.query(sql)).rows.length,6);});

test('short country code IN never matches ordinary preposition in',()=>assert.deepEqual(groundedFilters(catalog,'servers','How many servers exist in the inventory?'),[]));
test('grounded aliases preserve explicit production and US constraints',()=>assert.deepEqual(groundedFilters(catalog,'servers','Count US Prod machines.').map(f=>f.values[0]).sort(),['Production','US']));
test('missing grounded filter blocks otherwise executable wrong answer',()=>assert.throws(()=>compileQuery(plan(),catalog,'Count Production servers'),/Requested categorical filter missing/));

test('server country context excludes unrelated estate headquarters',()=>assert.deepEqual(catalog.retrieve('How many servers are in the United States?').tables.map(t=>t.name),['servers']));

test('group dimensions are automatically projected as labeled evidence',async()=>{const sql=compileQuery(plan({select:[{column:'servers.os',aggregate:'count'}],groupBy:['servers.os']}),catalog);const rows=(await db.query(sql)).rows;assert.ok(rows.every(r=>typeof r.os==='string'));assert.equal(rows.reduce((n,r)=>n+Number(r.count_1),0),4000);});
test('trivial distinct group-key count is rejected',()=>assert.throws(()=>compileQuery(plan({select:[{column:'servers.country',aggregate:'count_distinct'}],groupBy:['servers.country']}),catalog),/grouping key/));

test('counting distinct filtered category cannot masquerade as an entity count',()=>assert.throws(()=>compileQuery(plan({table:'vulnerabilities',select:[{column:'vulnerabilities.severity',aggregate:'count_distinct'}],filters:[{column:'vulnerabilities.severity',operator:'eq',values:['Critical']}]}),catalog),/fixed to one value/));
