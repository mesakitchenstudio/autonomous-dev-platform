import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCookieSession, sessionCookieHeaders, applyCsrf, authenticateRequest, applyCors } from '../../src/auth/http.js';
import { resetAuthTokensForTests, bootstrapOwnerToken, hashToken, listTokenMetadata } from '../../src/auth/tokens.js';
import { SecurityRole } from '../../src/security/kinds.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = process.env.OWNER_TOKEN_BOOTSTRAP || 'adp-ci-owner-token';

async function waitForHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('control plane did not become healthy');
}

test('live control-plane HTTP auth, CORS, and sanitized health/ready', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-live-api-'));
  const port = 4800 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['scripts/demo.js'], {
    cwd: root,
    env: {
      ...process.env,
      DEMO_MODE: 'true',
      APP_ROLE: 'api',
      OWNER_TOKEN_BOOTSTRAP: TOKEN,
      SECURITY_PROFILE: 'DEVELOPMENT',
      SECRET_MASTER_KEY: process.env.SECRET_MASTER_KEY || '00'.repeat(32),
      PORT: String(port),
      PGLITE_DATA_DIR: path.join(dir, 'pg'),
      DATA_DIR: dir,
      WORKSPACE_DIR: path.join(dir, 'ws'),
      IMPORT_JSON_ON_START: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const health = await waitForHealth(port);
    assert.equal(health.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(health, 'OPENAI_API_KEY'), false);
    const ready = await fetch(`http://127.0.0.1:${port}/ready`).then(item => item.json());
    assert.equal(ready.ok, true);
    assert.ok(ready.engine);
    assert.equal(ready.jobs, undefined);

    const createUnauth = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'should fail' })
    });
    assert.equal(createUnauth.status, 401);

    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ idea: 'live auth pantry' })
    }).then(async res => ({ status: res.status, body: await res.json() }));
    assert.equal(created.status, 202);
    assert.ok(created.body.id);

    const retryUnauth = await fetch(`http://127.0.0.1:${port}/api/projects/${created.body.id}/retry`, { method: 'POST' });
    assert.equal(retryUnauth.status, 401);
    const exportUnauth = await fetch(`http://127.0.0.1:${port}/api/projects/${created.body.id}/export`);
    assert.equal(exportUnauth.status, 401);
    const invalid = await fetch(`http://127.0.0.1:${port}/api/projects/${created.body.id}`, {
      headers: { authorization: 'Bearer not-the-token' }
    });
    assert.equal(invalid.status, 401);

    const exportOk = await fetch(`http://127.0.0.1:${port}/api/projects/${created.body.id}/export`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(exportOk.status, 200);
    const dump = await exportOk.json();
    const exported = JSON.stringify(dump);
    assert.doesNotMatch(exported, /adp-ci-owner-token|adp-demo-owner-token/);
    for (const name of ['SECRET_MASTER_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']) {
      const planted = process.env[name];
      if (planted) assert.equal(exported.includes(planted), false, `${name} must be absent from export`);
    }

    const other = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ idea: 'live auth sibling' })
    }).then(item => item.json());
    const forged = await fetch(`http://127.0.0.1:${port}/api/projects/${other.id}/artifacts/${created.body.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.ok(forged.status === 404 || forged.status === 403 || forged.status === 500);
    const traversal = await fetch(`http://127.0.0.1:${port}/api/projects/${created.body.id}/artifacts/..%2F..%2Fetc%2Fpasswd`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.ok(traversal.status === 404 || traversal.status === 403 || traversal.status === 500);

    for (let i = 0; i < 8; i += 1) {
      const poll = await fetch(`http://127.0.0.1:${port}/api/projects/${created.body.id}`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      });
      assert.equal(poll.status, 200);
    }

    let saw429 = false;
    for (let i = 0; i < 12; i += 1) {
      const denied = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer not-the-token',
          'x-forwarded-for': '203.0.113.88'
        },
        body: JSON.stringify({ idea: 'rate-limit probe' })
      });
      if (denied.status === 429) saw429 = true;
    }
    assert.equal(saw429, true);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
  }
});

test('cookie CSRF is required for cookie writes and CORS is origin-restricted', () => {
  resetAuthTokensForTests();
  bootstrapOwnerToken({ OWNER_TOKEN_BOOTSTRAP: TOKEN });
  const session = createCookieSession({ role: SecurityRole.OWNER });
  const headers = sessionCookieHeaders(session);
  assert.match(headers[0], /HttpOnly/);
  assert.match(headers[0], /SameSite=Lax/);
  const auth = authenticateRequest({
    headers: { cookie: `adp_session=${session.id}` }
  });
  assert.equal(auth.ok, true);
  assert.equal(applyCsrf({ method: 'POST', headers: { origin: 'http://127.0.0.1:4317' } }, auth), false);
  assert.equal(applyCsrf({
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:4317', 'x-csrf-token': session.csrf }
  }, auth), true);
  assert.equal(applyCsrf({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }, {
    ok: true,
    via: 'bearer',
    role: SecurityRole.OWNER
  }), true);
  const denied = {};
  applyCors({ headers: { origin: 'https://evil.example' } }, { setHeader(k, v) { denied[k.toLowerCase()] = v; } }, {
    ALLOWED_ORIGINS: 'http://127.0.0.1:4317'
  });
  assert.equal(denied['access-control-allow-origin'], undefined);
  const hashes = listTokenMetadata();
  assert.ok(hashes.every(item => item.hash == null));
  assert.notEqual(hashToken(TOKEN), TOKEN);
});
