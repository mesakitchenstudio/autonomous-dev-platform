import path from 'node:path';
import fs from 'node:fs/promises';
import { ApplicationKind, RuntimeAdapterName, RuntimeFindingCode, RuntimeStatus } from '../kinds.js';
import { launchManagedProcess, shutdownManagedProcess } from '../process.js';
import { buildVerificationEnv } from '../../verify/env.js';
import { runtimeArtifactDir } from '../artifacts.js';
import { RuntimeAdapter } from './base.js';

export class CliRuntimeAdapter extends RuntimeAdapter {
  constructor() {
    super(RuntimeAdapterName.CLI);
  }

  canHandle(plan) {
    return plan?.applicationKind === ApplicationKind.CLI;
  }

  async launch() {
    return { command: [], pid: null, note: 'CLI adapter executes bounded commands per scenario' };
  }

  async waitUntilReady() {
    return { status: 0, durationMs: 0 };
  }

  async executeScenario({ workspacePath, project, scenario }) {
    const pkg = JSON.parse(await fs.readFile(path.join(workspacePath, 'package.json'), 'utf8').catch(() => '{}'));
    const bin = resolveBin(pkg, workspacePath);
    if (!bin) {
      return {
        status: RuntimeStatus.FAIL,
        steps: [],
        screenshots: [],
        failures: [{ code: RuntimeFindingCode.RUNTIME_START_FAILED, message: 'No safe CLI entry was detected.' }]
      };
    }
    const logDir = runtimeArtifactDir(project.id, project.iteration || 1);
    await fs.mkdir(logDir, { recursive: true });
    const handle = await launchManagedProcess({
      argv: [process.execPath, bin, '--help'],
      cwd: workspacePath,
      workspaceRoot: workspacePath,
      env: buildVerificationEnv(),
      timeoutMs: 15000,
      logPath: path.join(logDir, `${scenario.id}.log`)
    });
    const deadline = Date.now() + 15000;
    while (!handle.exited && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    shutdownManagedProcess(handle, 'cli_complete');
    const ok = handle.exitCode === 0 || handle.exitCode === null;
    return {
      status: ok ? RuntimeStatus.PASS : RuntimeStatus.FAIL,
      steps: [{ index: 0, action: 'CLI', status: ok ? 'PASS' : 'FAIL', detail: { exitCode: handle.exitCode } }],
      screenshots: [],
      failures: ok ? [] : [{ code: RuntimeFindingCode.SCENARIO_FAILED, message: `CLI exited ${handle.exitCode}` }]
    };
  }
}

function resolveBin(pkg, workspacePath) {
  const bin = pkg.bin;
  if (typeof bin === 'string') return path.join(workspacePath, bin);
  if (bin && typeof bin === 'object') return path.join(workspacePath, Object.values(bin)[0]);
  if (pkg.main) return path.join(workspacePath, pkg.main);
  return null;
}
