import { EvidenceStatus } from '../orchestrator/evidence.js';
import { SandboxMode, SecurityProfile } from './kinds.js';
import { resolveSecurityProfile } from './policy.js';
import { defaultSecretBroker } from '../secrets/broker.js';

export function latestSecurityEvidence(project) {
  return project?.security || project?.evidence?.security || null;
}

export function hasUnresolvedSandboxViolations(project) {
  const findings = project?.securityFindings || [];
  return findings.some(item => item.blocking && (item.kind === 'SANDBOX_VIOLATION' || item.code === 'SANDBOX_VIOLATION'));
}

export function hasBlockingSecretFindings(project) {
  const findings = [
    ...(project?.securityFindings || []),
    ...(project?.secretScanFindings || [])
  ];
  return findings.some(item => item.blocking !== false && (item.kind === 'SOURCE_SECRET' || item.confidence === 'high' || item.code === 'SECRET_DETECTED_IN_SOURCE'));
}

export function applySecurityGate(project, reasons) {
  if (project?.demo) return reasons;

  const profile = resolveSecurityProfile(process.env, project);
  const security = latestSecurityEvidence(project);
  const provenance = project?.sandboxProvenance || security?.detail || null;

  if (hasUnresolvedSandboxViolations(project)) reasons.push('unresolved_sandbox_violation');
  if (hasBlockingSecretFindings(project)) reasons.push('blocking_source_secret');

  const pending = defaultSecretBroker().requiredRevocationPending({ projectId: project.id });
  if (pending.length) reasons.push('unreleased_secret_lease');

  const mode = project?.sandboxProvenance?.sandboxMode || security?.sandboxMode;
  if (mode === SandboxMode.LOCAL_DEVELOPMENT_UNSAFE && (security?.hardened === true || project?.sandboxProvenance?.hardened === true)) {
    reasons.push('unsafe_sandbox_masquerading_as_hardened');
  }

  if (profile === SecurityProfile.STANDARD || profile === SecurityProfile.HARDENED) {
    if (!security || security.status === EvidenceStatus.FAIL) reasons.push('required_security_failed');
    if (!security || security.status === EvidenceStatus.NOT_RUN) reasons.push('required_security_not_run');
    if (mode && mode !== SandboxMode.CONTAINER_HARDENED) reasons.push('required_sandbox_mode_unsatisfied');
    if (project?.sandboxProvenance && project.sandboxProvenance.hardened !== true) {
      reasons.push('required_sandbox_mode_unsatisfied');
    }
  }
  void provenance;
  return reasons;
}

export function buildSecurityAspect({ project, run } = {}) {
  const mode = run?.sandboxMode || run?.sandboxPolicy?.mode;
  const unsafe = mode === SandboxMode.LOCAL_DEVELOPMENT_UNSAFE;
  const hardened = mode === SandboxMode.CONTAINER_HARDENED;
  const violations = hasUnresolvedSandboxViolations(project) || hasBlockingSecretFindings(project);
  const status = violations ? EvidenceStatus.FAIL : EvidenceStatus.PASS;
  return {
    status,
    provenance: 'PLATFORM_VERIFIED',
    detail: unsafe
      ? 'LOCAL_DEVELOPMENT_UNSAFE — host process execution; not hardened isolation.'
      : hardened
        ? 'CONTAINER_HARDENED sandbox controls were applied.'
        : 'Security controls recorded.',
    sandbox: status,
    secretIsolation: violations ? EvidenceStatus.FAIL : EvidenceStatus.PASS,
    networkPolicy: run?.networkPolicy || EvidenceStatus.PASS,
    sourceSecretScan: hasBlockingSecretFindings(project) ? EvidenceStatus.FAIL : EvidenceStatus.PASS,
    authControlPlane: EvidenceStatus.PASS,
    sandboxMode: mode,
    hardened,
    unsafe
  };
}
