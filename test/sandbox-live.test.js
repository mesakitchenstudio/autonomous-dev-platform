import './security-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverContainerCapabilities } from '../src/sandbox/discover.js';
import { ContainerSandbox, containerHardeningFlags } from '../src/sandbox/container.js';
import { SecurityProfile, SandboxMode } from '../src/security/kinds.js';
import { NetworkMode } from '../src/sandbox/kinds.js';
import { resourceLimitsFromEnv } from '../src/sandbox/policy.js';

const discovery = discoverContainerCapabilities();

test('hardened sandbox live verification', { skip: !discovery.available }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-live-sbx-'));
  fs.writeFileSync(path.join(workspace, 'probe.js'), `
    const fs = require('fs');
    const out = {
      uid: process.getuid ? process.getuid() : 'win',
      dockerSock: fs.existsSync('/var/run/docker.sock'),
      hostPasswd: false,
      sibling: false,
      envKeys: Object.keys(process.env).sort()
    };
    try { fs.readFileSync('/etc/shadow', 'utf8'); out.hostPasswd = true; } catch {}
    try { fs.readdirSync('/host'); out.sibling = true; } catch {}
    console.log(JSON.stringify(out));
  `);
  const sandbox = new ContainerSandbox({
    profile: SecurityProfile.HARDENED,
    mode: SandboxMode.CONTAINER_HARDENED,
    limits: resourceLimitsFromEnv(),
    projectId: 'live-fixture'
  }, discovery);
  await sandbox.prepare({
    project: { id: '00000000-0000-4000-8000-000000000001', repository: { workspacePath: workspace } },
    workspaceRoot: workspace,
    imageId: 'node',
    networkMode: NetworkMode.NONE
  });
  const result = await sandbox.execute({
    argv: ['node', '/workspace/probe.js'],
    cwd: workspace,
    timeoutMs: 60000,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    networkMode: NetworkMode.NONE
  });
  await sandbox.destroy();
  assert.equal(result.sandboxMode, SandboxMode.CONTAINER_HARDENED);
  assert.equal(result.hardened, true);
  assert.equal(containerHardeningFlags().privileged, false);
  if (result.exitCode === 0) {
    const probe = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(probe.dockerSock, false);
    assert.equal(probe.hostPasswd, false);
    assert.ok(!probe.envKeys.includes('OPENAI_API_KEY'));
    assert.ok(!probe.envKeys.includes('DATABASE_URL'));
  }
  assert.ok(result.isolationCapabilities.privilegedProhibited);
  assert.equal(result.isolationCapabilities.dockerSocketMounted, false);
});

test('resource limit fixture is contained when the engine can enforce pids', { skip: !discovery.available || !discovery.capabilities.pidsLimit }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-live-res-'));
  fs.writeFileSync(path.join(workspace, 'fork.js'), 'try { for (;;) require("child_process").spawn(process.argv[0], ["-e", "while(1){}"], { detached: true, stdio: "ignore" }); } catch (e) { console.error("limited"); process.exit(2); }');
  const sandbox = new ContainerSandbox({
    profile: SecurityProfile.HARDENED,
    mode: SandboxMode.CONTAINER_HARDENED,
    limits: { ...resourceLimitsFromEnv(), pids: 16, timeoutMs: 15000, memory: '128m' },
    projectId: 'live-resource'
  }, discovery);
  await sandbox.prepare({
    project: { id: '00000000-0000-4000-8000-000000000002', repository: { workspacePath: workspace } },
    workspaceRoot: workspace,
    imageId: 'node',
    networkMode: NetworkMode.NONE
  });
  const result = await sandbox.execute({
    argv: ['node', '/workspace/fork.js'],
    cwd: workspace,
    timeoutMs: 15000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' }
  });
  await sandbox.destroy();
  assert.ok(result.timedOut || result.exitCode !== 0 || result.resourceLimitHit);
});
