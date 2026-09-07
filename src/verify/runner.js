import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { intEnv } from '../util/env.js';
import { buildVerificationEnv, assertNoPlatformSecrets } from './env.js';
import { executeSandboxedCommand } from '../sandbox/index.js';
import { defaultNetworkForKind } from '../sandbox/policy.js';

const active = new Set();

export function verificationOutputLimits() {
  return {
    previewBytes: intEnv('VERIFY_OUTPUT_PREVIEW_BYTES', 8000),
    maxLogBytes: intEnv('VERIFY_MAX_LOG_BYTES', 1_000_000)
  };
}

export function timeoutForKind(kind) {
  const map = {
    DEPENDENCY_INSTALL: intEnv('VERIFY_INSTALL_TIMEOUT_MS', 300000),
    BUILD: intEnv('VERIFY_BUILD_TIMEOUT_MS', 300000),
    TEST: intEnv('VERIFY_TEST_TIMEOUT_MS', 300000),
    LINT: intEnv('VERIFY_LINT_TIMEOUT_MS', 180000),
    STATIC_ANALYSIS: intEnv('VERIFY_LINT_TIMEOUT_MS', 180000),
    SECURITY_CHECK: intEnv('VERIFY_LINT_TIMEOUT_MS', 180000)
  };
  return map[kind] || intEnv('VERIFY_BUILD_TIMEOUT_MS', 300000);
}

export function cancelActiveVerification(reason = 'cancelled') {
  const handles = [...active];
  for (const handle of handles) {
    if (typeof handle.cancel === 'function') handle.cancel(reason);
  }
  return { attempted: handles.length > 0, reason };
}

export async function runVerificationCommand({
  argv,
  cwd,
  workspaceRoot,
  timeoutMs,
  env,
  logPath,
  kind,
  project,
  projectId,
  networkPolicy,
  operation
} = {}) {
  if (!Array.isArray(argv) || !argv.length) {
    throw new PlatformError({
      code: ErrorCode.VERIFICATION_COMMAND_INVALID,
      message: 'Verification command must be an argument array.',
      phase: 'PLATFORM_VERIFICATION',
      retryable: false
    });
  }
  const workspace = resolveCanonicalSync(workspaceRoot || cwd);
  const workdir = resolveCanonicalSync(cwd);
  if (!isInsideRoot(workdir, workspace)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Verification cwd is outside the managed workspace.',
      phase: 'PLATFORM_VERIFICATION',
      retryable: false,
      details: { cwd, workspaceRoot }
    });
  }
  const childEnv = env || buildVerificationEnv();
  assertNoPlatformSecrets(childEnv);
  const limits = verificationOutputLimits();
  const handle = { cancel: null };
  active.add(handle);
  try {
    const result = await executeSandboxedCommand({
      argv,
      cwd: workdir,
      workspaceRoot: workspace,
      timeoutMs: timeoutMs || timeoutForKind(kind),
      env: childEnv,
      logPath,
      kind,
      project,
      projectId: projectId || project?.id,
      networkPolicy: networkPolicy || defaultNetworkForKind(kind),
      operation: operation || 'VERIFY'
    });
    return {
      ...result,
      stdoutPreview: result.stdoutPreview || String(result.stdout || '').slice(0, limits.previewBytes),
      stderrPreview: result.stderrPreview || String(result.stderr || '').slice(0, limits.previewBytes)
    };
  } finally {
    active.delete(handle);
  }
}
