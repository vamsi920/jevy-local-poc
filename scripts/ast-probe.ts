import {Database,sqlLiteral} from '../backend/db.js';
const db=await Database.open();
for(const sql of ["SELECT CAST('2026-10-07' AS DATE) - INTERVAL '30 days'", "SELECT date_sub(DATE '2026-10-07',INTERVAL '30 days')"]){const rows=(await db.query(`SELECT json_serialize_sql(${sqlLiteral(sql)}) ast`)).rows;console.log(JSON.stringify(JSON.parse(String(rows[0].ast)).statements[0].node.select_list[0],null,2));}db.close();
