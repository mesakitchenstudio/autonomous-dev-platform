import { spawnSync } from 'node:child_process';
import path from 'node:path';

function spawnTool(bin, args) {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    shell: process.platform === 'win32' && !path.extname(bin) && !path.isAbsolute(bin)
  });
}

export function commandVersion(bin, args = ['--version']) {
  const result = spawnTool(bin, args);
  if (result.error || result.status !== 0) {
    return { available: false, bin, version: null, help: null, error: result.error?.message || result.stderr?.trim() || null };
  }
  return {
    available: true,
    bin,
    version: String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null,
    raw: String(result.stdout || '').trim()
  };
}

export function commandHelp(bin, args = ['--help']) {
  const result = spawnTool(bin, args);
  const text = String(result.stdout || result.stderr || '');
  const missing = Boolean(result.error) || /not recognized|not found|no such file|command not found/i.test(text);
  return {
    available: !missing && (result.status === 0 || text.length > 0),
    text
  };
}

export function discoverToolchainVersions(required = []) {
  const probes = {
    NODE: () => ({ node: commandVersion('node'), npm: commandVersion('npm') }),
    JAVA: () => ({ java: commandVersion('java') }),
    ANDROID_SDK: () => ({ android: commandVersion('android', ['--help']) }),
    ANDROID_PROJECT_CREATOR: () => ({ android: commandHelp('android', ['create', '--help']) }),
    FLUTTER_SDK: () => ({ flutter: commandVersion('flutter') }),
    PYTHON: () => ({ python: commandVersion('python', ['--version']) }),
    RUST_TOOLCHAIN: () => ({ cargo: commandVersion('cargo') }),
    GO_TOOLCHAIN: () => ({ go: commandVersion('go', ['version']) }),
    DOTNET_SDK: () => ({ dotnet: commandVersion('dotnet') }),
    XCODE: () => ({ xcodebuild: commandVersion('xcodebuild', ['-version']) })
  };
  const versions = {};
  for (const cap of required) {
    const probe = probes[cap];
    if (probe) Object.assign(versions, probe());
  }
  if (!required.length) {
    Object.assign(versions, probes.NODE());
  }
  return versions;
}

export function firstAvailableBin(candidates) {
  for (const bin of candidates) {
    const probed = commandVersion(bin);
    if (probed.available) return { bin, ...probed };
  }
  return null;
}
