import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { buildVerificationEnv, assertNoPlatformSecrets } from '../verify/env.js';
import { intEnv } from '../util/env.js';
import { RuntimeFindingCode } from './kinds.js';
import { launchSandboxedProcess } from '../sandbox/index.js';
import { NetworkMode } from '../sandbox/kinds.js';

const active = new Set();

export async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export async function launchManagedProcess({
  argv,
  cwd,
  workspaceRoot,
  env,
  timeoutMs,
  logPath,
  extraEnv = {},
  project,
  projectId,
  networkPolicy,
  policyEnv
} = {}) {
  if (!Array.isArray(argv) || !argv.length) {
    throw new PlatformError({
      code: ErrorCode.RUNTIME_START_FAILED,
      message: 'Runtime launch command must be an argument array.',
      phase: 'RUNTIME_VERIFICATION',
      retryable: false
    });
  }
  const workspace = resolveCanonicalSync(workspaceRoot || cwd);
  const workdir = resolveCanonicalSync(cwd);
  if (!isInsideRoot(workdir, workspace)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Runtime cwd is outside the managed workspace.',
      phase: 'RUNTIME_VERIFICATION',
      retryable: false
    });
  }
  const childEnv = { ...(env || buildVerificationEnv()), ...extraEnv };
  assertNoPlatformSecrets(childEnv);
  const handle = await launchSandboxedProcess({
    argv,
    cwd: workdir,
    workspaceRoot: workspace,
    env: childEnv,
    timeoutMs,
    logPath,
    project,
    projectId: projectId || project?.id,
    networkPolicy: networkPolicy || NetworkMode.TEST_LOCAL,
    operation: 'RUNTIME',
    policyEnv
  });
  active.add(handle);
  if (timeoutMs) {
    handle.timer = setTimeout(() => shutdownManagedProcess(handle, 'startup_timeout'), timeoutMs);
    if (handle.timer.unref) handle.timer.unref();
  }
  return handle;
}

export async function waitUntilReady({ url, timeoutMs, processRef, accept = (status) => status > 0 && status < 500 } = {}) {
  const deadline = Date.now() + (timeoutMs || intEnv('RUNTIME_READY_TIMEOUT_MS', 30000));
  const started = Date.now();
  let lastError = null;
  while (Date.now() < deadline) {
    if (processRef?.exited) {
      throw new PlatformError({
        code: ErrorCode.RUNTIME_PROCESS_EXITED,
        message: `Runtime process exited before readiness (code=${processRef.exitCode}).`,
        phase: 'RUNTIME_VERIFICATION',
        retryable: false,
        details: { code: RuntimeFindingCode.RUNTIME_PROCESS_EXITED, stderr: String(processRef.stderr || '').slice(0, 800) }
      });
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (accept(response.status)) {
        return {
          status: response.status,
          url,
          durationMs: Date.now() - started
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(200);
  }
  throw new PlatformError({
    code: ErrorCode.RUNTIME_READINESS_TIMEOUT,
    message: `Runtime readiness timed out for ${url}: ${lastError || 'no response'}`,
    phase: 'RUNTIME_VERIFICATION',
    retryable: false,
    details: { code: RuntimeFindingCode.RUNTIME_READINESS_TIMEOUT, url }
  });
}

export function shutdownManagedProcess(handle, reason = 'shutdown') {
  if (!handle) return { attempted: false, reason };
  if (handle.timer) clearTimeout(handle.timer);
  const child = handle.child;
  if (typeof handle.sandbox?.cancel === 'function') handle.sandbox.cancel(reason);
  if (typeof handle.sandbox?.destroy === 'function') handle.sandbox.destroy().catch(() => {});
  if (child?.pid && !handle.exited) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 8000 });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      }
    } catch {}
  }
  active.delete(handle);
  handle.shutdownReason = reason;
  return { attempted: true, reason, pid: handle.pid };
}

export function cancelActiveRuntime(reason = 'cancelled') {
  const handles = [...active];
  for (const handle of handles) shutdownManagedProcess(handle, reason);
  return { attempted: handles.length > 0, reason, count: handles.length };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
