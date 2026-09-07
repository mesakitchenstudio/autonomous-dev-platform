import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createVerificationPlan } from '../src/verify/plan.js';
import { detectToolchains } from '../src/verify/detect.js';
import { runVerificationCommand } from '../src/verify/runner.js';
import { buildVerificationEnv, assertNoPlatformSecrets } from '../src/verify/env.js';
import { runPlatformVerification } from '../src/verify/pipeline.js';
import { parseTestCounts } from '../src/verify/parse-reports.js';
import { isVerificationConfigPath } from '../src/verify/config-diff.js';
import { ProjectTypes, PolicyLevel } from '../src/verify/kinds.js';
import { EvidenceProvenance, EvidenceStatus, VerificationLevel } from '../src/orchestrator/evidence.js';
import { createProjectRecord } from '../src/storage/json-store.js';
import { gitOk } from '../src/git/exec.js';
import { ErrorCode } from '../src/orchestrator/errors.js';

async function writeTree(root, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents);
  }
}

test('Node/npm and lockfile conflict detection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-node-'));
  await writeTree(dir, {
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test', build: 'node -e "0"', lint: 'node -e "0"' } }),
    'package-lock.json': '{}',
    'yarn.lock': ''
  });
  const detected = await detectToolchains(dir);
  assert.equal(detected[0].adapter.name, ProjectTypes.NODE);
  const plan = await createVerificationPlan(dir, {});
  assert.ok(plan.problems.some(item => item.code === 'CONFLICTING_LOCKFILES'));
  assert.equal(plan.policy.tests, PolicyLevel.REQUIRED);
});

test('Gradle, Maven, Python, Rust, Go, and .NET detection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-detect-'));
  const cases = {
    gradle: { 'settings.gradle': 'rootProject.name = "x"\n', 'gradlew': '#!/bin/sh\n', 'gradlew.bat': '@echo off\n' },
    maven: { 'pom.xml': '<project></project>\n', 'mvnw': '#!/bin/sh\n' },
    python: { 'pyproject.toml': '[tool.pytest.ini_options]\n', 'pytest.ini': '[pytest]\n' },
    rust: { 'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\n' },
    go: { 'go.mod': 'module example.com/x\n' },
    dotnet: { 'App.csproj': '<Project></Project>\n' }
  };
  const expected = {
    gradle: ProjectTypes.GRADLE,
    maven: ProjectTypes.MAVEN,
    python: ProjectTypes.PYTHON,
    rust: ProjectTypes.RUST,
    go: ProjectTypes.GO,
    dotnet: ProjectTypes.DOTNET
  };
  for (const [name, files] of Object.entries(cases)) {
    const dir = path.join(root, name);
    await writeTree(dir, files);
    const plan = await createVerificationPlan(dir, {});
    assert.equal(plan.projectType, expected[name], name);
  }
});

test('unknown and unprovisioned projects do not fake PASS commands', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-unk-'));
  const unknown = await createVerificationPlan(dir, {});
  assert.equal(unknown.projectType, ProjectTypes.UNKNOWN);
  assert.equal(unknown.steps.length, 0);
  const unprovisioned = await createVerificationPlan(dir, {
    repository: { repositoryType: 'UNPROVISIONED_NEW_PROJECT' }
  });
  assert.equal(unprovisioned.projectType, ProjectTypes.UNPROVISIONED);
  assert.ok(unprovisioned.policy.unprovisioned);
});

test('command runner enforces workspace cwd and excludes secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-run-'));
  await assert.rejects(
    () => runVerificationCommand({ argv: [process.execPath, '-e', '0'], cwd: os.tmpdir(), workspaceRoot: dir }),
    err => err.code === ErrorCode.WORKSPACE_UNSAFE
  );
  const env = buildVerificationEnv({
    ...process.env,
    OPENAI_API_KEY: 'sk-test',
    DATABASE_URL: 'postgres://x',
    CURSOR_API_KEY: 'cursor',
    PATH: process.env.PATH
  });
  assertNoPlatformSecrets(env);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CURSOR_API_KEY, undefined);
  const result = await runVerificationCommand({
    argv: [process.execPath, '-e', 'console.log("ok")'],
    cwd: dir,
    workspaceRoot: dir,
    timeoutMs: 5000,
    env
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ok/);
});

test('huge output is truncated and timeout fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-lim-'));
  const prev = process.env.VERIFY_MAX_LOG_BYTES;
  process.env.VERIFY_MAX_LOG_BYTES = '64';
  try {
    const huge = await runVerificationCommand({
      argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(200))'],
      cwd: dir,
      workspaceRoot: dir,
      timeoutMs: 5000
    });
    assert.equal(huge.exitCode, 0);
    assert.equal(huge.truncated, true);
    const timed = await runVerificationCommand({
      argv: [process.execPath, '-e', 'while(true){}'],
      cwd: dir,
      workspaceRoot: dir,
      timeoutMs: 200
    });
    assert.equal(timed.timedOut, true);
  } finally {
    if (prev == null) delete process.env.VERIFY_MAX_LOG_BYTES;
    else process.env.VERIFY_MAX_LOG_BYTES = prev;
  }
});

test('Cursor PASS cannot override platform FAIL provenance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-fail-'));
  await writeTree(dir, {
    'package.json': JSON.stringify({ name: 'broken', scripts: { test: 'node --test fail.test.js' } }),
    'fail.test.js': "import test from 'node:test'; import assert from 'node:assert'; test('x', () => assert.equal(1, 2));\n"
  });
  const project = createProjectRecord({ idea: 'broken', id: '11111111-1111-4111-8111-111111111111' });
  project.iteration = 1;
  project.evidence = {
    verificationLevel: VerificationLevel.SELF_REPORTED,
    execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
    build: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
    tests: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
  };
  project.cursorRuns = [{ iteration: 1, evidence: project.evidence, checkpointSha: null }];
  const run = await runPlatformVerification({ project, workspacePath: dir, demo: false });
  assert.equal(run.status, 'FAIL');
  assert.equal(run.evidencePatch.tests.status, EvidenceStatus.FAIL);
  assert.equal(run.evidencePatch.tests.provenance, EvidenceProvenance.PLATFORM_VERIFIED);
  assert.notEqual(run.evidencePatch.runtime.provenance, EvidenceProvenance.PLATFORM_VERIFIED);
  assert.equal(run.evidencePatch.runtime.status, EvidenceStatus.NOT_RUN);
});

test('TAP counts parse only from structured output', () => {
  const counts = parseTestCounts('# tests 3\n# pass 2\n# fail 1\n# skipped 0\n');
  assert.deepEqual(counts, { total: 3, passed: 2, failed: 1, skipped: 0 });
  assert.equal(parseTestCounts('looks fine').total, null);
});

test('verification config paths are flagged', () => {
  assert.equal(isVerificationConfigPath('package.json'), true);
  assert.equal(isVerificationConfigPath('src/app.js'), false);
});

test('Gradle wrapper detection does not invent a global gradle command', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-gradle-'));
  await writeTree(dir, {
    'settings.gradle': 'rootProject.name = "tiny"\n',
    'gradlew': '#!/bin/sh\n',
    'gradlew.bat': '@echo off\n'
  });
  const plan = await createVerificationPlan(dir, {});
  assert.equal(plan.projectType, ProjectTypes.GRADLE);
  assert.ok(plan.steps.some(step => String(step.command[0]).includes('gradlew')));
  const java = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
  if (java.status !== 0 && java.error) {
    assert.ok(true, 'GRADLE LIVE EXECUTION UNAVAILABLE');
  }
});
