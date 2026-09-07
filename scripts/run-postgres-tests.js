import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertTestDatabaseUrl, redactDatabaseUrl } from '../test/postgres/guard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(err => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function listPgTests() {
  const dir = path.join(root, 'test', 'postgres');
  const names = (await fs.readdir(dir))
    .filter(name => /^\d{2}-.+\.js$/.test(name))
    .sort();
  return names.map(name => path.join(dir, name));
}

function runNodeTests(files, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', './test/security-env.js', '--test', '--test-concurrency=1', ...files], {
      cwd: root,
      env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function startEmbeddedPostgres() {
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
  } catch (error) {
    throw new Error(
      'REAL POSTGRESQL VERIFICATION BLOCKED — NO POSTGRESQL TEST INSTANCE AVAILABLE\n' +
      `embedded-postgres is not installed (${error.message}). Run npm install and retry, ` +
      'or set TEST_DATABASE_URL to an isolated database named adp_phase3_test.'
    );
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-pg-verify-'));
  const port = await freePort();
  const password = crypto.randomBytes(16).toString('hex');
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'),
    user: 'adp_test',
    password,
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8'],
    onLog() {},
    onError(message) { process.stderr.write(`[embedded-postgres] ${message}`); }
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('adp_phase3_test');
  const connectionString = `postgres://adp_test:${password}@127.0.0.1:${port}/adp_phase3_test`;
  const client = pg.getPgClient();
  await client.connect();
  const version = await client.query('SELECT version() AS version');
  await client.end();
  const pgCtl = path.join(
    root,
    'node_modules',
    '@embedded-postgres',
    `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`,
    'native',
    'bin',
    process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'
  );
  return {
    pg,
    connectionString,
    version: version.rows[0].version,
    mode: 'embedded-postgres temporary test instance',
    dataDir: path.join(dir, 'data'),
    pgCtl
  };
}

try {
  require('pg');
} catch {
  console.error('The pg driver is required for PostgreSQL verification.');
  process.exit(1);
}

const files = await listPgTests();
if (!files.length) {
  console.error('No PostgreSQL integration tests found in test/postgres/NN-*.js');
  process.exit(1);
}

let owned = null;
let url = process.env.TEST_DATABASE_URL;
let version = null;
let mode = null;

try {
  if (url) {
    assertTestDatabaseUrl(url);
    mode = 'externally supplied TEST_DATABASE_URL';
  } else {
    try {
      owned = await startEmbeddedPostgres();
      url = owned.connectionString;
      version = owned.version;
      mode = owned.mode;
    } catch (error) {
      console.error('REAL POSTGRESQL VERIFICATION BLOCKED — NO POSTGRESQL TEST INSTANCE AVAILABLE');
      console.error(error.message);
      console.error('Required: a reachable PostgreSQL test instance, then either:');
      console.error('  TEST_DATABASE_URL=postgres://USER:PASS@HOST:PORT/adp_phase3_test npm run test:postgres');
      console.error('or Docker: docker compose up -d  (database name must include "test" for this suite)');
      console.error('or install/start local PostgreSQL and create database adp_phase3_test.');
      process.exit(2);
    }
  }

  const env = {
    ...process.env,
    TEST_DATABASE_URL: url,
    ADP_TEST_PG_OWNED: owned ? '1' : '',
    ADP_TEST_PG_CTL: owned?.pgCtl || '',
    ADP_TEST_PG_DATA: owned?.dataDir || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-secret-must-not-appear',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'sk-ant-secret-must-not-appear',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'gemini-secret-must-not-appear',
    XAI_API_KEY: process.env.XAI_API_KEY || 'xai-secret-must-not-appear',
    CURSOR_API_KEY: process.env.CURSOR_API_KEY || 'cursor-secret-must-not-appear',
    CURSOR_AUTH_TOKEN: process.env.CURSOR_AUTH_TOKEN || 'cursor-token-must-not-appear',
    SECURITY_PROFILE: process.env.SECURITY_PROFILE || 'DEVELOPMENT',
    OWNER_TOKEN_BOOTSTRAP: process.env.OWNER_TOKEN_BOOTSTRAP || 'adp-test-owner-token',
    SECRET_MASTER_KEY: process.env.SECRET_MASTER_KEY || '00'.repeat(32)
  };

  console.log('PostgreSQL integration tests');
  console.log(`  connection: ${redactDatabaseUrl(url)}`);
  console.log(`  mode: ${mode}`);
  if (version) console.log(`  version: ${version}`);
  console.log(`  files: ${files.length}`);

  const result = await runNodeTests(files, env);
  if (result.code !== 0) process.exitCode = result.code;
} finally {
  if (owned?.pg) {
    try { await owned.pg.stop(); } catch {}
  }
}
