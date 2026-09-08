import { intEnv } from '../util/env.js';
import { SandboxMode } from '../security/kinds.js';
import { SecurityProfile } from '../security/kinds.js';
import { resolveRequiredSandboxMode, resolveSecurityProfile } from '../security/policy.js';
import { NetworkMode, SandboxBackend, emptyIsolationCapabilities } from './kinds.js';
import { cachedContainerCapabilities } from './discover.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { assertMockBackendAllowed, isDemoOrTestContext } from '../security/mock-backends.js';

export function resourceLimitsFromEnv(env = process.env) {
  return {
    cpu: env.SANDBOX_CPU_LIMIT || '1',
    memory: env.SANDBOX_MEMORY_LIMIT || '1g',
    pids: intEnv('SANDBOX_PIDS_LIMIT', 256),
    diskMb: intEnv('SANDBOX_DISK_LIMIT_MB', 2048),
    timeoutMs: intEnv('SANDBOX_TIMEOUT_MS', 300000),
    logBytes: intEnv('SANDBOX_LOG_LIMIT_BYTES', intEnv('VERIFY_MAX_LOG_BYTES', 1_000_000))
  };
}

export function resolveSandboxPolicy({ project, demo, env = process.env, operation } = {}) {
  const profile = resolveSecurityProfile(env, project);
  const requiredMode = resolveRequiredSandboxMode({ project, demo, env });
  if (String(env.SANDBOX_BACKEND || '').toLowerCase() === 'mock') {
    assertMockBackendAllowed('MockSandbox', env, { demo, project });
  }
  const discovery = requiredMode === SandboxMode.CONTAINER_HARDENED
    ? cachedContainerCapabilities()
    : { available: false, capabilities: emptyIsolationCapabilities() };

  if (requiredMode === SandboxMode.CONTAINER_HARDENED && !discovery.available) {
    if (String(env.SANDBOX_BACKEND || '').toLowerCase() === 'mock' && isDemoOrTestContext(env, { demo, project })) {
      // Demo/test may still request a mock backend when a container engine is absent.
    } else {
      throw new PlatformError({
        code: ErrorCode.SANDBOX_INFRASTRUCTURE_UNAVAILABLE,
        message: 'Production policy requires a hardened container sandbox, but no container engine is available. Refusing to run untrusted project code on the host.',
        phase: 'SANDBOX',
        retryable: true,
        details: {
          profile,
          requiredMode,
          os: discovery.capabilities?.os || process.platform
        }
      });
    }
  }

  const backend = requiredMode === SandboxMode.MOCK
    ? SandboxBackend.MOCK
    : requiredMode === SandboxMode.LOCAL_DEVELOPMENT_UNSAFE
      ? SandboxBackend.LOCAL_UNSAFE
      : SandboxBackend.CONTAINER;

  return {
    profile,
    mode: requiredMode,
    backend,
    operation: operation || null,
    networkMode: env.SANDBOX_NETWORK_POLICY || null,
    limits: resourceLimitsFromEnv(env),
    discovery,
    unsafe: requiredMode === SandboxMode.LOCAL_DEVELOPMENT_UNSAFE,
    hardened: requiredMode === SandboxMode.CONTAINER_HARDENED,
    aiEditable: false
  };
}

export function defaultNetworkForKind(kind, profile) {
  if (kind === 'DEPENDENCY_INSTALL' || kind === 'PACKAGE_INSTALL') return NetworkMode.PACKAGE_REGISTRY_ONLY;
  if (kind === 'PROJECT_RUNTIME' || kind === 'RUNTIME') return NetworkMode.TEST_LOCAL;
  if (profile === SecurityProfile.DEVELOPMENT) return NetworkMode.TEST_LOCAL;
  return NetworkMode.NONE;
}
