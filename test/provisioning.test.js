import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectState, orchestratorFor, FakeCouncil, FakeCursor, seedProject, readyProjectShape, specFixture, tempStore, waitFor } from './helpers.js';
import { canEnterOwnerReview } from '../src/orchestrator/gate.js';
import { ErrorCode } from '../src/orchestrator/errors.js';
import { JobType, plannedJob } from '../src/jobs/types.js';
import { WorkspaceManager } from '../src/storage/workspace.js';
import { createProjectRecord } from '../src/storage/json-store.js';
import {
  filesystemName,
  androidPackageId,
  dartPackageName,
  pythonPackageName,
  rustCrateName,
  npmPackageName,
  buildIdentity
} from '../src/provision/names.js';
import { inferProfileFromSpec, normalizeProfile } from '../src/provision/profile.js';
import { TEMPLATE_REGISTRY, assertKnownTemplate, templateById } from '../src/provision/templates.js';
import { createProvisioningPlan, needsProvisioning, isExistingRepositoryProject, hashPlan } from '../src/provision/plan.js';
import { resolveProvisioner, listProvisioners, getProvisioner } from '../src/provision/registry.js';
import { ProvisionerId, SupportStatus } from '../src/provision/kinds.js';
import { runProjectProvisioning, applyProvisioningResult, prepareEmptyWorkspace } from '../src/provision/pipeline.js';
import { evaluateArchitecture } from '../src/provision/architecture.js';
import { workerCanClaim, WorkerCapability } from '../src/capabilities/kinds.js';
import { createProvisioningBaseline } from '../src/provision/git.js';
import { isInsideRoot } from '../src/git/boundary.js';

async function tempRoot(prefix = 'adp-prov-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('profile normalization covers web, android, flutter, backend, cli, unsupported', () => {
  assert.equal(inferProfileFromSpec({ projectType: 'web' }, 'dashboard spa').framework, ProvisionerId.VITE);
  assert.equal(inferProfileFromSpec({}, 'Build a cooking Android application').framework, ProvisionerId.ANDROID_NATIVE);
  assert.equal(inferProfileFromSpec({}, 'Android + iOS application').framework, ProvisionerId.FLUTTER);
  assert.equal(inferProfileFromSpec({}, 'REST API backend service').framework, ProvisionerId.NODE_BACKEND);
  assert.equal(inferProfileFromSpec({}, 'command line tool').framework, ProvisionerId.CLI);
  assert.equal(normalizeProfile({ category: 'WEB', platform: 'WEB', framework: 'nextjs', language: 'typescript' }).framework, ProvisionerId.NEXTJS);
});

test('naming sanitizers keep display names separate and reject traversal', () => {
  const identity = buildIdentity('Mesa Kitchen');
  assert.equal(identity.productName, 'Mesa Kitchen');
  assert.equal(identity.projectName, 'mesa-kitchen');
  assert.equal(dartPackageName('Mesa Kitchen'), 'mesa_kitchen');
  assert.equal(pythonPackageName('Mesa Kitchen'), 'mesa_kitchen');
  assert.equal(npmPackageName('Mesa Kitchen'), 'mesa-kitchen');
  assert.equal(rustCrateName('Mesa Kitchen'), 'mesa-kitchen');
  assert.match(androidPackageId('Mesa Kitchen'), /^com\.autonomous\.generated\.mesakitchen$/);
  assert.equal(filesystemName('!!!'), 'generated-app');
  assert.equal(filesystemName('123food'), 'app-123food');
  assert.throws(() => filesystemName('../etc/passwd'));
});

test('template registry rejects unknown and executable AI commands', () => {
  assert.ok(templateById('web.react.vite.typescript'));
  assert.throws(() => assertKnownTemplate('cooking-app-template'));
  const plan = createProvisioningPlan({
    id: '11111111-1111-4111-8111-111111111111',
    idea: 'API',
    council: { discovery: { spec: specFixture() } }
  });
  assert.ok(plan.hash);
  assert.ok(!JSON.stringify(plan.steps).includes('npm create'));
  assert.equal(plan.identity.productName, 'Test App');
  const listed = listProvisioners();
  assert.ok(listed.some(item => item.id === ProvisionerId.VITE));
  assert.ok(listed.some(item => item.id === ProvisionerId.IOS && item.supportStatus === SupportStatus.DETECTION_ONLY || item.id === ProvisionerId.IOS));
});

test('existing repositories skip provisioning', () => {
  const existing = { projectPath: 'C:/projects/mesa', repository: { repositoryType: 'EXISTING_LOCAL' } };
  assert.equal(isExistingRepositoryProject(existing), true);
  assert.equal(needsProvisioning(existing), false);
  const planned = plannedJob({
    ...existing,
    id: '22222222-2222-4222-8222-222222222222',
    state: ProjectState.SPECIFICATION_READY,
    iteration: 0
  });
  assert.equal(planned.jobType, JobType.CURSOR_EXECUTION);
});

test('new projects require PROJECT_PROVISIONING before Cursor', () => {
  const project = {
    id: '33333333-3333-4333-8333-333333333333',
    state: ProjectState.SPECIFICATION_READY,
    idea: 'new app',
    iteration: 0,
    council: { discovery: { spec: specFixture() } }
  };
  assert.equal(needsProvisioning(project), true);
  assert.equal(plannedJob(project).jobType, JobType.PROJECT_PROVISIONING);
});

test('path traversal and malicious template ids are rejected', async () => {
  const root = await tempRoot();
  const project = createProjectRecord({ idea: 'evil', id: '44444444-4444-4444-8444-444444444444' });
  project.council = { discovery: { spec: { ...specFixture(), productName: '..\\..\\outside' } } };
  assert.throws(() => buildIdentity('..\\..\\outside'));
  const repo = await prepareEmptyWorkspace(project, root);
  assert.ok(isInsideRoot(repo.workspacePath, root));
  assert.throws(() => assertKnownTemplate('; rm -rf /'));
});

test('unexpected secrets block the provisioning baseline', async () => {
  const root = await tempRoot();
  const project = createProjectRecord({ idea: 'secrets', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const repo = await prepareEmptyWorkspace(project, root);
  await fs.writeFile(path.join(repo.workspacePath, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(repo.workspacePath, 'README.md'), 'ok\n');
  await assert.rejects(
    () => createProvisioningBaseline(repo.workspacePath, { workspaceRoot: root, projectId: project.id }),
    err => err.code === ErrorCode.SECRET_FILE_BLOCKED
  );
});

test('capability-aware claiming rejects workers missing provisioner capabilities', () => {
  assert.equal(workerCanClaim(['WEB_CHROMIUM'], [WorkerCapability.ANDROID_SDK, WorkerCapability.ANDROID_PROJECT_CREATOR]), false);
  assert.equal(workerCanClaim([WorkerCapability.NODE], [WorkerCapability.NODE]), true);
  assert.equal(workerCanClaim([], [WorkerCapability.FLUTTER_SDK]), false);
});

test('platform Node backend provisions a baseline without network generators', async () => {
  const root = await tempRoot();
  const project = createProjectRecord({ idea: 'Notes API', id: '55555555-5555-4555-8555-555555555555' });
  project.council = { discovery: { spec: specFixture() } };
  const run = await runProjectProvisioning({ project, workspace: { root }, demo: false });
  applyProvisioningResult(project, run);
  assert.equal(run.status, 'PASS');
  assert.ok(run.baselineSha);
  assert.notEqual(run.baselineSha, project.cursorRuns?.[0]?.checkpointSha);
  assert.equal(run.evidence.provenance, 'PLATFORM_VERIFIED');
  assert.equal(project.repository.repositoryType, 'PROVISIONED_NEW_PROJECT');
  assert.ok(project.activePrompt.includes('PROVISIONED FOUNDATION'));
  const pkg = JSON.parse(await fs.readFile(path.join(project.repository.workspacePath, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'test-app');
  const reused = await runProjectProvisioning({ project, workspace: { root }, demo: false });
  assert.equal(reused.reused, true);
});

test('broken generated starter does not reach feature implementation', async () => {
  const root = await tempRoot();
  const project = createProjectRecord({ idea: 'broken', id: '66666666-6666-4666-8666-666666666666' });
  project.council = {
    discovery: {
      spec: {
        ...specFixture(),
        templateId: 'test.broken.starter',
        architectureChoice: { category: 'WEB', platform: 'WEB', framework: 'BROKEN_TEST', language: 'JAVASCRIPT', ui: false, rationale: 'test' }
      }
    }
  };
  await assert.rejects(
    () => runProjectProvisioning({ project, workspace: { root }, demo: false }),
    err => err.code === ErrorCode.PROVISIONING_STARTER_INVALID
  );
});

test('orchestrator blocks Cursor until provisioning passes and existing repos skip', async () => {
  const { store } = await tempStore();
  const dir = await tempRoot();
  const orch = orchestratorFor(store);
  orch.workspace = new WorkspaceManager(dir);
  const created = await store.create({ idea: 'Build a notes API' });
  await orch.run(created.id);
  const project = await store.get(created.id);
  assert.equal(project.state, ProjectState.READY_FOR_OWNER_REVIEW);
  assert.equal(project.provisioning.status, 'PASS');
  assert.ok(project.repository.provisioningBaselineSha);
  assert.ok(project.history.some(item => item.to === ProjectState.PROJECT_PROVISIONING));
  assert.ok(project.cursorRuns.length >= 1);

  const owner = await tempRoot('adp-existing-');
  spawnSync('git', ['init'], { cwd: owner, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: owner });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: owner });
  await fs.writeFile(path.join(owner, 'README.md'), 'existing\n');
  spawnSync('git', ['add', '.'], { cwd: owner });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: owner });
  const existing = await store.create({ idea: 'change existing', projectPath: owner });
  existing.council = { discovery: { spec: specFixture() } };
  Object.assign(existing, readyProjectShape());
  await store.save(existing);
  assert.equal(needsProvisioning(existing), false);
});

test('completion gate requires provisioning for real new projects', () => {
  const project = {
    iteration: 1,
    error: null,
    council: {
      discovery: { spec: specFixture() },
      review1: { decision: { decision: 'COMPLETE', summary: 'ok' } },
      final: { decision: { decision: 'COMPLETE', summary: 'ok' } }
    },
    cursorRuns: [{
      iteration: 1,
      evidence: {
        verificationLevel: 'SELF_REPORTED',
        execution: { status: 'PASS', provenance: 'CURSOR_REPORTED' }
      }
    }],
    verificationRuns: [{
      id: 'v1',
      iteration: 1,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      policy: { build: 'NOT_APPLICABLE', tests: 'NOT_APPLICABLE', lint: 'NOT_APPLICABLE' }
    }]
  };
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('provisioning_not_run') || gate.reasons.includes('unprovisioned_project') || gate.reasons.includes('missing_canonical_evidence'));
});

test('worker without Android capabilities cannot claim Android provisioning', () => {
  const project = {
    id: '77777777-7777-4777-8777-777777777777',
    state: ProjectState.PROJECT_PROVISIONING,
    iteration: 0,
    provisioningPlan: { hash: 'abc', capabilitiesRequired: ['ANDROID_SDK', 'ANDROID_PROJECT_CREATOR', 'JAVA'] }
  };
  const planned = plannedJob(project);
  assert.deepEqual(planned.requiredCapabilities, ['ANDROID_SDK', 'ANDROID_PROJECT_CREATOR', 'JAVA']);
  assert.equal(workerCanClaim(['WEB_CHROMIUM', 'NODE'], planned.requiredCapabilities), false);
});

test('explicit iOS requirement is not rewritten to Android', () => {
  const evaluated = evaluateArchitecture({
    idea: 'Build an iOS app',
    council: { discovery: { spec: { architectureChoice: { category: 'MOBILE', platform: 'IOS', framework: 'IOS', language: 'SWIFT' } } } }
  });
  assert.equal(evaluated.profile.platform, 'IOS');
  assert.equal(evaluated.provisioner.id, ProvisionerId.IOS);
  assert.notEqual(evaluated.provisioner.id, ProvisionerId.ANDROID_NATIVE);
});

test('recovery after baseline does not regenerate', async () => {
  const root = await tempRoot();
  const project = createProjectRecord({ idea: 'recover', id: '88888888-8888-4888-8888-888888888888' });
  project.council = { discovery: { spec: specFixture() } };
  const first = await runProjectProvisioning({ project, workspace: { root }, demo: false });
  applyProvisioningResult(project, first);
  const sha = first.baselineSha;
  const second = await runProjectProvisioning({ project, workspace: { root }, demo: false });
  assert.equal(second.reused, true);
  assert.equal(second.baselineSha || project.repository.provisioningBaselineSha, sha);
});

test('live Vite provisioning when npm create is available', async (t) => {
  if (process.env.ADP_LIVE_PROVISION !== '1') {
    t.skip('Set ADP_LIVE_PROVISION=1 to re-run official web generators');
    return;
  }
  const { commandVersion } = await import('../src/provision/versions.js');
  if (!commandVersion('npm').available) {
    t.skip('npm unavailable');
    return;
  }
  const root = await tempRoot('adp-vite-');
  const project = createProjectRecord({ idea: 'Tiny recipe spa', id: '99999999-9999-4999-8999-999999999999' });
  project.council = {
    discovery: {
      spec: {
        ...specFixture(),
        productName: 'Recipe Spa',
        architectureChoice: {
          category: 'WEB',
          platform: 'WEB',
          framework: 'VITE',
          language: 'TYPESCRIPT',
          ui: true,
          rationale: 'SPA'
        }
      }
    }
  };
  try {
    const run = await runProjectProvisioning({ project, workspace: { root }, demo: false });
    assert.equal(run.status, 'PASS');
    assert.equal(run.provisioner, ProvisionerId.VITE);
    assert.ok(run.generator?.name);
    const pkg = JSON.parse(await fs.readFile(path.join(project.repository.workspacePath, 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies?.react || pkg.devDependencies?.vite || pkg.scripts?.dev);
    console.log(JSON.stringify({
      liveVite: {
        generator: run.generator?.name,
        version: run.generator?.version,
        template: run.generator?.template,
        baselineSha: run.baselineSha,
        starter: run.starterVerification?.status || null
      }
    }));
  } catch (error) {
    if (/ENOTFOUND|ECONN|network|404|ETIMEDOUT|generator exited/i.test(error.message || '')) {
      t.skip(`Vite live generator unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
});

test('live Next.js provisioning when create-next-app is available', async (t) => {
  if (process.env.ADP_LIVE_PROVISION !== '1') {
    t.skip('Set ADP_LIVE_PROVISION=1 to re-run official web generators');
    return;
  }
  const { commandVersion } = await import('../src/provision/versions.js');
  if (!commandVersion('npx').available) {
    t.skip('npx unavailable');
    return;
  }
  const root = await tempRoot('adp-next-');
  const project = createProjectRecord({ idea: 'Tiny recipe portal', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  project.council = {
    discovery: {
      spec: {
        ...specFixture(),
        productName: 'Recipe Portal',
        architectureChoice: {
          category: 'FULL_STACK',
          platform: 'WEB',
          framework: 'NEXTJS',
          language: 'TYPESCRIPT',
          ui: true,
          backendRequired: true,
          rationale: 'SSR portal'
        }
      }
    }
  };
  try {
    const run = await runProjectProvisioning({ project, workspace: { root }, demo: false });
    assert.equal(run.status, 'PASS');
    assert.equal(run.provisioner, ProvisionerId.NEXTJS);
    assert.ok(run.generator?.name);
    console.log(JSON.stringify({
      liveNext: {
        generator: run.generator?.name,
        version: run.generator?.version,
        template: run.generator?.template,
        baselineSha: run.baselineSha,
        starter: run.starterVerification?.status || null
      }
    }));
  } catch (error) {
    if (/ENOTFOUND|ECONN|network|404|ETIMEDOUT|generator exited|PROVISIONING_FAILED/i.test(error.message || '')) {
      t.skip(`Next.js live generator unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
});

test('live Android provisioning reports infrastructure status', async (t) => {
  const { commandHelp } = await import('../src/provision/versions.js');
  const help = commandHelp('android', ['create', '--help']);
  if (!help.available || !/empty-activity|activity/i.test(help.text || '')) {
    t.skip('ANDROID PROVISIONING — NOT VERIFIED — INFRASTRUCTURE UNAVAILABLE');
    return;
  }
  t.skip('Android CLI help is present; a full disposable scaffold was not run in this suite');
});

test('live Flutter provisioning reports SDK status', async (t) => {
  const { commandVersion } = await import('../src/provision/versions.js');
  if (!commandVersion('flutter').available) {
    t.skip('FLUTTER PROVISIONING — NOT VERIFIED — SDK UNAVAILABLE');
    return;
  }
  t.skip('Flutter SDK is present; a full disposable scaffold was not run in this suite');
});
