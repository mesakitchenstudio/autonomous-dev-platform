import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationStatus } from '../../src/db/migrate.js';
import { PHASE6_MIGRATION_ID } from '../../src/db/schema-phase6.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { JobType } from '../../src/jobs/types.js';
import { pgDurable } from './harness.js';

const PHASE6_TABLES = [
  'runtime_verification_runs',
  'runtime_scenarios',
  'runtime_steps',
  'screenshots',
  'accessibility_findings',
  'visual_review_runs',
  'visual_findings',
  'worker_capabilities'
];

test('Phase 6 migrations and capability-aware claiming run on real PostgreSQL', async () => {
  const { adapter, store } = await pgDurable({ reset: true });
  try {
    await migrate(adapter);
    const status = await migrationStatus(adapter);
    assert.ok(status.some(item => item.id === PHASE6_MIGRATION_ID));
    const tables = await adapter.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`);
    const names = tables.rows.map(row => row.tablename);
    for (const table of PHASE6_TABLES) {
      assert.ok(names.includes(table), `missing ${table}`);
    }
    const column = await adapter.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'jobs' AND column_name = 'required_capabilities'`);
    assert.equal(column.rows.length, 1);

    const project = await store.create({ idea: 'phase6 pg', projectPath: '/tmp/x', demo: true });
    const queue = new JobQueue(adapter);
    await queue.enqueue(project, {
      jobType: JobType.RUNTIME_VERIFICATION,
      phase: JobType.RUNTIME_VERIFICATION,
      iteration: 1,
      idempotencyKey: `project:${project.id}:runtime:pg-ios`,
      requiredCapabilities: ['MACOS', 'IOS_SIMULATOR']
    });
    const windows = await queue.claim('windows-worker', ['WEB_CHROMIUM']);
    assert.equal(windows, null);
    const mac = await queue.claim('mac-worker', ['MACOS', 'IOS_SIMULATOR', 'WEB_CHROMIUM']);
    assert.ok(mac);
    assert.deepEqual(mac.requiredCapabilities, ['MACOS', 'IOS_SIMULATOR']);
  } finally {
    await adapter.close();
  }
});
