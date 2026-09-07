import { createPGlite, PGliteAdapter } from '../src/db/adapter.js';
import { migrate } from '../src/db/migrate.js';
import { DurableStore } from '../src/storage/durable-store.js';
import { JobQueue } from '../src/jobs/queue.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { Worker } from '../src/worker/worker.js';
import { FakeCouncil, FakeCursor, FakeWorkspace } from './helpers.js';

export async function tempDurable(options = {}) {
  const adapter = new PGliteAdapter(await createPGlite());
  await migrate(adapter);
  const store = new DurableStore(adapter);
  const queue = new JobQueue(adapter, {
    leaseMs: options.leaseMs ?? 5000,
    retryBaseMs: options.retryBaseMs ?? 10,
    retryMaxMs: options.retryMaxMs ?? 20,
    maxAttempts: options.maxAttempts ?? 8
  });
  return { adapter, store, queue };
}

export function durableOrchestrator(store, queue, extras = {}) {
  const council = extras.council || new FakeCouncil();
  const cursor = extras.cursor || new FakeCursor();
  const orchestrator = new Orchestrator({
    store,
    queue,
    council,
    cursor,
    workspace: extras.workspace || new FakeWorkspace(),
    demo: extras.demo !== false,
    maxIterations: extras.maxIterations || 12,
    cursorTimeoutMs: extras.cursorTimeoutMs || 2000
  });
  return { orchestrator, council, cursor };
}

export function durableWorker(store, queue, orchestrator, extras = {}) {
  return new Worker({
    store,
    queue,
    orchestrator,
    pollMs: extras.pollMs ?? 30,
    heartbeatMs: extras.heartbeatMs ?? 50,
    concurrency: extras.concurrency ?? 1
  });
}

export async function waitForProject(store, id, predicate, timeoutMs = 25000) {
  const start = Date.now();
  let project;
  while (Date.now() - start < timeoutMs) {
    project = await store.get(id);
    if (predicate(project)) return project;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for project (state=${project?.state})`);
}
