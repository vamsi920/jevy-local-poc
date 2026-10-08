import {Database} from '../backend/db.js';import {Catalog} from '../backend/catalog.js';
const db=await Database.open();const c=await new Catalog(db).build();console.log(c.schemaText(['servers','vulnerabilities','applications']));db.close();
