import { SandboxMode } from '../security/kinds.js';
import { SandboxBackend } from './kinds.js';
import { resolveSandboxPolicy, defaultNetworkForKind } from './policy.js';
import { MockSandbox } from './mock.js';
import { LocalUnsafeSandbox } from './local-unsafe.js';
import { ContainerSandbox } from './container.js';
import { createSandboxSessionRecord, bindSandboxSession, completeSandboxSession } from './session.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export function createSandbox(policy) {
  if (policy.backend === SandboxBackend.MOCK || policy.mode === SandboxMode.MOCK) {
    return new MockSandbox(policy);
  }
  if (policy.backend === SandboxBackend.LOCAL_UNSAFE || policy.mode === SandboxMode.LOCAL_DEVELOPMENT_UNSAFE) {
    return new LocalUnsafeSandbox(policy);
  }
  if (policy.backend === SandboxBackend.CONTAINER || policy.mode === SandboxMode.CONTAINER_HARDENED) {
    return new ContainerSandbox(policy, policy.discovery);
  }
  throw new PlatformError({
    code: ErrorCode.SANDBOX_INFRASTRUCTURE_UNAVAILABLE,
    message: `Unknown sandbox backend ${policy.backend}.`,
    phase: 'SANDBOX',
    retryable: false
  });
}

export async function resolveExecutionSandbox(options = {}) {
  const policy = resolveSandboxPolicy({
    project: options.project,
    demo: options.demo || options.project?.demo,
    env: options.policyEnv || process.env,
    operation: options.operation
  });
  policy.projectId = options.project?.id || options.projectId || null;
  const sandbox = createSandbox(policy);
  return { sandbox, policy };
}

export async function executeSandboxedCommand(options = {}) {
  const { sandbox, policy } = await resolveExecutionSandbox(options);
  const session = createSandboxSessionRecord({
    projectId: options.project?.id || options.projectId || null,
    iteration: options.project?.iteration || options.iteration,
    backend: policy.backend,
    mode: policy.mode,
    imageDigest: null,
    policy,
    networkPolicy: options.networkPolicy || defaultNetworkForKind(options.kind, policy.profile),
    resourceLimits: policy.limits
  });
  bindSandboxSession(session.sandboxRunId, sandbox);
  try {
    await sandbox.prepare({
      project: options.project,
      workspaceRoot: options.workspaceRoot || options.cwd,
      artifactDir: options.artifactDir,
      cacheDir: options.cacheDir,
      imageId: options.imageId || 'node',
      networkMode: session.networkPolicy
    });
    const result = await sandbox.execute({
      ...options,
      networkMode: session.networkPolicy
    });
    completeSandboxSession(session.sandboxRunId, result.timedOut ? 'TIMEOUT' : 'COMPLETED');
    return {
      ...result,
      sandboxRunId: session.sandboxRunId,
      sandboxMode: result.sandboxMode || policy.mode,
      sandboxBackend: result.sandboxBackend || policy.backend,
      sandboxPolicy: {
        profile: policy.profile,
        mode: policy.mode,
        unsafe: policy.unsafe,
        hardened: policy.hardened
      }
    };
  } catch (error) {
    completeSandboxSession(session.sandboxRunId, 'FAILED');
    throw error;
  } finally {
    if (!options.keepAlive) await sandbox.destroy().catch(() => {});
  }
}

export async function launchSandboxedProcess(options = {}) {
  const { sandbox, policy } = await resolveExecutionSandbox({
    ...options,
    operation: 'RUNTIME',
    policyEnv: options.policyEnv
  });
  await sandbox.prepare({
    project: options.project,
    workspaceRoot: options.workspaceRoot || options.cwd,
    artifactDir: options.artifactDir,
    imageId: options.imageId || 'node',
    networkMode: options.networkPolicy || defaultNetworkForKind('RUNTIME', policy.profile)
  });
  const handle = await sandbox.launch(options);
  handle.sandbox = sandbox;
  handle.sandboxPolicy = {
    profile: policy.profile,
    mode: policy.mode,
    unsafe: policy.unsafe,
    hardened: policy.hardened
  };
  return handle;
}

export { resolveSandboxPolicy };
export { MockSandbox } from './mock.js';
export { LocalUnsafeSandbox } from './local-unsafe.js';
export { ContainerSandbox, containerHardeningFlags } from './container.js';
export { cleanupOrphanSandboxes } from './cleanup.js';
export { discoverContainerCapabilities, cachedContainerCapabilities } from './discover.js';
