import test from 'node:test';
import assert from 'node:assert/strict';
import { tempStore, waitFor, awaitJob, orchestratorFor, FakeCouncil, FakeCursor, seedProject, readyProjectShape, ProjectState, VerificationLevel } from './helpers.js';
import { ErrorCode } from '../src/orchestrator/errors.js';
import { Council } from '../src/council/council.js';
import { MockProvider } from '../src/providers/mock.js';
import { MockCursorClient } from '../src/cursor/mock-cursor.js';
import { WorkspaceManager } from '../src/storage/workspace.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

test('happy path reaches READY only through the completion gate', async () => {
  const { store } = await tempStore();
  const orch = orchestratorFor(store);
  const created = await store.create({ idea: 'Build a cooking app' });
  await orch.run(created.id);
  const project = await store.get(created.id);
  assert.equal(project.state, ProjectState.READY_FOR_OWNER_REVIEW);
  assert.ok([VerificationLevel.SELF_REPORTED, VerificationLevel.PLATFORM_VERIFIED].includes(project.delivery.verificationLevel));
  assert.equal(project.provisioning.status, 'PASS');
  assert.ok(project.repository.provisioningBaselineSha);
  assert.ok(project.delivery.gate.ok);
  assert.ok(project.evidence);
  assert.ok(project.history.every(h => h.from && h.to));
});

test('Chair COMPLETE without cursor evidence cannot become READY', async () => {
  const { store } = await tempStore();
  const orch = orchestratorFor(store, { cursor: new FakeCursor({ fail: true }) });
  const created = await store.create({ idea: 'idea' });
  await orch.run(created.id);
  const project = await store.get(created.id);
  assert.equal(project.state, ProjectState.FAILED);
  assert.notEqual(project.state, ProjectState.READY_FOR_OWNER_REVIEW);
  assert.ok(project.council.discovery.spec);
});

test('failed execution evidence cannot become READY', async () => {
  const { store } = await tempStore();
  const orch = orchestratorFor(store, { cursor: new FakeCursor({ executionFail: true }) });
  const created = await store.create({ idea: 'idea' });
  await orch.run(created.id);
  const project = await store.get(created.id);
  assert.equal(project.state, ProjectState.FAILED);
  assert.equal(project.error.code, ErrorCode.CURSOR_EXECUTION_FAILED);
});

test('max iterations produces structured failure rather than READY', async () => {
  const { store } = await tempStore();
  const orch = orchestratorFor(store, { council: new FakeCouncil({ review: 'CHANGES_REQUIRED' }), maxIterations: 2 });
  const created = await store.create({ idea: 'idea' });
  await orch.run(created.id);
  const project = await store.get(created.id);
  assert.equal(project.state, ProjectState.FAILED);
  assert.equal(project.error.code, ErrorCode.MAX_ITERATIONS_REACHED);
  assert.ok(project.cursorRuns.length >= 2);
  assert.ok(project.history.length > 0);
});

test('demo workflow is honest MOCK verification', async () => {
  const { store } = await tempStore();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-ws-'));
  const orch = orchestratorFor(store, {
    council: new Council(['openai', 'anthropic', 'gemini', 'xai'].map(name => new MockProvider(name)), 'openai'),
    cursor: new MockCursorClient(),
    demo: true
  });
  orch.workspace = new WorkspaceManager(dir);
  const created = await store.create({ idea: 'Build a cooking Android application', demo: true });
  await orch.run(created.id);
  const project = await store.get(created.id);
  assert.equal(project.state, ProjectState.READY_FOR_OWNER_REVIEW);
  assert.equal(project.verificationLevel, VerificationLevel.MOCK);
  assert.equal(project.evidence.verificationLevel, VerificationLevel.MOCK);
  assert.equal(project.delivery.verificationLevel, VerificationLevel.MOCK);
  assert.ok(project.iteration >= 2, 'demo must run one Cursor correction cycle');
  assert.ok(project.council.discovery.history.some(round => round.purpose === 'critique'));
});

test('retry after council failure preserves spec history and resumes', async () => {
  const { store } = await tempStore();
  const failing = new FakeCouncil({ failDiscover: true });
  const orch = orchestratorFor(store, { council: failing });
  const created = await store.create({ idea: 'idea' });
  await orch.run(created.id);
  const failed = await store.get(created.id);
  assert.equal(failed.state, ProjectState.FAILED);
  assert.ok(failed.errors.length);
  failing.failDiscover = false;
  const resumed = await orch.retry(created.id);
  assert.notEqual(resumed.state, ProjectState.FAILED);
  const project = await awaitJob(orch, store, created.id, 30000);
  assert.equal(project.state, ProjectState.READY_FOR_OWNER_REVIEW, project.error && `${project.error.code}: ${project.error.message}`);
  assert.ok(project.errors.length >= 1);
});

test('retry after cursor failure keeps the specification', async () => {
  const { store } = await tempStore();
  const cursor = new FakeCursor({ fail: true });
  const orch = orchestratorFor(store, { cursor });
  const created = await store.create({ idea: 'idea' });
  await orch.run(created.id);
  let project = await store.get(created.id);
  assert.equal(project.state, ProjectState.FAILED);
  const spec = project.council.discovery.spec;
  cursor.fail = false;
  await orch.retry(created.id);
  project = await awaitJob(orch, store, created.id, 30000);
  assert.equal(project.state, ProjectState.READY_FOR_OWNER_REVIEW, project.error && `${project.error.code}: ${project.error.message}`);
  assert.deepEqual(project.council.discovery.spec, spec);
  assert.ok(project.history.some(h => h.from === ProjectState.FAILED));
});

test('direct CURSOR_EXECUTING to READY is impossible through orchestrator.transition', async () => {
  const { store } = await tempStore();
  const orch = orchestratorFor(store);
  const project = await seedProject(store, { state: ProjectState.CURSOR_EXECUTING });
  await assert.rejects(() => orch.transition(project, ProjectState.READY_FOR_OWNER_REVIEW, 'nope'), err => err.code === ErrorCode.INVALID_STATE_TRANSITION);
  const saved = await store.get(project.id);
  assert.equal(saved.state, ProjectState.CURSOR_EXECUTING);
});

test('boot recovery does not double-run a project', async () => {
  const { store } = await tempStore();
  const cursor = new FakeCursor();
  const orch = orchestratorFor(store, { cursor });
  await seedProject(store, { ...readyProjectShape(), idea: 'idea' });
  const first = await orch.recoverOnBoot();
  const second = await orch.recoverOnBoot();
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  await waitFor(store, first[0], p => p.state === ProjectState.READY_FOR_OWNER_REVIEW || p.state === ProjectState.FAILED, 20000);
});

test('READY and FAILED are not auto-resumed on boot', async () => {
  const { store } = await tempStore();
  const orch = orchestratorFor(store);
  await seedProject(store, { state: ProjectState.READY_FOR_OWNER_REVIEW });
  await seedProject(store, { state: ProjectState.FAILED });
  const resumed = await orch.recoverOnBoot();
  assert.deepEqual(resumed, []);
});
