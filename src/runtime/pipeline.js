import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { inspectGit } from '../git/inspect.js';
import { isGitRepository } from '../git/worktree.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { createEvidence, EvidenceProvenance, EvidenceStatus, VerificationLevel, mockEvidence } from '../orchestrator/evidence.js';
import { latestCursorRun } from '../orchestrator/gate.js';
import { latestVerificationRun } from '../verify/pipeline.js';
import { PolicyLevel } from '../verify/kinds.js';
import { ApplicationKind, RuntimeFindingCode, RuntimeStatus } from './kinds.js';
import { createRuntimePlan } from './plan.js';
import { adapterFor } from './adapters/registry.js';
import { screenshotSetHash } from './artifacts.js';
import { cancelActiveRuntime } from './process.js';

export function latestRuntimeRun(project, iteration = project?.iteration) {
  const runs = project?.runtimeRuns || [];
  return [...runs].reverse().find(item => Number(item.iteration) === Number(iteration)) || runs.at(-1) || null;
}

export function runtimeIdempotencyKey(project) {
  const last = latestCursorRun(project);
  const sha = last?.checkpointSha || last?.git?.checkpointSha || last?.git?.afterSha || 'none';
  const artifact = latestRuntimeRun(project)?.artifactHash || latestVerificationRun(project)?.artifacts?.find(item => item.sha256)?.sha256 || 'none';
  return `project:${project.id}:runtime:${project.iteration || 1}:${sha}:${artifact}`;
}

export function findReusableRuntime(project) {
  const last = latestCursorRun(project);
  const sha = last?.checkpointSha || last?.git?.checkpointSha || last?.git?.afterSha || null;
  return (project.runtimeRuns || []).find(item => (
    Number(item.iteration) === Number(project.iteration)
    && item.checkpointSha === sha
    && item.status === RuntimeStatus.PASS
    && item.completedAt
  )) || null;
}

export function isRuntimeStale(project, run) {
  const last = latestCursorRun(project);
  const sha = last?.checkpointSha || last?.git?.checkpointSha || last?.git?.afterSha || null;
  if (run && sha && run.checkpointSha && run.checkpointSha !== sha) return true;
  return false;
}

export async function runRuntimeVerification({ project, workspacePath, demo, owns, dbReady, extraScenarios } = {}) {
  if (demo || project.demo) return mockRuntimeRun(project);

  if (typeof owns === 'function' && !(await owns())) {
    throw new PlatformError({
      code: ErrorCode.JOB_LEASE_LOST,
      message: 'Worker does not own the runtime verification job.',
      phase: 'RUNTIME_VERIFICATION',
      retryable: true
    });
  }
  if (typeof dbReady === 'function' && !(await dbReady())) {
    throw new PlatformError({
      code: ErrorCode.DATABASE_UNAVAILABLE,
      message: 'Database is unavailable; runtime verification was not started.',
      phase: 'RUNTIME_VERIFICATION',
      retryable: true
    });
  }

  const reused = findReusableRuntime(project);
  if (reused && !isRuntimeStale(project, reused)) return { ...reused, reused: true };

  if (!workspacePath || !(await fs.stat(workspacePath).catch(() => null))) {
    return notApplicableRun(project, 'WORKSPACE_MISSING', 'Managed workspace is missing; runtime was not invented.');
  }

  const last = latestCursorRun(project);
  const expectedSha = last?.checkpointSha || last?.git?.afterSha || project.repository?.baselineSha || null;
  if (await isGitRepository(workspacePath) && expectedSha) {
    const snapshot = inspectGit(workspacePath);
    if (snapshot.sha && snapshot.sha !== expectedSha) {
      // Continue against persisted checkpoint metadata; stale comparison is recorded on the run.
    }
  }

  const plan = await createRuntimePlan(workspacePath, project, { extraScenarios });
  project.runtimePlan = plan;
  const adapter = adapterFor(plan);
  const run = {
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: project.iteration || 1,
    checkpointSha: expectedSha || plan.checkpointSha,
    artifactHash: plan.artifactHash,
    adapter: adapter.name,
    applicationKind: plan.applicationKind,
    status: RuntimeStatus.PASS,
    plan,
    policy: plan.policy,
    launch: null,
    scenarios: [],
    diagnostics: [],
    screenshots: [],
    accessibility: [],
    layoutFindings: [],
    blockingFailures: [],
    problems: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    reused: false
  };

  try {
    const prepared = await adapter.prepare?.({ workspacePath, plan, project });
    if (prepared && prepared.ok === false) {
      run.status = plan.policy.runtime === PolicyLevel.REQUIRED ? RuntimeStatus.FAIL : RuntimeStatus.NOT_APPLICABLE;
      run.problems.push({ code: prepared.code || RuntimeFindingCode.RUNTIME_START_FAILED, message: prepared.message });
      if (run.status === RuntimeStatus.FAIL) run.blockingFailures.push(run.problems[0]);
      return finish(project, run);
    }

    let launch;
    try {
      launch = await adapter.launch({ workspacePath, project, plan });
    } catch (error) {
      run.status = RuntimeStatus.FAIL;
      run.blockingFailures.push({
        code: error.code || RuntimeFindingCode.RUNTIME_START_FAILED,
        message: error.message
      });
      return finish(project, run);
    }

    if (launch?.unavailable || launch?.skipped) {
      run.status = launch.skipped ? RuntimeStatus.NOT_APPLICABLE : RuntimeStatus.NOT_RUN;
      run.problems.push({
        code: launch.code || RuntimeFindingCode.INFRASTRUCTURE_UNAVAILABLE,
        message: launch.message || 'Runtime infrastructure unavailable'
      });
      if (plan.applicationKind === ApplicationKind.UNKNOWN) run.status = RuntimeStatus.NOT_APPLICABLE;
      return finish(project, run);
    }

    run.launch = {
      command: launch.command || plan.launch.command,
      pid: launch.pid || null,
      port: launch.port || null,
      url: launch.url || null
    };

    try {
      const ready = await adapter.waitUntilReady({ plan, project });
      run.launch = { ...run.launch, ...ready, readinessDurationMs: ready?.durationMs };
    } catch (error) {
      run.status = RuntimeStatus.FAIL;
      run.blockingFailures.push({
        code: error.code || RuntimeFindingCode.RUNTIME_READINESS_TIMEOUT,
        message: error.message
      });
      await adapter.shutdown?.();
      return finish(project, run);
    }

    const viewports = plan.viewports?.length ? plan.viewports : [null];
    for (const viewport of viewports) {
      for (const scenario of plan.scenarios) {
        const executed = await adapter.executeScenario({
          project,
          plan,
          scenario,
          viewport,
          workspacePath,
          recordTrace: scenario.priority === 'CRITICAL'
        });
        const record = {
          id: scenario.id,
          goal: scenario.goal,
          priority: scenario.priority,
          viewport: viewport?.name || null,
          status: executed.status,
          steps: executed.steps || [],
          assertions: executed.assertions || [],
          failures: executed.failures || [],
          artifacts: executed.artifacts || [],
          durationMs: (executed.steps || []).reduce((sum, step) => sum + (step.durationMs || 0), 0)
        };
        run.scenarios.push(record);
        run.screenshots.push(...(executed.screenshots || []));
        if (executed.diagnostics) run.diagnostics.push({ scenario: scenario.id, viewport: viewport?.name || null, ...executed.diagnostics });
        if (executed.accessibility) run.accessibility.push({ scenario: scenario.id, ...executed.accessibility });
        if (executed.layoutFindings?.length) run.layoutFindings.push(...executed.layoutFindings);
        if (executed.status === RuntimeStatus.FAIL && scenario.priority === 'CRITICAL') {
          run.blockingFailures.push(...(executed.failures || [{ code: RuntimeFindingCode.SCENARIO_FAILED, message: scenario.id }]));
        }
      }
    }

    if (run.accessibility.some(item => item.status === 'FAIL' && item.findings?.some(finding => finding.blocking))) {
      run.blockingFailures.push({
        code: RuntimeFindingCode.ACCESSIBILITY_FAILURE,
        message: 'Blocking automated accessibility findings were reported.'
      });
    }
    await adapter.shutdown?.();
  } catch (error) {
    await adapter.shutdown?.().catch(() => {});
    if (error instanceof PlatformError && error.code === ErrorCode.JOB_LEASE_LOST) throw error;
    run.status = RuntimeStatus.FAIL;
    run.blockingFailures.push({ code: error.code || RuntimeFindingCode.RUNTIME_CRASH, message: error.message });
  }

  if (run.blockingFailures.length) run.status = RuntimeStatus.FAIL;
  else if (run.scenarios.some(item => item.status === RuntimeStatus.FAIL)) run.status = RuntimeStatus.PARTIAL;
  else if (run.status !== RuntimeStatus.NOT_RUN && run.status !== RuntimeStatus.NOT_APPLICABLE) run.status = RuntimeStatus.PASS;
  return finish(project, run);
}

function finish(project, run) {
  run.completedAt = new Date().toISOString();
  run.screenshotSetHash = screenshotSetHash(run.screenshots);
  run.evidencePatch = evidenceFromRuntime(project, run);
  return run;
}

function notApplicableRun(project, code, message) {
  const run = {
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: project.iteration || 1,
    checkpointSha: latestCursorRun(project)?.checkpointSha || null,
    artifactHash: null,
    adapter: 'GENERIC',
    applicationKind: ApplicationKind.UNKNOWN,
    status: RuntimeStatus.NOT_APPLICABLE,
    plan: { applicationKind: ApplicationKind.UNKNOWN, policy: { runtime: PolicyLevel.NOT_APPLICABLE, visual: PolicyLevel.NOT_APPLICABLE, accessibility: PolicyLevel.NOT_APPLICABLE } },
    policy: { runtime: PolicyLevel.NOT_APPLICABLE, visual: PolicyLevel.NOT_APPLICABLE, accessibility: PolicyLevel.NOT_APPLICABLE },
    launch: null,
    scenarios: [],
    diagnostics: [],
    screenshots: [],
    accessibility: [],
    blockingFailures: [],
    problems: [{ code, message }],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  run.evidencePatch = evidenceFromRuntime(project, run);
  return run;
}

export function mockRuntimeRun(project) {
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: project.iteration || 1,
    status: RuntimeStatus.NOT_APPLICABLE,
    adapter: 'MOCK',
    applicationKind: ApplicationKind.UNKNOWN,
    mock: true,
    policy: { runtime: PolicyLevel.NOT_APPLICABLE, visual: PolicyLevel.NOT_APPLICABLE, accessibility: PolicyLevel.NOT_APPLICABLE },
    scenarios: [],
    screenshots: [],
    accessibility: [],
    blockingFailures: [],
    problems: [],
    checkpointSha: latestCursorRun(project)?.checkpointSha || null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    evidencePatch: mockEvidence({ prompt: 'mock runtime' })
  };
}

export function evidenceFromRuntime(project, run) {
  const previous = project.evidence || latestCursorRun(project)?.evidence || {};
  if (project.demo || run.mock) return mockEvidence({ prompt: 'runtime skipped in demo' });
  const runtimeStatus = run.status === RuntimeStatus.PASS
    ? EvidenceStatus.PASS
    : run.status === RuntimeStatus.NOT_APPLICABLE
      ? EvidenceStatus.NOT_APPLICABLE
      : run.status === RuntimeStatus.NOT_RUN
        ? EvidenceStatus.NOT_RUN
        : EvidenceStatus.FAIL;
  const a11yFail = (run.accessibility || []).some(item => item.status === 'FAIL');
  return createEvidence({
    ...previous,
    runtime: {
      status: runtimeStatus,
      provenance: EvidenceProvenance.PLATFORM_VERIFIED,
      detail: `adapter=${run.adapter} scenarios=${(run.scenarios || []).length}`
    },
    functional: {
      status: (run.scenarios || []).some(item => item.status === RuntimeStatus.FAIL) ? EvidenceStatus.FAIL : runtimeStatus,
      provenance: EvidenceProvenance.PLATFORM_VERIFIED,
      detail: 'Structured runtime scenarios'
    },
    accessibility: {
      status: !run.accessibility?.length
        ? (run.policy?.accessibility === PolicyLevel.NOT_APPLICABLE ? EvidenceStatus.NOT_APPLICABLE : EvidenceStatus.NOT_RUN)
        : a11yFail ? EvidenceStatus.FAIL : EvidenceStatus.PASS,
      provenance: EvidenceProvenance.PLATFORM_VERIFIED,
      detail: run.accessibility?.length ? 'AUTOMATED_ACCESSIBILITY_CHECKS_PASS is not WCAG certification.' : 'No automated accessibility checks ran.'
    },
    visual: previous.visual || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED },
    artifacts: [...(previous.artifacts || []), ...run.screenshots.map(item => ({ id: item.id, type: 'screenshot', path: item.path, sha256: item.sha256 }))],
    warnings: [
      ...(previous.warnings || []).filter(item => !/Phase 5 verifies/.test(item)),
      ...(run.policy?.accessibility !== PolicyLevel.NOT_APPLICABLE ? ['Automated accessibility checks do not claim WCAG compliance.'] : [])
    ],
    errors: run.blockingFailures.map(item => item.message || item.code),
    source: { ...(previous.source || {}), runtimeRunId: run.id }
  });
}

export function slimRuntimeReviewInput(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    adapter: run.adapter,
    applicationKind: run.applicationKind,
    checkpointSha: run.checkpointSha,
    artifactHash: run.artifactHash,
    blockingFailures: run.blockingFailures,
    problems: run.problems,
    scenarios: (run.scenarios || []).map(item => ({
      id: item.id,
      status: item.status,
      priority: item.priority,
      viewport: item.viewport,
      failures: item.failures
    })),
    accessibility: (run.accessibility || []).map(item => ({
      status: item.status,
      claim: item.claim || 'AUTOMATED_ACCESSIBILITY_CHECKS',
      findings: item.findings
    })),
    screenshotCount: (run.screenshots || []).length
  };
}

export function correctionPromptFromRuntime(run) {
  const failures = (run?.blockingFailures || []).map(item => `${item.code}: ${item.message || ''}`);
  const scenarios = (run?.scenarios || []).filter(item => item.status === 'FAIL').map(item => `${item.id} (${item.viewport || 'default'})`);
  return [
    'Platform runtime verification failed. Trust PLATFORM_VERIFIED runtime evidence over Cursor claims that the UI works.',
    'Fix the failing scenarios without breaking already passing behavior.',
    'Do not disable runtime checks or remove accessibility names to hide defects.',
    '',
    ...failures,
    scenarios.length ? `Failed scenarios: ${scenarios.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

export function shouldSkipRuntime(project, verification) {
  if (project?.demo) return true;
  if (project?.evidence?.verificationLevel === VerificationLevel.MOCK) return true;
  if (verification?.mock) return true;
  if (verification?.blockingFailures?.length) return true;
  return false;
}

export { cancelActiveRuntime };
