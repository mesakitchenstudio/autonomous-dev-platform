import { loadDotEnv } from '../src/util/env.js';
import { migrateFromUrl } from '../src/db/run-migrate.js';

loadDotEnv();
const result = await migrateFromUrl(process.env.DATABASE_URL);
console.log(`Migrations verified on ${result.engine} (${result.id}).`);
