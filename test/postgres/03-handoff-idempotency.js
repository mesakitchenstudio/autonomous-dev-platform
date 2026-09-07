import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStatus, JobType } from '../../src/jobs/types.js';
import { ProjectState, VerificationLevel } from '../helpers.js';
import { FakeCouncil } from '../helpers.js';
import { pgDurable, pgOrchestrator, pgWorker, recordEvidence, truncateAppTables, waitForProject } from './harness.js';

test('PostgreSQL constraints reject duplicate active jobs', async () => {
  const { adapter, store, queue } = await pgDurable();
  try {
    await truncateAppTables(adapter);
    const project = await store.create({ idea: 'constraint project', demo: true });
    const first = await queue.enqueue(project);
    assert.ok(first);
    await assert.rejects(async () => {
      await adapter.query(`INSERT INTO jobs (
        id, project_id, job_type, phase, iteration, idempotency_key, payload, status
      ) VALUES (gen_random_uuid(), $1, 'COUNCIL_DISCOVERY', 'COUNCIL_DISCOVERY', 0, $2, '{}'::jsonb, 'QUEUED')`, [
        project.id, `project:${project.id}:other-active`
      ]);
    }, /jobs_one_active_per_project|duplicate key/i);

    await assert.rejects(async () => {
      await adapter.query(`INSERT INTO jobs (
        id, project_id, job_type, phase, iteration, idempotency_key, payload, status
      ) VALUES (gen_random_uuid(), $1, 'COUNCIL_DISCOVERY', 'COUNCIL_DISCOVERY', 0, $2, '{}'::jsonb, 'QUEUED')`, [
        project.id, first.idempotencyKey
      ]);
    }, /jobs_active_idempotency|jobs_one_active_per_project|duplicate key/i);

    const other = await store.create({ idea: 'constraint other', demo: true });
    await assert.rejects(async () => {
      await adapter.query(`INSERT INTO jobs (
        id, project_id, job_type, phase, iteration, idempotency_key, payload, status
      ) VALUES (gen_random_uuid(), $1, 'COUNCIL_DISCOVERY', 'COUNCIL_DISCOVERY', 0, $2, '{}'::jsonb, 'QUEUED')`, [
        other.id, first.idempotencyKey
      ]);
    }, /jobs_active_idempotency|duplicate key/i);

    await recordEvidence({ constraints: { oneActivePerProject: 'rejected', activeIdempotency: 'rejected' } });
  } finally {
    await adapter.close();
  }
});

test('completeAndHandoff rolls back so a failed next-job insert cannot leave a completed-without-next state', async () => {
  const { adapter, store, queue } = await pgDurable();
  try {
    await truncateAppTables(adapter);
    const { orchestrator } = pgOrchestrator(store, queue);
    const created = await store.create({ idea: 'handoff rollback', demo: true, projectPath: '/repo' });
    await orchestrator.ensureDiscovery(await store.get(created.id));
    const ready = await store.get(created.id);
    assert.equal(ready.state, ProjectState.SPECIFICATION_READY);
    const job = await queue.enqueue(ready);
    const claimed = await queue.claim('handoff-worker');
    assert.equal(claimed.id, job.id);

    const original = adapter.transact.bind(adapter);
    adapter.transact = async fn => original(async tx => fn({
      query: async (text, params = []) => {
        const result = await tx.query(text, params);
        if (/INSERT INTO jobs/i.test(text)) throw new Error('injected handoff failure');
        return result;
      }
    }));

    await assert.rejects(() => queue.completeAndHandoff(claimed, ready), /injected handoff failure/);
    adapter.transact = original;

    const afterFail = await adapter.query('SELECT status, locked_by FROM jobs WHERE id = $1', [claimed.id]);
    assert.equal(afterFail.rows[0].status, JobStatus.RUNNING, 'UPDATE must roll back with the failed INSERT');
    const nextJobs = await adapter.query(
      `SELECT * FROM jobs WHERE project_id = $1 AND id <> $2`,
      [created.id, claimed.id]
    );
    assert.equal(nextJobs.rows.length, 0, 'next job must not exist after rolled-back handoff');

    const completed = await queue.completeAndHandoff(claimed, ready);
    assert.ok(completed.next);
    assert.equal(completed.next.jobType, JobType.CURSOR_EXECUTION);
    const originalJob = await adapter.query('SELECT status FROM jobs WHERE id = $1', [claimed.id]);
    assert.equal(originalJob.rows[0].status, JobStatus.COMPLETED);

    await recordEvidence({
      atomicHandoff: {
        injectedFailureRolledBack: true,
        jobId: claimed.id,
        nextJobId: completed.next.id
      }
    });
  } finally {
    await adapter.close();
  }
});

test('reconcile repairs completed-state-without-next-job and rejects next-job-without-completed-predecessor', async () => {
  const { adapter, store, queue } = await pgDurable();
  try {
    await truncateAppTables(adapter);
    const { orchestrator } = pgOrchestrator(store, queue);
    const created = await store.create({ idea: 'handoff reconcile', demo: true, projectPath: '/repo' });
    await orchestrator.ensureDiscovery(await store.get(created.id));
    const ready = await store.get(created.id);
    assert.equal(ready.state, ProjectState.SPECIFICATION_READY);

    const dangling = await adapter.query(
      `SELECT id FROM jobs WHERE project_id = $1 AND status IN ('QUEUED','RUNNING')`,
      [created.id]
    );
    assert.equal(dangling.rows.length, 0);
    const resumed = await queue.reconcile([ready]);
    assert.ok(resumed.includes(created.id));
    const planned = await queue.findActiveByKey(`project:${created.id}:cursor:1`);
    assert.ok(planned);

    const claimed = await queue.claim('state-b-worker');
    await assert.rejects(async () => {
      await adapter.query(`INSERT INTO jobs (
        id, project_id, job_type, phase, iteration, idempotency_key, payload, status
      ) VALUES (gen_random_uuid(), $1, 'COUNCIL_REVIEW', 'COUNCIL_REVIEW', 1, $2, '{}'::jsonb, 'QUEUED')`, [
        created.id, `project:${created.id}:review:1`
      ]);
    }, /jobs_one_active_per_project|duplicate key/i);

    const worker = pgWorker(store, queue, orchestrator);
    await worker.start();
    const done = await waitForProject(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW);
    await worker.stop();
    assert.ok(done.council.review1);
    assert.ok(done.council.final);
    await recordEvidence({
      handoffReconcile: {
        projectId: created.id,
        repairedMissingNextJob: true,
        rejectedNextWhilePreviousActive: true
      }
    });
  } finally {
    await adapter.close();
  }
});

test('idempotency: duplicate discovery/cursor/review/final do not duplicate durable effects', async () => {
  const { adapter, store, queue } = await pgDurable();
  const council = new FakeCouncil();
  try {
    await truncateAppTables(adapter);
    const { orchestrator, cursor } = pgOrchestrator(store, queue, { council });
    const project = await orchestrator.submit({ idea: 'pg idempotent' });
    const worker = pgWorker(store, queue, orchestrator);
    await worker.start();
    await waitForProject(store, project.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW);
    await worker.stop();

    const ready = await store.get(project.id);
    const discoverCalls = council.discoverCalls;
    const reviewCalls = council.reviewCalls;
    const finalCalls = council.finalCalls;
    const cursorRuns = ready.cursorRuns.length;
    const readyTransitions = ready.history.filter(item => item.to === ProjectState.READY_FOR_OWNER_REVIEW).length;

    const replay = async extras => {
      await queue.enqueue(await store.get(project.id), extras);
      const replayWorker = pgWorker(store, queue, orchestrator);
      await replayWorker.start();
      await new Promise(resolve => setTimeout(resolve, 250));
      await replayWorker.stop();
    };
    await replay({
      jobType: JobType.COUNCIL_DISCOVERY,
      phase: JobType.COUNCIL_DISCOVERY,
      idempotencyKey: `project:${project.id}:discovery`
    });
    await replay({
      jobType: JobType.CURSOR_EXECUTION,
      phase: JobType.CURSOR_EXECUTION,
      iteration: 1,
      idempotencyKey: `project:${project.id}:cursor:1`
    });
    await replay({
      jobType: JobType.PLATFORM_VERIFICATION,
      phase: JobType.PLATFORM_VERIFICATION,
      iteration: 1,
      idempotencyKey: `project:${project.id}:verification:1:none`
    });
    await replay({
      jobType: JobType.COUNCIL_REVIEW,
      phase: JobType.COUNCIL_REVIEW,
      iteration: 1,
      idempotencyKey: `project:${project.id}:review:1`
    });
    await replay({
      jobType: JobType.FINAL_VERIFICATION,
      phase: JobType.FINAL_VERIFICATION,
      idempotencyKey: `project:${project.id}:final:${cursorRuns}`
    });

    const after = await store.get(project.id);
    assert.equal(after.state, ProjectState.READY_FOR_OWNER_REVIEW);
    assert.equal(council.discoverCalls, discoverCalls);
    assert.equal(council.reviewCalls, reviewCalls);
    assert.equal(council.finalCalls, finalCalls);
    assert.equal(after.cursorRuns.length, cursorRuns);
    assert.equal(after.history.filter(item => item.to === ProjectState.READY_FOR_OWNER_REVIEW).length, readyTransitions);
    assert.equal(cursor.runs, cursorRuns);

    const discoveryOps = await adapter.query(
      `SELECT COUNT(*)::int AS count FROM operations WHERE project_id = $1 AND type = 'council_discovery' AND status = 'completed'`,
      [project.id]
    );
    assert.equal(discoveryOps.rows[0].count, 1);
    const readyRows = await adapter.query(
      `SELECT COUNT(*)::int AS count FROM state_transitions WHERE project_id = $1 AND to_state = 'READY_FOR_OWNER_REVIEW'`,
      [project.id]
    );
    assert.equal(readyRows.rows[0].count, 1);

    await recordEvidence({
      idempotency: {
        projectId: project.id,
        discoverCalls: council.discoverCalls,
        reviewCalls: council.reviewCalls,
        finalCalls: council.finalCalls,
        cursorRuns: after.cursorRuns.length,
        readyTransitions: readyRows.rows[0].count
      }
    });
  } finally {
    await adapter.close();
  }
});

test('expired lease is reclaimed by another worker and workflow is not skipped', async () => {
  const { adapter, store, queue } = await pgDurable({ leaseMs: 250 });
  try {
    await truncateAppTables(adapter);
    const { orchestrator } = pgOrchestrator(store, queue);
    const project = await orchestrator.submit({ idea: 'pg lease recovery' });
    const first = await queue.claim('dead-lease-worker');
    assert.ok(first);
    await adapter.query(`UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id]);
    const recovered = await queue.recoverExpiredLeases();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, first.id);
    await store.appendEvent(project.id, 'recovery.performed', { jobId: first.id, reason: 'lease_expired' });

    const next = await queue.claim('live-lease-worker');
    assert.equal(next.id, first.id);
    assert.equal(next.lockedBy, 'live-lease-worker');
    assert.ok(next.attempts >= 2);

    const worker = pgWorker(store, queue, orchestrator);
    await worker.start();
    const done = await waitForProject(store, project.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW);
    await worker.stop();
    assert.equal(done.delivery?.verificationLevel || done.verificationLevel, VerificationLevel.MOCK);
    assert.ok(done.council.review1, 'Council review must not be skipped after lease recovery');
    assert.ok(done.council.final, 'Final verification must not be skipped after lease recovery');
    const readyCount = done.history.filter(item => item.to === ProjectState.READY_FOR_OWNER_REVIEW).length;
    assert.equal(readyCount, 1);
    const events = await adapter.query(
      `SELECT type FROM events WHERE project_id = $1 AND type = 'recovery.performed'`,
      [project.id]
    );
    assert.ok(events.rows.length >= 1);
    await recordEvidence({
      leaseRecovery: {
        jobId: first.id,
        staleWorker: 'dead-lease-worker',
        reclaimWorker: 'live-lease-worker',
        attempts: next.attempts,
        recoveryEvents: events.rows.length
      }
    });
  } finally {
    await adapter.close();
  }
});
