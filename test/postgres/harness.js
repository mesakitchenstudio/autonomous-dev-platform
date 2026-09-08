import '../security-env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPgPool, PgAdapter } from '../../src/db/adapter.js';
import { migrate } from '../../src/db/migrate.js';
import { DurableStore } from '../../src/storage/durable-store.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { Worker } from '../../src/worker/worker.js';
import { FakeCouncil, FakeCursor, FakeWorkspace } from '../helpers.js';
import { assertTestDatabaseUrl, redactDatabaseUrl } from './guard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_PATH = path.join(root, 'test', 'postgres', '.last-evidence.json');

export const CLAIM_CANDIDATE_SQL = `SELECT id FROM jobs
        WHERE status = 'QUEUED' AND available_at <= NOW()
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`;

export function testDatabaseUrl() {
  return assertTestDatabaseUrl(process.env.TEST_DATABASE_URL).connectionString;
}

export async function pgDurable(options = {}) {
  const url = testDatabaseUrl();
  const adapter = new PgAdapter(createPgPool(url));
  await adapter.ready();
  if (options.reset) await resetPublicSchema(adapter);
  await migrate(adapter);
  if (options.truncate) await truncateAppTables(adapter);
  const store = new DurableStore(adapter);
  const queue = new JobQueue(adapter, {
    leaseMs: options.leaseMs ?? 5000,
    retryBaseMs: options.retryBaseMs ?? 10,
    retryMaxMs: options.retryMaxMs ?? 20,
    maxAttempts: options.maxAttempts ?? 8
  });
  return { adapter, store, queue, url, redactedUrl: redactDatabaseUrl(url) };
}

export function pgOrchestrator(store, queue, extras = {}) {
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

export function pgWorker(store, queue, orchestrator, extras = {}) {
  return new Worker({
    store,
    queue,
    orchestrator,
    pollMs: extras.pollMs ?? 30,
    heartbeatMs: extras.heartbeatMs ?? 50,
    concurrency: extras.concurrency ?? 1
  });
}

export async function waitForProject(store, id, predicate, timeoutMs = 20000) {
  const start = Date.now();
  let project;
  while (Date.now() - start < timeoutMs) {
    project = await store.get(id);
    if (predicate(project)) return project;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for project (state=${project?.state})`);
}

export async function resetPublicSchema(adapter) {
  await adapter.query('DROP SCHEMA IF EXISTS public CASCADE');
  await adapter.query('CREATE SCHEMA public');
}

export async function truncateAppTables(adapter) {
  await adapter.query(`TRUNCATE
    events, jobs, json_imports, error_records, evidence_records,
    sandbox_runs, sandbox_events, secret_references, secret_leases,
    security_findings, security_events, owner_tokens, owner_sessions,
    project_security_policies, temporary_project_resources,
    cursor_runs, council_artifacts, council_rounds, operations,
    verification_steps, verification_artifacts, verification_runs,
    delivery_artifacts, delivery_snapshots, owner_reviews, owner_notifications,
    notification_deliveries, review_sessions,
    state_transitions, projects
    RESTART IDENTITY CASCADE`);
}

export async function waitForHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server on ${port} did not become healthy`);
}

export async function waitForPredicate(fn, timeoutMs = 20000, intervalMs = 50) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for predicate (last=${JSON.stringify(last)})`);
}

export function spawnPlatform({ role, port, databaseUrl, extraEnv = {} }) {
  const script = role === 'worker' ? 'src/worker/main.js' : 'src/server.js';
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      DEMO_MODE: 'true',
      APP_ROLE: role,
      PORT: String(port || 0),
      WORKER_POLL_MS: extraEnv.WORKER_POLL_MS || '80',
      WORKER_CONCURRENCY: extraEnv.WORKER_CONCURRENCY || '1',
      JOB_LEASE_MS: extraEnv.JOB_LEASE_MS || '900000',
      JOB_HEARTBEAT_MS: extraEnv.JOB_HEARTBEAT_MS || '30000',
      JOB_MAX_ATTEMPTS: extraEnv.JOB_MAX_ATTEMPTS || '8',
      JOB_RETRY_BASE_MS: extraEnv.JOB_RETRY_BASE_MS || '50',
      JOB_RETRY_MAX_MS: extraEnv.JOB_RETRY_MAX_MS || '200',
      DATA_DIR: extraEnv.DATA_DIR,
      WORKSPACE_DIR: extraEnv.WORKSPACE_DIR,
      PGLITE_DATA_DIR: '',
      IMPORT_JSON_ON_START: 'false',
      OWNER_TOKEN_BOOTSTRAP: extraEnv.OWNER_TOKEN_BOOTSTRAP || process.env.OWNER_TOKEN_BOOTSTRAP || 'adp-test-owner-token',
      SECURITY_PROFILE: extraEnv.SECURITY_PROFILE || 'DEVELOPMENT',
      SECRET_MASTER_KEY: extraEnv.SECRET_MASTER_KEY || process.env.SECRET_MASTER_KEY || '00'.repeat(32),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.output = '';
  const collect = chunk => { child.output += chunk; };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return child;
}

export function killProcess(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try { child.kill('SIGKILL'); } catch {}
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

export async function waitForWorkerReady(child, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = child.output.match(/Autonomous worker (\S+)/);
    if (match) return match[1];
    if (child.exitCode != null) throw new Error(`Worker exited early: ${child.output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Worker did not start: ${child.output}`);
}

export async function recordEvidence(update) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(EVIDENCE_PATH, 'utf8'));
  } catch {}
  const next = { ...current, ...update, updatedAt: new Date().toISOString() };
  await fs.writeFile(EVIDENCE_PATH, JSON.stringify(next, null, 2));
  return next;
}

export async function openClient(connectionString = testDatabaseUrl()) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

export { redactDatabaseUrl, root, EVIDENCE_PATH };
