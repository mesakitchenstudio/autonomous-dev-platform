import test from 'node:test';
import assert from 'node:assert/strict';
import { pgDurable, recordEvidence } from './harness.js';
import { PHASE8_MIGRATION_ID } from '../../src/db/schema-phase8.js';
import { migrationStatus } from '../../src/db/migrate.js';
import { SecretClass } from '../../src/security/kinds.js';

test('Phase 8 security tables persist metadata without secret values', async () => {
  const { adapter, store } = await pgDurable({ truncate: true });
  try {
    const status = await migrationStatus(adapter);
    assert.ok(status.some(item => item.id === PHASE8_MIGRATION_ID));
    const created = await store.create({ idea: 'Phase 8 security persistence', projectPath: '/repo', demo: true });
    created.securityPolicy = { profile: 'DEVELOPMENT', requiredSandboxMode: 'LOCAL_DEVELOPMENT_UNSAFE', aiEditable: false };
    created.sandboxRuns = [{
      sandboxRunId: '11111111-1111-4111-8111-111111111111',
      iteration: 1,
      backend: 'LOCAL_UNSAFE',
      mode: 'LOCAL_DEVELOPMENT_UNSAFE',
      status: 'COMPLETED',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    }];
    created.securityFindings = [];
    created.secretReferences = [{ secretRef: 'project/' + created.id + '/runtime/API_TOKEN', class: SecretClass.PROJECT_RUNTIME_SECRET }];
    await store.save(created);
    const dump = await store.exportProject(created.id);
    assert.equal(dump.securityPolicy.profile, 'DEVELOPMENT');
    assert.ok(dump.sandboxRuns.length >= 1);
    assert.doesNotMatch(JSON.stringify(dump), /SECRET_MASTER_KEY\s*[:=]\s*[^"\s]{8,}/);
    await recordEvidence({ phase8: { projectId: created.id, sandboxRuns: dump.sandboxRuns.length } });
  } finally {
    await adapter.close();
  }
});

test('Phase 8 secret tables have no plaintext value columns', async () => {
  const { adapter } = await pgDurable({ truncate: true });
  try {
    const columns = await adapter.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'secret_references','secret_leases','security_events','security_findings',
          'owner_tokens','owner_sessions','sandbox_runs','project_security_policies'
        )
      ORDER BY table_name, column_name`);
    const names = columns.rows.map(row => `${row.table_name}.${row.column_name}`);
    assert.ok(names.includes('owner_tokens.token_hash'));
    assert.ok(!names.some(name => /\.(value|secret|password|token)$/i.test(name) && !name.endsWith('token_hash')));
    assert.ok(names.includes('secret_references.secret_ref'));
    assert.ok(names.includes('secret_leases.lease_id'));
  } finally {
    await adapter.close();
  }
});
