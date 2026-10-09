// Run a read-only SQL query against the configured DuckDB: npx tsx scripts/sql.ts "SELECT ..."
import {Database} from '../backend/db.js';
const db=await Database.open();console.log(JSON.stringify((await db.query(process.argv[2],50)).rows));db.close();
