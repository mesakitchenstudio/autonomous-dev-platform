import test from 'node:test';
import assert from 'node:assert/strict';
import { JobType } from '../../src/jobs/types.js';
import { FakeCursor, ProjectState } from '../helpers.js';
import { SecretClass } from '../../src/security/kinds.js';
import {
  assertDatabaseReachable,
  closeAdapter,
  pgDurable,
  pgOrchestrator,
  pgWorker,
  recordEvidence,
  runBounded,
  truncateAppTables
} from './harness.js';

async function prepareCursorJob(store, queue, orchestrator, idea) {
  const created = await store.create({ idea, demo: true, projectPath: '/repo' });
  await orchestrator.ensureDiscovery(await store.get(created.id));
  const ready = await store.get(created.id);
  assert.equal(ready.state, ProjectState.SPECIFICATION_READY);
  const job = await queue.enqueue(ready);
  const claimed = await queue.claim('outage-worker');
  assert.equal(claimed.jobType, JobType.CURSOR_EXECUTION);
  assert.equal(claimed.id, job.id);
  return { created, claimed };
}

test('database outage prevents Cursor from starting', { timeout: 30000 }, async () => {
  const { adapter, store, queue, url } = await pgDurable();
  const cursor = new FakeCursor();
  try {
    await truncateAppTables(adapter);
    const { orchestrator } = pgOrchestrator(store, queue, { cursor });
    const { claimed } = await prepareCursorJob(store, queue, orchestrator, 'outage before cursor');
    const runsBefore = cursor.runs;
    if (adapter.pool) adapter.pool.on('error', () => {});
    await adapter.pool.end();

    const worker = pgWorker(store, queue, orchestrator);
    const execution = worker.executeClaimed(claimed).catch(() => {});
    await Promise.race([
      execution,
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    assert.equal(cursor.runs, runsBefore, 'Cursor must not start when persistence is unavailable');
    await Promise.race([
      execution,
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);

    await assertDatabaseReachable(url);
    await recordEvidence({
      databaseOutage: {
        jobId: claimed.id,
        cursorRuns: cursor.runs,
        stoppedSharedCluster: false,
        cursorStarted: cursor.runs > runsBefore
      }
    });
  } finally {
    await closeAdapter(adapter);
  }
});

test('phase-8 writes then outage do not stop the shared suite cluster', { timeout: 30000 }, async () => {
  const predecessor = await pgDurable({ truncate: true });
  try {
    const created = await predecessor.store.create({
      idea: 'Phase 8 security persistence then outage',
      projectPath: '/repo',
      demo: true
    });
    created.securityPolicy = { profile: 'DEVELOPMENT', requiredSandboxMode: 'LOCAL_DEVELOPMENT_UNSAFE', aiEditable: false };
    created.secretReferences = [{
      secretRef: `project/${created.id}/runtime/API_TOKEN`,
      class: SecretClass.PROJECT_RUNTIME_SECRET
    }];
    await predecessor.store.save(created);
    await predecessor.store.exportProject(created.id);
  } finally {
    await closeAdapter(predecessor.adapter);
  }

  const { adapter, store, queue, url } = await pgDurable();
  const cursor = new FakeCursor();
  try {
    const { orchestrator } = pgOrchestrator(store, queue, { cursor });
    const { claimed } = await prepareCursorJob(store, queue, orchestrator, 'outage after phase-8 writes');
    const runsBefore = cursor.runs;
    if (adapter.pool) adapter.pool.on('error', () => {});
    await adapter.pool.end();

    const worker = pgWorker(store, queue, orchestrator);
    const execution = worker.executeClaimed(claimed).catch(() => {});
    await Promise.race([
      execution,
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    assert.equal(cursor.runs, runsBefore, 'Cursor must not start when persistence is unavailable');
    await Promise.race([
      execution,
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);

    await runBounded(assertDatabaseReachable(url), 5000, 'shared suite cluster after predecessor+outage');
    await recordEvidence({
      outageAfterPhase8: {
        jobId: claimed.id,
        sharedClusterSurvived: true,
        cursorStarted: cursor.runs > runsBefore
      }
    });
  } finally {
    await closeAdapter(adapter);
  }
});
