import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JobType } from '../../src/jobs/types.js';
import { FakeCursor, ProjectState } from '../helpers.js';
import { pgDurable, pgOrchestrator, pgWorker, recordEvidence, truncateAppTables } from './harness.js';

test('database outage prevents Cursor from starting', { timeout: 30000 }, async () => {
  const { adapter, store, queue } = await pgDurable();
  const cursor = new FakeCursor();
  try {
    await truncateAppTables(adapter);
    const { orchestrator } = pgOrchestrator(store, queue, { cursor });
    const created = await store.create({ idea: 'outage before cursor', demo: true, projectPath: '/repo' });
    await orchestrator.ensureDiscovery(await store.get(created.id));
    const ready = await store.get(created.id);
    assert.equal(ready.state, ProjectState.SPECIFICATION_READY);
    const job = await queue.enqueue(ready);
    const claimed = await queue.claim('outage-worker');
    assert.equal(claimed.jobType, JobType.CURSOR_EXECUTION);
    assert.equal(claimed.id, job.id);

    const runsBefore = cursor.runs;
    const owned = process.env.ADP_TEST_PG_OWNED === '1';
    adapter.pool.on('error', () => {});
    try { await adapter.pool.end(); } catch {}
    if (owned && process.env.ADP_TEST_PG_CTL && process.env.ADP_TEST_PG_DATA) {
      const stopped = spawnSync(process.env.ADP_TEST_PG_CTL, [
        'stop', '-D', process.env.ADP_TEST_PG_DATA, '-m', 'fast', '-w'
      ], { encoding: 'utf8' });
      assert.equal(stopped.status, 0, `pg_ctl stop failed: ${stopped.stderr || stopped.stdout}`);
    }

    const worker = pgWorker(store, queue, orchestrator);
    await Promise.race([
      worker.executeClaimed(claimed).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    assert.equal(cursor.runs, runsBefore, 'Cursor must not start when persistence is unavailable');

    await recordEvidence({
      databaseOutage: {
        jobId: claimed.id,
        cursorRuns: cursor.runs,
        stoppedOwnedCluster: Boolean(owned && process.env.ADP_TEST_PG_CTL),
        cursorStarted: cursor.runs > runsBefore
      }
    });
  } finally {
    try { await adapter.close(); } catch {}
  }
});
