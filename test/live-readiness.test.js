import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCursorClient } from '../src/cursor/index.js';
import { CursorAcpClient } from '../src/cursor/acp-client.js';
import { resolveSandboxPolicy } from '../src/sandbox/policy.js';
import { createSecretBroker } from '../src/secrets/broker.js';
import { ErrorCode } from '../src/orchestrator/errors.js';
import { checkLiveReadiness } from '../src/readiness/live.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function liveEnv(overrides = {}) {
  return {
    DEMO_MODE: 'false',
    NODE_ENV: 'production',
    STRICT_COUNCIL: 'true',
    MIN_COUNCIL_RESPONSES: '4',
    CURSOR_MODE: 'acp',
    SANDBOX_BACKEND: 'auto',
    SECURITY_PROFILE: 'STANDARD',
    SECRET_BROKER: 'encrypted-local',
    OWNER_AUTH_MODE: 'token',
    ...overrides
  };
}

test('CURSOR_MODE=mock cannot start an ordinary live runtime', () => {
  assert.throws(
    () => createCursorClient({ env: liveEnv({ CURSOR_MODE: 'mock' }) }),
    err => err.code === ErrorCode.MOCK_BACKEND_NOT_ALLOWED
  );
});

test('MockCursor remains available in DEMO_MODE', () => {
  const client = createCursorClient({ env: liveEnv({ DEMO_MODE: 'true', CURSOR_MODE: 'mock' }), demo: true });
  assert.equal(client.constructor.name, 'MockCursorClient');
});

test('MockSandbox cannot start a real STANDARD runtime', () => {
  assert.throws(
    () => resolveSandboxPolicy({ env: liveEnv({ SANDBOX_BACKEND: 'mock', SECURITY_PROFILE: 'STANDARD' }) }),
    err => err.code === ErrorCode.MOCK_BACKEND_NOT_ALLOWED || err.code === ErrorCode.SANDBOX_INFRASTRUCTURE_UNAVAILABLE
  );
});

test('MockSecretBroker cannot start a real runtime', () => {
  assert.throws(
    () => createSecretBroker({ kind: 'mock', env: liveEnv() }),
    err => err.code === ErrorCode.MOCK_BACKEND_NOT_ALLOWED
  );
});

test('missing ACP executable returns a structured error instead of crashing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-acp-missing-'));
  const client = new CursorAcpClient({
    bin: path.join(cwd, 'adp-missing-agent-xyz'),
    timeoutMs: 4000
  });
  await assert.rejects(
    () => client.run({ cwd, prompt: 'hello', workspace: { workspacePath: cwd } }),
    err => err.code === ErrorCode.CURSOR_EXECUTABLE_UNAVAILABLE && /adp-missing-agent-xyz/.test(err.message)
  );
});

test('ACP authentication failure is structured and does not fall back to mock', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-acp-auth-'));
  const fixture = path.join(root, 'test', 'fixtures', 'fake-acp-unauth.js');
  const client = new CursorAcpClient({
    bin: process.execPath,
    extraArgs: [fixture],
    timeoutMs: 8000
  });
  await assert.rejects(
    () => client.run({ cwd, prompt: 'hello', workspace: { workspacePath: cwd } }),
    err => err.code === ErrorCode.CURSOR_AUTH_FAILURE && err.name === 'PlatformError'
  );
});

test('migrate script does not initialize AI providers', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'migrate.js'), 'utf8');
  assert.doesNotMatch(source, /createRuntime|createProviders/);
  assert.match(source, /migrateFromUrl/);
});

test('package.json exposes readiness:live', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['readiness:live'], 'node scripts/readiness-live.js');
});

test('live readiness never prints secrets and exits non-zero when blockers remain', async () => {
  const env = liveEnv({
    OPENAI_API_KEY: 'sk-secret-must-not-appear-in-report',
    ANTHROPIC_API_KEY: 'sk-ant-secret-must-not-appear',
    OWNER_TOKEN_BOOTSTRAP: 'live-bootstrap-secret-value-xyz'
  });
  const result = await checkLiveReadiness({
    env,
    skipDotEnv: true,
    argv: [],
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, role: 'combined', demo: true, engine: 'json-demo' }) })
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /AUTONOMOUS DEVELOPMENT PLATFORM — LIVE READINESS/);
  assert.match(result.text, /LIVE PLATFORM NOT READY/);
  assert.match(result.text, /Port 4317 currently hosts DEMO/);
  assert.equal(result.text.includes('sk-secret-must-not-appear-in-report'), false);
  assert.equal(result.text.includes('sk-ant-secret-must-not-appear'), false);
  assert.equal(result.text.includes('live-bootstrap-secret-value-xyz'), false);
  assert.match(result.text, /Mock \/ Demo Safety/);
  assert.match(result.text, /json-demo|DATABASE_URL/);
});

test('live readiness fails DEMO_MODE and mock backends', async () => {
  const result = await checkLiveReadiness({
    env: liveEnv({
      DEMO_MODE: 'true',
      CURSOR_MODE: 'mock',
      SANDBOX_BACKEND: 'mock',
      SECRET_BROKER: 'mock',
      OWNER_TOKEN_BOOTSTRAP: 'adp-demo-owner-token'
    }),
    skipDotEnv: true,
    argv: []
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /DEMO_MODE/);
  assert.match(result.text, /MockCursor|MockSandbox|MockSecretBroker|adp-demo-owner-token|demo-only/i);
});
