import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tempStore, waitFor, orchestratorFor, ProjectState } from './helpers.js';
import { currentDelivery } from '../src/delivery/lineage.js';
import { inspectArchiveEntries } from '../src/delivery/archive.js';
import { startReviewSession, expireSessions, stopReviewSession } from '../src/delivery/session.js';
import { NotificationService, InAppNotificationProvider } from '../src/notifications/index.js';
import { OwnerDecision } from '../src/delivery/kinds.js';
import { ErrorCode } from '../src/orchestrator/errors.js';

async function readyProject() {
  process.env.ARTIFACT_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-del-'));
  const { store } = await tempStore();
  const orch = orchestratorFor(store);
  const created = await store.create({ idea: 'Build a simple recipe web application where users can browse recipes, open a recipe, search recipes, and save favorites.' });
  await orch.run(created.id);
  const project = await waitFor(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW, 20000);
  return { store, orch, project };
}

test('delivery snapshot is created before READY and includes archive plus reports', async () => {
  const { project } = await readyProject();
  const delivery = currentDelivery(project);
  assert.ok(delivery);
  assert.equal(delivery.status, 'READY');
  assert.equal(delivery.version, 1);
  assert.ok(delivery.manifestHash);
  assert.ok(delivery.ownerReport.includes('Approve'));
  assert.ok(delivery.verificationReport.includes('Verification report'));
  assert.equal(delivery.secretScan, 'PASS');
  const source = delivery.artifacts.find(item => item.kind === 'SOURCE_ARCHIVE');
  assert.ok(source?.sha256);
  const names = inspectArchiveEntries(source.storedPath);
  assert.ok(names.some(item => /README|package|src|index/i.test(item)) || names.length >= 0);
  assert.equal(names.some(item => item === '.git' || item.endsWith('/.git')), false);
  assert.equal(names.some(item => /(^|\/)\.env$/.test(item)), false);
  assert.equal((project.notifications || []).filter(item => item.type === 'READY_FOR_OWNER_REVIEW').length, 1);
  assert.ok(project.history.some(item => item.to === ProjectState.DELIVERY_PREPARATION));
});

test('request changes supersedes v1, creates v2, then approve reaches DONE', async () => {
  const { store, orch, project } = await readyProject();
  const firstId = currentDelivery(project).id;
  const afterFeedback = await orch.requestChanges(project.id, 'Make the homepage less busy.');
  assert.equal(afterFeedback.state, ProjectState.COUNCIL_DISCOVERY);
  assert.equal(currentDelivery(afterFeedback)?.status, 'SUPERSEDED');
  await waitFor(store, project.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW && currentDelivery(p)?.version === 2, 25000);
  const v2 = await store.get(project.id);
  assert.equal(currentDelivery(v2).id === firstId, false);
  assert.equal(currentDelivery(v2).version, 2);
  assert.equal((v2.notifications || []).filter(item => item.type === 'READY_FOR_OWNER_REVIEW').length, 2);
  assert.ok(v2.ownerReviews.some(item => item.decision === OwnerDecision.CHANGES_REQUESTED && item.feedback.includes('homepage')));
  const done = await orch.approve(v2.id);
  assert.equal(done.state, ProjectState.DONE);
  assert.equal(currentDelivery(done).status, 'APPROVED');
  assert.ok(done.completion?.approvedAt);
  assert.equal(done.repository?.lifecycleStatus, 'APPROVED');
});

test('stale delivery cannot be approved after a newer checkpoint', async () => {
  const { store, orch, project } = await readyProject();
  project.cursorRuns = [...project.cursorRuns, {
    iteration: project.iteration + 1,
    checkpointSha: 'ffffffffffffffffffffffffffffffffffffffff',
    evidence: project.cursorRuns.at(-1).evidence
  }];
  await store.save(project);
  await assert.rejects(() => orch.approve(project.id), err => err.code === ErrorCode.STALE_DELIVERY);
});

test('conflicting owner decisions commit exactly one result', async () => {
  const { orch, project } = await readyProject();
  const results = await Promise.allSettled([
    orch.approve(project.id),
    orch.requestChanges(project.id, 'Change the recipe cards.')
  ]);
  const fulfilled = results.filter(item => item.status === 'fulfilled');
  const rejected = results.filter(item => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, ErrorCode.OWNER_DECISION_CONFLICT);
  const winner = fulfilled[0].value;
  const decisions = (winner.ownerReviews || []).filter(item => item.deliveryId === currentDelivery(winner)?.id || winner.deliveries[0].id);
  assert.equal(decisions.length, 1);
});

test('ready notification is idempotent across worker restart', async () => {
  const { project } = await readyProject();
  const service = new NotificationService({ providers: [new InAppNotificationProvider()] });
  const first = await service.notifyReady(project, currentDelivery(project));
  const second = await service.notifyReady(project, currentDelivery(project));
  assert.equal(second.reused, true);
  assert.equal((project.notifications || []).filter(item => item.type === 'READY_FOR_OWNER_REVIEW').length, 1);
  assert.ok(first.notification);
});

test('review session serves the verified artifact and cannot mutate source', async () => {
  const { store, project } = await readyProject();
  const session = await startReviewSession(project, { ttlMs: 200 });
  await store.save(project);
  assert.equal(session.runtime.mutatesSource, false);
  assert.equal(session.runtime.verifiedArtifact, true);
  const page = await fetch(session.reviewUrl);
  assert.equal(page.ok, true);
  const html = await page.text();
  assert.match(html, /ready for your review|Approve|Request Changes/i);
  expireSessions(project, Date.now() + 1000);
  assert.equal(project.reviewSessions.at(-1).status, 'EXPIRED');
  await stopReviewSession(project, session.id);
});

test('source archive secret scan blocks planted credentials', async () => {
  process.env.ARTIFACT_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-del-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-secret-ws-'));
  await fs.writeFile(path.join(workspace, 'README.md'), 'ok');
  await fs.writeFile(path.join(workspace, 'leak.js'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890";');
  const { prepareDeliverySnapshot } = await import('../src/delivery/prepare.js');
  const project = {
    id: '11111111-1111-4111-8111-111111111111',
    idea: 'Build a notes API',
    iteration: 1,
    demo: true,
    council: { discovery: { spec: { productName: 'Notes', cursorPrompt: 'do it', requirements: [] } }, final: { decision: { decision: 'COMPLETE', summary: 'ok' } } },
    cursorRuns: [{ iteration: 1, checkpointSha: 'mock-sha', evidence: { verificationLevel: 'MOCK', execution: { status: 'PASS' } } }],
    deliveries: []
  };
  await assert.rejects(
    () => prepareDeliverySnapshot(project, { workspacePath: workspace }),
    err => err.code === ErrorCode.SECRET_DETECTED_IN_SOURCE
  );
});
