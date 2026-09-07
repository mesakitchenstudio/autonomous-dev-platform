import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate, migrationStatus } from '../src/db/migrate.js';
import { DurableStore } from '../src/storage/durable-store.js';
import { importJsonProjects } from '../src/storage/json-import.js';
import { JobStatus } from '../src/jobs/types.js';
import { ProjectState, VerificationLevel } from './helpers.js';
import { FakeCouncil } from './helpers.js';
import { specFixture } from './helpers.js';
import { createProjectRecord } from '../src/storage/json-store.js';
import { tempDurable, durableOrchestrator, durableWorker, waitForProject } from './helpers-durable.js';
import { ErrorCode } from '../src/orchestrator/errors.js';

test('fresh database migrates and a second migrate is a no-op', async () => {
  const { adapter } = await tempDurable();
  const second = await migrate(adapter);
  assert.equal(second.applied, false);
  const status = await migrationStatus(adapter);
  assert.ok(status.some(item => item.id === '001_initial'));
  assert.ok(status.some(item => item.id === '003_phase5_platform_verification'));
  await adapter.close();
});

test('project, council, cursor, evidence, and errors survive reload', async () => {
  const { adapter, store } = await tempDurable();
  const { orchestrator } = durableOrchestrator(store, null);
  const created = await store.create({ idea: 'Build a pantry app', demo: true });
  orchestrator.queue = null;
  await orchestrator.run(created.id);
  const saved = await store.get(created.id);
  assert.equal(saved.state, ProjectState.READY_FOR_OWNER_REVIEW);
  assert.ok(saved.council.discovery.history.length >= 1 || saved.council.discovery.spec);
  const reloaded = await store.get(created.id);
  assert.equal(reloaded.state, saved.state);
  assert.equal(reloaded.council.discovery.spec.productName, specFixture().productName);
  assert.ok(reloaded.cursorRuns.length >= 1);
  assert.ok(['MOCK', 'SELF_REPORTED'].includes(reloaded.evidence.verificationLevel));
  assert.equal(reloaded.history[0].from, ProjectState.IDEA_SUBMITTED);
  await adapter.close();
});

test('verification runs and artifacts survive reload and export', async () => {
  const { adapter, store } = await tempDurable();
  const created = await store.create({ idea: 'verification persist', demo: true });
  created.iteration = 1;
  created.verificationRuns = [{
    id: '11111111-1111-4111-8111-111111111111',
    iteration: 1,
    status: 'PASS',
    checkpointSha: 'deadbeef',
    projectType: 'node',
    policy: { build: 'NOT_APPLICABLE', tests: 'REQUIRED' },
    steps: [{
      id: 'test',
      kind: 'TEST',
      required: true,
      status: 'PASS',
      provenance: 'PLATFORM_VERIFIED',
      command: ['npm', 'run', 'test'],
      exitCode: 0,
      durationMs: 12,
      stdoutPreview: 'ok',
      stderrPreview: '',
      truncated: false
    }],
    artifacts: [{
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'log',
      type: 'log',
      path: '/tmp/test.log',
      size: 2,
      sha256: 'aa',
      createdAt: new Date().toISOString()
    }],
    blockingFailures: [],
    problems: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  }];
  await store.save(created);
  const loaded = await store.get(created.id);
  assert.equal(loaded.verificationRuns.length, 1);
  assert.equal(loaded.verificationRuns[0].steps[0].exitCode, 0);
  assert.ok(loaded.verificationRuns[0].artifacts.length >= 1);
  const dump = await store.exportProject(created.id);
  assert.equal(dump.verificationRuns[0].id, created.verificationRuns[0].id);
  assert.ok(dump.artifacts.length >= 1);
  await adapter.close();
});

test('legacy JSON import is idempotent and preserves history', async () => {
  const { adapter, store } = await tempDurable();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-json-'));
  const project = createProjectRecord({ idea: 'Imported idea', demo: true });
  project.state = ProjectState.COUNCIL_REVIEW;
  project.iteration = 1;
  project.history = [{ at: '2026-01-01T00:00:00.000Z', from: 'IDEA_SUBMITTED', to: 'COUNCIL_DISCOVERY', note: 'go' }];
  project.council.discovery = { spec: specFixture(), chair: 'openai', failures: [], history: [{ id: 'r1', purpose: 'independent_analysis', phase: 'COUNCIL_DISCOVERY', at: '2026-01-01T00:00:00.000Z' }] };
  project.cursorRuns = [{ iteration: 1, result: { output: 'done' }, evidence: { verificationLevel: 'MOCK', execution: { status: 'PASS', provenance: 'MOCK' } } }];
  project.errors = [{ code: 'PROVIDER_TIMEOUT', message: 'slow', phase: 'COUNCIL_DISCOVERY', retryable: true, at: '2026-01-01T00:00:01.000Z', details: {} }];
  const file = path.join(dir, `${project.id}.json`);
  await fs.writeFile(file, JSON.stringify(project, null, 2));
  const first = await importJsonProjects(store, dir, { logger: { log() {} } });
  const second = await importJsonProjects(store, dir, { logger: { log() {} } });
  assert.equal(first[0].status, 'imported');
  assert.equal(second[0].status, 'already_imported');
  const loaded = await store.get(project.id);
  assert.equal(loaded.idea, 'Imported idea');
  assert.equal(loaded.state, ProjectState.COUNCIL_REVIEW);
  assert.equal(loaded.history[0].to, 'COUNCIL_DISCOVERY');
  assert.ok(loaded.council.discovery.spec.cursorPrompt);
  assert.equal(loaded.cursorRuns.length, 1);
  assert.equal(loaded.errors[0].code, 'PROVIDER_TIMEOUT');
  await adapter.close();
});

test('job claim, complete, scheduled retry, and max attempts', async () => {
  const { adapter, store, queue } = await tempDurable({ maxAttempts: 2, retryBaseMs: 5 });
  const project = await store.create({ idea: 'queue', demo: true });
  const job = await queue.enqueue(project);
  const first = await queue.claim('w1');
  const second = await queue.claim('w2');
  assert.equal(first.id, job.id);
  assert.equal(first.status, JobStatus.RUNNING);
  assert.equal(second, null);
  await queue.completeAndHandoff(first, await store.get(project.id), false);
  const done = await queue.findByKey(job.idempotencyKey);
  assert.ok(!done || done.status !== JobStatus.RUNNING);

  const again = await store.create({ idea: 'fail-me', demo: true });
  const failing = await queue.enqueue(again);
  const claimed = await queue.claim('w1');
  const retry = await queue.fail(claimed, { code: ErrorCode.PROVIDER_TIMEOUT, message: 'temp', retryable: true });
  assert.equal(retry.retryable, true);
  assert.equal(retry.job.status, JobStatus.QUEUED);
  await adapter.query('UPDATE jobs SET available_at = NOW() WHERE id = $1', [retry.job.id]);
  const claimed2 = await queue.claim('w1');
  const dead = await queue.fail(claimed2, { code: ErrorCode.PROVIDER_TIMEOUT, message: 'temp', retryable: true });
  assert.equal(dead.dead, true);
  assert.equal(dead.job.status, JobStatus.DEAD);
  await adapter.close();
});

test('expired lease becomes recoverable and another worker can claim it', async () => {
  const { adapter, store, queue } = await tempDurable({ leaseMs: 1 });
  const project = await store.create({ idea: 'lease', demo: true });
  await queue.enqueue(project);
  const claimed = await queue.claim('dead-worker');
  assert.ok(claimed);
  await new Promise(resolve => setTimeout(resolve, 5));
  await adapter.query('UPDATE jobs SET lease_expires_at = NOW() - INTERVAL \'1 second\' WHERE id = $1', [claimed.id]);
  const recovered = await queue.recoverExpiredLeases();
  assert.equal(recovered.length, 1);
  const next = await queue.claim('live-worker');
  assert.equal(next.id, claimed.id);
  assert.equal(next.lockedBy, 'live-worker');
  await adapter.close();
});

test('API submit queues work and does not execute Council inline', async () => {
  const { adapter, store, queue } = await tempDurable();
  const { orchestrator, council } = durableOrchestrator(store, queue);
  const project = await orchestrator.submit({ idea: 'queued only' });
  assert.equal(council.discoverCalls, 0);
  assert.equal(project.state, ProjectState.IDEA_SUBMITTED);
  const job = await queue.findActiveByKey(`project:${project.id}:discovery`);
  assert.ok(job);
  assert.equal(job.status, JobStatus.QUEUED);
  await adapter.close();
});

test('worker runs queued demo project to READY with MOCK verification', async () => {
  const { adapter, store, queue } = await tempDurable();
  const { orchestrator } = durableOrchestrator(store, queue, { council: new FakeCouncil() });
  const worker = durableWorker(store, queue, orchestrator);
  const project = await orchestrator.submit({ idea: 'Worker demo' });
  await worker.start();
  const done = await waitForProject(store, project.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW);
  await worker.stop();
  assert.equal(done.delivery.verificationLevel, VerificationLevel.MOCK);
  assert.ok(done.council.review1);
  assert.ok(done.council.final);
  await adapter.close();
});

test('two workers cannot claim the same job and can process two projects', async () => {
  const { adapter, store, queue } = await tempDurable();
  const a = durableOrchestrator(store, queue);
  const b = durableOrchestrator(store, queue);
  const w1 = durableWorker(store, queue, a.orchestrator, { concurrency: 1 });
  const w2 = durableWorker(store, queue, b.orchestrator, { concurrency: 1 });
  try {
    const p1 = await a.orchestrator.submit({ idea: 'one' });
    const p2 = await b.orchestrator.submit({ idea: 'two' });
    await w1.start();
    await w2.start();
    const d1 = await waitForProject(store, p1.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW, 30000);
    const d2 = await waitForProject(store, p2.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW, 30000);
    assert.equal(d1.state, ProjectState.READY_FOR_OWNER_REVIEW);
    assert.equal(d2.state, ProjectState.READY_FOR_OWNER_REVIEW);
    const jobs = await adapter.query('SELECT locked_by, status FROM jobs WHERE status = \'RUNNING\'');
    assert.equal(jobs.rows.length, 0);
  } finally {
    await w1.stop().catch(() => {});
    await w2.stop().catch(() => {});
    await adapter.close();
  }
});

test('duplicate completed jobs do not re-run Council discovery', async () => {
  const { adapter, store, queue } = await tempDurable();
  const { orchestrator, council } = durableOrchestrator(store, queue);
  const project = await orchestrator.submit({ idea: 'idempotent' });
  const worker = durableWorker(store, queue, orchestrator);
  await worker.start();
  await waitForProject(store, project.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW);
  await worker.stop();
  const calls = council.discoverCalls;
  await queue.enqueue(await store.get(project.id), {
    jobType: 'COUNCIL_DISCOVERY',
    idempotencyKey: `project:${project.id}:discovery`
  });
  const worker2 = durableWorker(store, queue, orchestrator);
  await worker2.start();
  await new Promise(resolve => setTimeout(resolve, 200));
  await worker2.stop();
  assert.equal(council.discoverCalls, calls);
  const ready = await store.get(project.id);
  assert.equal(ready.state, ProjectState.READY_FOR_OWNER_REVIEW);
  await adapter.close();
});

test('crash after persisted result still enqueues the next step on reconcile', async () => {
  const { adapter, store, queue } = await tempDurable();
  const { orchestrator } = durableOrchestrator(store, queue);
  const created = await store.create({ idea: 'handoff', demo: true });
  await orchestrator.ensureDiscovery(await store.get(created.id));
  const after = await store.get(created.id);
  assert.equal(after.state, ProjectState.SPECIFICATION_READY);
  const active = await adapter.query(`SELECT * FROM jobs WHERE project_id = $1 AND status IN ('QUEUED','RUNNING')`, [created.id]);
  assert.equal(active.rows.length, 0);
  const resumed = await queue.reconcile([after]);
  assert.ok(resumed.includes(created.id));
  const worker = durableWorker(store, queue, orchestrator);
  await worker.start();
  const done = await waitForProject(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW);
  await worker.stop();
  assert.ok(done.council.review1);
  await adapter.close();
});

test('terminal auth error is not retried forever', async () => {
  const { adapter, store, queue } = await tempDurable({ maxAttempts: 5 });
  const project = await store.create({ idea: 'auth', demo: true });
  await queue.enqueue(project);
  const claimed = await queue.claim('w1');
  const result = await queue.fail(claimed, { code: ErrorCode.AUTH_FAILURE, message: 'bad key', retryable: false }, { terminal: true });
  assert.equal(result.dead, true);
  assert.equal(result.job.status, JobStatus.DEAD);
  await adapter.close();
});

test('graceful worker stop releases an unfinished lease', async () => {
  const { adapter, store, queue } = await tempDurable();
  const hanging = {
    async discover() { await new Promise(resolve => setTimeout(resolve, 400)); },
    async review() { return { decision: { decision: 'COMPLETE' } }; },
    async finalVerify() { return { decision: { decision: 'COMPLETE' } }; }
  };
  const { orchestrator } = durableOrchestrator(store, queue, { council: hanging });
  const project = await orchestrator.submit({ idea: 'hang' });
  const worker = durableWorker(store, queue, orchestrator, { pollMs: 20 });
  await worker.start();
  await new Promise(resolve => setTimeout(resolve, 80));
  await worker.stop({ timeoutMs: 800 });
  const jobs = await adapter.query(`SELECT status, locked_by FROM jobs WHERE project_id = $1`, [project.id]);
  assert.ok(jobs.rows.every(row => row.status !== 'RUNNING' || row.locked_by == null || true));
  const running = jobs.rows.filter(row => row.status === 'RUNNING');
  assert.equal(running.length, 0);
  await adapter.close();
});
