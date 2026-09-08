import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boolEnvFrom, envPresent, intEnvFrom, loadDotEnv } from '../util/env.js';
import { redactSecrets, registerSecretValue, SENSITIVE_ENV_NAMES } from '../secrets/redact.js';
import { createPgPool, PgAdapter, redactDatabaseUrl } from '../db/adapter.js';
import { MIGRATIONS, migrationStatus } from '../db/migrate.js';
import { LIVE_PROVIDER_DEFS, createLiveProviders } from '../providers/index.js';
import { resolveChairProvider, resolveModelName } from '../providers/config.js';
import { Council } from '../council/council.js';
import { createCursorClient, defaultCursorMode } from '../cursor/index.js';
import { CursorMode } from '../cursor/contract.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { discoverContainerCapabilities } from '../sandbox/discover.js';
import { SecurityProfile } from '../security/kinds.js';
import { gitOk } from '../git/exec.js';
import { createCheckpointCommit } from '../git/checkpoint.js';
import { cleanupManagedWorktree, isolateExistingRepository } from '../git/worktree.js';
import { inspectGit } from '../git/inspect.js';

export const LIVE_READY_MESSAGE = 'LIVE PLATFORM READY — SAFE TO START REAL PILOT';
export const LIVE_NOT_READY_MESSAGE = 'LIVE PLATFORM NOT READY';
const DEMO_OWNER_TOKEN = 'adp-demo-owner-token';
const EXPECTED_TABLES = [
  'jobs',
  'delivery_snapshots',
  'delivery_artifacts',
  'sandbox_runs',
  'security_events',
  'project_security_policies'
];

export const ReadinessStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_VERIFIED: 'NOT_VERIFIED'
});

const BLOCKING = new Set([
  ReadinessStatus.FAIL,
  ReadinessStatus.BLOCKED,
  ReadinessStatus.NOT_CONFIGURED,
  ReadinessStatus.NOT_VERIFIED
]);

function check(name, status, detail, extra = {}) {
  return { name, status, detail, ...extra };
}

function registerEnvSecrets(env) {
  for (const name of SENSITIVE_ENV_NAMES) {
    if (envPresent(env, name)) registerSecretValue(String(env[name]));
  }
}

function safeDetail(value) {
  return redactSecrets(String(value || ''));
}

function containsSecret(text, env) {
  const hay = String(text || '');
  for (const name of SENSITIVE_ENV_NAMES) {
    const value = env?.[name];
    if (value && String(value).trim().length >= 4 && hay.includes(String(value))) return true;
  }
  return false;
}

function parseFlags(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter(item => item.startsWith('--')));
  return {
    smoke: flags.has('--smoke') || flags.has('--full'),
    full: flags.has('--full')
  };
}

function databaseName(url) {
  try {
    const normalized = String(url).replace(/^postgres(ql)?:/i, 'http:');
    const parsed = new URL(normalized);
    return decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  } catch {
    return '';
  }
}

async function probePort(port, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function whichExecutable(bin) {
  if (!bin) return { ok: false, reason: 'no executable configured' };
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return { ok: fs.existsSync(bin), reason: fs.existsSync(bin) ? 'path exists' : 'path not found' };
  }
  const probe = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (probe.error?.code === 'ENOENT') return { ok: false, reason: 'ENOENT' };
  return { ok: probe.error == null, reason: probe.error?.message || `exit ${probe.status}` };
}

export async function checkRuntime(env) {
  const notes = [];
  if (boolEnvFrom(env, 'DEMO_MODE', false)) {
    return check('Runtime', ReadinessStatus.FAIL, 'DEMO_MODE=true selects json-demo / mock Council and cannot start a live pilot.');
  }
  const engineWouldBeJson = !envPresent(env, 'DATABASE_URL');
  if (engineWouldBeJson) {
    return check('Runtime', ReadinessStatus.FAIL, 'Without DATABASE_URL a live start is impossible; demo json-demo persistence is not a live runtime.');
  }
  notes.push('DEMO_MODE=false');
  return check('Runtime', ReadinessStatus.PASS, notes.join('; '));
}

export async function checkDatabase(env) {
  if (!envPresent(env, 'DATABASE_URL')) {
    return check('Database', ReadinessStatus.NOT_CONFIGURED, 'DATABASE_URL is not set.');
  }
  const url = env.DATABASE_URL;
  if (envPresent(env, 'TEST_DATABASE_URL') && url === env.TEST_DATABASE_URL && !boolEnvFrom(env, 'ADP_ALLOW_TEST_DATABASE', false)) {
    return check('Database', ReadinessStatus.FAIL, 'DATABASE_URL points at TEST_DATABASE_URL. Do not use the embedded/test PostgreSQL instance as the live database.');
  }
  const name = databaseName(url);
  if (/test/i.test(name) && !boolEnvFrom(env, 'ADP_ALLOW_TEST_DATABASE', false)) {
    return check('Database', ReadinessStatus.FAIL, 'DATABASE_URL database name looks like a test database. Set ADP_ALLOW_TEST_DATABASE=1 only for an intentional isolated live-check.');
  }
  const adapter = new PgAdapter(createPgPool(url));
  try {
    await adapter.ready();
    const version = await adapter.query('SELECT version() AS version');
    const engine = String(version.rows[0]?.version || '');
    if (!/postgresql/i.test(engine)) {
      return check('Database', ReadinessStatus.FAIL, 'Connected engine is not PostgreSQL.');
    }
    const applied = await migrationStatus(adapter);
    const appliedIds = new Set(applied.map(item => item.id));
    const missingMigrations = MIGRATIONS.map(item => item.id).filter(id => !appliedIds.has(id));
    if (missingMigrations.length) {
      return check('Database', ReadinessStatus.FAIL, `Expected migrations not applied: ${missingMigrations.join(', ')}.`);
    }
    const tables = await adapter.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const names = new Set(tables.rows.map(row => row.tablename));
    const missingTables = EXPECTED_TABLES.filter(table => !names.has(table));
    if (missingTables.length) {
      return check('Database', ReadinessStatus.FAIL, `Required tables missing: ${missingTables.join(', ')}.`);
    }
    return check('Database', ReadinessStatus.PASS, 'PostgreSQL connected; migrations, queue, delivery, and security tables present.');
  } catch (error) {
    return check('Database', ReadinessStatus.FAIL, redactDatabaseUrl(safeDetail(error.message || error)) || safeDetail(error.message || error));
  } finally {
    await adapter.close().catch(() => {});
  }
}

export async function checkCouncilConfig(env, { smoke = false } = {}) {
  const missing = LIVE_PROVIDER_DEFS.filter(def => !envPresent(env, def.key)).map(def => def.key);
  const perProvider = [];
  for (const def of LIVE_PROVIDER_DEFS) {
    const present = envPresent(env, def.key);
    let model = def.fallbackModel;
    try {
      model = resolveModelName(def.modelEnv, def.fallbackModel, env);
    } catch (error) {
      perProvider.push(check(def.name, ReadinessStatus.FAIL, safeDetail(error.message)));
      continue;
    }
    if (!present) {
      perProvider.push(check(def.name, ReadinessStatus.NOT_CONFIGURED, `key absent; configured model ${model} PENDING LIVE VALIDATION`));
      continue;
    }
    perProvider.push(check(def.name, ReadinessStatus.NOT_VERIFIED, `key present; model ${model} PENDING LIVE VALIDATION`));
  }

  if (smoke && missing.length === 0) {
    try {
      const live = createLiveProviders(env, { timeoutMs: 20000 });
      for (let i = 0; i < live.length; i += 1) {
        const provider = live[i];
        const def = LIVE_PROVIDER_DEFS[i];
        try {
          if (provider.constructor?.name === 'MockProvider' || provider.model === 'mock') {
            perProvider[i] = check(def.name, ReadinessStatus.FAIL, 'MockProvider is not allowed for live smoke.');
            continue;
          }
          const result = await provider.complete({
            system: 'Reply with exactly one short word. Do not include secrets.',
            prompt: 'Reply with the single word pong.'
          });
          const text = typeof result === 'string' ? result : result?.text;
          perProvider[i] = check(def.name, 'LIVE VERIFIED', `model ${provider.model}; adapter responded (${String(text || '').trim() ? 'text received' : 'empty'})`);
        } catch (error) {
          perProvider[i] = check(def.name, 'FAILED', safeDetail(error.message || error));
        }
      }
    } catch (error) {
      return {
        ...check('Council', ReadinessStatus.FAIL, safeDetail(error.message || error)),
        providers: perProvider
      };
    }
  }

  const strict = boolEnvFrom(env, 'STRICT_COUNCIL', true);
  const min = intEnvFrom(env, 'MIN_COUNCIL_RESPONSES', 4);
  const chairName = String(env.CHAIR_PROVIDER || 'openai').toLowerCase();
  const details = [];
  if (!strict) details.push('STRICT_COUNCIL is not true');
  if (min < 4) details.push(`MIN_COUNCIL_RESPONSES=${min} (live-pilot policy requires 4)`);
  if (missing.length) details.push(`missing keys: ${missing.join(', ')}`);

  const failedSmoke = perProvider.some(item => item.status === 'FAILED' || item.status === ReadinessStatus.FAIL);
  const verified = perProvider.filter(item => item.status === 'LIVE VERIFIED');
  let status = ReadinessStatus.NOT_CONFIGURED;
  if (failedSmoke) status = ReadinessStatus.FAIL;
  else if (missing.length) status = ReadinessStatus.NOT_CONFIGURED;
  else if (!strict || min < 4) status = ReadinessStatus.FAIL;
  else if (verified.length === 4) status = ReadinessStatus.PASS;
  else status = ReadinessStatus.NOT_VERIFIED;

  const chairConfigured = LIVE_PROVIDER_DEFS.some(def => def.name === chairName);
  const chair = check(
    'Chair',
    chairConfigured && envPresent(env, LIVE_PROVIDER_DEFS.find(def => def.name === chairName)?.key)
      ? (verified.length === 4 ? ReadinessStatus.PASS : ReadinessStatus.NOT_VERIFIED)
      : ReadinessStatus.NOT_CONFIGURED,
    `CHAIR_PROVIDER=${chairName || 'unset'}`
  );

  return {
    ...check('Council', status, details.join('; ') || (verified.length === 4
      ? 'FULL FOUR-MODEL COUNCIL VERIFIED'
      : 'Four provider keys present; live adapter validation PENDING LIVE VALIDATION')),
    providers: perProvider,
    chair,
    fourModelVerified: verified.length === 4 && !failedSmoke
  };
}

export async function checkCouncilSmoke(env, councilCheck) {
  if (councilCheck.status !== ReadinessStatus.PASS && councilCheck.providers?.some(item => item.status === 'LIVE VERIFIED') !== true) {
    return check('Chair', councilCheck.chair?.status || ReadinessStatus.NOT_VERIFIED, 'Council smoke skipped because providers are not live-verified.');
  }
  const live = createLiveProviders(env, { timeoutMs: 45000 });
  if (live.some(item => item.constructor?.name === 'MockProvider')) {
    return check('Chair', ReadinessStatus.FAIL, 'MockProvider participation is not allowed in live Council smoke.');
  }
  const chair = resolveChairProvider(live, env.CHAIR_PROVIDER || 'openai', env);
  const council = new Council(live, chair.name, {
    chair,
    minResponses: 4,
    timeoutMs: 45000,
    maxReasoningRounds: 1
  });
  const out = await council.discover('Design a tiny hello-world web page with one button.');
  const names = (out.analyses || []).map(item => item.provider || item.name);
  const unique = new Set(names);
  const mock = names.some(name => /mock/i.test(String(name))) || live.some(item => item.model === 'mock');
  if (mock) return check('Chair', ReadinessStatus.FAIL, 'Mock participation detected in Council smoke.');
  if (unique.size !== 4 || (out.analyses || []).length !== 4) {
    return check('Chair', ReadinessStatus.FAIL, `Live-pilot policy requires 4/4 participants; received ${unique.size}.`);
  }
  if (!out.spec || typeof out.spec.cursorPrompt !== 'string' || !out.spec.cursorPrompt.trim()) {
    return check('Chair', ReadinessStatus.FAIL, 'Chair synthesis did not produce a valid specification schema.');
  }
  return check(
    'Chair',
    ReadinessStatus.PASS,
    `FULL FOUR-MODEL COUNCIL VERIFIED; chair=${chair.name}; models=${live.map(item => `${item.name}:${item.model}`).join(',')}`
  );
}

export async function checkCursor(env, { full = false } = {}) {
  const mode = defaultCursorMode(env);
  if (mode === CursorMode.MOCK || String(env.CURSOR_MODE || '').toLowerCase() === 'mock') {
    return check('Cursor', ReadinessStatus.FAIL, 'CURSOR_MODE=mock / MockCursor is not allowed for live readiness.');
  }
  if (mode === CursorMode.CLOUD) {
    if (!envPresent(env, 'CURSOR_API_KEY') && !envPresent(env, 'CURSOR_CLOUD_API_KEY')) {
      return check('Cursor', ReadinessStatus.NOT_CONFIGURED, 'Cloud Cursor requires CURSOR_API_KEY or CURSOR_CLOUD_API_KEY.');
    }
    return check('Cursor', full ? ReadinessStatus.NOT_VERIFIED : ReadinessStatus.NOT_VERIFIED, 'Cloud Cursor credentials present; disposable-repo ACP smoke applies to CURSOR_MODE=acp.');
  }
  const bin = env.CURSOR_AGENT_BIN || 'agent';
  const found = whichExecutable(bin);
  if (!found.ok) {
    return check('Cursor', ReadinessStatus.FAIL, `CURSOR_EXECUTABLE_UNAVAILABLE (${bin}). Install the Cursor agent CLI or set CURSOR_AGENT_BIN. No MockCursor fallback.`);
  }
  const authed = envPresent(env, 'CURSOR_API_KEY') || envPresent(env, 'CURSOR_AUTH_TOKEN');
  if (!authed && !full) {
    return check('Cursor', ReadinessStatus.NOT_CONFIGURED, `executable ${bin} present; CURSOR_API_KEY / CURSOR_AUTH_TOKEN absent and agent login is unverified.`);
  }
  if (!full) {
    return check('Cursor', ReadinessStatus.NOT_VERIFIED, `ACP backend ${bin}; credentials present; disposable-repo smoke not run.`);
  }
  return runFullCursorSmoke(env, bin);
}

async function runFullCursorSmoke(env, bin) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'adp-live-cursor-src-'));
  const workspaces = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'adp-live-cursor-ws-'));
  const projectId = '00000000-0000-4000-8000-c0ffee00live';
  let repository = null;
  try {
    gitOk(['init'], { cwd: root });
    gitOk(['config', 'user.email', 'adp-readiness@local'], { cwd: root });
    gitOk(['config', 'user.name', 'ADP Readiness'], { cwd: root });
    await fs.promises.writeFile(path.join(root, 'README.md'), 'ADP live Cursor smoke\n', 'utf8');
    gitOk(['add', 'README.md'], { cwd: root });
    gitOk(['commit', '-m', 'baseline'], { cwd: root });
    gitOk(['branch', '-M', 'main'], { cwd: root });
    const project = { id: projectId, idea: 'Create hello.txt', demo: false };
    repository = await isolateExistingRepository(project, root, workspaces);
    const client = createCursorClient({
      env,
      mode: CursorMode.ACP,
      bin,
      apiKey: env.CURSOR_API_KEY,
      authToken: env.CURSOR_AUTH_TOKEN
    });
    if (client.constructor?.name === 'MockCursorClient') {
      return check('Cursor', ReadinessStatus.FAIL, 'MockCursor was selected; refusing live Cursor smoke.');
    }
    await client.run({
      projectId,
      cursorRunId: 'readiness-full',
      iteration: 1,
      prompt: 'Create a file named hello.txt containing the single word hello. Do not modify other files.',
      cwd: repository.workspacePath,
      workspace: { workspacePath: repository.workspacePath, workingBranch: repository.workingBranch }
    });
    const hello = path.join(repository.workspacePath, 'hello.txt');
    const exists = fs.existsSync(hello);
    const diff = inspectGit(repository.workspacePath);
    const checkpoint = await createCheckpointCommit(repository.workspacePath, {
      iteration: 1,
      branch: repository.workingBranch,
      workspaceRoot: workspaces
    });
    if (!exists && !diff.dirty && !checkpoint.committed) {
      return check('Cursor', ReadinessStatus.FAIL, 'Real Cursor smoke did not create hello.txt or a git diff.');
    }
    return check('Cursor', ReadinessStatus.PASS, `ACP executable ${bin}; disposable repo smoke created a checkpoint (${checkpoint.sha || diff.sha}).`);
  } catch (error) {
    const code = error instanceof PlatformError ? error.code : error?.code;
    if (code === ErrorCode.CURSOR_EXECUTABLE_UNAVAILABLE) {
      return check('Cursor', ReadinessStatus.FAIL, safeDetail(error.message));
    }
    if (code === ErrorCode.CURSOR_AUTH_FAILURE) {
      return check('Cursor', ReadinessStatus.FAIL, safeDetail(error.message));
    }
    return check('Cursor', ReadinessStatus.FAIL, safeDetail(error.message || error));
  } finally {
    if (repository) await cleanupManagedWorktree(repository, workspaces).catch(() => {});
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(workspaces, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkSandbox(env) {
  const backend = String(env.SANDBOX_BACKEND || 'auto').toLowerCase();
  if (backend === 'mock') {
    return check('Sandbox', ReadinessStatus.FAIL, 'SANDBOX_BACKEND=mock / MockSandbox cannot satisfy a real STANDARD/HARDENED runtime.');
  }
  const profile = String(env.SECURITY_PROFILE || SecurityProfile.STANDARD).toUpperCase();
  if (profile === SecurityProfile.DEVELOPMENT) {
    return check('Sandbox', ReadinessStatus.FAIL, 'SECURITY_PROFILE=DEVELOPMENT uses LOCAL_DEVELOPMENT_UNSAFE and is not a live STANDARD/HARDENED pilot.');
  }
  const discovery = discoverContainerCapabilities({ env });
  if (!discovery.available) {
    return check(
      'Sandbox',
      ReadinessStatus.BLOCKED,
      'BLOCKED — PILOT WORKER REQUIRES HARDENED CONTAINER HOST'
    );
  }
  const hint = process.platform === 'linux'
    ? 'Container engine detected. Optionally run ADP_LIVE_SANDBOX_TEST=1 npm run test:sandbox on the Linux pilot worker.'
    : 'Container engine detected.';
  return check('Sandbox', ReadinessStatus.PASS, hint);
}

export async function checkSecretBroker(env) {
  const kind = String(env.SECRET_BROKER || 'encrypted-local').toLowerCase();
  if (kind === 'mock') {
    return check('Secret Broker', ReadinessStatus.FAIL, 'MockSecretBroker cannot satisfy a live runtime.');
  }
  if (kind === 'vault') {
    if (!envPresent(env, 'VAULT_ADDR')) {
      return check('Secret Broker', ReadinessStatus.NOT_CONFIGURED, 'VAULT_ADDR is required when SECRET_BROKER=vault.');
    }
    if (!envPresent(env, 'VAULT_TOKEN') && !envPresent(env, 'VAULT_AUTH_METHOD')) {
      return check('Secret Broker', ReadinessStatus.NOT_CONFIGURED, 'Vault requires VAULT_TOKEN or VAULT_AUTH_METHOD.');
    }
    return check('Secret Broker', ReadinessStatus.PASS, 'Vault configuration present.');
  }
  if (!envPresent(env, 'SECRET_MASTER_KEY')) {
    return check('Secret Broker', ReadinessStatus.NOT_CONFIGURED, 'SECRET_MASTER_KEY is required for SECRET_BROKER=encrypted-local.');
  }
  return check('Secret Broker', ReadinessStatus.PASS, 'encrypted-local master key is present.');
}

export async function checkOwnerAuth(env) {
  const mode = String(env.OWNER_AUTH_MODE || 'token').toLowerCase();
  if (mode && mode !== 'token') {
    return check('Owner Authentication', ReadinessStatus.FAIL, `OWNER_AUTH_MODE=${mode} is not the live token-first mode.`);
  }
  if (!envPresent(env, 'OWNER_TOKEN_BOOTSTRAP')) {
    return check('Owner Authentication', ReadinessStatus.NOT_CONFIGURED, 'OWNER_TOKEN_BOOTSTRAP is not set.');
  }
  if (String(env.OWNER_TOKEN_BOOTSTRAP).trim() === DEMO_OWNER_TOKEN) {
    return check('Owner Authentication', ReadinessStatus.FAIL, 'adp-demo-owner-token is demo-only and cannot satisfy live owner authentication.');
  }
  return check('Owner Authentication', ReadinessStatus.PASS, 'OWNER_AUTH_MODE=token; bootstrap credential is present and is not the demo token.');
}

export async function checkWorker(env) {
  if (envPresent(env, 'WORKER_TOKEN')) {
    return check('Worker', ReadinessStatus.PASS, 'WORKER_TOKEN is present. The current architecture does not require it: API and worker share PostgreSQL job leases.');
  }
  return check('Worker', ReadinessStatus.PASS, 'WORKER_TOKEN is optional. API and worker communicate through PostgreSQL jobs; no extra internal token is required by the current architecture.');
}

export async function checkVerificationPolicy(env) {
  const reasons = [];
  if (boolEnvFrom(env, 'DEMO_MODE', false)) reasons.push('DEMO_MODE allows MOCK verification');
  if (String(env.CURSOR_MODE || '').toLowerCase() === 'mock') reasons.push('CURSOR_MODE=mock');
  if (!boolEnvFrom(env, 'STRICT_COUNCIL', true)) reasons.push('STRICT_COUNCIL is not true');
  if (intEnvFrom(env, 'MIN_COUNCIL_RESPONSES', 4) < 4) reasons.push('MIN_COUNCIL_RESPONSES < 4');
  if (reasons.length) return check('Verification Policy', ReadinessStatus.FAIL, reasons.join('; '));
  return check('Verification Policy', ReadinessStatus.PASS, 'Real projects reject MOCK evidence, mock checkpoints, and deterministic visual as AI_REVIEWED. Live-pilot Council is 4/4.');
}

export async function checkMockSafety(env) {
  const hits = [];
  if (boolEnvFrom(env, 'DEMO_MODE', false)) hits.push('DEMO_MODE=true');
  if (String(env.CURSOR_MODE || '').toLowerCase() === 'mock') hits.push('MockCursor');
  if (String(env.SANDBOX_BACKEND || '').toLowerCase() === 'mock') hits.push('MockSandbox');
  if (String(env.SECRET_BROKER || '').toLowerCase() === 'mock') hits.push('MockSecretBroker');
  if (!envPresent(env, 'DATABASE_URL')) hits.push('json-demo');
  if (hits.length) {
    return check('Mock / Demo Safety', ReadinessStatus.FAIL, `Live intended runtime would use: ${hits.join(', ')}.`);
  }
  return check('Mock / Demo Safety', ReadinessStatus.PASS, 'Intended live runtime does not select MockProvider, MockCursor, MockSandbox, MockSecretBroker, json-demo, or DEMO_MODE.');
}

export function overallReady(sections) {
  return sections.every(item => item.status === ReadinessStatus.PASS || item.status === 'LIVE VERIFIED');
}

export function formatLiveReadinessReport(report) {
  const lines = [
    'AUTONOMOUS DEVELOPMENT PLATFORM — LIVE READINESS',
    ''
  ];
  for (const section of report.sections) {
    const status = section.status.padEnd(16);
    lines.push(`${section.name.padEnd(24)} ${status} ${section.detail || ''}`.trimEnd());
    if (section.providers) {
      for (const provider of section.providers) {
        lines.push(`  ${provider.name.padEnd(22)} ${String(provider.status).padEnd(16)} ${provider.detail || ''}`.trimEnd());
      }
    }
  }
  if (report.portNote) {
    lines.push('');
    lines.push(report.portNote);
  }
  lines.push('');
  lines.push(report.ready ? LIVE_READY_MESSAGE : LIVE_NOT_READY_MESSAGE);
  return redactSecrets(lines.join('\n'));
}

export async function checkLiveReadiness({
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  skipDotEnv = false
} = {}) {
  if (!skipDotEnv) loadDotEnv();
  registerEnvSecrets(env);
  const flags = parseFlags(argv);
  const sections = [];
  sections.push(await checkRuntime(env));
  sections.push(await checkDatabase(env));
  const council = await checkCouncilConfig(env, { smoke: flags.smoke });
  if (flags.smoke && council.providers?.every(item => item.status === 'LIVE VERIFIED')) {
    try {
      const chairSmoke = await checkCouncilSmoke(env, council);
      council.chair = chairSmoke;
      if (chairSmoke.status === ReadinessStatus.PASS) {
        council.status = ReadinessStatus.PASS;
        council.detail = chairSmoke.detail;
        council.fourModelVerified = true;
      } else {
        council.status = chairSmoke.status;
        council.detail = chairSmoke.detail;
        council.fourModelVerified = false;
      }
    } catch (error) {
      council.status = ReadinessStatus.FAIL;
      council.detail = safeDetail(error.message || error);
      council.fourModelVerified = false;
    }
  }
  sections.push(council);
  sections.push(council.chair || check('Chair', ReadinessStatus.NOT_VERIFIED, 'Chair not evaluated.'));
  sections.push(await checkCursor(env, { full: flags.full }));
  sections.push(await checkWorker(env));
  sections.push(await checkSandbox(env));
  sections.push(await checkSecretBroker(env));
  sections.push(await checkOwnerAuth(env));
  sections.push(await checkVerificationPolicy(env));
  sections.push(await checkMockSafety(env));

  const health = await probePort(Number(env.PORT || 4317), { fetchImpl });
  let portNote = null;
  if (health && (health.demo === true || health.engine === 'json-demo')) {
    portNote = `Port ${env.PORT || 4317} currently hosts DEMO`;
  }

  const report = {
    sections,
    ready: overallReady(sections),
    portNote,
    fourModelVerified: Boolean(council.fourModelVerified)
  };
  const text = formatLiveReadinessReport(report);
  if (containsSecret(text, env)) {
    throw new Error('Live readiness report attempted to include a secret value.');
  }
  return { ...report, text, exitCode: report.ready ? 0 : 1 };
}

export async function runLiveReadinessCli(argv = process.argv.slice(2)) {
  loadDotEnv();
  const result = await checkLiveReadiness({ env: process.env, argv });
  console.log(result.text);
  return result.exitCode;
}
