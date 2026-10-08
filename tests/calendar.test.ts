import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../backend/db.js';
import {periodComparisonSQL} from '../backend/calendar.js';
let db:Database;before(async()=>{db=await Database.open();});after(()=>db.close());
for(const [table,column] of [['incidents','created_date'],['vulnerabilities','discovered_date']] )test('calendar count matches oracle for '+table,async()=>{
 const rows=(await db.query(periodComparisonSQL(table,column))).rows;
 assert.equal(rows.length,2);
 for(const row of rows){const expected=await db.query(`SELECT count(*) n FROM "${table}" WHERE "${column}">=DATE '${row.period_start}' AND "${column}"<DATE '${row.period_end}'`);assert.equal(row.count,expected.rows[0].n);}
});
test('calendar compiler supports arbitrary units and retains zero periods',async()=>{
 const rows=(await db.query(periodComparisonSQL('incidents','created_date',[{unit:'year',offset:2},{unit:'week',offset:-1},{unit:'quarter',offset:0}]))).rows;
 assert.equal(rows.length,3);assert.equal(rows[0].count,0);assert.equal(rows[1].period,'week:-1');
});
test('calendar contract rejects unsafe units and fractional offsets',()=>{
 assert.throws(()=>periodComparisonSQL('incidents','created_date',[{unit:'month',offset:1.5}]));
 assert.throws(()=>periodComparisonSQL('incidents','created_date',[{unit:'unsafe' as 'day',offset:0}]));
});
test('calendar grammar handles relative units and excludes rolling or distinct measures',async()=>{
 const {calendarPeriods}=await import('../backend/calendar.js');assert.deepEqual(calendarPeriods('Compare records this quarter and previous quarter'),[{unit:'quarter',offset:0},{unit:'quarter',offset:-1}]);assert.deepEqual(calendarPeriods('Count distinct servers this month'),[]);assert.deepEqual(calendarPeriods('Count records in last 30 days'),[]);
});
