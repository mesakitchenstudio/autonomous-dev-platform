import { collectGitEvidence, createCheckpointCommit } from '../git/checkpoint.js';
import { EvidenceProvenance, EvidenceStatus, VerificationLevel, createEvidence } from '../orchestrator/evidence.js';
import { CursorUncertainty } from './contract.js';
import { detectArchitectureReplacement } from '../provision/validate.js';

export async function cursorPostflight({ project, workspacePath, raw, demo }) {
  const repo = project.repository;
  if (demo || !repo?.workspacePath) {
    return {
      git: raw?.git || null,
      evidence: raw?.evidence || null,
      checkpointSha: raw?.checkpointSha || raw?.git?.checkpointSha || raw?.result?.checkpointSha || null,
      changedFiles: raw?.git?.changedFiles || []
    };
  }
  const collected = await collectGitEvidence(workspacePath, {
    baselineSha: repo.baselineSha,
    workspaceRoot: repo.workspacePath
  });
  let checkpoint = { committed: false, sha: collected.snapshot.sha, evidence: collected };
  if (collected.secrets.length === 0 && collected.snapshot.dirty) {
    checkpoint = await createCheckpointCommit(workspacePath, {
      iteration: project.iteration,
      branch: repo.workingBranch,
      workspaceRoot: repo.workspacePath
    });
  } else if (collected.secrets.length) {
    const error = new Error(`Protected secret files were modified and were not committed: ${collected.secrets.join(', ')}`);
    error.code = 'SECRET_FILE_BLOCKED';
    error.retryable = true;
    error.details = { files: collected.secrets, git: collected };
    throw error;
  }
  const after = checkpoint.evidence.snapshot;
  const git = {
    beforeSha: repo.baselineSha,
    afterSha: after.sha,
    branch: after.branch,
    changedFiles: checkpoint.evidence.manifest,
    diffStat: checkpoint.evidence.diffStat,
    dirty: after.dirty,
    checkpointSha: checkpoint.committed ? checkpoint.sha : after.sha
  };
  const evidence = mergeGitEvidence(raw?.evidence, git, demo);
  const architectureRisk = detectArchitectureReplacement(git.changedFiles, project.provisioningPlan);
  if (architectureRisk.highRisk) {
    evidence.warnings = [...(evidence.warnings || []), `High-interest architecture change: ${architectureRisk.files.map(item => `${item.path} (${item.reason})`).join(', ')}`];
    project.architectureReplacement = architectureRisk;
  }
  return {
    git,
    evidence,
    checkpointSha: git.checkpointSha,
    changedFiles: git.changedFiles,
    uncertainty: after.dirty ? CursorUncertainty.UNCOMMITTED_CHANGES : raw?.uncertainty,
    architectureReplacement: architectureRisk
  };
}

export function mergeGitEvidence(existing, git, demo) {
  if (demo) return existing;
  const base = existing && typeof existing === 'object' ? existing : {};
  return createEvidence({
    ...base,
    verificationLevel: base.verificationLevel === VerificationLevel.MOCK
      ? VerificationLevel.MOCK
      : VerificationLevel.SELF_REPORTED,
    git: {
      status: git?.afterSha ? EvidenceStatus.PASS : EvidenceStatus.UNKNOWN,
      provenance: EvidenceProvenance.PLATFORM_VERIFIED,
      detail: `branch=${git.branch || '?'} before=${git.beforeSha || '?'} after=${git.afterSha || '?'} files=${git.changedFiles?.length || 0}`
    },
    build: base.build || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED, detail: 'Build not independently verified in Phase 4.' },
    tests: base.tests || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED, detail: 'Tests not independently verified in Phase 4.' },
    lint: base.lint || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED },
    runtime: base.runtime || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED },
    visual: base.visual || { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED }
  });
}
