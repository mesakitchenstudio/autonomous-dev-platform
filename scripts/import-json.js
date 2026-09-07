import { loadDotEnv } from '../src/util/env.js';
import { createRuntime } from '../src/app/runtime.js';
import { importJsonProjects } from '../src/storage/json-import.js';

loadDotEnv();
const runtime = await createRuntime({ role: 'import', demo: !process.env.DATABASE_URL });
const results = await importJsonProjects(runtime.store, runtime.jsonDir);
console.log(JSON.stringify(results, null, 2));
console.log('Original JSON files were left in place. Archive them manually after you confirm the import.');
await runtime.close();
