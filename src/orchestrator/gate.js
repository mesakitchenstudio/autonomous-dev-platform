import { isCanonicalEvidence, EvidenceStatus } from './evidence.js';

export function hasValidSpec(project) {
  const spec = project?.council?.discovery?.spec;
  return Boolean(spec && typeof spec.cursorPrompt === 'string' && spec.cursorPrompt.trim() && spec.productName);
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

  const review = run ? reviewForIteration(project, run.iteration) : null;
  if (review?.decision?.decision !== 'COMPLETE') reasons.push('review_not_complete');
  if (project?.council?.final?.decision?.decision !== 'COMPLETE') reasons.push('final_verification_not_complete');

  if (project?.error) reasons.push('unresolved_orchestration_error');
  if (Number(project?.iteration) > Number(maxIterations)) reasons.push('iteration_limit_exceeded');

  return {
    ok: reasons.length === 0,
    reasons,
    verificationLevel: evidence?.verificationLevel || null
  };
}
