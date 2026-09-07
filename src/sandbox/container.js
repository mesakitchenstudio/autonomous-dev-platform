import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { SandboxBackend, emptyIsolationCapabilities } from './kinds.js';
import { SandboxMode } from '../security/kinds.js';
import { SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';
import { dockerNetworkFlag } from './network.js';
import { imageProfileFor, assertApprovedImage, recordImageDigest } from './images.js';
import { approvedRootsFor, defaultMounts, validateMounts } from './mounts.js';
import { ErrorCode, PlatformError, redactSecrets } from '../orchestrator/errors.js';

const CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function containerProcessEnv(env = {}) {
  const out = { ...env };
  out.PATH = CONTAINER_PATH;
  out.HOME = '/tmp';
  out.TMPDIR = '/tmp';
  out.TMP = '/tmp';
  out.TEMP = '/tmp';
  out.NPM_CONFIG_CACHE = '/cache/npm';
  out.npm_config_cache = '/cache/npm';
  out.NPM_CONFIG_TMP = '/cache';
  out.npm_config_tmp = '/cache';
  out.NPM_CONFIG_USERCONFIG = '/cache/npmrc';
  out.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  delete out.USERPROFILE;
  delete out.HOMEDRIVE;
  delete out.HOMEPATH;
  delete out.SYSTEMROOT;
  delete out.WINDIR;
  delete out.COMSPEC;
  return out;
}

function ensureHostMountWritable(dir) {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try { fs.chmodSync(dir, 0o777); } catch {}
}

function runDocker(bin, args, { timeoutMs = 30000 } = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

export class ContainerSandbox {
  constructor(policy, discovery) {
    this.policy = policy;
    this.discovery = discovery;
    this.bin = discovery?.bin || 'docker';
    this.containerName = null;
    this.imageDigest = null;
    this.prepared = false;
  }

  capabilities() {
    return {
      ...emptyIsolationCapabilities(),
      ...(this.discovery?.capabilities || {}),
      engine: 'docker',
      engineAvailable: true,
      privilegedProhibited: true,
      dockerSocketMounted: false,
      hostNamespaces: false
    };
  }

  hardenedArgs({ mounts, networkMode, name, image }) {
    const limits = this.policy.limits || {};
    const args = [
      '--name', name,
      '--user', '1000:1000',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
      '--tmpfs', '/cache:rw,nosuid,size=256m,mode=1777',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--memory', limits.memory || '1g',
      '--memory-swap', limits.memory || '1g',
      '--cpus', String(limits.cpu || '1'),
      '--pids-limit', String(limits.pids || 256),
      '--label', `adp.sandbox=1`,
      '--label', `adp.project=${this.policy.projectId || 'unknown'}`,
      '--label', process.env.ADP_LIVE_SANDBOX_TEST === '1' ? 'adp.test=1' : 'adp.test=0',
      '--workdir', '/workspace'
    ];
    args.push(...dockerNetworkFlag(networkMode));
    for (const mount of mounts) {
      const flag = `${mount.source}:${mount.target}:${mount.readOnly ? 'ro' : 'rw'}`;
      args.push('-v', flag);
    }
    args.push(image);
    return args;
  }

  async prepare({ project, workspaceRoot, artifactDir, cacheDir, imageId = 'node', networkMode } = {}) {
    const image = imageProfileFor(imageId);
    assertApprovedImage(image.image, { profile: this.policy.profile });
    const roots = approvedRootsFor(project, { workspaceRoot, artifactDir, cacheDir });
    const mounts = validateMounts(defaultMounts({
      workspaceRoot: workspaceRoot || project?.repository?.workspacePath,
      artifactDir,
      cacheDir,
      writableWorkspace: true
    }), roots, { projectId: project?.id });
    const name = `adp-sbx-${String(project?.id || 'x').slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const inspect = runDocker(this.bin, ['image', 'inspect', '--format', '{{.Id}}', image.image]);
    this.imageDigest = inspect.ok ? inspect.stdout.trim() : null;
    this.containerName = name;
    this.mounts = mounts;
    for (const mount of mounts) {
      if (!mount.readOnly) ensureHostMountWritable(mount.source);
    }
    this.image = image.image;
    this.networkMode = networkMode || this.policy.networkMode;
    this.prepared = true;
    this.projectId = project?.id || null;
    recordSecurityEvent(SecurityEventType.SANDBOX_STARTED, {
      projectId: this.projectId,
      backend: SandboxBackend.CONTAINER,
      mode: SandboxMode.CONTAINER_HARDENED,
      image: image.image,
      digest: this.imageDigest
    }, { projectId: this.projectId });
    return {
      sandboxRunId: name,
      mode: SandboxMode.CONTAINER_HARDENED,
      backend: SandboxBackend.CONTAINER,
      imageDigest: this.imageDigest,
      isolationCapabilities: this.capabilities(),
      image: recordImageDigest(image.image, this.imageDigest)
    };
  }

  dockerRunArgs(commandArgv, { networkMode } = {}) {
    const name = this.containerName || `adp-sbx-${crypto.randomUUID().slice(0, 8)}`;
    return [
      'run', '--rm',
      ...this.hardenedArgs({
        mounts: this.mounts || [],
        networkMode: networkMode || this.networkMode,
        name,
        image: this.image || imageProfileFor('node').image
      }),
      ...(commandArgv || ['true'])
    ];
  }

  async execute({
    argv,
    cwd,
    timeoutMs,
    env = {},
    logPath,
    networkMode,
    projectId,
    store
  } = {}) {
    if (!this.prepared) await this.prepare({ project: { id: projectId }, workspaceRoot: cwd });
    const envArgs = [];
    for (const [key, value] of Object.entries(containerProcessEnv(env))) {
      if (value == null) continue;
      envArgs.push('-e', `${key}=${value}`);
    }
    const args = this.dockerRunArgs(argv, { networkMode });
    const insertAt = args.indexOf('--name');
    args.splice(insertAt, 0, ...envArgs);
    const startedAt = Date.now();
    const child = spawn(this.bin, args, { windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];
    const maxLog = this.policy.limits?.logBytes || 1_000_000;
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
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        child.killedByTimeout = true;
        recordSecurityEvent(SecurityEventType.SANDBOX_RESOURCE_LIMIT, {
          projectId: projectId || this.projectId,
          limit: 'timeout'
        }, { store, projectId: projectId || this.projectId });
      }, timeoutMs || this.policy.limits?.timeoutMs || 300000);
      child.stdout?.on('data', chunk => append(stdoutChunks, chunk));
      child.stderr?.on('data', chunk => append(stderrChunks, chunk));
      child.on('error', error => {
        clearTimeout(timer);
        if (logFd) try { fs.closeSync(logFd); } catch {}
        resolve({
          argv,
          cwd: '/workspace',
          exitCode: null,
          missingExecutable: /not found|ENOENT/i.test(error.message),
          stdout: redactSecrets(error.message),
          stderr: '',
          stdoutPreview: redactSecrets(error.message).slice(0, 8000),
          stderrPreview: '',
          truncated: false,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          sandboxMode: SandboxMode.CONTAINER_HARDENED,
          sandboxBackend: SandboxBackend.CONTAINER,
          isolationCapabilities: this.capabilities(),
          imageDigest: this.imageDigest,
          hardened: true,
          unsafe: false
        });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (logFd) try { fs.closeSync(logFd); } catch {}
        const stdout = redactSecrets(stdoutChunks.join(''));
        const stderr = redactSecrets(stderrChunks.join(''));
        const resource = /memory|oom|pids|too many processes/i.test(stderr);
        if (resource) {
          recordSecurityEvent(SecurityEventType.SANDBOX_RESOURCE_LIMIT, {
            projectId: projectId || this.projectId,
            limit: 'cgroup'
          }, { store, projectId: projectId || this.projectId });
        }
        resolve({
          argv,
          cwd: '/workspace',
          exitCode: code,
          signal,
          timedOut: Boolean(child.killedByTimeout),
          missingExecutable: false,
          stdout,
          stderr,
          stdoutPreview: stdout.slice(0, 8000),
          stderrPreview: stderr.slice(0, 8000),
          truncated,
          durationMs: Date.now() - startedAt,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          sandboxMode: SandboxMode.CONTAINER_HARDENED,
          sandboxBackend: SandboxBackend.CONTAINER,
          isolationCapabilities: this.capabilities(),
          imageDigest: this.imageDigest,
          hardened: true,
          unsafe: false,
          resourceLimitHit: resource
        });
      });
    });
  }

  async launch(request = {}) {
    if (!this.prepared) {
      await this.prepare({
        project: request.project || { id: request.projectId, repository: { workspacePath: request.workspaceRoot || request.cwd } },
        workspaceRoot: request.workspaceRoot || request.cwd,
        artifactDir: request.artifactDir,
        cacheDir: request.cacheDir,
        imageId: request.imageId || 'node',
        networkMode: request.networkMode || request.networkPolicy
      });
    }
    const env = containerProcessEnv(request.env || {});
    const hostPort = env.PORT != null ? Number(env.PORT) : null;
    if (Number.isFinite(hostPort) && hostPort > 0) {
      env.HOST = '0.0.0.0';
    }
    const envArgs = [];
    for (const [key, value] of Object.entries(env)) {
      if (value == null) continue;
      envArgs.push('-e', `${key}=${value}`);
    }
    const name = this.containerName;
    const args = ['run', '-d', ...envArgs];
    if (Number.isFinite(hostPort) && hostPort > 0) {
      args.push('-p', `127.0.0.1:${hostPort}:${hostPort}`);
    }
    args.push(...this.hardenedArgs({
      mounts: this.mounts || [],
      networkMode: request.networkMode || request.networkPolicy || this.networkMode,
      name,
      image: this.image || imageProfileFor('node').image
    }));
    args.push(...(request.argv || ['sleep', 'infinity']));
    const started = runDocker(this.bin, args, { timeoutMs: 60000 });
    if (!started.ok) {
      throw new PlatformError({
        code: ErrorCode.SANDBOX_INFRASTRUCTURE_UNAVAILABLE,
        message: 'Hardened runtime sandbox failed to start.',
        phase: 'SANDBOX',
        retryable: true,
        details: { stderr: redactSecrets(started.stderr || '').slice(0, 800) }
      });
    }
    const handle = {
      pid: null,
      containerName: name,
      argv: request.argv,
      cwd: '/workspace',
      child: null,
      exited: false,
      exitCode: null,
      stdout: '',
      stderr: redactSecrets(started.stderr || ''),
      startedAt: new Date().toISOString(),
      sandboxMode: SandboxMode.CONTAINER_HARDENED,
      sandboxBackend: SandboxBackend.CONTAINER,
      isolationCapabilities: this.capabilities(),
      hardened: true,
      unsafe: false,
      publishedPort: Number.isFinite(hostPort) ? hostPort : null
    };
    this.runtimeHandle = handle;
    this.runtimePoll = setInterval(() => {
      const state = runDocker(this.bin, ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name]);
      const [running, code] = String(state.stdout || '').trim().split(/\s+/);
      if (!state.ok || running === 'false') {
        handle.exited = true;
        handle.exitCode = Number(code || 0);
        if (this.runtimePoll) clearInterval(this.runtimePoll);
      }
    }, 400);
    if (this.runtimePoll.unref) this.runtimePoll.unref();
    return handle;
  }

  async inspect() {
    if (!this.containerName) return null;
    const result = runDocker(this.bin, ['inspect', this.containerName]);
    if (!result.ok) return null;
    try {
      return JSON.parse(result.stdout)[0];
    } catch {
      return null;
    }
  }

  async cancel() {
    if (this.runtimePoll) clearInterval(this.runtimePoll);
    if (!this.containerName) return { attempted: false };
    runDocker(this.bin, ['kill', this.containerName]);
    return { attempted: true, reason: 'cancel' };
  }

  async copyIn() {
    return { copied: 0 };
  }

  async collectArtifacts() {
    return [];
  }

  async destroy() {
    if (this.runtimePoll) clearInterval(this.runtimePoll);
    if (this.containerName) {
      runDocker(this.bin, ['rm', '-f', this.containerName]);
    }
    this.prepared = false;
    return { destroyed: true, name: this.containerName };
  }
}

export function containerHardeningFlags() {
  return {
    user: '1000:1000',
    privileged: false,
    dockerSocket: false,
    hostRoot: false,
    hostPid: false,
    hostNetwork: false,
    hostIpc: false,
    capDrop: 'ALL',
    noNewPrivileges: true,
    seccomp: 'default',
    readOnlyRoot: true
  };
}
