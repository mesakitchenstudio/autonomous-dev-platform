import test from 'node:test';
import assert from 'node:assert/strict';
import { tempStore, orchestratorFor, FakeCursor, seedProject, specFixture, reviewComplete, createEvidence, EvidenceStatus, EvidenceProvenance, VerificationLevel, ProjectState, OperationType, verificationNotApplicable } from './helpers.js';
import { resumeTargetAfterFailure } from '../src/orchestrator/orchestrator.js';
import { beginOperation } from '../src/orchestrator/checkpoint.js';

const evidence = () => createEvidence({
  verificationLevel: VerificationLevel.SELF_REPORTED,
  execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
});

test('persisted CURSOR_EXECUTING recovers without skipping review', async () => {
  const { store } = await tempStore();
  const cursor = new FakeCursor();
  const orch = orchestratorFor(store, { cursor });
  const project = await seedProject(store, {
    state: ProjectState.CURSOR_EXECUTING,
    iteration: 1,
    activePrompt: specFixture().cursorPrompt,
    council: { discovery: { spec: specFixture(), chair: 'openai', failures: [] } }
  });
  beginOperation(project, OperationType.CURSOR);
  await store.save(project);
  await orch.run(project.id);
  const done = await store.get(project.id);
  assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW, done.error?.message || done.state);
  assert.equal(cursor.runs, 1);
  assert.equal(done.cursorRuns.length, 1);
  assert.ok(done.council.review1);
  assert.ok(done.council.final);
});

test('persisted CURSOR_EXECUTING with completed run resumes at review', async () => {
  const { store } = await tempStore();
  const cursor = new FakeCursor();
  const orch = orchestratorFor(store, { cursor });
  const run = { iteration: 1, at: new Date().toISOString(), prompt: 'p', result: { output: 'done', evidence: evidence() }, sessionId: 's1', evidence: evidence() };
  const project = await seedProject(store, {
    state: ProjectState.CURSOR_EXECUTING,
    iteration: 1,
    activePrompt: 'p',
    council: { discovery: { spec: specFixture(), chair: 'openai', failures: [] } },
    cursorRuns: [run],
    evidence: evidence()
  });
  await orch.run(project.id);
  const done = await store.get(project.id);
  assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW, done.error?.message || done.state);
  assert.equal(cursor.runs, 0);
});

test('persisted COUNCIL_REVIEW recovers without another Cursor run', async () => {
  const { store } = await tempStore();
  const cursor = new FakeCursor();
  const orch = orchestratorFor(store, { cursor });
  const run = { iteration: 1, at: new Date().toISOString(), prompt: 'p', result: { output: 'done', evidence: evidence() }, sessionId: 's1', evidence: evidence() };
  const project = await seedProject(store, {
    state: ProjectState.COUNCIL_REVIEW,
    iteration: 1,
    council: { discovery: { spec: specFixture(), chair: 'openai', failures: [] } },
    cursorRuns: [run],
    evidence: evidence(),
    verificationRuns: [verificationNotApplicable(1)]
  });
  await orch.run(project.id);
  const done = await store.get(project.id);
  assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW, done.error?.message || done.state);
  assert.equal(cursor.runs, 0);
  assert.ok(done.council.review1);
});

test('persisted FINAL_VERIFICATION recovers through the gate', async () => {
  const { store } = await tempStore();
  const cursor = new FakeCursor();
  const orch = orchestratorFor(store, { cursor });
  const run = { iteration: 1, at: new Date().toISOString(), prompt: 'p', result: { output: 'done', evidence: evidence() }, sessionId: 's1', evidence: evidence() };
  const project = await seedProject(store, {
    state: ProjectState.FINAL_VERIFICATION,
    iteration: 1,
    council: {
      discovery: { spec: specFixture(), chair: 'openai', failures: [] },
      review1: reviewComplete('COMPLETE')
    },
    cursorRuns: [run],
    evidence: evidence(),
    verificationRuns: [verificationNotApplicable(1)]
  });
  await orch.run(project.id);
  const done = await store.get(project.id);
  assert.equal(done.state, ProjectState.READY_FOR_OWNER_REVIEW, done.error?.message || done.state);
  assert.equal(cursor.runs, 0);
});

test('retry target prefers review when Cursor finished', () => {
  const project = {
    state: ProjectState.FAILED,
    iteration: 1,
    projectPath: '/repo',
    repository: { repositoryType: 'EXISTING_LOCAL' },
    council: { discovery: { spec: specFixture() } },
    cursorRuns: [{ iteration: 1, evidence: evidence() }],
    history: [{ from: ProjectState.CURSOR_EXECUTING, to: ProjectState.FAILED }]
  };
  assert.equal(resumeTargetAfterFailure(project), ProjectState.PLATFORM_VERIFICATION);
  project.verificationRuns = [{ iteration: 1, completedAt: new Date().toISOString(), status: 'PASS' }];
  assert.equal(resumeTargetAfterFailure(project), ProjectState.RUNTIME_VERIFICATION);
  project.runtimeRuns = [{
    iteration: 1,
    completedAt: new Date().toISOString(),
    status: 'NOT_APPLICABLE',
    policy: { runtime: 'NOT_APPLICABLE', visual: 'NOT_APPLICABLE' }
  }];
  assert.equal(resumeTargetAfterFailure(project), ProjectState.COUNCIL_REVIEW);
});

test('retry without a specification restarts discovery', () => {
  assert.equal(resumeTargetAfterFailure({ state: ProjectState.FAILED, council: {}, cursorRuns: [] }), ProjectState.COUNCIL_DISCOVERY);
});
