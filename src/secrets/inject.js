import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSecretValue } from './redact.js';

export function injectEphemeralEnv(baseEnv, issued = []) {
  const env = { ...baseEnv };
  const injected = [];
  for (const item of issued) {
    if (!item?.name || item.value == null) continue;
    env[item.name] = item.value;
    registerSecretValue(item.value);
    injected.push(item.name);
  }
  return { env, injected, files: [] };
}

export function injectEphemeralFiles(issued = [], { dir } = {}) {
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'adp-sec-'));
  const files = [];
  for (const item of issued) {
    if (!item?.fileName || item.value == null) continue;
    const dest = path.join(root, item.fileName);
    fs.writeFileSync(dest, item.value, { mode: 0o600 });
    registerSecretValue(item.value);
    files.push(dest);
  }
  return {
    files,
    cleanup() {
      for (const file of files) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  };
}

export function assertNoSecretDotEnv(workspacePath) {
  const dest = path.join(workspacePath, '.env');
  return { exists: fs.existsSync(dest), path: dest, checkpointForbidden: true };
}
