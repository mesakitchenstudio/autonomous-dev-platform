import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectArchiveEntries } from '../src/delivery/archive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'adp-demo-owner-token';
const RECIPE = 'Build a simple recipe web application where users can browse recipes, search recipes, open recipe details, save recipes to favorites, and create a simple weekly meal plan.';
const FEEDBACK = 'Make the homepage less busy and use larger recipe images.';
const MAX_HTTP_MS = 3000;
const MAX_LOOP_DELAY_MS = 2500;

function spawnDemo({ port, dataDir }) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawn(process.execPath, ['scripts/demo.js'], {
    cwd: root,
    env: {
      ...env,
      DEMO_MODE: 'true',
      APP_ROLE: 'combined',
      OWNER_TOKEN_BOOTSTRAP: TOKEN,
      SECURITY_PROFILE: 'DEVELOPMENT',
      SECRET_MASTER_KEY: '00'.repeat(32),
      PORT: String(port),
      DATA_DIR: dataDir,
      WORKSPACE_DIR: path.join(dataDir, 'ws'),
      ARTIFACT_ROOT: path.join(dataDir, 'artifacts')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

async function waitHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return res.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`demo server on ${port} did not become healthy`);
}

async function timedGet(url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body: await res.json().catch(() => null) };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: error.name || error.message };
  }
}

test('Request Changes to v2 keeps the demo HTTP event loop interactive', { timeout: 120_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-resp-'));
  const port = 14600 + Math.floor(Math.random() * 200);
  const child = spawnDemo({ port, dataDir: dir });
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  try {
    const health = await waitHealth(port);
    assert.equal(health.engine, 'json-demo');
    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ idea: RECIPE })
    }).then(res => res.json());
    assert.ok(created.id);

    let project;
    for (let i = 0; i < 90; i += 1) {
      const ping = await timedGet(`http://127.0.0.1:${port}/health`);
      assert.equal(ping.ok, true, `v1 health failed after ${ping.ms}ms`);
      assert.ok(ping.ms < MAX_HTTP_MS, `v1 health blocked the event loop (${ping.ms}ms)`);
      project = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
        headers: auth,
        signal: AbortSignal.timeout(8000)
      }).then(res => res.json());
      if (project.state === 'READY_FOR_OWNER_REVIEW' || project.state === 'FAILED') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(project.state, 'READY_FOR_OWNER_REVIEW', JSON.stringify(project.error || project.state));
    assert.equal(project.delivery?.version, 1);

    const samples = [];
    const loopDelays = [];
    let expected = Date.now() + 50;
    const beat = setInterval(() => {
      const now = Date.now();
      loopDelays.push(now - expected);
      expected = now + 50;
    }, 50);

    const changeStart = Date.now();
    const changed = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}/changes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ feedback: FEEDBACK })
    });
    assert.equal(changed.status, 202);
    const afterChanges = await changed.json();
    assert.notEqual(afterChanges.state, 'READY_FOR_OWNER_REVIEW');

    for (let i = 0; i < 100; i += 1) {
      const healthPing = await timedGet(`http://127.0.0.1:${port}/health`);
      const listPing = await timedGet(`http://127.0.0.1:${port}/api/projects`, { authorization: `Bearer ${TOKEN}` });
      samples.push({ healthPing, listPing });
      assert.equal(healthPing.ok, true, `v2 health failed after ${healthPing.ms}ms (${healthPing.error || healthPing.status})`);
      assert.ok(healthPing.ms < MAX_HTTP_MS, `health blocked for ${healthPing.ms}ms during v2`);
      if (!listPing.ok) {
        const one = await timedGet(`http://127.0.0.1:${port}/api/projects/${created.id}`, { authorization: `Bearer ${TOKEN}` });
        assert.equal(one.ok, true, `project poll failed after list=${listPing.status}/${listPing.ms}ms one=${one.status}/${one.ms}ms ${one.error || ''}`);
        assert.ok(one.ms < MAX_HTTP_MS, `GET project blocked for ${one.ms}ms during v2`);
        project = one.body || project;
      } else {
        assert.ok(listPing.ms < MAX_HTTP_MS, `GET /api/projects blocked for ${listPing.ms}ms during v2`);
        project = listPing.body?.find?.(item => item.id === created.id) || project;
      }
      if (project.state === 'READY_FOR_OWNER_REVIEW' && project.delivery?.version === 2) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    clearInterval(beat);

    const v2Ms = Date.now() - changeStart;
    assert.equal(project.state, 'READY_FOR_OWNER_REVIEW');
    assert.equal(project.delivery?.version, 2);
    const v1 = (project.deliveries || []).find(item => Number(item.version) === 1);
    const v2 = (project.deliveries || []).find(item => Number(item.version) === 2);
    assert.equal(v1?.status, 'SUPERSEDED');
    assert.equal(v2?.status, 'READY');

    const healthMax = Math.max(...samples.map(item => item.healthPing.ms));
    const listMax = Math.max(...samples.map(item => item.listPing.ms));
    const delayMax = Math.max(0, ...loopDelays);
    assert.ok(healthMax < MAX_HTTP_MS, `max /health ${healthMax}ms`);
    assert.ok(listMax < MAX_HTTP_MS, `max /api/projects ${listMax}ms`);
    assert.ok(delayMax < MAX_LOOP_DELAY_MS, `event-loop heartbeat delayed ${delayMax}ms`);
    assert.ok(v2Ms < 60000, `v2 took ${v2Ms}ms`);

    const archive = (v2.artifacts || []).find(item => item.kind === 'SOURCE_ARCHIVE');
    assert.ok(archive?.sha256);
    assert.equal(v2.manifest?.sourceArchiveSha256, archive.sha256);
    const zipRes = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}/artifacts/${archive.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(zipRes.status, 200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    const zipPath = path.join(dir, 'v2.zip');
    await fs.writeFile(zipPath, zipBuf);
    const names = inspectArchiveEntries(zipPath).map(item => item.replace(/^\.\//, '').replace(/\\/g, '/'));
    assert.ok(names.some(name => /(^|\/)index\.html$/i.test(name)), names.join(','));
    assert.ok(names.some(name => /(^|\/)app\.js$/i.test(name)), names.join(','));
    const appHtml = await fs.readFile(path.join(dir, 'artifacts', created.id, 'deliveries', 'v2', 'app', 'index.html'), 'utf8');
    assert.match(appHtml, /data-delivery-version="2"/);
    assert.match(appHtml, /\bcompact\b/);
    assert.match(appHtml, /\blarge-art\b/);

    const approved = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}/approve`, {
      method: 'POST',
      headers: auth,
      body: '{}'
    });
    assert.equal(approved.status, 200);
    const done = await approved.json();
    assert.equal(done.state, 'DONE');
    const v2After = (done.deliveries || []).find(item => Number(item.version) === 2);
    const v1After = (done.deliveries || []).find(item => Number(item.version) === 1);
    assert.equal(v2After?.status, 'APPROVED');
    assert.equal(v1After?.status, 'SUPERSEDED');
    assert.equal((done.notifications || []).filter(item => item.type === 'READY_FOR_OWNER_REVIEW' && item.deliveryVersion === 3).length, 0);
  } finally {
    killTree(child);
  }
});
