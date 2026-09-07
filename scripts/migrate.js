import { loadDotEnv } from '../src/util/env.js';
import { createRuntime } from '../src/app/runtime.js';

loadDotEnv();
const runtime = await createRuntime({ role: 'migrate', demo: !process.env.DATABASE_URL });
console.log(`Migrations verified on ${runtime.engine}.`);
await runtime.close();
