import { detectToolchains, mergePolicy, primaryProjectType } from './detect.js';
import { PolicyLevel, ProjectTypes, VerificationKind } from './kinds.js';
import { RepositoryType } from '../git/worktree.js';

const ORDER = [
  VerificationKind.DEPENDENCY_INSTALL,
  VerificationKind.BUILD,
  VerificationKind.STATIC_ANALYSIS,
  VerificationKind.TEST,
  VerificationKind.LINT,
  VerificationKind.SECURITY_CHECK
];

export async function createVerificationPlan(workspacePath, project = {}) {
  const unprovisioned = project.repository?.repositoryType === RepositoryType.UNPROVISIONED_NEW_PROJECT;
  if (unprovisioned) {
    return {
      projectType: ProjectTypes.UNPROVISIONED,
      detectedTooling: [],
      problems: [{ code: 'UNPROVISIONED', message: 'New project has not been provisioned; no build system is applicable.' }],
      policy: mergePolicy([], { unprovisioned: true }),
      steps: []
    };
  }

  const detections = await detectToolchains(workspacePath);
  const problems = [];
  for (const item of detections) {
    if (item.detection.lockfileConflict) {
      problems.push({
        code: 'CONFLICTING_LOCKFILES',
        message: `Multiple Node lockfiles present: ${item.detection.lockfiles.join(', ')}`,
        files: item.detection.lockfiles
      });
    }
  }

  const steps = [];
  for (const item of detections) {
    const adapter = item.adapter;
    const detection = item.detection;
    const produced = [
      adapter.dependencyInstallStep?.(detection),
      ...(adapter.buildSteps?.(detection) || []),
      ...(adapter.staticAnalysisSteps?.(detection) || []),
      ...(adapter.testSteps?.(detection) || []),
      ...(adapter.lintSteps?.(detection) || []),
      ...(adapter.securitySteps?.(detection) || [])
    ].filter(Boolean);
    steps.push(...produced);
  }

  steps.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const policy = mergePolicy(detections, { unprovisioned: false });
  if (!detections.length) {
    problems.push({ code: 'NO_BUILD_SYSTEM', message: 'No detectable toolchain. Verification cannot invent commands.' });
  }

  return {
    projectType: primaryProjectType(detections, project.repository),
    detectedTooling: detections.map(item => item.detection),
    problems,
    policy,
    steps
  };
}

export function policyForKind(policy, kind) {
  if (kind === VerificationKind.BUILD) return policy.build;
  if (kind === VerificationKind.TEST) return policy.tests;
  if (kind === VerificationKind.LINT) return policy.lint;
  if (kind === VerificationKind.STATIC_ANALYSIS) return policy.staticAnalysis;
  if (kind === VerificationKind.SECURITY_CHECK) return policy.security;
  if (kind === VerificationKind.DEPENDENCY_INSTALL) return PolicyLevel.REQUIRED;
  return PolicyLevel.OPTIONAL;
}
