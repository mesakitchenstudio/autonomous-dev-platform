import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStatus } from '../../src/jobs/types.js';
import { CLAIM_CANDIDATE_SQL, openClient, pgDurable, recordEvidence, truncateAppTables } from './harness.js';

test('FOR UPDATE SKIP LOCKED: Worker B cannot claim Job 1 while Worker A holds the row lock', async () => {
  const { adapter, store, queue } = await pgDurable();
  const clientA = await openClient();
  const clientB = await openClient();
  try {
    await truncateAppTables(adapter);
    await migrateIfNeeded(adapter);

    const projectA = await store.create({ idea: 'lock project A', demo: true });
    const projectB = await store.create({ idea: 'lock project B', demo: true });
    const job1 = await queue.enqueue(projectA);
    const job2 = await queue.enqueue(projectB);
    assert.ok(job1.id !== job2.id);

    await clientA.query('BEGIN');
    const locked = await clientA.query(CLAIM_CANDIDATE_SQL);
    assert.equal(locked.rows.length, 1);
    const lockedId = locked.rows[0].id;
    assert.ok([job1.id, job2.id].includes(lockedId));
    const otherId = lockedId === job1.id ? job2.id : job1.id;

    await clientB.query('BEGIN');
    const skipped = await clientB.query(CLAIM_CANDIDATE_SQL);
    assert.equal(skipped.rows.length, 1, 'Worker B must still be able to claim another eligible job');
    assert.notEqual(skipped.rows[0].id, lockedId, 'Worker B must not claim the row locked by Worker A');
    assert.equal(skipped.rows[0].id, otherId);

    const workerA = 'pg-lock-worker-a';
    const workerB = 'pg-lock-worker-b';
    await clientB.query(`UPDATE jobs SET
      status = 'RUNNING', locked_by = $2, lease_expires_at = NOW() + INTERVAL '5 minutes',
      heartbeat_at = NOW(), started_at = NOW(), attempts = attempts + 1
      WHERE id = $1`, [skipped.rows[0].id, workerB]);
    await clientB.query('COMMIT');

    const mid = await adapter.query('SELECT id, status, locked_by FROM jobs WHERE id = $1', [lockedId]);
    assert.equal(mid.rows[0].status, JobStatus.QUEUED);
    assert.equal(mid.rows[0].locked_by, null);

    await clientA.query(`UPDATE jobs SET
      status = 'RUNNING', locked_by = $2, lease_expires_at = NOW() + INTERVAL '5 minutes',
      heartbeat_at = NOW(), started_at = NOW(), attempts = attempts + 1
      WHERE id = $1`, [lockedId, workerA]);
    await clientA.query('COMMIT');

    const owned = await adapter.query('SELECT id, status, locked_by FROM jobs ORDER BY created_at');
    const byId = Object.fromEntries(owned.rows.map(row => [row.id, row]));
    assert.equal(byId[lockedId].status, JobStatus.RUNNING);
    assert.equal(byId[lockedId].locked_by, workerA);
    assert.equal(byId[otherId].status, JobStatus.RUNNING);
    assert.equal(byId[otherId].locked_by, workerB);

    await recordEvidence({
      skipLocked: {
        job1: lockedId,
        job2: otherId,
        workerA,
        workerB,
        whileAHeldLock: { claimedByB: skipped.rows[0].id, job1StillQueued: true },
        afterACommit: {
          [lockedId]: { status: byId[lockedId].status, lockedBy: byId[lockedId].locked_by },
          [otherId]: { status: byId[otherId].status, lockedBy: byId[otherId].locked_by }
        }
      }
    });
  } finally {
    try { await clientA.query('ROLLBACK'); } catch {}
    try { await clientB.query('ROLLBACK'); } catch {}
    await clientA.end().catch(() => {});
    await clientB.end().catch(() => {});
    await adapter.close();
  }
});

async function migrateIfNeeded(adapter) {
  const { migrate } = await import('../../src/db/migrate.js');
  await migrate(adapter);
}
