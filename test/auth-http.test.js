import './security-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyCors, authenticateRequest, limitSensitive } from '../src/auth/http.js';
import { resetAuthTokensForTests, bootstrapOwnerToken } from '../src/auth/tokens.js';
import { resetRateLimitsForTests } from '../src/auth/rate-limit.js';
import { ownerAuthHeaders } from './security-env.js';

function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(key, value) { headers[key.toLowerCase()] = value; }
  };
}

test('CORS is origin-restricted and never star', () => {
  const res = fakeRes();
  applyCors({ headers: { origin: 'https://evil.example' } }, res, { ALLOWED_ORIGINS: 'http://127.0.0.1:4317' });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  applyCors({ headers: { origin: 'http://127.0.0.1:4317' } }, res, { ALLOWED_ORIGINS: 'http://127.0.0.1:4317' });
  assert.equal(res.headers['access-control-allow-origin'], 'http://127.0.0.1:4317');
});

test('repeated auth failures are rate limited', () => {
  resetRateLimitsForTests();
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' } };
  let blocked = false;
  for (let i = 0; i < 12; i += 1) {
    const result = limitSensitive(req, 'auth');
    if (!result.ok) blocked = true;
  }
  assert.equal(blocked, true);
});

test('health-shaped handler stays reachable without a token', async () => {
  resetAuthTokensForTests();
  bootstrapOwnerToken({ OWNER_TOKEN_BOOTSTRAP: process.env.OWNER_TOKEN_BOOTSTRAP });
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const auth = authenticateRequest(req);
    res.writeHead(auth.ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: auth.ok }));
  });
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(item => item.json());
    assert.equal(health.ok, true);
    const denied = await fetch(`http://127.0.0.1:${port}/api`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/api`, { headers: ownerAuthHeaders() });
    assert.equal(allowed.status, 200);
  } finally {
    server.close();
  }
});
