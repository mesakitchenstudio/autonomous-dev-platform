import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGlite } from '../src/db/adapter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('demo launch mechanism does not depend on POSIX env assignment syntax', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.demo, 'node scripts/demo.js');
  assert.doesNotMatch(pkg.scripts.demo, /DEMO_MODE=true node/);
  const launcher = fs.readFileSync(path.join(root, 'scripts/demo.js'), 'utf8');
  assert.match(launcher, /DEMO_MODE/);
  assert.match(launcher, /server\.js/);
  assert.doesNotMatch(launcher, /DEMO_MODE=true node/);
});

test('gitignore keeps runtime data and secrets out of version control', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const line of ['.env', '.env.*', 'data/', 'workspaces/', 'node_modules/', '.pglite/', '.adp-secrets/']) {
    assert.ok(ignore.includes(line), `missing ${line}`);
  }
  assert.ok(ignore.includes('!.env.example'));
});

test('README distinguishes demo local persistence from production PostgreSQL', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /Demo uses local\/demo persistence/);
  assert.match(readme, /Production uses PostgreSQL/);
  assert.doesNotMatch(readme, /default demo when `DATABASE_URL` is unset/);
});

test('DEMO_MODE without DATABASE_URL uses JsonStore instead of PGlite', async () => {
  const prevUrl = process.env.DATABASE_URL;
  const prevData = process.env.DATA_DIR;
  const prevWs = process.env.WORKSPACE_DIR;
  const prevDemo = process.env.DEMO_MODE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-json-demo-'));
  delete process.env.DATABASE_URL;
  process.env.DEMO_MODE = 'true';
  process.env.DATA_DIR = dir;
  process.env.WORKSPACE_DIR = path.join(dir, 'ws');
  const { createRuntime } = await import('../src/app/runtime.js');
  const runtime = await createRuntime({ role: 'api', demo: true });
  try {
    assert.equal(runtime.engine, 'json-demo');
    assert.equal(runtime.queue, null);
    assert.equal(runtime.adapter, null);
    const created = await runtime.store.create({ idea: 'json demo export', demo: true });
    const dumped = await runtime.store.exportProject(created.id);
    assert.equal(dumped.id, created.id);
    assert.equal(dumped.idea, 'json demo export');
  } finally {
    await runtime.close();
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    if (prevData === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevData;
    if (prevWs === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prevWs;
    if (prevDemo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prevDemo;
  }
});

test('createPGlite creates missing parent directories before opening the store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-pglite-'));
  const dataDir = path.join(dir, 'nested', 'demo');
  const db = await createPGlite(dataDir);
  try {
    const result = await db.query('select 1 as ok');
    assert.equal(Number(result.rows[0].ok), 1);
    assert.ok(fs.existsSync(dataDir));
  } finally {
    if (typeof db.close === 'function') await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
