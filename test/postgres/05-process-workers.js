import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectState, VerificationLevel } from '../helpers.js';
import {
  killProcess,
  pgDurable,
  recordEvidence,
  spawnPlatform,
  testDatabaseUrl,
  truncateAppTables,
  waitForHealth,
  waitForPredicate,
  waitForWorkerReady
} from './harness.js';

async function installClaimAudit(adapter) {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS job_claim_audit (
      id BIGSERIAL PRIMARY KEY,
      job_id UUID NOT NULL,
      locked_by TEXT,
      attempts INTEGER,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await adapter.query('TRUNCATE job_claim_audit');
  await adapter.query(`
    CREATE OR REPLACE FUNCTION adp_audit_job_claim() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'RUNNING' AND (
        TG_OP = 'INSERT'
        OR OLD.status IS DISTINCT FROM 'RUNNING'
        OR OLD.locked_by IS DISTINCT FROM NEW.locked_by
      ) THEN
        INSERT INTO job_claim_audit (job_id, locked_by, attempts)
        VALUES (NEW.id, NEW.locked_by, NEW.attempts);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  await adapter.query('DROP TRIGGER IF EXISTS trg_adp_audit_job_claim ON jobs');
  await adapter.query(`
    CREATE TRIGGER trg_adp_audit_job_claim
    AFTER INSERT OR UPDATE ON jobs
    FOR EACH ROW EXECUTE PROCEDURE adp_audit_job_claim()`);
}

function legalWorkflow(history) {
  const order = [
    'IDEA_SUBMITTED',
    'COUNCIL_DISCOVERY',
    'SPECIFICATION_READY',
    'PROJECT_PROVISIONING',
    'CURSOR_EXECUTING',
    'PLATFORM_VERIFICATION',
    'RUNTIME_VERIFICATION',
    'VISUAL_VERIFICATION',
    'COUNCIL_REVIEW',
    'FINAL_VERIFICATION',
    'READY_FOR_OWNER_REVIEW'
  ];
  const seen = [];
  for (const item of history) {
    seen.push(item.to);
  }
  const positions = seen.map(state => order.indexOf(state)).filter(idx => idx >= 0);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] < positions[i - 1] && seen[i] !== 'CURSOR_EXECUTING') {
      return false;
    }
  }
  return seen.includes('COUNCIL_REVIEW') && seen.includes('FINAL_VERIFICATION');
}

async function submitIdea(port, idea) {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OWNER_TOKEN_BOOTSTRAP || 'adp-test-owner-token'}` },
    body: JSON.stringify({ idea })
  });
  assert.equal(res.status, 202);
  return res.json();
}

async function getProject(port, id) {
  return fetch(`http://127.0.0.1:${port}/api/projects/${id}`, {
    headers: { authorization: `Bearer ${process.env.OWNER_TOKEN_BOOTSTRAP || 'adp-test-owner-token'}` }
  }).then(res => res.json());
}

test('two OS worker processes contend on PostgreSQL without duplicate claims', { timeout: 180000 }, async () => {
  const { adapter } = await pgDurable();
  const children = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-pg-workers-'));
  const port = 4500 + Math.floor(Math.random() * 200);
  const url = testDatabaseUrl();
  try {
    await truncateAppTables(adapter);
    await installClaimAudit(adapter);
    const extraEnv = { DATA_DIR: dir, WORKSPACE_DIR: path.join(dir, 'ws') };
    const api = spawnPlatform({ role: 'api', port, databaseUrl: url, extraEnv });
    children.push(api);
    await waitForHealth(port);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(res => res.json());
    assert.equal(health.engine, 'postgres');

    const workerA = spawnPlatform({ role: 'worker', port, databaseUrl: url, extraEnv });
    const workerB = spawnPlatform({ role: 'worker', port, databaseUrl: url, extraEnv });
    children.push(workerA, workerB);
    const workerIdA = await waitForWorkerReady(workerA);
    const workerIdB = await waitForWorkerReady(workerB);
    assert.notEqual(workerIdA, workerIdB);

    const created = [];
    for (let i = 0; i < 6; i++) {
      created.push(await submitIdea(port, `PostgreSQL two-process project ${i + 1}`));
    }
    assert.equal(created.length, 6);

    const snapshots = [];
    const concurrentProjects = new Set();
    const start = Date.now();
    while (Date.now() - start < 120000) {
      const running = await adapter.query(
        `SELECT id, project_id, locked_by, job_type FROM jobs WHERE status = 'RUNNING'`
      );
      snapshots.push({ at: Date.now(), rows: running.rows });
      const projectIds = new Set(running.rows.map(row => row.project_id));
      if (projectIds.size >= 2) {
        for (const id of projectIds) concurrentProjects.add(id);
      }
      const projects = await Promise.all(created.map(item => getProject(port, item.id)));
      if (projects.every(item => item.state === ProjectState.READY_FOR_OWNER_REVIEW || item.state === ProjectState.FAILED)) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }

    const finished = await Promise.all(created.map(item => getProject(port, item.id)));
    for (const project of finished) {
      assert.equal(project.state, ProjectState.READY_FOR_OWNER_REVIEW);
      assert.equal(project.delivery?.verificationLevel || project.verificationLevel, VerificationLevel.MOCK);
      assert.ok(legalWorkflow(project.history || []), `workflow order broken for ${project.id}`);
      assert.ok(project.council?.review1, 'review skipped');
      assert.ok(project.council?.final, 'final skipped');
    }

    const leftover = await adapter.query(`SELECT id, status, locked_by FROM jobs WHERE status = 'RUNNING'`);
    assert.equal(leftover.rows.length, 0, 'no job should remain locked after completion');

    const activeConflicts = await adapter.query(`
      SELECT project_id, COUNT(*)::int AS count
      FROM jobs
      WHERE status IN ('QUEUED', 'RUNNING')
      GROUP BY project_id
      HAVING COUNT(*) > 1`);
    assert.equal(activeConflicts.rows.length, 0);

    const audit = await adapter.query('SELECT job_id, locked_by, attempts, at FROM job_claim_audit ORDER BY job_id, at');
    const owners = new Set(audit.rows.map(row => row.locked_by).filter(Boolean));
    assert.ok(owners.has(workerIdA), `worker A ${workerIdA} never claimed work`);
    assert.ok(owners.has(workerIdB), `worker B ${workerIdB} never claimed work`);

    let duplicateConcurrentClaims = 0;
    const byJob = new Map();
    for (const row of audit.rows) {
      const list = byJob.get(row.job_id) || [];
      list.push(row);
      byJob.set(row.job_id, list);
    }
    for (const rows of byJob.values()) {
      for (let i = 1; i < rows.length; i++) {
        const dt = new Date(rows[i].at) - new Date(rows[i - 1].at);
        if (rows[i].locked_by !== rows[i - 1].locked_by && dt < 150) duplicateConcurrentClaims += 1;
      }
    }
    for (const snap of snapshots) {
      const seen = new Map();
      for (const row of snap.rows) {
        if (seen.has(row.id) && seen.get(row.id) !== row.locked_by) duplicateConcurrentClaims += 1;
        seen.set(row.id, row.locked_by);
      }
    }
    assert.equal(duplicateConcurrentClaims, 0);
    assert.ok(concurrentProjects.size >= 2, 'different projects must be able to progress concurrently');

    const ownership = audit.rows.map(row => ({
      jobId: row.job_id,
      worker: row.locked_by,
      attempts: row.attempts,
      at: row.at
    }));

    await recordEvidence({
      twoProcess: {
        workerIdA,
        workerIdB,
        jobCount: byJob.size,
        workerCount: 2,
        projectIds: created.map(item => item.id),
        ownership,
        duplicateConcurrentClaims,
        concurrentProjects: [...concurrentProjects]
      },
      contention: {
        jobs: byJob.size,
        workers: 2,
        duplicateConcurrentClaims,
        ownership
      }
    });
  } finally {
    for (const child of children) killProcess(child);
    await adapter.close();
  }
});

test('killing a worker process recovers on a new worker without skipping review or final', { timeout: 180000 }, async () => {
  const { adapter } = await pgDurable();
  const children = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-pg-kill-'));
  const port = 4700 + Math.floor(Math.random() * 200);
  const url = testDatabaseUrl();
  try {
    await truncateAppTables(adapter);
    const extraEnv = {
      DATA_DIR: dir,
      WORKSPACE_DIR: path.join(dir, 'ws'),
      JOB_LEASE_MS: '2000',
      JOB_HEARTBEAT_MS: '30000',
      WORKER_POLL_MS: '80'
    };
    const api = spawnPlatform({ role: 'api', port, databaseUrl: url, extraEnv });
    children.push(api);
    await waitForHealth(port);
    const workerA = spawnPlatform({ role: 'worker', port, databaseUrl: url, extraEnv });
    children.push(workerA);
    const workerIdA = await waitForWorkerReady(workerA);

    const created = await submitIdea(port, 'PostgreSQL process-kill pantry tracker');
    await waitForPredicate(async () => {
      const jobs = await adapter.query(
        `SELECT id, status, locked_by FROM jobs WHERE project_id = $1 AND status = 'RUNNING'`,
        [created.id]
      );
      return jobs.rows[0] || null;
    }, 20000);

    killProcess(workerA);
    await new Promise(resolve => setTimeout(resolve, 400));
    const apiHealth = await fetch(`http://127.0.0.1:${port}/health`).then(res => res.json());
    assert.equal(apiHealth.ok, true, 'API must remain up after worker kill');

    await new Promise(resolve => setTimeout(resolve, 2200));
    const workerB = spawnPlatform({ role: 'worker', port, databaseUrl: url, extraEnv });
    children.push(workerB);
    const workerIdB = await waitForWorkerReady(workerB);

    const done = await waitForPredicate(async () => {
      const project = await getProject(port, created.id);
      if (project.state === ProjectState.READY_FOR_OWNER_REVIEW || project.state === ProjectState.FAILED) return project;
      return null;
    }, 90000);

    assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW);
    assert.equal(done.delivery?.verificationLevel || done.verificationLevel, VerificationLevel.MOCK);
    assert.ok(done.council?.review1, 'Council review must not be skipped after process kill');
    assert.ok(done.council?.final, 'Final verification must not be skipped after process kill');
    assert.ok((done.cursorRuns || []).length >= 1);
    const readyCount = (done.history || []).filter(item => item.to === ProjectState.READY_FOR_OWNER_REVIEW).length;
    assert.equal(readyCount, 1);

    const recovery = await adapter.query(
      `SELECT type, payload FROM events WHERE project_id = $1 AND type = 'recovery.performed'`,
      [created.id]
    );

    killProcess(workerB);
    killProcess(api);
    await new Promise(resolve => setTimeout(resolve, 400));
    const port2 = port;
    const api2 = spawnPlatform({ role: 'api', port: port2, databaseUrl: url, extraEnv });
    children.push(api2);
    await waitForHealth(port2, 20000);
    const workerC = spawnPlatform({ role: 'worker', port: port2, databaseUrl: url, extraEnv });
    children.push(workerC);
    await waitForWorkerReady(workerC);
    const still = await getProject(port2, created.id);
    assert.equal(still.state, ProjectState.READY_FOR_OWNER_REVIEW);

    await recordEvidence({
      processKill: {
        projectId: created.id,
        killedWorker: workerIdA,
        recoveryWorker: workerIdB,
        recoveryEvents: recovery.rows.length,
        verificationLevel: still.delivery?.verificationLevel || still.verificationLevel,
        apiAndWorkerRestarted: true
      }
    });
  } finally {
    for (const child of children) killProcess(child);
    await adapter.close();
  }
});
