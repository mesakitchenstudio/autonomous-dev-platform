import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { createEvidence, EvidenceProvenance, EvidenceStatus, mockEvidence } from '../orchestrator/evidence.js';
import { latestCursorRun } from '../orchestrator/gate.js';
import { PolicyLevel } from '../verify/kinds.js';
import { RuntimeFindingCode, RuntimeStatus } from '../runtime/kinds.js';
import { latestRuntimeRun } from '../runtime/pipeline.js';
import { screenshotSetHash } from '../runtime/artifacts.js';
import { visualChairSchema, visualReviewSchema } from './schema.js';
import { selectScreensForReview } from './policy.js';
import { classifyScreenshot, maySendToExternalReview } from '../security/screenshot.js';
import { visualChairPrompt, visualReviewPrompt } from './prompts.js';
import { HIGH_SEVERITY } from '../council/schemas.js';

export function latestVisualRun(project, iteration = project?.iteration) {
  const runs = project?.visualReviewRuns || [];
  return [...runs].reverse().find(item => Number(item.iteration) === Number(iteration)) || runs.at(-1) || null;
}

export function visualIdempotencyKey(project) {
  const runtime = latestRuntimeRun(project);
  return `project:${project.id}:visual:${runtime?.id || 'none'}:${runtime?.screenshotSetHash || screenshotSetHash(runtime?.screenshots || [])}`;
}

export function findReusableVisual(project) {
  const runtime = latestRuntimeRun(project);
  if (!runtime) return null;
  return (project.visualReviewRuns || []).find(item => (
    item.runtimeRunId === runtime.id
    && item.screenshotSetHash === runtime.screenshotSetHash
    && item.decision === 'COMPLETE'
    && item.completedAt
  )) || null;
}

export function isVisualStale(project, visual) {
  const runtime = latestRuntimeRun(project);
  const last = latestCursorRun(project);
  if (!visual) return false;
  if (last?.checkpointSha && visual.checkpointSha && visual.checkpointSha !== last.checkpointSha) return true;
  if (runtime?.id && visual.runtimeRunId && visual.runtimeRunId !== runtime.id) return true;
  return false;
}

export async function runVisualVerification({ project, council, demo, owns, dbReady } = {}) {
  if (demo || project.demo) return mockVisualRun(project);
  if (typeof owns === 'function' && !(await owns())) {
    throw new PlatformError({
      code: ErrorCode.JOB_LEASE_LOST,
      message: 'Worker does not own the visual verification job.',
      phase: 'VISUAL_VERIFICATION',
      retryable: true
    });
  }
  if (typeof dbReady === 'function' && !(await dbReady())) {
    throw new PlatformError({
      code: ErrorCode.DATABASE_UNAVAILABLE,
      message: 'Database is unavailable; visual verification was not started.',
      phase: 'VISUAL_VERIFICATION',
      retryable: true
    });
  }

  const runtime = latestRuntimeRun(project);
  if (!runtime || runtime.policy?.visual === PolicyLevel.NOT_APPLICABLE || !runtime.screenshots?.length) {
    return notApplicableVisual(project, runtime);
  }
  if (isVisualStale(project, latestVisualRun(project)) === false) {
    const reused = findReusableVisual(project);
    if (reused) return { ...reused, reused: true };
  }

  const last = latestCursorRun(project);
  const run = {
    id: crypto.randomUUID(),
    projectId: project.id,
    runtimeRunId: runtime.id,
    iteration: project.iteration || 1,
    screenshotSetHash: runtime.screenshotSetHash || screenshotSetHash(runtime.screenshots),
    checkpointSha: last?.checkpointSha || runtime.checkpointSha,
    status: 'PASS',
    decision: 'COMPLETE',
    reviewers: [],
    findings: [],
    chair: null,
    blockingFindings: [],
    usage: [],
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  const selected = selectScreensForReview(runtime.screenshots, {
    suspicious: (runtime.layoutFindings || []).map(item => item.screenshotId).filter(Boolean)
  });
  const spec = project.council?.discovery?.spec || {};
  const images = [];
  for (const item of selected) {
    const classification = classifyScreenshot(item.screenshot);
    item.screenshot.classification = classification;
    if (!maySendToExternalReview(item.screenshot)) continue;
    const bytes = await fs.readFile(item.screenshot.path).catch(() => null);
    if (!bytes) continue;
    images.push({
      name: item.screenshot.path,
      mimeType: 'image/png',
      data: bytes.toString('base64'),
      meta: item,
      classification
    });
  }

  const layoutFindings = (runtime.layoutFindings || []).map(item => ({
    severity: item.severity || 'HIGH',
    category: item.category || 'broken_layout',
    description: item.description,
    evidence: item.evidence || 'Deterministic layout inspection',
    requiredFix: item.requiredFix || 'Fix the clipped or overflowing control',
    screen: item.screen || 'unknown',
    device: item.device || 'unknown',
    provenance: 'PLATFORM_VERIFIED'
  }));

  if (council?.visualReview) {
    const visual = await council.visualReview({
      spec,
      acceptance: spec.acceptanceCriteria || [],
      screens: selected.map(item => ({
        purpose: item.screenshot.route || item.screenshot.step || 'screen',
        viewport: { name: item.screenshot.viewport, width: item.screenshot.width, height: item.screenshot.height },
        diagnostics: runtime.diagnostics,
        priorFindings: project.council?.visualPrior || [],
        checkpointSha: run.checkpointSha,
        images: images.filter(image => image.meta.screenshot.id === item.screenshot.id).map(image => ({
          mimeType: image.mimeType,
          data: image.data,
          name: image.meta.screenshot.id
        })),
        reviewerCount: item.reviewerCount
      })),
      layoutFindings
    });
    run.reviewers = visual.reviewers || [];
    run.findings = visual.findings || [];
    run.chair = visual.chair || null;
    run.usage = visual.usage || [];
    run.decision = visual.decision?.decision || 'COMPLETE';
    run.blockingFindings = visual.decision?.blockingFindings || [];
  } else {
    run.findings = layoutFindings;
    run.decision = layoutFindings.some(item => HIGH_SEVERITY.has(item.severity)) ? 'CHANGES_REQUIRED' : 'COMPLETE';
    run.blockingFindings = layoutFindings.filter(item => HIGH_SEVERITY.has(item.severity));
    run.chair = { provider: 'deterministic', decision: { decision: run.decision, blockingFindings: run.blockingFindings, summary: 'Deterministic visual heuristics' } };
  }

  if (!run.blockingFindings.length && layoutFindings.some(item => HIGH_SEVERITY.has(item.severity))) {
    run.blockingFindings.push(...layoutFindings.filter(item => HIGH_SEVERITY.has(item.severity)));
    run.decision = 'CHANGES_REQUIRED';
  }
  if (run.decision === 'CHANGES_REQUIRED' || run.blockingFindings.length) {
    run.status = RuntimeStatus.FAIL;
    run.decision = 'CHANGES_REQUIRED';
  }
  run.completedAt = new Date().toISOString();
  run.evidencePatch = evidenceFromVisual(project, run, runtime);
  return run;
}

function notApplicableVisual(project, runtime) {
  const run = {
    id: crypto.randomUUID(),
    projectId: project.id,
    runtimeRunId: runtime?.id || null,
    iteration: project.iteration || 1,
    screenshotSetHash: runtime?.screenshotSetHash || 'none',
    checkpointSha: latestCursorRun(project)?.checkpointSha || runtime?.checkpointSha || null,
    status: RuntimeStatus.NOT_APPLICABLE,
    decision: 'NOT_APPLICABLE',
    reviewers: [],
    findings: [],
    blockingFindings: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  run.evidencePatch = evidenceFromVisual(project, run, runtime);
  return run;
}

export function mockVisualRun(project) {
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    iteration: project.iteration || 1,
    status: RuntimeStatus.NOT_APPLICABLE,
    decision: 'NOT_APPLICABLE',
    mock: true,
    reviewers: [],
    findings: [],
    blockingFindings: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    evidencePatch: mockEvidence({ prompt: 'mock visual' })
  };
}

export function evidenceFromVisual(project, run, runtime) {
  const previous = project.evidence || latestCursorRun(project)?.evidence || {};
  if (project.demo || run.mock) return mockEvidence({ prompt: 'visual skipped in demo' });
  const judgmentStatus = run.decision === 'NOT_APPLICABLE'
    ? EvidenceStatus.NOT_APPLICABLE
    : run.blockingFindings?.length || run.decision === 'CHANGES_REQUIRED'
      ? EvidenceStatus.FAIL
      : run.decision === 'COMPLETE' || run.decision === 'PASS'
        ? EvidenceStatus.PASS
        : EvidenceStatus.NOT_RUN;
  return createEvidence({
    ...previous,
    visual: {
      status: judgmentStatus,
      provenance: run.decision === 'NOT_APPLICABLE' ? EvidenceProvenance.PLATFORM_VERIFIED : EvidenceProvenance.AI_REVIEWED,
      detail: run.decision === 'NOT_APPLICABLE'
        ? 'Visual review is NOT_APPLICABLE for this application kind.'
        : `AI_REVIEWED visual judgment; screenshot capture remains PLATFORM_VERIFIED (${(runtime?.screenshots || []).length} images).`
    },
    artifacts: previous.artifacts || [],
    warnings: [
      ...(previous.warnings || []),
      ...(run.decision === 'NOT_APPLICABLE' ? [] : ['Visual aesthetic/usability judgment is AI_REVIEWED, not PLATFORM_VERIFIED exit-code evidence.'])
    ],
    errors: (run.blockingFindings || []).map(item => item.description || item.issue || item.code),
    source: { ...(previous.source || {}), visualRunId: run.id }
  });
}

export function slimVisualReviewInput(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    decision: run.decision,
    checkpointSha: run.checkpointSha,
    screenshotSetHash: run.screenshotSetHash,
    blockingFindings: run.blockingFindings,
    findings: (run.findings || []).slice(0, 20),
    reviewers: (run.reviewers || []).map(item => ({ provider: item.provider, model: item.model, decision: item.decision }))
  };
}

export function correctionPromptFromVisual(run, runtime) {
  const findings = (run?.blockingFindings || run?.findings || []).map(item => `${item.severity} ${item.category}: ${item.description || item.issue} — ${item.requiredFix || ''}`);
  return [
    'Platform visual verification found blocking UI defects.',
    'Fix the visual issues. Do not break already passing runtime scenarios or Phase 5 build/tests.',
    `Failed scenarios: ${(runtime?.scenarios || []).filter(item => item.status === 'FAIL').map(item => item.id).join(', ') || 'none'}`,
    `Screenshot references: ${(runtime?.screenshots || []).map(item => item.path).slice(0, 6).join(', ')}`,
    '',
    ...findings
  ].join('\n');
}

export function shouldSkipVisual(project, runtime) {
  if (project?.demo) return true;
  if (!runtime) return true;
  if (runtime.policy?.visual === PolicyLevel.NOT_APPLICABLE) return true;
  if (runtime.status === RuntimeStatus.FAIL && runtime.blockingFailures?.some(item => item.code === RuntimeFindingCode.RUNTIME_START_FAILED || item.code === RuntimeFindingCode.RUNTIME_READINESS_TIMEOUT || item.code === RuntimeFindingCode.RUNTIME_PROCESS_EXITED)) {
    return true;
  }
  return false;
}

export { visualReviewSchema, visualChairSchema };
