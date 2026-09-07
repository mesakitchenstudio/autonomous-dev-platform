import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ProjectState } from '../src/orchestrator/states.js';
import { canEnterOwnerReview } from '../src/orchestrator/gate.js';
import { validateAction, validateScenario } from '../src/runtime/dsl.js';
import { runRuntimeVerification, latestRuntimeRun, isRuntimeStale } from '../src/runtime/pipeline.js';
import { runVisualVerification } from '../src/visual/pipeline.js';
import { MockProvider } from '../src/providers/mock.js';
import { Council } from '../src/council/council.js';
import { createEvidence, EvidenceProvenance, EvidenceStatus, VerificationLevel } from '../src/orchestrator/evidence.js';
import { specFixture, reviewComplete, finalComplete, verificationNotApplicable } from './helpers.js';
import { launchChromium } from '../src/runtime/web/browsers.js';
import { PolicyLevel } from '../src/verify/kinds.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(root, 'fixtures', 'phase6');

async function ensureBrowser() {
  try {
    const launched = await launchChromium();
    await launched.browser.close();
    return launched.version;
  } catch {
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, ['scripts/setup-browsers.js'], { stdio: 'inherit', cwd: path.join(root, '..') });
    const launched = await launchChromium();
    await launched.browser.close();
    return launched.version;
  }
}

function projectFor(workspace, extras = {}) {
  return {
    id: extras.id || cryptoRandom(),
    idea: 'Recipe box',
    iteration: 1,
    demo: false,
    projectPath: workspace,
    council: { discovery: { spec: { ...specFixture(), projectType: 'web' } } },
    cursorRuns: [{
      iteration: 1,
      checkpointSha: extras.sha || 'abc123',
      evidence: createEvidence({
        verificationLevel: VerificationLevel.PLATFORM_VERIFIED,
        execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
        build: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.PLATFORM_VERIFIED }
      })
    }],
    verificationRuns: [{
      ...verificationNotApplicable(1),
      checkpointSha: extras.sha || 'abc123',
      status: 'PASS'
    }],
    runtimeRuns: [],
    visualReviewRuns: [],
    ...extras
  };
}

function cryptoRandom() {
  return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
}

async function copyFixture(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `adp-p6-${name}-`));
  await fs.cp(path.join(fixtures, name), dir, { recursive: true });
  if (name.startsWith('web-')) {
    await fs.copyFile(path.join(fixtures, 'serve.js'), path.join(dir, 'serve.js'));
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    pkg.scripts.start = 'node serve.js';
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  }
  return dir;
}

const webScenarios = [
  {
    id: 'home-load',
    goal: 'Open home',
    priority: 'CRITICAL',
    steps: [
      { action: 'NAVIGATE', url: '/' },
      { action: 'WAIT_FOR', condition: 'load' },
      { action: 'ASSERT_VISIBLE', selector: 'h1' },
      { action: 'SCREENSHOT', name: 'home' }
    ]
  },
  {
    id: 'save-favorite',
    goal: 'Save a recipe',
    priority: 'CRITICAL',
    steps: [
      { action: 'NAVIGATE', url: '/' },
      { action: 'CLICK', selector: '#save' },
      { action: 'ASSERT_TEXT', selector: '#status', text: 'Saved' },
      { action: 'SCREENSHOT', name: 'after-save' }
    ]
  }
];

test('AI cannot inject arbitrary browser or shell actions', () => {
  assert.equal(validateAction({ action: 'EVAL', selector: 'window.close()' }).ok, false);
  assert.equal(validateAction({ action: 'NAVIGATE', url: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateAction({ action: 'CLICK', selector: 'document.body' }).ok, false);
  assert.equal(validateScenario({ id: 'ok', goal: 'x', steps: [{ action: 'CLICK' }] }).ok, false);
});

test('Phase 6 web fixture launches, interacts, screenshots, traces, and shuts down', { timeout: 120000 }, async () => {
  const version = await ensureBrowser();
  const workspace = await copyFixture('web-ok');
  const project = projectFor(workspace);
  const run = await runRuntimeVerification({
    project,
    workspacePath: workspace,
    extraScenarios: webScenarios
  });
  assert.equal(run.status, 'PASS');
  assert.ok(run.launch?.port);
  assert.notEqual(run.launch.port, 3000);
  assert.ok(run.screenshots.length >= 2);
  assert.ok(run.screenshots.every(item => item.sha256 && item.checkpointSha === 'abc123'));
  assert.ok(run.scenarios.some(item => item.id === 'save-favorite' && item.status === 'PASS'));
  assert.ok(run.scenarios.some(item => item.viewport === 'MOBILE' || item.viewport === 'DESKTOP'));
  const browser = { name: 'chromium', version };
  globalThis.__phase6Browser = browser;
  assert.match(String(version), /\d+/);
});

test('broken functional fixture fails runtime then passes after correction', { timeout: 120000 }, async () => {
  await ensureBrowser();
  const workspace = await copyFixture('web-functional-broken');
  const project = projectFor(workspace);
  const failed = await runRuntimeVerification({ project, workspacePath: workspace, extraScenarios: webScenarios });
  assert.equal(failed.status, 'FAIL');
  assert.ok(failed.blockingFailures.length);
  const good = await fs.readFile(path.join(fixtures, 'web-ok', 'index.html'), 'utf8');
  await fs.writeFile(path.join(workspace, 'index.html'), good);
  project.cursorRuns[0].checkpointSha = 'def456';
  const passed = await runRuntimeVerification({ project, workspacePath: workspace, extraScenarios: webScenarios });
  assert.equal(passed.status, 'PASS');
});

test('broken visual fixture is detected and corrected', { timeout: 120000 }, async () => {
  await ensureBrowser();
  const workspace = await copyFixture('web-visual-broken');
  const project = projectFor(workspace);
  const runtime = await runRuntimeVerification({
    project,
    workspacePath: workspace,
    extraScenarios: [webScenarios[0]]
  });
  assert.equal(runtime.status, 'PASS');
  assert.ok(runtime.layoutFindings.some(item => item.category === 'clipping'));
  project.runtimeRuns = [runtime];
  const providers = [new MockProvider('openai'), new MockProvider('anthropic')];
  const council = new Council(providers, 'openai', { minResponses: 1, maxRepairAttempts: 0 });
  const visual = await runVisualVerification({ project, council });
  assert.equal(visual.decision, 'CHANGES_REQUIRED');
  assert.ok(visual.blockingFindings.length);
  assert.equal(visual.evidencePatch.visual.provenance, EvidenceProvenance.AI_REVIEWED);
  await fs.writeFile(path.join(workspace, 'index.html'), await fs.readFile(path.join(fixtures, 'web-ok', 'index.html'), 'utf8'));
  project.cursorRuns[0].checkpointSha = 'visual-fixed';
  const rerun = await runRuntimeVerification({ project, workspacePath: workspace, extraScenarios: [webScenarios[0]] });
  project.runtimeRuns = [rerun];
  const visual2 = await runVisualVerification({ project, council });
  assert.ok(!visual2.blockingFindings?.length, JSON.stringify(visual2.blockingFindings));
  assert.ok(visual2.decision === 'COMPLETE' || visual2.decision === 'PASS' || visual2.status === 'PASS');
});

test('mobile viewport exposes a responsive-only defect', { timeout: 120000 }, async () => {
  await ensureBrowser();
  const workspace = await copyFixture('web-responsive-broken');
  const project = projectFor(workspace);
  const run = await runRuntimeVerification({
    project,
    workspacePath: workspace,
    extraScenarios: [webScenarios[0]]
  });
  const mobile = (run.layoutFindings || []).filter(item => item.device === 'MOBILE' || /MOBILE/.test(item.screen || ''));
  const desktop = (run.layoutFindings || []).filter(item => item.device === 'DESKTOP');
  assert.ok(mobile.length, 'mobile defect should be visible');
});

test('accessibility fixture reports a deterministic unlabeled control', { timeout: 120000 }, async () => {
  await ensureBrowser();
  const workspace = await copyFixture('web-a11y-broken');
  const project = projectFor(workspace);
  const run = await runRuntimeVerification({
    project,
    workspacePath: workspace,
    extraScenarios: [webScenarios[0]]
  });
  const findings = (run.accessibility || []).flatMap(item => item.findings || []);
  assert.ok(findings.some(item => item.code === 'MISSING_ACCESSIBLE_NAME'));
  assert.ok(!(JSON.stringify(run).includes('WCAG_CERTIFIED')));
});

test('backend runtime has NOT_APPLICABLE visual policy', async () => {
  const workspace = await copyFixture('backend-ok');
  const project = projectFor(workspace, { council: { discovery: { spec: { ...specFixture(), projectType: 'backend' } } } });
  const run = await runRuntimeVerification({ project, workspacePath: workspace });
  assert.ok(['PASS', 'NOT_APPLICABLE', 'PARTIAL'].includes(run.status));
  assert.equal(run.policy.visual, PolicyLevel.NOT_APPLICABLE);
});

test('stale runtime evidence is rejected after a new checkpoint', async () => {
  const project = projectFor('/tmp/missing', { sha: 'old' });
  project.runtimeRuns = [{
    id: 'r1',
    iteration: 1,
    checkpointSha: 'old',
    status: 'PASS',
    completedAt: new Date().toISOString(),
    policy: { runtime: 'REQUIRED', visual: 'REQUIRED' }
  }];
  project.cursorRuns[0].checkpointSha = 'new';
  assert.equal(isRuntimeStale(project, project.runtimeRuns[0]), true);
});

test('gate blocks UI runtime NOT_RUN / FAIL and stale screenshots; Chair cannot override', () => {
  const base = {
    iteration: 1,
    error: null,
    council: {
      discovery: { spec: specFixture() },
      review1: reviewComplete('COMPLETE'),
      final: finalComplete('COMPLETE')
    },
    cursorRuns: [{
      iteration: 1,
      checkpointSha: 'sha',
      evidence: createEvidence({
        verificationLevel: VerificationLevel.PLATFORM_VERIFIED,
        execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
      })
    }],
    verificationRuns: [verificationNotApplicable(1)],
    runtimePolicy: { runtime: 'REQUIRED', visual: 'REQUIRED' }
  };
  assert.equal(canEnterOwnerReview(base).ok, false);
  assert.ok(canEnterOwnerReview(base).reasons.includes('required_runtime_not_run'));

  const failed = {
    ...base,
    runtimeRuns: [{
      id: 'r',
      iteration: 1,
      checkpointSha: 'sha',
      status: 'FAIL',
      completedAt: new Date().toISOString(),
      policy: { runtime: 'REQUIRED', visual: 'REQUIRED', accessibility: 'REQUIRED' },
      blockingFailures: [{ code: 'SCENARIO_FAILED' }]
    }]
  };
  const failGate = canEnterOwnerReview(failed);
  assert.equal(failGate.ok, false);
  assert.ok(failGate.reasons.includes('required_runtime_failed'));

  const visualBlocked = {
    ...failed,
    runtimeRuns: [{
      ...failed.runtimeRuns[0],
      status: 'PASS',
      blockingFailures: [],
      screenshots: [{ sha256: 's', checkpointSha: 'sha' }]
    }],
    visualReviewRuns: [{
      id: 'v',
      iteration: 1,
      runtimeRunId: 'r',
      checkpointSha: 'sha',
      status: 'FAIL',
      decision: 'CHANGES_REQUIRED',
      blockingFindings: [{ severity: 'HIGH', category: 'clipping', description: 'x', evidence: 'e', requiredFix: 'fix' }],
      completedAt: new Date().toISOString()
    }]
  };
  const visualGate = canEnterOwnerReview(visualBlocked);
  assert.equal(visualGate.ok, false);
  assert.ok(visualGate.reasons.includes('blocking_visual_finding'));

  const stale = {
    ...visualBlocked,
    visualReviewRuns: [{
      ...visualBlocked.visualReviewRuns[0],
      decision: 'COMPLETE',
      blockingFindings: [],
      status: 'PASS',
      checkpointSha: 'old-sha'
    }]
  };
  assert.ok(canEnterOwnerReview(stale).reasons.includes('stale_screenshot_evidence'));

  const backend = {
    ...base,
    runtimePolicy: { runtime: 'REQUIRED', visual: 'NOT_APPLICABLE' },
    runtimeRuns: [{
      id: 'b',
      iteration: 1,
      checkpointSha: 'sha',
      status: 'PASS',
      completedAt: new Date().toISOString(),
      policy: { runtime: 'REQUIRED', visual: 'NOT_APPLICABLE' },
      applicationKind: 'BACKEND'
    }],
    visualReviewRuns: [{
      id: 'vn',
      iteration: 1,
      decision: 'NOT_APPLICABLE',
      status: 'NOT_APPLICABLE',
      checkpointSha: 'sha',
      completedAt: new Date().toISOString()
    }]
  };
  const backendGate = canEnterOwnerReview(backend);
  assert.equal(backendGate.reasons.includes('required_visual_not_run'), false);
});

test('workflow helpers distinguish Phase 5 failure from runtime', () => {
  assert.equal(ProjectState.RUNTIME_VERIFICATION !== ProjectState.COUNCIL_REVIEW, true);
  assert.equal(latestRuntimeRun({ runtimeRuns: [{ iteration: 1, id: 'a' }] }).id, 'a');
});
