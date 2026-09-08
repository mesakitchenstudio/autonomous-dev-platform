import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectState } from '../../src/orchestrator/states.js';
import { currentDelivery } from '../../src/delivery/lineage.js';
import { OwnerDecision } from '../../src/delivery/kinds.js';
import { pgDurable, pgOrchestrator, pgWorker, waitForProject, truncateAppTables } from './harness.js';

test('Phase 9 delivery, notification, request changes, and approval persist in PostgreSQL', async () => {
  const { adapter, store, queue } = await pgDurable({ truncate: true, leaseMs: 30000 });
  let worker;
  try {
    await truncateAppTables(adapter);
    const { orchestrator } = pgOrchestrator(store, queue, { demo: true });
    worker = pgWorker(store, queue, orchestrator);
    await worker.start();
    const created = await orchestrator.submit({ idea: 'Build a recipe notebook' });
    const ready = await waitForProject(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW, 40000);
    assert.equal(currentDelivery(ready).status, 'READY');
    assert.equal((ready.notifications || []).length >= 1, true);
    const tables = await adapter.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    for (const name of ['delivery_snapshots', 'delivery_artifacts', 'owner_reviews', 'owner_notifications', 'notification_deliveries', 'review_sessions']) {
      assert.ok(tables.rows.some(row => row.tablename === name), name);
    }
    const current = await adapter.query('SELECT COUNT(*)::int AS n FROM delivery_snapshots WHERE project_id = $1 AND current', [created.id]);
    assert.equal(current.rows[0].n, 1);
    await worker.stop();
    worker = null;
    const afterFeedback = await orchestrator.requestChanges(created.id, 'Change the recipe cards.');
    assert.equal(currentDelivery(afterFeedback)?.status, 'SUPERSEDED');
    assert.ok(afterFeedback.ownerReviews.some(item => item.decision === OwnerDecision.CHANGES_REQUESTED));
    await assert.rejects(() => orchestrator.approve(created.id));
    const decisions = await adapter.query('SELECT decision FROM owner_reviews WHERE project_id = $1 ORDER BY created_at', [created.id]);
    assert.deepEqual(decisions.rows.map(row => row.decision), ['CHANGES_REQUESTED']);
    const exported = await store.exportProject(created.id);
    assert.ok(exported.deliveries?.length >= 1);
    assert.ok(exported.ownerReviews?.some(item => item.decision === 'CHANGES_REQUESTED'));
    assert.equal(JSON.stringify(exported).includes('adp-demo-owner-token'), false);
  } finally {
    if (worker) await worker.stop().catch(() => {});
    await adapter.close().catch(() => {});
  }
});
