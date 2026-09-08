import crypto from 'node:crypto';
import { latestProvisioningRun } from '../provision/plan.js';
import { latestVerificationRun } from '../verify/pipeline.js';
import { latestRuntimeRun } from '../runtime/pipeline.js';
import { latestVisualRun } from '../visual/pipeline.js';
import { collectRealProjectMockViolations, isGitObjectId, isMockCheckpoint, isSyntheticCheckpoint } from '../orchestrator/mock-policy.js';

function latestCursorRun(project) {
  const runs = project?.cursorRuns || [];
  return runs.length ? runs[runs.length - 1] : null;
}

export function finalCheckpointSha(project) {
  const run = latestCursorRun(project);
  const sha = run?.checkpointSha
    || run?.git?.checkpointSha
    || run?.git?.afterSha
    || run?.result?.checkpointSha
    || run?.result?.git?.checkpointSha
    || null;
  if (sha) return sha;
  if (project?.demo) return `mock:${project.id}:${project.iteration || 1}`;
  return `unverified:${project.id}:${run?.iteration || project?.iteration || 1}`;
}

export function verificationSetHash(project) {
  const run = latestCursorRun(project);
  const verify = latestVerificationRun(project, run?.iteration);
  const runtime = latestRuntimeRun(project, run?.iteration);
  const visual = latestVisualRun(project, run?.iteration);
  const security = project.sandboxProvenance?.sandboxMode || project.evidence?.security?.status || 'none';
  const material = [
    finalCheckpointSha(project) || 'none',
    verify?.id || 'none',
    verify?.status || 'none',
    runtime?.id || 'none',
    runtime?.status || 'none',
    visual?.id || 'none',
    visual?.decision || 'none',
    security
  ].join(':');
  return crypto.createHash('sha256').update(material).digest('hex');
}

export function deliveryIdempotencyKey(project) {
  return `project:${project.id}:delivery:${finalCheckpointSha(project) || 'none'}:${verificationSetHash(project)}`;
}

export function validateEvidenceLineage(project, checkpointSha) {
  const reasons = [...collectRealProjectMockViolations(project)];
  const spec = project?.council?.discovery?.spec;
  if (!spec?.cursorPrompt) reasons.push('missing_authoritative_spec');
  const provisioning = project.provisioning || latestProvisioningRun(project);
  const demo = Boolean(project.demo);
  if (!demo && provisioning?.status === 'PASS') {
    const baseline = provisioning.baselineSha || project.repository?.provisioningBaselineSha;
    if (!baseline) reasons.push('missing_provisioning_baseline');
  }
  if (!checkpointSha) reasons.push('missing_final_checkpoint');
  if (!demo && (isMockCheckpoint(checkpointSha) || isSyntheticCheckpoint(checkpointSha) || !isGitObjectId(checkpointSha))) {
    reasons.push('mock_checkpoint_not_allowed_for_real_project');
  }
  const verify = latestVerificationRun(project, latestCursorRun(project)?.iteration);
  const runtime = latestRuntimeRun(project, latestCursorRun(project)?.iteration);
  const visual = latestVisualRun(project, latestCursorRun(project)?.iteration);
  if (!demo) {
    if (verify?.checkpointSha && checkpointSha && verify.checkpointSha !== 'none' && verify.checkpointSha !== checkpointSha) {
      reasons.push('stale_platform_verification');
    }
    if (runtime?.checkpointSha && checkpointSha && runtime.checkpointSha !== checkpointSha) {
      reasons.push('stale_runtime_evidence');
    }
    if (visual?.checkpointSha && checkpointSha && visual.checkpointSha !== checkpointSha) {
      reasons.push('stale_visual_evidence');
    }
    if (runtime?.screenshots?.some(item => item.checkpointSha && item.checkpointSha !== checkpointSha)) {
      reasons.push('stale_screenshot_evidence');
    }
    if (project.sandboxProvenance?.checkpointSha && project.sandboxProvenance.checkpointSha !== checkpointSha) {
      reasons.push('stale_security_evidence');
    }
  }
  if (!project.council?.final) reasons.push('missing_final_adversarial_review');
  const unique = [...new Set(reasons)];
  return {
    ok: unique.length === 0,
    reasons: unique,
    chain: {
      idea: Boolean(project.idea),
      spec: Boolean(spec),
      provisioningBaselineSha: provisioning?.baselineSha || project.repository?.provisioningBaselineSha || null,
      checkpointSha,
      verificationRunId: verify?.id || null,
      runtimeRunId: runtime?.id || null,
      visualRunId: visual?.id || null,
      securityStatus: project.evidence?.security?.status || project.sandboxProvenance?.sandboxMode || null,
      finalReview: project.council?.final?.decision?.decision || null
    }
  };
}

export function currentDelivery(project) {
  const deliveries = project.deliveries || [];
  return deliveries.find(item => item.current) || deliveries.at(-1) || null;
}

export function deliveryIsCurrent(project, delivery) {
  if (!delivery) return false;
  if (delivery.status === 'STALE' || delivery.status === 'SUPERSEDED') return false;
  const sha = finalCheckpointSha(project);
  const setHash = verificationSetHash(project);
  return delivery.checkpointSha === sha && delivery.verificationSetHash === setHash;
}
