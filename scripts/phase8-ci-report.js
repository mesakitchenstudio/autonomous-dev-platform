import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.PHASE8_REPORT_DIR || path.join('artifacts', 'phase8-ci');
fs.mkdirSync(dir, { recursive: true });

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const steps = readJson(path.join(dir, 'steps.json'), {});
const engine = readJson(path.join(dir, 'engine.json'), {});
const failed = Object.entries(steps).filter(([, status]) => status !== 'PASS');
const decision = failed.length
  ? 'PHASE 8 VERIFICATION INCOMPLETE'
  : 'PHASE 8 VERIFIED — COMPLETE';

const live = steps.sandbox === 'PASS' ? 'PASS' : 'FAIL';
const json = {
  environment: {
    os: engine.os,
    uname: engine.uname,
    runner: engine.runner,
    githubActions: engine.githubActions
  },
  docker: {
    client: engine.dockerClient,
    server: engine.dockerServer,
    daemonRootless: engine.rootless ? 'YES' : 'NO',
    daemonIdentity: engine.rootless ? 'ROOTLESS' : 'ROOTFUL',
    seccomp: engine.seccomp ? 'YES' : 'NO',
    seccompProfile: engine.seccompProfile,
    cgroupVersion: engine.cgroupVersion,
    hostnameAllowlistEnforced: false
  },
  projectContainer: {
    nonRoot: live,
    privilegedFalse: live
  },
  steps,
  controls: {
    regression: steps.unit === 'PASS' && steps.check === 'PASS' ? 'PASS' : 'FAIL',
    postgres: steps.postgres || 'FAIL',
    liveHardenedSandbox: live,
    hostnameAllowlistEnforced: 'false'
  },
  decision,
  generatedAt: new Date().toISOString()
};

const md = [
  '# Phase 8 hardened verification',
  '',
  `Decision: **${decision}**`,
  '',
  `Docker client/server: ${engine.dockerClient || 'unknown'} / ${engine.dockerServer || 'unknown'}`,
  `Daemon rootless: ${engine.rootless ? 'YES' : 'NO'}`,
  `Seccomp: ${engine.seccomp ? 'YES' : 'NO'} (${engine.seccompProfile || 'n/a'})`,
  `hostnameAllowlistEnforced: false`,
  '',
  '| Step | Result |',
  '|---|---|',
  ...Object.entries(steps).map(([name, status]) => `| ${name} | ${status} |`),
  '',
  'No secret values, tokens, or environment dumps are included.'
].join('\n');

fs.writeFileSync(path.join(dir, 'phase8-hardened-verification.json'), JSON.stringify(json, null, 2));
fs.writeFileSync(path.join(dir, 'phase8-hardened-verification.md'), md);
if (failed.length) process.exit(1);
