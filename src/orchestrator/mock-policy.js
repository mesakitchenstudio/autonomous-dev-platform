import { EvidenceProvenance, VerificationLevel } from './evidence.js';
import { CursorMode } from '../cursor/contract.js';
import { SandboxMode } from '../security/kinds.js';

const MOCK_REASON = 'mock_evidence_not_allowed_for_real_project';
const MOCK_CHECKPOINT_REASON = 'mock_checkpoint_not_allowed_for_real_project';
const DETERMINISTIC_VISUAL_REASON = 'deterministic_visual_not_allowed_for_required_ai_review';

export function isGitObjectId(value) {
  return /^[0-9a-f]{7,64}$/i.test(String(value || '').trim());
}

export function isSyntheticCheckpoint(value) {
  const sha = String(value || '');
  return sha.startsWith('mock:') || sha.startsWith('unverified:');
}

export function isMockCheckpoint(value) {
  return String(value || '').startsWith('mock:');
}

export function isExplicitDemoProject(project) {
  return Boolean(project?.demo);
}

function unique(reasons) {
  return [...new Set(reasons.filter(Boolean))];
}

function mergedEvidence(project) {
  const run = project?.cursorRuns?.at?.(-1);
  if (run?.evidence && project?.evidence) return { ...run.evidence, ...project.evidence };
  return run?.evidence || project?.evidence || null;
}

function aspectIsMock(item) {
  if (!item) return false;
  return item.provenance === EvidenceProvenance.MOCK || item.mock === true;
}

export function isHeuristicVisualRun(visual) {
  if (!visual) return false;
  if (visual.heuristicOnly || visual.aiReviewed === false) return true;
  return visual.chair?.provider === 'deterministic';
}

export function collectRealProjectMockViolations(project) {
  if (isExplicitDemoProject(project)) return [];
  const reasons = [];
  const evidence = mergedEvidence(project);
  const run = project?.cursorRuns?.at?.(-1);
  const runtime = project?.runtimeRuns?.at?.(-1);
  const visual = project?.visualReviewRuns?.at?.(-1);
  const verification = project?.verificationRuns?.at?.(-1);
  const delivery = (project?.deliveries || []).find(item => item.current) || (project?.deliveries || []).at(-1);

  if (evidence?.verificationLevel === VerificationLevel.MOCK) reasons.push(MOCK_REASON);
  if (project?.verificationLevel === VerificationLevel.MOCK) reasons.push(MOCK_REASON);
  if (delivery?.verificationLevel === VerificationLevel.MOCK || delivery?.demo) reasons.push(MOCK_REASON);

  const aspects = ['execution', 'git', 'build', 'tests', 'lint', 'runtime', 'functional', 'accessibility', 'visual', 'security', 'provisioning'];
  if (aspects.some(key => aspectIsMock(evidence?.[key]))) reasons.push(MOCK_REASON);

  if (run?.executionMode === CursorMode.MOCK || run?.result?.executionMode === CursorMode.MOCK || run?.mock) {
    reasons.push(MOCK_REASON);
  }
  if (runtime?.mock || runtime?.adapter === 'MOCK') reasons.push(MOCK_REASON);
  if (visual?.mock) reasons.push(MOCK_REASON);
  if (verification?.mock) reasons.push(MOCK_REASON);
  if (project?.sandboxProvenance?.sandboxMode === SandboxMode.MOCK || project?.security?.sandboxMode === SandboxMode.MOCK) {
    reasons.push(MOCK_REASON);
  }

  const checkpoint = run?.checkpointSha
    || run?.git?.checkpointSha
    || delivery?.checkpointSha
    || project?.checkpoint?.sha
    || null;
  if (isMockCheckpoint(checkpoint) || isSyntheticCheckpoint(checkpoint)) {
    reasons.push(MOCK_CHECKPOINT_REASON);
  }

  return unique(reasons);
}

export function collectDeterministicVisualViolations(project, { required = false } = {}) {
  if (isExplicitDemoProject(project) || !required) return [];
  const visual = [...(project?.visualReviewRuns || [])].reverse()
    .find(item => Number(item.iteration) === Number(project?.iteration))
    || project?.visualReviewRuns?.at?.(-1);
  if (!visual) return [];
  if (visual.decision === 'NOT_APPLICABLE') return [];
  if (isHeuristicVisualRun(visual)) return [DETERMINISTIC_VISUAL_REASON];
  return [];
}

export { MOCK_REASON, MOCK_CHECKPOINT_REASON, DETERMINISTIC_VISUAL_REASON };
