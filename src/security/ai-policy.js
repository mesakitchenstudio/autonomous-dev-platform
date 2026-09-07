import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { assertPolicyNotAiEditable } from './policy.js';
import { NetworkMode } from '../sandbox/kinds.js';

const PRIVILEGED_NETWORK = new Set([
  NetworkMode.UNRESTRICTED_EXPLICIT
]);

export function validateAiSecurityClaims(candidate, { phase = 'COUNCIL_DISCOVERY' } = {}) {
  const editable = assertPolicyNotAiEditable(candidate);
  if (!editable.ok) {
    throw new PlatformError({
      code: ErrorCode.INVALID_SPECIFICATION,
      message: 'AI output cannot change platform security policy.',
      phase,
      retryable: false,
      details: { attempted: editable.attempted }
    });
  }
  if (candidate?.releaseSecrets || candidate?.secretRelease || candidate?.issueControlPlaneSecret) {
    throw new PlatformError({
      code: ErrorCode.SECRET_ACCESS_DENIED,
      message: 'AI output cannot authorize secret release.',
      phase,
      retryable: false
    });
  }
  if (candidate?.privilegedSandbox || candidate?.sandboxMode === 'PRIVILEGED' || candidate?.hostNamespaces) {
    throw new PlatformError({
      code: ErrorCode.SANDBOX_VIOLATION,
      message: 'AI output cannot authorize a privileged sandbox.',
      phase,
      retryable: false
    });
  }
  if (candidate?.filesystemRoots || candidate?.allowedRoots || candidate?.hostRoot) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'AI output cannot broaden filesystem access.',
      phase,
      retryable: false
    });
  }
  const network = candidate?.networkPolicy || candidate?.network?.mode;
  if (network && PRIVILEGED_NETWORK.has(network) && candidate?.explicitPlatformNetwork !== true) {
    throw new PlatformError({
      code: ErrorCode.NETWORK_POLICY_DENIED,
      message: 'AI output cannot authorize unrestricted or protected network access.',
      phase,
      retryable: false
    });
  }
  return true;
}

export function validateProvisioningSecurity(plan) {
  return validateAiSecurityClaims(plan, { phase: 'PROJECT_PROVISIONING' });
}

export function validateCursorPromptSecurity(contract) {
  return validateAiSecurityClaims(contract?.task || contract, { phase: 'CURSOR_EXECUTING' });
}

export function validateRuntimePlanSecurity(plan) {
  return validateAiSecurityClaims(plan, { phase: 'RUNTIME_VERIFICATION' });
}

export function validateNetworkRequestPlan(plan) {
  const requests = plan?.requests || plan?.egress || [];
  for (const item of requests || []) {
    if (item?.allowUnknown || item?.unrestricted) {
      throw new PlatformError({
        code: ErrorCode.NETWORK_POLICY_DENIED,
        message: 'Unknown egress cannot be authorized by AI output.',
        phase: 'RUNTIME_VERIFICATION',
        retryable: false
      });
    }
  }
  return true;
}
