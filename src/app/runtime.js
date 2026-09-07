import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boolEnv, intEnv } from '../util/env.js';
import { createPgPool, createPGlite, PgAdapter, PGliteAdapter, redactDatabaseUrl } from '../db/adapter.js';
import { migrate } from '../db/migrate.js';
import { DurableStore } from '../storage/durable-store.js';
import { JsonStore } from '../storage/json-store.js';
import { JobQueue } from '../jobs/queue.js';
import { createProviders } from '../providers/index.js';
import { Council } from '../council/council.js';
import { resolveChairProvider } from '../providers/config.js';
import { createCursorClient } from '../cursor/index.js';
import { WorkspaceManager } from '../storage/workspace.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function createRuntime({ role = 'api', demo = boolEnv('DEMO_MODE', false) } = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !demo) {
    throw new Error('DATABASE_URL is required outside DEMO_MODE. Start local Postgres or set DEMO_MODE=true.');
  }

  let adapter = null;
  let store;
  let queue = null;
  let engine = 'json-legacy';

  if (databaseUrl) {
    adapter = new PgAdapter(createPgPool(databaseUrl));
    await adapter.ready().catch(error => {
      throw new Error(`Database is unavailable (${redactDatabaseUrl(databaseUrl) || 'DATABASE_URL'}): ${error.message}`);
    });
    await migrate(adapter);
    store = new DurableStore(adapter);
    queue = new JobQueue(adapter);
    engine = 'postgres';
  } else {
    const dataDir = process.env.PGLITE_DATA_DIR || path.join(root, '.pglite', demo ? 'demo' : 'data');
    adapter = new PGliteAdapter(await createPGlite(dataDir));
    await migrate(adapter);
    store = new DurableStore(adapter);
    queue = new JobQueue(adapter);
    engine = 'pglite';
  }

  const providers = createProviders();
  const council = new Council(providers, process.env.CHAIR_PROVIDER || 'openai', {
    chair: resolveChairProvider(providers, process.env.CHAIR_PROVIDER || 'openai')
  });
  const cursor = createCursorClient();
  const workspace = new WorkspaceManager(process.env.WORKSPACE_DIR || path.join(root, 'workspaces'));
  const orchestrator = new Orchestrator({
    store,
    council,
    cursor,
    workspace,
    maxIterations: intEnv('MAX_IMPLEMENTATION_ITERATIONS', 12),
    demo,
    queue
  });

  return {
    role,
    demo,
    engine,
    adapter,
    store,
    queue,
    orchestrator,
    databaseUrl: redactDatabaseUrl(databaseUrl),
    jsonDir: process.env.DATA_DIR || path.join(root, 'data'),
    async close() {
      await adapter.close();
    }
  };
}

export function legacyJsonStore() {
  return new JsonStore(process.env.DATA_DIR || path.join(root, 'data'));
}
