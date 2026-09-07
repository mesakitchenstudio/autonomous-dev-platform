import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationStatus } from '../../src/db/migrate.js';
import { MIGRATION_ID } from '../../src/db/schema.js';
import { pgDurable, recordEvidence } from './harness.js';

const EXPECTED_TABLES = [
  'schema_migrations', 'projects', 'state_transitions', 'operations',
  'council_rounds', 'council_artifacts', 'cursor_runs', 'evidence_records',
  'error_records', 'events', 'jobs', 'json_imports', 'project_repositories',
  'verification_runs', 'verification_steps', 'verification_artifacts',
  'runtime_verification_runs', 'runtime_scenarios', 'screenshots',
  'accessibility_findings',   'visual_review_runs', 'visual_findings', 'worker_capabilities',
  'project_components', 'provisioning_plans', 'provisioning_runs', 'provisioning_steps',
  'sandbox_runs', 'sandbox_events', 'secret_references', 'secret_leases',
  'security_findings', 'security_events', 'owner_tokens', 'owner_sessions',
  'project_security_policies', 'temporary_project_resources'
];

const EXPECTED_JOB_INDEXES = [
  'jobs_one_active_per_project',
  'jobs_active_idempotency',
  'jobs_claim_idx',
  'jobs_lease_idx'
];

test('migrations execute on a clean PostgreSQL database and are idempotent', async () => {
  const { adapter, redactedUrl } = await pgDurable({ reset: true });
  try {
    const version = await adapter.query('SELECT version() AS version');
    const tables = await adapter.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`);
    const names = tables.rows.map(row => row.tablename);
    for (const table of EXPECTED_TABLES) {
      assert.ok(names.includes(table), `missing table ${table}`);
    }

    const indexes = await adapter.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'jobs'`);
    const indexNames = indexes.rows.map(row => row.indexname);
    for (const name of EXPECTED_JOB_INDEXES) {
      assert.ok(indexNames.includes(name), `missing job index ${name}`);
    }

    const active = indexes.rows.find(row => row.indexname === 'jobs_one_active_per_project');
    const idem = indexes.rows.find(row => row.indexname === 'jobs_active_idempotency');
    const claim = indexes.rows.find(row => row.indexname === 'jobs_claim_idx');
    assert.match(active.indexdef, /UNIQUE/i);
    assert.match(active.indexdef, /QUEUED/);
    assert.match(active.indexdef, /RUNNING/);
    assert.match(idem.indexdef, /UNIQUE/i);
    assert.match(idem.indexdef, /idempotency_key/);
    assert.match(claim.indexdef, /priority/);
    assert.match(claim.indexdef, /created_at/);

    const status = await migrationStatus(adapter);
    assert.ok(status.some(item => item.id === MIGRATION_ID));
    assert.ok(status.some(item => item.id === '002_phase4_cursor'));
    assert.ok(status.some(item => item.id === '003_phase5_platform_verification'));
    assert.ok(status.some(item => item.id === '004_phase6_runtime_visual'));
    assert.ok(status.some(item => item.id === '005_phase7_provisioning'));
    assert.ok(status.some(item => item.id === '006_phase8_security'));

    const second = await migrate(adapter);
    assert.equal(second.applied, false);
    const third = await migrate(adapter);
    assert.equal(third.applied, false);
    const after = await migrationStatus(adapter);
    assert.equal(after.filter(item => item.id === MIGRATION_ID).length, 1);

    await recordEvidence({
      migrations: {
        version: version.rows[0].version,
        connection: redactedUrl,
        tables: names,
        jobIndexes: indexes.rows.map(row => ({ name: row.indexname, def: row.indexdef })),
        rerunApplied: second.applied
      }
    });
  } finally {
    await adapter.close();
  }
});
