import { NetworkMode, SandboxOperation } from './kinds.js';
import { SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export const PACKAGE_REGISTRY_HOSTS = Object.freeze([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'index.crates.io',
  'static.crates.io',
  'repo.maven.apache.org',
  'api.nuget.org'
]);

export const BLOCKED_METADATA_HOSTS = Object.freeze([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.gce.internal'
]);

export const BLOCKED_PRIVATE_PATTERNS = Object.freeze([
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^localhost$/i,
  /^\[::1\]$/,
  /^::1$/
]);

export function networkModeForOperation(operation, { profileNetwork } = {}) {
  if (operation === SandboxOperation.TEST || operation === 'STATIC_ANALYSIS' || operation === 'LINT' || operation === 'SECURITY_CHECK') {
    return NetworkMode.NONE;
  }
  if (operation === SandboxOperation.PACKAGE_INSTALL || operation === SandboxOperation.PROVISION || operation === 'DEPENDENCY_INSTALL') {
    return NetworkMode.PACKAGE_REGISTRY_ONLY;
  }
  if (operation === SandboxOperation.RUNTIME) return NetworkMode.TEST_LOCAL;
  if (operation === SandboxOperation.VERIFY || operation === 'BUILD') return NetworkMode.NONE;
  return profileNetwork || NetworkMode.NONE;
}

export function allowedHostsForMode(mode, extra = []) {
  if (mode === NetworkMode.NONE) return [];
  if (mode === NetworkMode.PACKAGE_REGISTRY_ONLY) return [...PACKAGE_REGISTRY_HOSTS, ...extra];
  if (mode === NetworkMode.PROJECT_ALLOWLIST) return [...extra];
  if (mode === NetworkMode.TEST_LOCAL) return [...extra];
  if (mode === NetworkMode.UNRESTRICTED_EXPLICIT) return null;
  return [];
}

export function hostIsBlocked(host) {
  const value = String(host || '').replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  if (BLOCKED_METADATA_HOSTS.includes(value)) return true;
  return BLOCKED_PRIVATE_PATTERNS.some(pattern => pattern.test(value));
}

export function assertNetworkAllowed(target, mode, { projectId, extraAllow = [], store } = {}) {
  if (mode === NetworkMode.UNRESTRICTED_EXPLICIT) return true;
  const host = String(target || '').replace(/^https?:\/\//, '').split('/')[0];
  if (hostIsBlocked(host) && mode !== NetworkMode.TEST_LOCAL) {
    recordSecurityEvent(SecurityEventType.NETWORK_POLICY_DENIED, { projectId, target: host, mode }, { store, projectId });
    throw new PlatformError({
      code: ErrorCode.NETWORK_POLICY_DENIED,
      message: 'Sandbox network policy denied a private or metadata endpoint.',
      phase: 'SANDBOX',
      retryable: false,
      details: { target: host, mode }
    });
  }
  if (mode === NetworkMode.NONE) {
    recordSecurityEvent(SecurityEventType.NETWORK_POLICY_DENIED, { projectId, target: host, mode }, { store, projectId });
    throw new PlatformError({
      code: ErrorCode.NETWORK_POLICY_DENIED,
      message: 'Sandbox network policy is NONE; egress is denied.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  const allow = allowedHostsForMode(mode, extraAllow);
  if (allow && !allow.includes(host.split(':')[0]) && mode !== NetworkMode.TEST_LOCAL) {
    recordSecurityEvent(SecurityEventType.NETWORK_POLICY_DENIED, { projectId, target: host, mode }, { store, projectId });
    throw new PlatformError({
      code: ErrorCode.NETWORK_POLICY_DENIED,
      message: `Sandbox network policy denied host ${host}.`,
      phase: 'SANDBOX',
      retryable: false
    });
  }
  return true;
}

export function dockerNetworkFlag(mode) {
  if (mode === NetworkMode.NONE) return ['--network', 'none'];
  return ['--network', 'bridge'];
}

export function networkEnforcementNote(mode, capabilities) {
  if (mode === NetworkMode.NONE) {
    return 'Docker --network none isolates the container from all networks, including the host loopback.';
  }
  if (!capabilities?.hostnameAllowlistEnforced) {
    return 'Hostname allowlists are recorded as policy. The first Docker backend cannot enforce DNS names perfectly; isolation uses an unprivileged bridge or none, which does not share the host network namespace.';
  }
  return 'Hostname allowlist enforced at the sandbox network layer.';
}
