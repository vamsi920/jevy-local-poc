import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../backend/db.js';
import {Catalog} from '../backend/catalog.js';
import {normalizeSQL} from '../backend/sql-guard.js';
let db:Database,catalog:Catalog;
before(async()=>{db=await Database.open();catalog=await new Catalog(db).build();});after(()=>db.close());
test('missing grouping labels are restored without changing counts',async()=>{
 const fixed=await normalizeSQL('SELECT count(*) AS n FROM servers GROUP BY country ORDER BY country',catalog);
 assert.deepEqual((await db.query(fixed.sql)).rows,(await db.query('SELECT country,count(*) AS n FROM servers GROUP BY country ORDER BY country')).rows);
 assert.equal(fixed.notes.length,1);
});
test('already labeled groups retain original SQL',async()=>{
 const sql='SELECT country,count(*) AS n FROM servers GROUP BY country';
 assert.equal((await normalizeSQL(sql,catalog)).sql,sql);
});
test('root count over child joins cannot silently inflate inventory',async()=>{
 await assert.rejects(normalizeSQL('SELECT count(*) FROM servers JOIN vulnerabilities USING(server_id)',catalog),/multiplies/);
 const fixed=await normalizeSQL('SELECT count(DISTINCT servers.server_id) AS n FROM servers JOIN vulnerabilities USING(server_id)',catalog);
 assert.equal((await db.query(fixed.sql)).rows[0].n,(await db.query('SELECT count(DISTINCT server_id) AS n FROM vulnerabilities')).rows[0].n);
});
test('multiple statements cannot enter normalization',async()=>{
 await assert.rejects(normalizeSQL('SELECT 1; SELECT 2',catalog),/one SELECT/);
});
test('a scalar count cannot replace requested category counts',async()=>{
 await assert.rejects(normalizeSQL('SELECT count(*) FROM servers',catalog,'How many servers are in each environment?'),/category environment|breakdown by environment/);
 const fixed=await normalizeSQL('SELECT count(*) AS n FROM servers GROUP BY environment',catalog,'How many servers are in each environment?');
 const rows=(await db.query(fixed.sql)).rows;assert.equal(rows.length,4);assert.equal(rows.reduce((n,r)=>n+Number(r.n),0),4000);
});
test('two-argument date subtraction translates without changing date meaning',async()=>{
 const fixed=await normalizeSQL("SELECT date_sub(DATE '2026-01-02', INTERVAL '30 days') AS d",catalog);
 assert.deepEqual((await db.query(fixed.sql)).rows,(await db.query("SELECT DATE '2026-01-02' - INTERVAL '30 days' AS d")).rows);
 const native="SELECT date_sub('month', DATE '2025-01-01', DATE '2026-01-01') AS n";
 assert.equal((await normalizeSQL(native,catalog)).sql,native);
});
test('every-category wording requires labeled output, not one total',async()=>{
 await assert.rejects(normalizeSQL('SELECT count(*) FROM servers',catalog,'Show server counts for every country.'),/category country|breakdown by country/);
});
test('observed aliases normalize before execution and retain entity counts',async()=>{
 const fixed=await normalizeSQL("SELECT count(*) AS n FROM servers WHERE os='RHEL'",catalog,'Count RHEL servers');
 assert.equal((await db.query(fixed.sql)).rows[0].n,(await db.query("SELECT count(*) AS n FROM servers WHERE os='Red Hat Enterprise Linux'")).rows[0].n);
});
test('dropping explicit categorical constraints cannot pass as a successful count',async()=>{
 await assert.rejects(normalizeSQL("SELECT count(*) FROM servers WHERE country='AU'",catalog,'Count US Production servers'),/not requested|filter missing/);
 await assert.rejects(normalizeSQL("SELECT count(*) FROM servers WHERE country='US'",catalog,'Count US Production servers'),/filter missing/);
 const fixed=await normalizeSQL("SELECT count(*) AS n FROM servers WHERE country='US' AND environment='Prod'",catalog,'Count US Prod servers');
 assert.equal((await db.query(fixed.sql)).rows[0].n,(await db.query("SELECT count(*) AS n FROM servers WHERE country='US' AND environment='Production'")).rows[0].n);
});
test('shared category values do not imply a filter on every matching field',async()=>{
 const fixed=await normalizeSQL("SELECT count(*) AS n FROM evergreening WHERE current_os='RHEL'",catalog,'Count RHEL servers');
 assert.equal((await db.query(fixed.sql)).rows[0].n,(await db.query("SELECT count(*) AS n FROM evergreening WHERE current_os='Red Hat Enterprise Linux'")).rows[0].n);
});
test('random sampling enforces requested cardinality even if model omits LIMIT',async()=>{
 const result=await normalizeSQL('SELECT server_id FROM servers ORDER BY server_id',catalog,'Give me three random servers');
 const rows=(await db.query(result.sql)).rows;assert.equal(rows.length,3);assert.match(result.sql,/random\(/i);assert.notEqual(rows[0].server_id,'SRV-00001');
});
test('unrequested temporal restriction cannot silently erase an unfiltered sample',async()=>{
 const result=await normalizeSQL("SELECT * FROM servers WHERE created_date=DATE '2026-10-07' LIMIT 3",catalog,'Give me three random servers');
 assert.equal((await db.query(result.sql)).rows.length,3);assert.ok(!/WHERE/i.test(result.sql));assert.ok(result.notes.some(n=>n.includes('temporal restriction')));
});
