import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectGit } from '../git/inspect.js';
import { isGitRepository, RepositoryType } from '../git/worktree.js';
import { isInsideRoot } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { createEvidence, EvidenceProvenance, EvidenceStatus, VerificationLevel, mockEvidence } from '../orchestrator/evidence.js';
import { latestCursorRun } from '../orchestrator/gate.js';
import { createVerificationPlan, policyForKind } from './plan.js';
import { runVerificationCommand, timeoutForKind } from './runner.js';
import { writeLogArtifact, discoverBuildOutputs, verificationArtifactDir } from './artifacts.js';
import { detectVerificationConfigChanges } from './config-diff.js';
import { parseTestCounts } from './parse-reports.js';
import { buildVerificationEnv } from './env.js';
import { PolicyLevel, StepStatus, VerificationKind, VerificationStatus } from './kinds.js';
import { buildSecurityAspect } from '../security/gate.js';
import { projectSecurityPolicy } from '../security/policy.js';

const INSTALL_ARTIFACTS = new Set(['node_modules', '.venv', 'venv', 'target', 'build', 'dist', '.next', 'bin', 'obj']);

export function latestVerificationRun(project, iteration = project?.iteration) {
  const runs = project?.verificationRuns || [];
  return [...runs].reverse().find(item => Number(item.iteration) === Number(iteration)) || runs.at(-1) || null;
}

export function verificationIdempotencyKey(project) {
  const last = latestCursorRun(project);
  const sha = last?.checkpointSha || last?.git?.checkpointSha || last?.git?.afterSha || project.repository?.baselineSha || 'none';
  return `project:${project.id}:verification:${project.iteration || 1}:${sha}`;
}

export function findReusableVerification(project) {
  const keySha = verificationIdempotencyKey(project).split(':').pop();
  return (project.verificationRuns || []).find(item => (
    Number(item.iteration) === Number(project.iteration)
    && item.checkpointSha === keySha
    && item.status === VerificationStatus.PASS
    && item.completedAt
  )) || null;
}

export async function runPlatformVerification({ project, workspacePath, demo, owns, dbReady } = {}) {
  if (demo || project.demo) return mockVerificationRun(project);

  if (typeof owns === 'function' && !(await owns())) {
    throw new PlatformError({
      code: ErrorCode.JOB_LEASE_LOST,
      message: 'Worker does not own the verification job.',
      phase: 'PLATFORM_VERIFICATION',
      retryable: true
    });
  }
  if (typeof dbReady === 'function' && !(await dbReady())) {
    throw new PlatformError({
      code: ErrorCode.DATABASE_UNAVAILABLE,
      message: 'Database is unavailable; verification was not started.',
      phase: 'PLATFORM_VERIFICATION',
      retryable: true
    });
  }

  const reused = findReusableVerification(project);
  if (reused) return { ...reused, reused: true };

  if (!workspacePath || !(await fs.stat(workspacePath).catch(() => null))) {
    return emptyRun(project, 'WORKSPACE_MISSING', 'Managed workspace is missing; no commands were invented.');
  }
  if (project.repository?.workspacePath && !isInsideRoot(workspacePath, project.repository.workspacePath)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Verification path is outside the managed workspace.',
      phase: 'PLATFORM_VERIFICATION',
      retryable: false
    });
  }

  const last = latestCursorRun(project);
  const expectedSha = last?.checkpointSha || last?.git?.afterSha || project.repository?.baselineSha || null;
  const expectedBranch = project.repository?.workingBranch || null;
  let snapshot = { sha: null, branch: null, dirty: false, porcelain: '' };
  if (await isGitRepository(workspacePath)) {
    snapshot = inspectGit(workspacePath);
    if (expectedBranch && snapshot.branch && snapshot.branch !== expectedBranch) {
      throw new PlatformError({
        code: ErrorCode.VERIFICATION_PREFLIGHT_FAILED,
        message: `Verification branch ${snapshot.branch} does not match ${expectedBranch}`,
        phase: 'PLATFORM_VERIFICATION',
        retryable: true
      });
    }
    if (expectedSha && snapshot.sha && snapshot.sha !== expectedSha && !onlyInstallDirt(snapshot.porcelain)) {
      // Continue against the persisted checkpoint when dirty only with install artifacts.
    }
  }

  const plan = await createVerificationPlan(workspacePath, project);
  const configChanges = detectVerificationConfigChanges(workspacePath, project.repository?.baselineSha);
  const run = {
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: project.iteration || 1,
    status: VerificationStatus.PASS,
    projectType: plan.projectType,
    toolchains: plan.detectedTooling,
    plan,
    policy: plan.policy,
    steps: [],
    blockingFailures: [],
    problems: plan.problems,
    verificationConfigurationChanged: configChanges.changed,
    verificationConfigFiles: configChanges.files,
    checkpointSha: expectedSha || snapshot.sha,
    artifacts: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    reused: false
  };

  if (plan.problems.some(item => item.code === 'CONFLICTING_LOCKFILES')) {
    run.blockingFailures.push({
      code: 'CONFLICTING_LOCKFILES',
      message: plan.problems.find(item => item.code === 'CONFLICTING_LOCKFILES').message
    });
  }

  const env = buildVerificationEnv();
  for (const planned of plan.steps) {
    const logDir = verificationArtifactDir(project.id, run.iteration);
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${planned.id}.log`);
    const executed = await runVerificationCommand({
      argv: planned.command,
      cwd: workspacePath,
      workspaceRoot: workspacePath,
      timeoutMs: timeoutForKind(planned.kind),
      env,
      logPath,
      kind: planned.kind,
      project,
      projectId: project.id,
      operation: 'VERIFY'
    });
    run.sandboxMode = executed.sandboxMode || run.sandboxMode;
    run.sandboxBackend = executed.sandboxBackend || run.sandboxBackend;
    run.isolationCapabilities = executed.isolationCapabilities || run.isolationCapabilities;
    run.sandboxPolicy = executed.sandboxPolicy || run.sandboxPolicy;
    const required = planned.required && policyForKind(plan.policy, planned.kind) === PolicyLevel.REQUIRED;
    const failed = executed.timedOut || executed.missingExecutable || executed.exitCode !== 0;
    const status = failed ? StepStatus.FAIL : StepStatus.PASS;
    const artifact = await writeLogArtifact({
      projectId: project.id,
      iteration: run.iteration,
      kind: planned.id,
      contents: `${executed.stdout || ''}\n${executed.stderr || ''}`
    });
    run.artifacts.push(artifact);
    const step = {
      id: planned.id,
      kind: planned.kind,
      required,
      status,
      provenance: EvidenceProvenance.PLATFORM_VERIFIED,
      command: planned.command,
      exitCode: executed.exitCode,
      durationMs: executed.durationMs,
      stdoutPreview: executed.stdoutPreview || String(executed.stdout || '').slice(0, 8000),
      stderrPreview: executed.stderrPreview || String(executed.stderr || '').slice(0, 8000),
      truncated: Boolean(executed.truncated),
      logArtifactId: artifact.id,
      timedOut: executed.timedOut,
      missingExecutable: executed.missingExecutable,
      counts: planned.kind === VerificationKind.TEST ? parseTestCounts(`${executed.stdout}\n${executed.stderr}`) : null,
      toolchain: planned.toolchain
    };
    run.steps.push(step);
    if (failed && required) {
      run.blockingFailures.push({
        code: executed.timedOut ? 'TIMEOUT' : executed.missingExecutable ? 'MISSING_EXECUTABLE' : 'COMMAND_FAILED',
        kind: planned.kind,
        command: planned.command,
        exitCode: executed.exitCode,
        preview: step.stderrPreview || step.stdoutPreview
      });
    }
    if (planned.kind === VerificationKind.DEPENDENCY_INSTALL && failed && required) break;
  }

  const outputs = await discoverBuildOutputs(workspacePath);
  run.artifacts.push(...outputs.map(item => ({
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: run.iteration,
    kind: 'build_output',
    type: 'build_output',
    path: item.path,
    size: item.size,
    sha256: item.sha256,
    createdAt: new Date().toISOString()
  })));

  if (run.blockingFailures.length) run.status = VerificationStatus.FAIL;
  else if (run.steps.some(step => step.status === StepStatus.FAIL)) run.status = VerificationStatus.PARTIAL;
  else run.status = VerificationStatus.PASS;
  run.completedAt = new Date().toISOString();
  run.evidencePatch = evidenceFromVerification(project, run);
  return run;
}

export function mockVerificationRun(project) {
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: project.iteration || 1,
    status: VerificationStatus.PASS,
    projectType: 'mock',
    toolchains: [],
    plan: { projectType: 'mock', steps: [], policy: {}, problems: [] },
    policy: {
      build: PolicyLevel.NOT_APPLICABLE,
      tests: PolicyLevel.NOT_APPLICABLE,
      lint: PolicyLevel.NOT_APPLICABLE,
      staticAnalysis: PolicyLevel.NOT_APPLICABLE,
      security: PolicyLevel.NOT_APPLICABLE
    },
    steps: [],
    blockingFailures: [],
    problems: [],
    mock: true,
    checkpointSha: latestCursorRun(project)?.checkpointSha || null,
    artifacts: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    evidencePatch: mockEvidence({ prompt: 'mock verification' })
  };
}

function emptyRun(project, code, message) {
  const unprovisioned = project.repository?.repositoryType === RepositoryType.UNPROVISIONED_NEW_PROJECT;
  const run = {
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: project.iteration || 1,
    status: unprovisioned ? VerificationStatus.PASS : VerificationStatus.PASS,
    projectType: unprovisioned ? 'unprovisioned' : 'unknown',
    toolchains: [],
    plan: { projectType: unprovisioned ? 'unprovisioned' : 'unknown', steps: [], problems: [{ code, message }] },
    policy: {
      build: PolicyLevel.NOT_APPLICABLE,
      tests: PolicyLevel.NOT_APPLICABLE,
      lint: PolicyLevel.NOT_APPLICABLE,
      staticAnalysis: PolicyLevel.NOT_APPLICABLE,
      security: PolicyLevel.OPTIONAL,
      unprovisioned
    },
    steps: [],
    blockingFailures: [],
    problems: [{ code, message }],
    checkpointSha: latestCursorRun(project)?.checkpointSha || null,
    artifacts: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  run.evidencePatch = evidenceFromVerification(project, run);
  return run;
}

export function evidenceFromVerification(project, run) {
  const previous = project.evidence || latestCursorRun(project)?.evidence || {};
  const demo = project.demo || run.mock;
  if (demo) return mockEvidence({ prompt: 'platform verification skipped in demo' });
  const build = aspectFor(run, [VerificationKind.BUILD], run.policy.build);
  const tests = aspectFor(run, [VerificationKind.TEST], run.policy.tests);
  const lint = aspectFor(run, [VerificationKind.LINT, VerificationKind.STATIC_ANALYSIS], run.policy.lint);
  const executed = [build, tests, lint].some(item => item.status === EvidenceStatus.PASS || item.status === EvidenceStatus.FAIL);
  return createEvidence({
    ...previous,
    verificationLevel: executed ? VerificationLevel.PLATFORM_VERIFIED : (previous.verificationLevel || VerificationLevel.SELF_REPORTED),
    execution: previous.execution,
    git: previous.git,
    build,
    tests,
    lint,
    runtime: previous.runtime || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED, detail: 'Runtime not independently verified in Phase 5.' },
    visual: previous.visual || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED, detail: 'Visual review is Phase 6.' },
    security: buildSecurityAspect({ project, run }),
    artifacts: run.artifacts.map(item => ({ id: item.id, type: item.type || item.kind, path: item.path, sha256: item.sha256 })),
    warnings: [
      ...(previous.warnings || []),
      'Phase 5 verifies build/test/lint only. Runtime and visual are separate Phase 6 stages.',
      ...(run.sandboxMode === 'LOCAL_DEVELOPMENT_UNSAFE' ? ['Verification used LOCAL_DEVELOPMENT_UNSAFE. This is not hardened isolation.'] : []),
      ...(run.verificationConfigurationChanged ? [`Verification configuration changed: ${run.verificationConfigFiles.join(', ')}`] : [])
    ],
    source: {
      ...(typeof previous.source === 'object' && previous.source ? previous.source : {}),
      verificationRunId: run.id,
      projectType: run.projectType,
      sandboxMode: run.sandboxMode || null,
      sandboxBackend: run.sandboxBackend || null,
      isolationCapabilities: run.isolationCapabilities || null,
      securityPolicy: projectSecurityPolicy(project)
    },
    errors: run.blockingFailures.map(item => item.message || item.code)
  });
}

function aspectFor(run, kinds, policy) {
  const steps = run.steps.filter(step => kinds.includes(step.kind));
  if (!steps.length) {
    return {
      status: policy === PolicyLevel.NOT_APPLICABLE ? EvidenceStatus.NOT_APPLICABLE : EvidenceStatus.NOT_RUN,
      provenance: EvidenceProvenance.PLATFORM_VERIFIED,
      detail: policy === PolicyLevel.NOT_APPLICABLE ? 'No applicable command was detected.' : 'Required command was not run.'
    };
  }
  const failed = steps.find(step => step.status === StepStatus.FAIL);
  const step = failed || steps[0];
  return {
    status: failed ? EvidenceStatus.FAIL : EvidenceStatus.PASS,
    provenance: EvidenceProvenance.PLATFORM_VERIFIED,
    detail: `${step.command.join(' ')} exit=${step.exitCode} duration=${step.durationMs}ms`
  };
}

function onlyInstallDirt(porcelain) {
  const lines = String(porcelain || '').split(/\r?\n/).map(line => line.slice(3).trim()).filter(Boolean);
  return lines.length > 0 && lines.every(file => INSTALL_ARTIFACTS.has(file.split(/[\\/]/)[0]));
}

export function slimVerificationReviewInput(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    projectType: run.projectType,
    policy: run.policy,
    checkpointSha: run.checkpointSha,
    blockingFailures: run.blockingFailures,
    problems: run.problems,
    verificationConfigurationChanged: Boolean(run.verificationConfigurationChanged),
    verificationConfigFiles: run.verificationConfigFiles || [],
    steps: (run.steps || []).map(step => ({
      id: step.id,
      kind: step.kind,
      required: step.required,
      status: step.status,
      provenance: step.provenance,
      command: step.command,
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      stdoutPreview: String(step.stdoutPreview || '').slice(0, 1200),
      stderrPreview: String(step.stderrPreview || '').slice(0, 1200),
      counts: step.counts
    }))
  };
}

export function correctionPromptFromVerification(run) {
  const failures = (run?.blockingFailures || []).map(item => {
    const preview = String(item.preview || '').slice(0, 800);
    return `${item.kind || item.code}: ${(item.command || []).join(' ')}\n${preview}`;
  });
  return [
    'Platform verification failed. Trust PLATFORM_VERIFIED evidence over any Cursor claim that the build or tests passed.',
    'Fix the verified failures.',
    'Do not disable tests, delete failing tests, comment assertions, exclude test directories, or lower compiler/lint strictness just to hide defects.',
    'Do not change package scripts so commands no longer run tests.',
    '',
    ...failures
  ].join('\n');
}
