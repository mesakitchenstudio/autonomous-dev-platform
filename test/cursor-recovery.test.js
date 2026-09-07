import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitOk } from '../src/git/exec.js';
import { isolateExistingRepository } from '../src/git/worktree.js';
import { createCheckpointCommit } from '../src/git/checkpoint.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeCouncil, FakeCursor, FakeWorkspace, ProjectState } from './helpers.js';
import { JsonStore, createProjectRecord } from '../src/storage/json-store.js';
import { WorkspaceManager } from '../src/storage/workspace.js';
import { MockCursorClient } from '../src/cursor/mock-cursor.js';

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  gitOk(['init'], { cwd: dir });
  gitOk(['config', 'user.email', 'r@t'], { cwd: dir });
  gitOk(['config', 'user.name', 'R'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), 'base\n');
  gitOk(['add', '.'], { cwd: dir });
  gitOk(['commit', '-m', 'base'], { cwd: dir });
  gitOk(['branch', '-M', 'main'], { cwd: dir });
}

test('interrupted uncommitted Cursor work is preserved and not reset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-rec-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  await makeRepo(owner);
  const project = createProjectRecord({ idea: 'recover', id: '99999999-9999-4999-8999-999999999999' });
  const repo = await isolateExistingRepository(project, owner, managed);
  await fs.writeFile(path.join(repo.workspacePath, 'INTERRUPTED.md'), 'keep me\n');
  const store = new JsonStore(path.join(root, 'data'));
  await store.init();
  project.projectPath = owner;
  project.repository = repo;
  project.state = ProjectState.CURSOR_EXECUTING;
  project.iteration = 1;
  project.activePrompt = 'finish it';
  project.council = { discovery: { spec: { productName: 'X', cursorPrompt: 'do it' } } };
  project.cursorRuns = [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    iteration: 1,
    status: 'STARTED',
    startedAt: new Date().toISOString()
  }];
  await store.save(project);
  const orchestrator = new Orchestrator({
    store,
    council: new FakeCouncil(),
    cursor: new FakeCursor(),
    workspace: new WorkspaceManager(managed),
    demo: false
  });
  const loadedForRecovery = await store.get(project.id);
  await orchestrator.prepareInterruptedCursor(loadedForRecovery, loadedForRecovery.cursorRuns[0]);
  const kept = await fs.readFile(path.join(repo.workspacePath, 'INTERRUPTED.md'), 'utf8');
  assert.equal(kept, 'keep me\n');
  const loaded = await store.get(project.id);
  assert.equal(loaded.cursorRuns[0].status, 'RECOVERY_REQUIRED');
  assert.match(loaded.activePrompt, /interrupted/i);
});

test('checkpointed iteration is not blindly rerun', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-ckpt-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  await makeRepo(owner);
  const record = createProjectRecord({ idea: 'ckpt', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  const repo = await isolateExistingRepository(record, owner, managed);
  await fs.writeFile(path.join(repo.workspacePath, 'done.txt'), 'done\n');
  const checkpoint = await createCheckpointCommit(repo.workspacePath, {
    iteration: 1,
    branch: repo.workingBranch,
    workspaceRoot: repo.workspacePath
  });
  const store = new JsonStore(path.join(root, 'data'));
  await store.init();
  record.projectPath = owner;
  record.repository = repo;
  record.state = ProjectState.CURSOR_EXECUTING;
  record.iteration = 1;
  record.council = { discovery: { spec: { productName: 'X', cursorPrompt: 'do it' } } };
  record.cursorRuns = [{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    iteration: 1,
    status: 'STARTED',
    checkpointSha: checkpoint.sha,
    startedAt: new Date().toISOString()
  }];
  await store.save(record);
  let cursorRuns = 0;
  const cursor = new MockCursorClient({
    async mutate() { cursorRuns += 1; }
  });
  const orchestrator = new Orchestrator({
    store,
    council: new FakeCouncil(),
    cursor,
    workspace: new WorkspaceManager(managed),
    demo: false
  });
  await orchestrator.finishOrReplayCursor(await store.get(record.id));
  assert.equal(cursorRuns, 0);
  const loaded = await store.get(record.id);
  assert.equal(loaded.state, ProjectState.COUNCIL_REVIEW);
});

test('FakeWorkspace path still works for Phase 1 demo tests', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-fake-'));
  const store = new JsonStore(dir);
  await store.init();
  const orchestrator = new Orchestrator({
    store,
    council: new FakeCouncil(),
    cursor: new FakeCursor(),
    workspace: new FakeWorkspace(),
    demo: true
  });
  const created = await store.create({ idea: 'still demo', demo: true });
  await orchestrator.run(created.id);
  const done = await store.get(created.id);
  assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW);
  assert.equal(done.verificationLevel, 'MOCK');
});
