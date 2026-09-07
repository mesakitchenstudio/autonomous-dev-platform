import { loadDotEnv } from '../src/util/env.js';
import { createRuntime } from '../src/app/runtime.js';

loadDotEnv();
const id = process.argv[2];
if (!id) {
  console.error('Usage: node scripts/export-project.js <project-id>');
  process.exit(1);
}
const runtime = await createRuntime({ role: 'export', demo: !process.env.DATABASE_URL });
const dump = await runtime.store.exportProject(id);
console.log(JSON.stringify(dump, null, 2));
await runtime.close();
