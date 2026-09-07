import { isCanonicalEvidence, EvidenceStatus, VerificationLevel } from './evidence.js';
import { RepositoryType } from '../git/worktree.js';
import { PolicyLevel } from '../verify/kinds.js';
import { isExistingRepositoryProject, latestProvisioningRun } from '../provision/plan.js';
import { latestVerificationRun } from '../verify/pipeline.js';
import { isRuntimeStale, latestRuntimeRun } from '../runtime/pipeline.js';
import { isVisualStale, latestVisualRun } from '../visual/pipeline.js';
import { RuntimeStatus } from '../runtime/kinds.js';
import { applySecurityGate } from '../security/gate.js';

export function specProductName(spec) {
  return spec?.productName || spec?.product?.name || null;
}

export function hasValidSpec(project) {
  const spec = project?.council?.discovery?.spec;
  return Boolean(spec && typeof spec.cursorPrompt === 'string' && spec.cursorPrompt.trim() && specProductName(spec));
}

export function latestCursorRun(project) {
  const runs = project?.cursorRuns || [];
  return runs.length ? runs[runs.length - 1] : null;
}

export function reviewForIteration(project, iteration) {
  return project?.council?.[`review${iteration}`] || null;
}

export function canEnterOwnerReview(project, { maxIterations = 12 } = {}) {
  const reasons = [];
  if (!hasValidSpec(project)) reasons.push('missing_specification');

  const run = latestCursorRun(project);
  if (!run) reasons.push('no_cursor_execution');

  const evidence = run?.evidence || project?.evidence || null;
  if (!isCanonicalEvidence(evidence)) reasons.push('missing_canonical_evidence');
  if (evidence?.execution?.status === EvidenceStatus.FAIL) reasons.push('execution_failed');

  if (requiresPlatformVerification(project, evidence)) {
    const verification = latestVerificationRun(project, run?.iteration);
    if (!verification) reasons.push('required_verification_not_run');
    else {
      const policy = verification.policy || {};
      const checks = [
        ['build', policy.build, evidence?.build],
        ['tests', policy.tests, evidence?.tests],
        ['lint', policy.lint, evidence?.lint]
      ];
      for (const [name, level, aspect] of checks) {
        if (level !== PolicyLevel.REQUIRED) continue;
        const status = aspect?.status;
        if (status === EvidenceStatus.FAIL) reasons.push(`required_${name}_failed`);
        else if (!status || status === EvidenceStatus.NOT_RUN) reasons.push(`required_${name}_not_run`);
        else if (status === EvidenceStatus.UNKNOWN) reasons.push(`required_${name}_unknown`);
      }
    }
    if (project.repository?.repositoryType === RepositoryType.UNPROVISIONED_NEW_PROJECT) {
      reasons.push('unprovisioned_project');
    }
    if (!isExistingRepositoryProject(project)) {
      const provisioning = project.provisioning || latestProvisioningRun(project);
      if (!provisioning || provisioning.status === 'NOT_RUN') reasons.push('provisioning_not_run');
      else if (provisioning.status === 'FAIL') reasons.push('provisioning_failed');
      else if (provisioning.status !== 'PASS' && provisioning.status !== 'NOT_APPLICABLE') reasons.push('provisioning_not_run');
      if (provisioning?.status === 'PASS' && !provisioning.baselineSha && !project.repository?.provisioningBaselineSha) {
        reasons.push('missing_provisioning_baseline');
      }
    }
  }

  if (requiresRuntimeVerification(project, evidence)) {
    const runtime = latestRuntimeRun(project, run?.iteration);
    if (!runtime) reasons.push('required_runtime_not_run');
    else if (isRuntimeStale(project, runtime)) reasons.push('stale_runtime_evidence');
    else if (runtime.status === RuntimeStatus.FAIL) reasons.push('required_runtime_failed');
    else if (runtime.status === RuntimeStatus.NOT_RUN) reasons.push('required_runtime_not_run');
    if (runtime?.policy?.accessibility === PolicyLevel.REQUIRED) {
      const blocked = (runtime.accessibility || []).some(item => item.status === 'FAIL' && item.findings?.some(finding => finding.blocking));
      if (blocked) reasons.push('required_accessibility_failed');
    }
  }

  if (requiresVisualVerification(project, evidence)) {
    const visual = latestVisualRun(project, run?.iteration);
    const runtime = latestRuntimeRun(project, run?.iteration);
    if (!visual) reasons.push('required_visual_not_run');
    else if (isVisualStale(project, visual) || (runtime?.checkpointSha && visual.checkpointSha && visual.checkpointSha !== runtime.checkpointSha)) {
      reasons.push('stale_screenshot_evidence');
    } else if (visual.status === RuntimeStatus.NOT_RUN || visual.decision === 'NOT_RUN') reasons.push('required_visual_not_run');
    else if (visual.decision === 'CHANGES_REQUIRED' || (visual.blockingFindings || []).length) reasons.push('blocking_visual_finding');
    else if (visual.status === RuntimeStatus.FAIL) reasons.push('required_visual_failed');
  }

  const review = run ? reviewForIteration(project, run.iteration) : null;
  if (review?.decision?.decision !== 'COMPLETE') reasons.push('review_not_complete');
  if (project?.council?.final?.decision?.decision !== 'COMPLETE') reasons.push('final_verification_not_complete');

  applySecurityGate(project, reasons);

  if (project?.error) reasons.push('unresolved_orchestration_error');
  if (Number(project?.iteration) > Number(maxIterations)) reasons.push('iteration_limit_exceeded');

  return {
    ok: reasons.length === 0,
    reasons,
    verificationLevel: evidence?.verificationLevel || null
  };
}

function requiresPlatformVerification(project, evidence) {
  if (project?.demo) return false;
  if (evidence?.verificationLevel === VerificationLevel.MOCK) return false;
  return true;
}

function requiresRuntimeVerification(project, evidence) {
  if (project?.demo) return false;
  if (evidence?.verificationLevel === VerificationLevel.MOCK) return false;
  if (project?.runtimePolicy?.runtime === PolicyLevel.REQUIRED) return true;
  const runtime = latestRuntimeRun(project);
  return runtime?.policy?.runtime === PolicyLevel.REQUIRED;
}

function requiresVisualVerification(project, evidence) {
  if (project?.demo) return false;
  if (evidence?.verificationLevel === VerificationLevel.MOCK) return false;
  if (project?.runtimePolicy?.visual === PolicyLevel.REQUIRED) return true;
  const runtime = latestRuntimeRun(project);
  const visual = latestVisualRun(project);
  return runtime?.policy?.visual === PolicyLevel.REQUIRED || visual?.decision && visual.decision !== 'NOT_APPLICABLE' && runtime?.policy?.visual === PolicyLevel.REQUIRED;
}
