import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { ErrorCode, PlatformError, redactSecrets } from '../orchestrator/errors.js';
import { SandboxBackend, emptyIsolationCapabilities } from './kinds.js';
import { SandboxMode } from '../security/kinds.js';
import { SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}

export class LocalUnsafeSandbox {
  constructor(policy) {
    this.policy = policy;
    this.active = new Set();
    this.prepared = false;
  }

  async prepare() {
    this.prepared = true;
    return {
      sandboxRunId: null,
      mode: SandboxMode.LOCAL_DEVELOPMENT_UNSAFE,
      unsafe: true,
      hardened: false
    };
  }

  capabilities() {
    return {
      ...emptyIsolationCapabilities(),
      engine: 'host-process',
      os: process.platform,
      resourceLimits: false,
      pidsLimit: false,
      networkPolicy: false,
      seccomp: false,
      noNewPrivileges: false,
      capDrop: false,
      nonRootUser: process.getuid ? process.getuid() !== 0 : true
    };
  }

  async execute({
    argv,
    cwd,
    workspaceRoot,
    timeoutMs,
    env,
    logPath,
    projectId,
    store
  } = {}) {
    if (!Array.isArray(argv) || !argv.length) {
      throw new PlatformError({
        code: ErrorCode.VERIFICATION_COMMAND_INVALID,
        message: 'Sandbox command must be an argument array.',
        phase: 'SANDBOX',
        retryable: false
      });
    }
    const workspace = resolveCanonicalSync(workspaceRoot || cwd);
    const workdir = resolveCanonicalSync(cwd);
    if (!isInsideRoot(workdir, workspace)) {
      recordSecurityEvent(SecurityEventType.PROTECTED_PATH_DENIED, { projectId, path: workdir }, { store, projectId });
      throw new PlatformError({
        code: ErrorCode.WORKSPACE_UNSAFE,
        message: 'Sandbox cwd is outside the managed workspace.',
        phase: 'SANDBOX',
        retryable: false
      });
    }
    const limits = this.policy.limits || {};
    const maxLog = Number(process.env.SANDBOX_LOG_LIMIT_BYTES || process.env.VERIFY_MAX_LOG_BYTES || limits.logBytes || 1_000_000);
    const preview = 8000;
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let captured = 0;
    let truncated = false;
    const logFd = logPath ? fs.openSync(logPath, 'w') : null;
    const append = (stream, chunk) => {
      const text = redactSecrets(String(chunk));
      stream.push(text);
      captured += Buffer.byteLength(text);
      if (captured > maxLog) truncated = true;
      if (logFd && captured <= maxLog) fs.writeSync(logFd, text);
    };

    return new Promise(resolve => {
      const [bin, ...args] = argv;
      const child = spawn(bin, args, {
        cwd: workdir,
        env,
        windowsHide: true,
        shell: process.platform === 'win32' && !path.extname(bin) && !path.isAbsolute(bin)
      });
      this.active.add(child);
      const timer = setTimeout(() => {
        killTree(child);
        child.killedByTimeout = true;
        recordSecurityEvent(SecurityEventType.SANDBOX_RESOURCE_LIMIT, {
          projectId,
          limit: 'timeout',
          timeoutMs: timeoutMs || limits.timeoutMs
        }, { store, projectId });
      }, timeoutMs || limits.timeoutMs || 300000);
      child.stdout?.on('data', chunk => append(stdoutChunks, chunk));
      child.stderr?.on('data', chunk => append(stderrChunks, chunk));
      const finish = (extra) => {
        clearTimeout(timer);
        this.active.delete(child);
        if (logFd) try { fs.closeSync(logFd); } catch {}
        const stdout = redactSecrets(stdoutChunks.join(''));
        const stderr = redactSecrets(stderrChunks.join(''));
        resolve({
          argv,
          cwd: workdir,
          exitCode: extra.exitCode ?? null,
          signal: extra.signal ?? null,
          timedOut: Boolean(child.killedByTimeout),
          missingExecutable: Boolean(extra.missingExecutable),
          stdout: extra.stdout || stdout,
          stderr,
          stdoutPreview: (extra.stdout || stdout).slice(0, preview),
          stderrPreview: stderr.slice(0, preview),
          truncated,
          durationMs: Date.now() - startedAt,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          sandboxMode: SandboxMode.LOCAL_DEVELOPMENT_UNSAFE,
          sandboxBackend: SandboxBackend.LOCAL_UNSAFE,
          isolationCapabilities: this.capabilities(),
          unsafe: true,
          hardened: false
        });
      };
      child.on('error', error => finish({ missingExecutable: true, stdout: redactSecrets(error.message), exitCode: null }));
      child.on('close', (code, signal) => finish({ exitCode: code, signal }));
    });
  }

  async launch(request = {}) {
    const workspace = resolveCanonicalSync(request.workspaceRoot || request.cwd);
    const workdir = resolveCanonicalSync(request.cwd);
    if (!isInsideRoot(workdir, workspace)) {
      throw new PlatformError({
        code: ErrorCode.WORKSPACE_UNSAFE,
        message: 'Runtime cwd is outside the managed workspace.',
        phase: 'RUNTIME_VERIFICATION',
        retryable: false
      });
    }
    const [bin, ...args] = request.argv;
    const ext = path.extname(bin).toLowerCase();
    const child = spawn(bin, args, {
      cwd: workdir,
      env: request.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32' && (!ext || ext === '.cmd' || ext === '.bat')
    });
    const handle = {
      pid: child.pid,
      argv: request.argv,
      cwd: workdir,
      child,
      exited: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      startedAt: new Date().toISOString(),
      sandboxMode: SandboxMode.LOCAL_DEVELOPMENT_UNSAFE,
      sandboxBackend: SandboxBackend.LOCAL_UNSAFE,
      isolationCapabilities: this.capabilities(),
      unsafe: true,
      hardened: false
    };
    this.active.add(child);
    const stdoutChunks = [];
    const stderrChunks = [];
    const logFd = request.logPath ? fs.openSync(request.logPath, 'w') : null;
    const append = (stream, chunk) => {
      const text = redactSecrets(String(chunk));
      stream.push(text);
      if (logFd) fs.writeSync(logFd, text);
      handle.stdout = stdoutChunks.join('');
      handle.stderr = stderrChunks.join('');
    };
    child.stdout?.on('data', chunk => append(stdoutChunks, chunk));
    child.stderr?.on('data', chunk => append(stderrChunks, chunk));
    child.on('exit', (code) => {
      handle.exited = true;
      handle.exitCode = code;
      handle.completedAt = new Date().toISOString();
      this.active.delete(child);
      if (logFd) try { fs.closeSync(logFd); } catch {}
    });
    child.on('error', error => {
      handle.exited = true;
      handle.error = error.message;
      this.active.delete(child);
    });
    return handle;
  }

  async cancel(reason = 'cancelled') {
    for (const child of this.active) killTree(child);
    return { attempted: this.active.size > 0, reason };
  }

  async copyIn() {
    return { copied: 0, note: 'Local unsafe mode uses the managed workspace directly.' };
  }

  async collectArtifacts() {
    return [];
  }

  async destroy() {
    await this.cancel('destroy');
    return { destroyed: true };
  }
}
