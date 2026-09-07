import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ContainerSandbox } from '../../src/sandbox/container.js';
import { discoverContainerCapabilities } from '../../src/sandbox/discover.js';
import { SecurityProfile, SandboxMode } from '../../src/security/kinds.js';
import { NetworkMode } from '../../src/sandbox/kinds.js';

export const discovery = discoverContainerCapabilities();

export function docker(args, timeoutMs = 20000) {
  const result = spawnSync(discovery.bin || 'docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

export function tempWorkspace(prefix = 'adp-live-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeSandbox({ projectId, limits = {}, networkMode = NetworkMode.NONE } = {}) {
  return new ContainerSandbox({
    profile: SecurityProfile.HARDENED,
    mode: SandboxMode.CONTAINER_HARDENED,
    limits: {
      cpu: '0.5',
      memory: '128m',
      pids: 64,
      timeoutMs: 60000,
      logBytes: 64_000,
      ...limits
    },
    networkMode,
    projectId
  }, discovery);
}

export async function prepareSandbox(sandbox, { workspace, projectId, networkMode = NetworkMode.NONE } = {}) {
  return sandbox.prepare({
    project: {
      id: projectId,
      repository: { workspacePath: workspace }
    },
    workspaceRoot: workspace,
    imageId: 'node',
    networkMode
  });
}

export async function waitForInspect(sandbox, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inspect = await sandbox.inspect();
    if (inspect?.State) return inspect;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

export function hostConfig(inspect) {
  return inspect?.HostConfig || {};
}

export function dockerExecJs(containerName, source, timeoutMs = 15000) {
  return docker(['exec', containerName, 'node', '-e', source], timeoutMs);
}

export function sanitizedEngineInfo() {
  const info = docker(['info', '--format', '{{json .}}']);
  let parsed = {};
  try { parsed = JSON.parse(info.stdout || '{}'); } catch { parsed = {}; }
  return {
    os: parsed.OperatingSystem || os.type(),
    osType: parsed.OSType || process.platform,
    architecture: parsed.Architecture || os.arch(),
    serverVersion: parsed.ServerVersion || discovery.capabilities.engineVersion,
    ncpu: parsed.NCPU || null,
    cgroupDriver: parsed.CgroupDriver || null,
    cgroupVersion: parsed.CgroupVersion || null,
    securityOptions: parsed.SecurityOptions || parsed.securityOptions || [],
    rootless: discovery.capabilities.rootless,
    seccompDetected: Array.isArray(parsed.SecurityOptions)
      ? parsed.SecurityOptions.some(item => /seccomp/i.test(String(item)))
      : false
  };
}
