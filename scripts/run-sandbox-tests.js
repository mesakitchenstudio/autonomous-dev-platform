import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { discoverContainerCapabilities } from '../src/sandbox/discover.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.ADP_LIVE_SANDBOX_TEST !== '1') {
  console.error('HARDENED SANDBOX LIVE VERIFICATION BLOCKED');
  console.error('ADP_LIVE_SANDBOX_TEST=1 is required. Refusing to start live containers.');
  console.error('Run this only on an isolated non-production Linux container host.');
  process.exit(2);
}

const discovery = discoverContainerCapabilities();
if (!discovery.available) {
  console.error('HARDENED SANDBOX LIVE VERIFICATION BLOCKED — INFRASTRUCTURE UNAVAILABLE');
  console.error('No container engine was detected. MockSandbox and LOCAL_DEVELOPMENT_UNSAFE are not substitutes.');
  process.exit(2);
}
if (process.env.GITHUB_ACTIONS === 'true' && process.platform !== 'linux') {
  console.error('GitHub hardened verification must run on Linux.');
  process.exit(2);
}

console.log(JSON.stringify({
  backend: discovery.capabilities.engine,
  engineVersion: discovery.capabilities.engineVersion,
  os: discovery.capabilities.os,
  rootless: discovery.capabilities.rootless,
  seccomp: discovery.capabilities.seccomp,
  mock: false
}, null, 2));

const result = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  'test/live/sandbox-hardened.test.js',
  'test/live/control-plane-http.test.js'
], {
  cwd: root,
  env: {
    ...process.env,
    ADP_LIVE_SANDBOX_TEST: '1',
    SECURITY_PROFILE: 'HARDENED',
    DEMO_MODE: 'false',
    SANDBOX_BACKEND: 'container'
  },
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
