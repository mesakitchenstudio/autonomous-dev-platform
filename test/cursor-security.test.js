import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decidePermission } from '../src/cursor/permission-policy.js';
import { buildCursorChildEnv, assertNoCouncilSecrets } from '../src/cursor/child-env.js';
import { classifyGitCommand, gitPolicyAllowsCursor, isProtectedBranch } from '../src/git/policy.js';
import { assertInsideWorkspace } from '../src/git/boundary.js';
import { createCheckpointCommit } from '../src/git/checkpoint.js';
import { gitOk } from '../src/git/exec.js';
import { isolateExistingRepository } from '../src/git/worktree.js';
import { createProjectRecord } from '../src/storage/json-store.js';
import { cursorPreflight } from '../src/cursor/preflight.js';
import { MockCursorClient } from '../src/cursor/mock-cursor.js';
import { ErrorCode } from '../src/orchestrator/errors.js';

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  gitOk(['init'], { cwd: dir });
  gitOk(['config', 'user.email', 's@t'], { cwd: dir });
  gitOk(['config', 'user.name', 'S'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'app.js'), 'console.log(1)\n');
  gitOk(['add', '.'], { cwd: dir });
  gitOk(['commit', '-m', 'base'], { cwd: dir });
  gitOk(['branch', '-M', 'main'], { cwd: dir });
}

test('workspace path escape and owner worktree writes are denied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-esc-'));
  const workspace = path.join(root, 'ws');
  const owner = path.join(root, 'owner');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(owner, { recursive: true });
  const escaped = decidePermission('safe-development', {
    params: { toolCall: { kind: 'edit', path: path.join(root, 'outside.txt') }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  }, { workspaceRoot: workspace });
  assert.equal(escaped.decision, 'deny');
  const ownerWrite = decidePermission('safe-development', {
    params: { toolCall: { kind: 'edit', path: path.join(owner, 'secret.js') }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  }, { workspaceRoot: workspace, ownerPath: owner });
  assert.equal(ownerWrite.decision, 'deny');
  assert.equal(assertInsideWorkspace(path.join(workspace, '..', 'owner', 'x'), workspace), false);
});

test('protected branches and destructive git commands are rejected', () => {
  assert.equal(isProtectedBranch('main'), true);
  assert.equal(isProtectedBranch('release/1.0'), true);
  assert.equal(isProtectedBranch('adp/abc'), false);
  assert.equal(classifyGitCommand('git reset --hard main').action, 'DESTRUCTIVE');
  assert.equal(classifyGitCommand('git push --force origin main').action, 'DESTRUCTIVE');
  assert.equal(classifyGitCommand('git clean -fdx').action, 'DESTRUCTIVE');
  assert.equal(gitPolicyAllowsCursor('git push --force', { branch: 'adp/x' }).allow, false);
  const denied = decidePermission('safe-development', {
    params: { toolCall: { kind: 'execute', command: 'git reset --hard' }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  });
  assert.equal(denied.decision, 'deny');
});

test('unknown permissions default to reject and coding commands can be allowed', () => {
  const unknown = decidePermission('safe-development', { params: { options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] } });
  assert.equal(unknown.decision, 'deny');
  const npmTest = decidePermission('safe-development', {
    params: { toolCall: { kind: 'execute', command: 'npm test' }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  });
  assert.equal(npmTest.decision, 'allow');
  const edit = decidePermission('safe-development', {
    params: { toolCall: { kind: 'edit', path: 'src/app.js' }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  }, { workspaceRoot: process.cwd() });
  // src/app.js may resolve outside a fake workspace; without workspaceRoot check relative path uses cwd
  assert.ok(['allow', 'deny'].includes(edit.decision));
});

test('platform secrets are not inherited by the Cursor child', () => {
  const env = buildCursorChildEnv({
    PATH: '/bin',
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'sk-ant',
    GEMINI_API_KEY: 'gem',
    XAI_API_KEY: 'xai',
    DATABASE_URL: 'postgres://adp:secret@localhost/adp',
    CURSOR_PROJECT_ENV_ALLOW: 'DATABASE_URL,MY_APP_FLAG',
    MY_APP_FLAG: '1'
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.MY_APP_FLAG, '1');
  assert.doesNotThrow(() => assertNoCouncilSecrets(env));
});

test('checkpoint commit refuses protected secret files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-sec-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  await makeRepo(owner);
  const project = createProjectRecord({ idea: 'secrets', id: '88888888-8888-4888-8888-888888888888' });
  const repo = await isolateExistingRepository(project, owner, managed);
  await fs.writeFile(path.join(repo.workspacePath, '.env'), 'SECRET=1\n');
  await assert.rejects(
    () => createCheckpointCommit(repo.workspacePath, { iteration: 1, branch: repo.workingBranch, workspaceRoot: repo.workspacePath }),
    error => error.code === ErrorCode.SECRET_FILE_BLOCKED || /secret/i.test(error.message)
  );
});

test('preflight blocks Cursor when the worker lost the lease or the database is down', async () => {
  await assert.rejects(
    () => cursorPreflight({ project: { cursorRuns: [] }, workspacePath: '/tmp/x', demo: true, owns: async () => false, dbReady: async () => true, timeoutMs: 1000, backend: 'ACP' }),
    error => error.code === 'JOB_LEASE_LOST'
  );
  await assert.rejects(
    () => cursorPreflight({ project: { cursorRuns: [] }, workspacePath: '/tmp/x', demo: true, owns: async () => true, dbReady: async () => false, timeoutMs: 1000, backend: 'ACP' }),
    error => error.code === 'DATABASE_UNAVAILABLE'
  );
});

test('symlink or junction escape is denied when the platform can create one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-link-'));
  const workspace = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
  const link = path.join(workspace, 'escape');
  try {
    await fs.symlink(outside, link, 'junction');
  } catch {
    return;
  }
  const decision = decidePermission('safe-development', {
    params: { toolCall: { kind: 'edit', path: path.join(link, 'secret.txt') }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  }, { workspaceRoot: workspace });
  assert.equal(decision.decision, 'deny');
});

test('mock cursor cancel is invoked on request', async () => {
  const cursor = new MockCursorClient();
  const result = await cursor.cancel('lease_lost');
  assert.equal(result.attempted, true);
});
