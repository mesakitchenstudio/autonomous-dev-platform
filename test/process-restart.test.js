import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForHealth(port, timeoutMs = 15000) {
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

function startDemo({ port, dataDir, pgliteDir }) {
  return spawn(process.execPath, ['scripts/demo.js'], {
    cwd: root,
    env: {
      ...process.env,
      DEMO_MODE: 'true',
      APP_ROLE: 'combined',
      OWNER_TOKEN_BOOTSTRAP: 'adp-demo-owner-token',
      SECURITY_PROFILE: 'DEVELOPMENT',
      SECRET_MASTER_KEY: '00'.repeat(32),
      JOB_LEASE_MS: '2000',
      JOB_HEARTBEAT_MS: '500',
      WORKER_POLL_MS: '80',
      PORT: String(port),
      PGLITE_DATA_DIR: pgliteDir,
      DATA_DIR: dataDir,
      WORKSPACE_DIR: path.join(dataDir, 'ws')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function killTree(child) {
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 500);
}

test('process kill during workflow resumes without skipping review', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-restart-'));
  const pgliteDir = path.join(dir, 'pg');
  const port = 4400 + Math.floor(Math.random() * 200);
  const first = startDemo({ port, dataDir: dir, pgliteDir });
  await waitForHealth(port);
  const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer adp-demo-owner-token' },
    body: JSON.stringify({ idea: 'Process restart pantry tracker' })
  }).then(res => res.json());
  assert.ok(created.id);
  await new Promise(resolve => setTimeout(resolve, 150));
  killTree(first);
  await new Promise(resolve => setTimeout(resolve, 600));

  const second = startDemo({ port, dataDir: dir, pgliteDir });
  try {
    await waitForHealth(port, 20000);
    const start = Date.now();
    let project;
    while (Date.now() - start < 25000) {
      project = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
        headers: { authorization: 'Bearer adp-demo-owner-token' }
      }).then(res => res.json());
      if (project.state === 'READY_FOR_OWNER_REVIEW' || project.state === 'FAILED') break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(project.state, 'READY_FOR_OWNER_REVIEW');
    assert.equal(project.verificationLevel, 'MOCK');
    assert.ok(project.council.review1, 'Council review must not be skipped after restart');
    assert.ok(project.council.final, 'Final verification must not be skipped after restart');
    assert.ok((project.cursorRuns || []).length >= 1);
  } finally {
    killTree(second);
  }
});
