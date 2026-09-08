import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, gitOk } from '../src/git/exec.js';
import { inspectGit } from '../src/git/inspect.js';
import { isolateExistingRepository, provisionNewWorkspace, cleanupManagedWorktree, managedWorkspaceRoot } from '../src/git/worktree.js';
import { createCheckpointCommit, collectGitEvidence } from '../src/git/checkpoint.js';
import { WorkspaceManager } from '../src/storage/workspace.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeCouncil, ProjectState, createEvidence, EvidenceStatus, EvidenceProvenance, VerificationLevel } from './helpers.js';
import { JsonStore, createProjectRecord } from '../src/storage/json-store.js';

async function makeRepo(dir, { file = 'README.md', contents = 'base\n', branch = 'main' } = {}) {
  await fs.mkdir(dir, { recursive: true });
  gitOk(['init'], { cwd: dir });
  gitOk(['config', 'user.email', 'phase4@test'], { cwd: dir });
  gitOk(['config', 'user.name', 'Phase4'], { cwd: dir });
  await fs.writeFile(path.join(dir, file), contents);
  gitOk(['add', '.'], { cwd: dir });
  gitOk(['commit', '-m', 'baseline'], { cwd: dir });
  gitOk(['branch', '-M', branch], { cwd: dir });
  return inspectGit(dir);
}

test('worktree isolation leaves the owner branch and files untouched', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-git-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  const before = await makeRepo(owner);
  const project = createProjectRecord({ idea: 'isolate', id: '11111111-1111-4111-8111-111111111111' });
  const repo = await isolateExistingRepository(project, owner, managed);
  assert.equal(repo.workingBranch, `adp/${project.id}`);
  assert.equal(repo.baselineSha, before.sha);
  assert.equal(inspectGit(owner).branch, 'main');
  assert.equal(inspectGit(owner).sha, before.sha);
  assert.equal(inspectGit(repo.workspacePath).branch, repo.workingBranch);
  await fs.writeFile(path.join(repo.workspacePath, 'AUTONOMOUS.md'), 'from worktree\n');
  const ownerFiles = await fs.readdir(owner);
  assert.ok(!ownerFiles.includes('AUTONOMOUS.md'));
});

test('dirty owner working tree is preserved and excluded from the autonomous baseline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-dirty-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  await makeRepo(owner);
  await fs.writeFile(path.join(owner, 'OWNER_WIP.md'), 'do not take this\n');
  const project = createProjectRecord({ idea: 'dirty', id: '22222222-2222-4222-8222-222222222222' });
  const repo = await isolateExistingRepository(project, owner, managed);
  assert.equal(repo.ownerWorkingTreeDirty, true);
  const isolatedFiles = await fs.readdir(repo.workspacePath);
  assert.ok(!isolatedFiles.includes('OWNER_WIP.md'));
  const ownerWip = await fs.readFile(path.join(owner, 'OWNER_WIP.md'), 'utf8');
  assert.equal(ownerWip, 'do not take this\n');
});

test('iterations stay on the same autonomous branch and create checkpoint commits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-iter-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  await makeRepo(owner);
  const project = createProjectRecord({ idea: 'iterate', id: '33333333-3333-4333-8333-333333333333' });
  const repo = await isolateExistingRepository(project, owner, managed);
  await fs.writeFile(path.join(repo.workspacePath, 'one.txt'), '1\n');
  const first = await createCheckpointCommit(repo.workspacePath, { iteration: 1, branch: repo.workingBranch, workspaceRoot: repo.workspacePath });
  await fs.writeFile(path.join(repo.workspacePath, 'two.txt'), '2\n');
  const second = await createCheckpointCommit(repo.workspacePath, { iteration: 2, branch: repo.workingBranch, workspaceRoot: repo.workspacePath });
  assert.equal(inspectGit(repo.workspacePath).branch, repo.workingBranch);
  assert.ok(first.committed && second.committed);
  const log = gitOk(['log', '--oneline'], { cwd: repo.workspacePath });
  assert.match(log, /ADP iteration 1/);
  assert.match(log, /ADP iteration 2/);
});

test('two projects against one source repo get separate worktrees', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-conc-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  await makeRepo(owner);
  const a = createProjectRecord({ idea: 'A', id: '44444444-4444-4444-8444-444444444444' });
  const b = createProjectRecord({ idea: 'B', id: '55555555-5555-4555-8555-555555555555' });
  const repoA = await isolateExistingRepository(a, owner, managed);
  const repoB = await isolateExistingRepository(b, owner, managed);
  assert.notEqual(repoA.workspacePath, repoB.workspacePath);
  assert.notEqual(repoA.workingBranch, repoB.workingBranch);
  await fs.writeFile(path.join(repoA.workspacePath, 'A.txt'), 'a\n');
  const bFiles = await fs.readdir(repoB.workspacePath);
  assert.ok(!bFiles.includes('A.txt'));
});

test('cleanup removes only the managed worktree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-clean-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  await makeRepo(owner);
  const project = createProjectRecord({ idea: 'clean', id: '66666666-6666-4666-8666-666666666666' });
  const repo = await isolateExistingRepository(project, owner, managed);
  const cleaned = await cleanupManagedWorktree(repo, managed);
  assert.equal(cleaned.lifecycleStatus, 'CLEANED');
  await assert.rejects(() => fs.access(repo.workspacePath));
  await fs.access(owner);
  assert.equal(inspectGit(owner).branch, 'main');
});

test('orchestrator Cursor cwd is the isolated worktree, not the owner tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-orch-'));
  const owner = path.join(root, 'owner');
  const managed = path.join(root, 'managed');
  const data = path.join(root, 'data');
  await makeRepo(owner);
  const store = new JsonStore(data);
  await store.init();
  let seenCwd = null;
  const cursor = {
    async run(input) {
      const cwd = input.cwd || input.workspace?.workspacePath;
      seenCwd = cwd;
      await fs.writeFile(path.join(cwd, 'FROM_CURSOR.md'), 'ok\n');
      return {
        sessionId: 's1',
        stopReason: 'end_turn',
        output: 'ok',
        executionMode: 'ACP',
        evidence: createEvidence({
          verificationLevel: VerificationLevel.SELF_REPORTED,
          execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
        })
      };
    }
  };
  const workspace = new WorkspaceManager(managed);
  const orchestrator = new Orchestrator({
    store,
    council: new FakeCouncil(),
    cursor,
    workspace,
    demo: false,
    maxIterations: 12
  });
  const created = await store.create({ idea: 'Use existing repo', projectPath: owner });
  await orchestrator.run(created.id);
  const done = await store.get(created.id);
  assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW);
  assert.ok(seenCwd.startsWith(managed));
  assert.notEqual(seenCwd, owner);
  const ownerFiles = await fs.readdir(owner);
  assert.ok(!ownerFiles.includes('FROM_CURSOR.md'));
  assert.equal(done.evidence.git.provenance, 'PLATFORM_VERIFIED');
  assert.ok(['NOT_APPLICABLE', 'NOT_RUN'].includes(done.evidence.build.status));
  assert.ok(['NOT_APPLICABLE', 'NOT_RUN'].includes(done.evidence.runtime.status));
  assert.ok(['NOT_APPLICABLE', 'NOT_RUN'].includes(done.evidence.visual.status));
  assert.equal(done.repository.workingBranch, `adp/${created.id}`);
  assert.ok(done.cursorRuns[0].checkpointSha);
});

test('unprovisioned new projects are classified and get a bookkeeping git repo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-new-'));
  const repo = await provisionNewWorkspace({ idea: 'brand new', id: '77777777-7777-4777-8777-777777777777' }, root);
  assert.equal(repo.repositoryType, 'UNPROVISIONED_NEW_PROJECT');
  assert.ok(repo.baselineSha);
  assert.ok(repo.workspacePath);
});

void managedWorkspaceRoot;
