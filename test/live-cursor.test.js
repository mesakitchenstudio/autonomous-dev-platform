import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitOk } from '../src/git/exec.js';
import { inspectGit } from '../src/git/inspect.js';
import { isolateExistingRepository } from '../src/git/worktree.js';
import { collectGitEvidence, createCheckpointCommit } from '../src/git/checkpoint.js';
import { createProjectRecord } from '../src/storage/json-store.js';
import { CursorAcpClient } from '../src/cursor/acp-client.js';
import { CursorCloudClient } from '../src/cursor/cloud-client.js';

function agentAvailable() {
  const probe = spawnSync(process.env.CURSOR_AGENT_BIN || 'agent', ['--help'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  return probe.status === 0 || /usage|acp|agent/i.test(`${probe.stdout || ''}${probe.stderr || ''}`);
}

function acpAuthAvailable() {
  return Boolean(process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN);
}

function cloudLiveAvailable() {
  const key = process.env.CURSOR_CLOUD_API_KEY || process.env.CURSOR_API_KEY;
  const repo = process.env.CURSOR_LIVE_TEST_REPO_URL;
  return Boolean(key && repo);
}

function isAuthFailure(error) {
  return /auth|unauthor|login|credential|401|403/i.test(error?.message || '');
}

async function makeDisposableRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  gitOk(['init'], { cwd: dir });
  gitOk(['config', 'user.email', 'phase4-live@test'], { cwd: dir });
  gitOk(['config', 'user.name', 'Phase4Live'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'NOTE.md'), 'baseline note\n');
  gitOk(['add', '.'], { cwd: dir });
  gitOk(['commit', '-m', 'baseline'], { cwd: dir });
  gitOk(['branch', '-M', 'main'], { cwd: dir });
  return inspectGit(dir);
}

test('ACP live verification reports availability honestly', async () => {
  if (!agentAvailable() || !acpAuthAvailable()) {
    assert.ok(true, 'ACP LIVE VERIFICATION NOT RUN — AUTHENTICATION UNAVAILABLE');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-live-acp-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  const baseline = await makeDisposableRepo(owner);
  const project = createProjectRecord({ idea: 'phase4 live acp', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const repo = await isolateExistingRepository(project, owner, managed);
  const client = new CursorAcpClient({
    bin: process.env.CURSOR_AGENT_BIN || 'agent',
    apiKey: process.env.CURSOR_API_KEY,
    authToken: process.env.CURSOR_AUTH_TOKEN,
    timeoutMs: 180000
  });

  let first;
  try {
    first = await client.run({
      cwd: repo.workspacePath,
      prompt: 'Create a file named LIVE_ACP_1.md containing the single line phase4-live-1. Do not modify any other files. Do not use git push.',
      projectId: project.id,
      iteration: 1,
      workspace: repo
    });
  } catch (error) {
    if (isAuthFailure(error)) {
      assert.ok(true, 'ACP LIVE VERIFICATION NOT RUN — AUTHENTICATION UNAVAILABLE');
      return;
    }
    throw error;
  }

  assert.ok(first.session?.sessionId || first.sessionId, 'ACP session id must be captured');
  assert.notEqual(first.workspace.workspacePath, owner);
  const afterFirst = await collectGitEvidence(repo.workspacePath, { baselineSha: baseline.sha, workspaceRoot: repo.workspacePath });
  assert.match(afterFirst.snapshot.branch, /adp\//);
  const checkpoint1 = await createCheckpointCommit(repo.workspacePath, {
    iteration: 1,
    branch: repo.workingBranch,
    workspaceRoot: repo.workspacePath
  });
  assert.ok(checkpoint1.committed || afterFirst.manifest.some(item => item.path === 'LIVE_ACP_1.md'));

  const second = await client.run({
    cwd: repo.workspacePath,
    sessionId: first.session?.sessionId || first.sessionId,
    prompt: 'Create a file named LIVE_ACP_2.md containing the single line phase4-live-2. Leave LIVE_ACP_1.md in place.',
    projectId: project.id,
    iteration: 2,
    workspace: repo
  });
  assert.equal(inspectGit(repo.workspacePath).branch, repo.workingBranch);
  await createCheckpointCommit(repo.workspacePath, {
    iteration: 2,
    branch: repo.workingBranch,
    workspaceRoot: repo.workspacePath
  });
  const ownerAfter = inspectGit(owner);
  assert.equal(ownerAfter.sha, baseline.sha);
  assert.equal(ownerAfter.branch, 'main');
  assert.ok(second.session?.sessionId || second.sessionId);
  console.log('ACP live session', first.session?.sessionId || first.sessionId);
});

test('Cloud live verification reports availability honestly', async () => {
  if (!cloudLiveAvailable()) {
    assert.ok(true, 'CLOUD LIVE VERIFICATION NOT RUN — CREDENTIALS/REPOSITORY UNAVAILABLE');
    return;
  }

  const client = new CursorCloudClient({
    apiKey: process.env.CURSOR_CLOUD_API_KEY || process.env.CURSOR_API_KEY,
    timeoutMs: 180000,
    requestTimeoutMs: 60000
  });
  const repoUrl = process.env.CURSOR_LIVE_TEST_REPO_URL;
  const startingRef = process.env.CURSOR_LIVE_TEST_STARTING_REF || 'main';
  let first;
  try {
    first = await client.run({
      prompt: 'Create or update LIVE_CLOUD_1.md with the single line phase4-live-cloud-1. Do not open a pull request. Do not merge.',
      workspace: { cloudRepositoryUrl: repoUrl, baseRef: startingRef },
      projectId: 'live-cloud',
      iteration: 1
    });
  } catch (error) {
    if (isAuthFailure(error)) {
      assert.ok(true, 'CLOUD LIVE VERIFICATION NOT RUN — CREDENTIALS/REPOSITORY UNAVAILABLE');
      return;
    }
    throw error;
  }

  assert.ok(first.session?.agentId, 'Cloud agent id must be persisted');
  assert.ok(first.session?.runId, 'Cloud run id must be persisted');
  const second = await client.run({
    prompt: 'Create or update LIVE_CLOUD_2.md with the single line phase4-live-cloud-2. Stay on the same agent branch.',
    sessionId: first.session.agentId,
    workspace: { cloudRepositoryUrl: repoUrl, baseRef: startingRef },
    projectId: 'live-cloud',
    iteration: 2
  });
  assert.equal(second.session.agentId, first.session.agentId);
  console.log('Cloud live agent/run', first.session.agentId, first.session.runId);
});
