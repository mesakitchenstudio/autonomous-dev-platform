import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { emptyIsolationCapabilities } from './kinds.js';

function run(bin, args) {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (result.error?.code === 'ENOENT') {
      return { ok: false, stdout: '', stderr: 'ENOENT', status: null, missing: true };
    }
    return {
      ok: result.status === 0,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      status: result.status,
      missing: false
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error?.message || '', status: null, missing: error?.code === 'ENOENT' };
  }
}

export function discoverContainerCapabilities({ env = process.env } = {}) {
  const capabilities = emptyIsolationCapabilities();
  capabilities.os = os.platform();
  const bin = env.SANDBOX_DOCKER_BIN || 'docker';
  const version = run(bin, ['version', '--format', '{{.Server.Version}}']);
  if (version.missing) return { available: false, bin, capabilities };
  if (!version.ok) {
    const fallback = run(bin, ['version']);
    if (fallback.missing || !fallback.ok) return { available: false, bin, capabilities };
    capabilities.engineAvailable = true;
    capabilities.engine = 'docker';
    capabilities.engineVersion = fallback.stdout.split(/\r?\n/).find(line => /Version/i.test(line)) || 'unknown';
  } else {
    capabilities.engineAvailable = true;
    capabilities.engine = 'docker';
    capabilities.engineVersion = version.stdout.trim() || 'unknown';
  }

  const info = run(bin, ['info', '--format', '{{json .}}']);
  let parsed = {};
  if (info.ok) {
    try { parsed = JSON.parse(info.stdout); } catch { parsed = {}; }
  }
  const security = parsed.SecurityOptions || parsed.securityOptions || [];
  const rootless = Array.isArray(security)
    ? security.some(item => /rootless/i.test(String(item)))
    : /rootless/i.test(String(parsed.Name || ''));
  capabilities.rootless = Boolean(rootless);
  capabilities.seccomp = os.platform() === 'linux';
  capabilities.noNewPrivileges = os.platform() !== 'win32';
  capabilities.capDrop = os.platform() !== 'win32';
  capabilities.readOnlyRoot = true;
  capabilities.resourceLimits = true;
  capabilities.pidsLimit = os.platform() !== 'win32';
  capabilities.networkPolicy = true;
  capabilities.hostnameAllowlistEnforced = false;
  capabilities.privilegedProhibited = true;
  capabilities.dockerSocketMounted = false;
  capabilities.hostNamespaces = false;
  capabilities.nonRootUser = true;

  return {
    available: capabilities.engineAvailable,
    bin,
    capabilities,
    details: {
      operatingSystem: parsed.OperatingSystem || os.type(),
      osType: parsed.OSType || os.platform(),
      rootlessDetected: capabilities.rootless,
      securityOptions: security
    }
  };
}

let cached = null;
export function cachedContainerCapabilities(force = false) {
  if (!cached || force) cached = discoverContainerCapabilities();
  return cached;
}
