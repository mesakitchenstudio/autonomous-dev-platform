import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverContainerCapabilities } from '../src/sandbox/discover.js';

if (process.env.ADP_LIVE_SANDBOX_TEST !== '1') {
  console.error('ADP_LIVE_SANDBOX_TEST=1 is required.');
  process.exit(2);
}
if (process.platform !== 'linux') {
  console.error('Phase 8 hardened CI preflight requires Linux.');
  process.exit(2);
}
if (!process.env.GITHUB_ACTIONS && process.env.ADP_LIVE_SANDBOX_ALLOW_LOCAL !== '1') {
  console.error('Refusing to run outside GitHub Actions without ADP_LIVE_SANDBOX_ALLOW_LOCAL=1.');
  process.exit(2);
}
if (process.env.ADP_PRODUCTION === '1' || process.env.ADP_ENVIRONMENT === 'production') {
  console.error('Refusing to run live sandbox verification in a production environment.');
  process.exit(2);
}

const discovery = discoverContainerCapabilities();
if (!discovery.available) {
  console.error('HARDENED SANDBOX LIVE VERIFICATION BLOCKED — INFRASTRUCTURE UNAVAILABLE');
  process.exit(2);
}

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000 });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

const info = run('docker', ['info', '--format', '{{json .}}']);
let parsed = {};
try { parsed = JSON.parse(info.stdout || '{}'); } catch { parsed = {}; }
const security = parsed.SecurityOptions || [];
const report = {
  os: os.type(),
  platform: process.platform,
  arch: os.arch(),
  uname: run('uname', ['-a']).stdout.trim(),
  dockerClient: run('docker', ['version', '--format', '{{.Client.Version}}']).stdout.trim(),
  dockerServer: run('docker', ['version', '--format', '{{.Server.Version}}']).stdout.trim(),
  cgroupDriver: parsed.CgroupDriver || null,
  cgroupVersion: parsed.CgroupVersion || null,
  securityOptions: security,
  rootless: security.some(item => /rootless/i.test(String(item))),
  seccomp: security.some(item => /seccomp/i.test(String(item))),
  seccompProfile: String(security.find(item => /seccomp/i.test(String(item))) || 'builtin/default-if-unspecified'),
  hostnameAllowlistEnforced: false,
  githubActions: Boolean(process.env.GITHUB_ACTIONS),
  runner: process.env.RUNNER_OS || null,
  mock: false
};

const dest = process.env.PHASE8_ENGINE_REPORT || path.join('artifacts', 'phase8-ci', 'engine.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  dockerClient: report.dockerClient,
  dockerServer: report.dockerServer,
  rootless: report.rootless,
  seccomp: report.seccomp,
  cgroupVersion: report.cgroupVersion
}, null, 2));

if (!report.seccomp) {
  console.error('Seccomp is not reported by docker info. Phase 8 cannot close.');
  process.exit(1);
}
