import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitOk } from '../src/git/exec.js';
import { inspectGit } from '../src/git/inspect.js';
import { isolateExistingRepository } from '../src/git/worktree.js';
import { createCheckpointCommit } from '../src/git/checkpoint.js';
import { JsonStore, createProjectRecord } from '../src/storage/json-store.js';
import { WorkspaceManager } from '../src/storage/workspace.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeCouncil, createEvidence, EvidenceStatus, EvidenceProvenance, VerificationLevel, ProjectState } from './helpers.js';
import { runPlatformVerification } from '../src/verify/pipeline.js';

async function makeNodeFixture(dir, { broken = false } = {}) {
  await fs.mkdir(dir, { recursive: true });
  gitOk(['init'], { cwd: dir });
  gitOk(['config', 'user.email', 'phase5@test'], { cwd: dir });
  gitOk(['config', 'user.name', 'Phase5'], { cwd: dir });
  const impl = broken
    ? 'export function add(a, b) { return a; }\n'
    : 'export function add(a, b) { return a + b; }\n';
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'adp-fixture',
    type: 'module',
    scripts: {
      build: 'node --input-type=commonjs -e "require(\'node:fs\').writeFileSync(\'dist.txt\',\'ok\')"',
      test: 'node --test add.test.js',
      lint: 'node -e "process.exit(0)"'
    }
  }, null, 2));
  await fs.writeFile(path.join(dir, 'add.js'), impl);
  await fs.writeFile(path.join(dir, 'add.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './add.js';
test('adds', () => assert.equal(add(2, 3), 5));
`);
  gitOk(['add', '.'], { cwd: dir });
  gitOk(['commit', '-m', 'baseline'], { cwd: dir });
  gitOk(['branch', '-M', 'main'], { cwd: dir });
  return inspectGit(dir);
}

class MutatingCursor {
  constructor(write) {
    this.write = write;
    this.runs = 0;
  }
  async run({ cwd }) {
    this.runs += 1;
    await this.write(cwd, this.runs);
    return {
      sessionId: `s${this.runs}`,
      stopReason: 'end_turn',
      output: 'cursor claimed success',
      evidence: createEvidence({
        verificationLevel: VerificationLevel.SELF_REPORTED,
        execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
        build: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
        tests: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
      })
    };
  }
}

test('Fixture A: passing Node project is PLATFORM_VERIFIED', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-fix-a-'));
  const owner = path.join(root, 'owner');
  await makeNodeFixture(owner);
  const project = createProjectRecord({ idea: 'pass', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  project.iteration = 1;
  const repo = await isolateExistingRepository(project, owner, path.join(root, 'managed'));
  project.repository = repo;
  const run = await runPlatformVerification({ project, workspacePath: repo.workspacePath, demo: false });
  assert.equal(run.status, 'PASS', JSON.stringify(run.blockingFailures));
  assert.equal(run.evidencePatch.build.provenance, EvidenceProvenance.PLATFORM_VERIFIED);
  assert.equal(run.evidencePatch.tests.provenance, EvidenceProvenance.PLATFORM_VERIFIED);
  assert.equal(run.evidencePatch.lint.provenance, EvidenceProvenance.PLATFORM_VERIFIED);
  assert.equal(run.evidencePatch.verificationLevel, VerificationLevel.PLATFORM_VERIFIED);
  assert.equal(run.evidencePatch.runtime.status, EvidenceStatus.NOT_RUN);
  assert.ok(run.steps.every(step => Array.isArray(step.command)));
  assert.ok(run.artifacts.some(item => item.sha256 || item.kind === 'build_output' || item.type === 'log'));
});

test('Fixture B: broken Node project captures real failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-fix-b-'));
  const owner = path.join(root, 'owner');
  await makeNodeFixture(owner, { broken: true });
  const project = createProjectRecord({ idea: 'fail', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  project.iteration = 1;
  const repo = await isolateExistingRepository(project, owner, path.join(root, 'managed'));
  project.repository = repo;
  const run = await runPlatformVerification({ project, workspacePath: repo.workspacePath, demo: false });
  assert.equal(run.status, 'FAIL');
  assert.ok(run.blockingFailures.length);
  assert.equal(run.evidencePatch.tests.status, EvidenceStatus.FAIL);
  assert.match(String(run.steps.find(step => step.kind === 'TEST')?.stderrPreview || run.steps.find(step => step.kind === 'TEST')?.stdoutPreview || ''), /AssertionError|fail|not equal|5/i);
});

test('Fixture C: failed verification, Cursor correction, re-verify PASS', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-fix-c-'));
  const owner = path.join(root, 'owner');
  await makeNodeFixture(owner, { broken: true });
  const store = new JsonStore(path.join(root, 'data'));
  await store.init();
  const project = createProjectRecord({ idea: 'correct', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', projectPath: owner });
  project.state = ProjectState.SPECIFICATION_READY;
  project.council = { discovery: { spec: { productName: 'Fix', cursorPrompt: 'Implement add correctly.' } } };
  project.activePrompt = 'Implement add correctly.';
  await store.save(project);
  const cursor = new MutatingCursor(async (cwd, run) => {
    const file = path.join(cwd, 'add.js');
    if (run === 1) return;
    await fs.writeFile(file, 'export function add(a, b) { return a + b; }\n');
  });
  const orchestrator = new Orchestrator({
    store,
    council: new FakeCouncil(),
    cursor,
    workspace: new WorkspaceManager(path.join(root, 'managed')),
    demo: false
  });
  await orchestrator.run(project.id);
  const done = await store.get(project.id);
  assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW, done.error?.message || done.state);
  assert.ok(done.verificationRuns.length >= 2, 'correction must re-verify');
  assert.equal(done.verificationRuns.at(-1).status, 'PASS');
  assert.equal(done.evidence.tests.status, EvidenceStatus.PASS);
  assert.equal(done.evidence.tests.provenance, EvidenceProvenance.PLATFORM_VERIFIED);
  assert.ok(cursor.runs >= 2);
  assert.ok(done.council.review1.decision.decision === 'CHANGES_REQUIRED' || done.history.some(item => item.to === ProjectState.CURSOR_EXECUTING && item.from === ProjectState.COUNCIL_REVIEW));
});

test('existing repo pipeline: worktree, checkpoint, platform build and tests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-live-p5-'));
  const owner = path.join(root, 'owner');
  await makeNodeFixture(owner);
  const project = createProjectRecord({ idea: 'pipeline', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  const repo = await isolateExistingRepository(project, owner, path.join(root, 'managed'));
  await fs.writeFile(path.join(repo.workspacePath, 'NOTE.md'), 'autonomous\n');
  const checkpoint = await createCheckpointCommit(repo.workspacePath, {
    iteration: 1,
    branch: repo.workingBranch,
    workspaceRoot: repo.workspacePath
  });
  project.repository = repo;
  project.iteration = 1;
  project.cursorRuns = [{ iteration: 1, checkpointSha: checkpoint.sha, result: { output: 'ok' } }];
  const run = await runPlatformVerification({ project, workspacePath: repo.workspacePath, demo: false });
  assert.equal(run.checkpointSha, checkpoint.sha);
  assert.equal(run.status, 'PASS');
  assert.equal(inspectGit(owner).branch, 'main');
});

test('demo verification remains MOCK', async () => {
  const project = createProjectRecord({ idea: 'demo', demo: true });
  project.iteration = 1;
  const run = await runPlatformVerification({ project, workspacePath: '/tmp/unused', demo: true });
  assert.equal(run.mock, true);
  assert.equal(run.evidencePatch.verificationLevel, VerificationLevel.MOCK);
});
