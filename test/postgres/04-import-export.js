import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importJsonProjects } from '../../src/storage/json-import.js';
import { createProjectRecord } from '../../src/storage/json-store.js';
import { ProjectState } from '../helpers.js';
import { specFixture } from '../helpers.js';
import { pgDurable, pgOrchestrator, pgWorker, recordEvidence, redactDatabaseUrl, truncateAppTables, waitForProject } from './harness.js';

test('legacy JSON import against PostgreSQL preserves records and is idempotent', async () => {
  const { adapter, store } = await pgDurable();
  try {
    await truncateAppTables(adapter);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-pg-json-'));
    const project = createProjectRecord({ idea: 'Imported PostgreSQL idea', demo: true });
    project.state = ProjectState.COUNCIL_REVIEW;
    project.iteration = 1;
    project.history = [{ at: '2026-01-01T00:00:00.000Z', from: 'IDEA_SUBMITTED', to: 'COUNCIL_DISCOVERY', note: 'go' }];
    project.council.discovery = {
      spec: specFixture(),
      chair: 'openai',
      failures: [],
      history: [{ id: 'r1', purpose: 'independent_analysis', phase: 'COUNCIL_DISCOVERY', at: '2026-01-01T00:00:00.000Z' }]
    };
    project.cursorRuns = [{
      iteration: 1,
      result: { output: 'done' },
      evidence: { verificationLevel: 'MOCK', execution: { status: 'PASS', provenance: 'MOCK' } }
    }];
    project.errors = [{
      code: 'PROVIDER_TIMEOUT', message: 'slow', phase: 'COUNCIL_DISCOVERY',
      retryable: true, at: '2026-01-01T00:00:01.000Z', details: {}
    }];
    await fs.writeFile(path.join(dir, `${project.id}.json`), JSON.stringify(project, null, 2));

    const first = await importJsonProjects(store, dir, { logger: { log() {} } });
    const second = await importJsonProjects(store, dir, { logger: { log() {} } });
    assert.equal(first[0].status, 'imported');
    assert.equal(first[0].id, project.id);
    assert.equal(second[0].status, 'already_imported');

    const loaded = await store.get(project.id);
    assert.equal(loaded.idea, 'Imported PostgreSQL idea');
    assert.equal(loaded.id, project.id);
    assert.equal(loaded.state, ProjectState.COUNCIL_REVIEW);
    assert.equal(loaded.history[0].to, 'COUNCIL_DISCOVERY');
    assert.ok(loaded.council.discovery.spec.cursorPrompt);
    assert.equal(loaded.cursorRuns.length, 1);
    assert.equal(loaded.errors[0].code, 'PROVIDER_TIMEOUT');

    const rounds = await adapter.query('SELECT * FROM council_rounds WHERE project_id = $1', [project.id]);
    const artifacts = await adapter.query('SELECT * FROM council_artifacts WHERE project_id = $1', [project.id]);
    const runs = await adapter.query('SELECT * FROM cursor_runs WHERE project_id = $1', [project.id]);
    const errors = await adapter.query('SELECT * FROM error_records WHERE project_id = $1', [project.id]);
    const transitions = await adapter.query('SELECT * FROM state_transitions WHERE project_id = $1', [project.id]);
    const imports = await adapter.query('SELECT * FROM json_imports WHERE project_id = $1', [project.id]);
    assert.ok(artifacts.rows.length >= 1);
    assert.equal(runs.rows.length, 1);
    assert.equal(errors.rows.length, 1);
    assert.ok(transitions.rows.length >= 1);
    assert.equal(imports.rows.length, 1);
    assert.ok(rounds.rows.length >= 1 || loaded.council.discovery.history.length >= 1);

    await recordEvidence({
      legacyImport: {
        projectId: project.id,
        first: first[0].status,
        second: second[0].status,
        councilArtifacts: artifacts.rows.length,
        cursorRuns: runs.rows.length
      }
    });
  } finally {
    await adapter.close();
  }
});

test('project export contains durable history and does not expose secrets', async () => {
  const { adapter, store, queue, url } = await pgDurable();
  try {
    await truncateAppTables(adapter);
    const { orchestrator } = pgOrchestrator(store, queue);
    const project = await orchestrator.submit({ idea: 'export secrets check' });
    const worker = pgWorker(store, queue, orchestrator);
    await worker.start();
    await waitForProject(store, project.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW);
    await worker.stop();

    const dump = await store.exportProject(project.id);
    assert.ok(dump.project);
    assert.ok(Array.isArray(dump.transitions) && dump.transitions.length);
    assert.ok(Array.isArray(dump.operations) && dump.operations.length);
    assert.ok(dump.council?.discovery || dump.council);
    assert.ok(Array.isArray(dump.cursorRuns) && dump.cursorRuns.length);
    assert.ok(dump.evidence);
    assert.ok(Array.isArray(dump.errors) || dump.errors);
    assert.ok(Array.isArray(dump.events));

    const serialized = JSON.stringify(dump);
    const password = new URL(url).password;
    const planted = [
      password,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.GEMINI_API_KEY,
      process.env.XAI_API_KEY,
      process.env.CURSOR_API_KEY,
      process.env.CURSOR_AUTH_TOKEN,
      'sk-secret-must-not-appear'
    ].filter(Boolean);
    for (const secret of planted) {
      assert.equal(serialized.includes(secret), false, 'export must not contain secrets');
    }
    assert.equal(serialized.includes(redactDatabaseUrl(url).split('[redacted]')[0] + password), false);

    await recordEvidence({
      exportCheck: {
        projectId: project.id,
        hasTransitions: dump.transitions.length,
        hasOperations: dump.operations.length,
        hasEvents: dump.events.length,
        secretsAbsent: true
      }
    });
  } finally {
    await adapter.close();
  }
});
