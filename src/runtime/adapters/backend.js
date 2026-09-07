import path from 'node:path';
import fs from 'node:fs/promises';
import { buildVerificationEnv } from '../../verify/env.js';
import { ApplicationKind, RuntimeAdapterName, RuntimeFindingCode, RuntimeStatus } from '../kinds.js';
import { allocatePort, launchManagedProcess, shutdownManagedProcess, waitUntilReady } from '../process.js';
import { runtimeArtifactDir } from '../artifacts.js';
import { RuntimeAdapter } from './base.js';

export class BackendRuntimeAdapter extends RuntimeAdapter {
  constructor() {
    super(RuntimeAdapterName.BACKEND);
    this.handle = null;
  }

  canHandle(plan) {
    return plan?.applicationKind === ApplicationKind.BACKEND;
  }

  async launch({ workspacePath, project, plan }) {
    if (!plan.launch?.command?.length) {
      return { skipped: true, code: RuntimeFindingCode.RUNTIME_START_FAILED, message: 'No backend launch command detected.' };
    }
    const port = await allocatePort();
    const logDir = runtimeArtifactDir(project.id, project.iteration || 1);
    await fs.mkdir(logDir, { recursive: true });
    this.handle = await launchManagedProcess({
      argv: plan.launch.command,
      cwd: workspacePath,
      workspaceRoot: workspacePath,
      env: buildVerificationEnv(),
      extraEnv: { PORT: String(port), HOST: '127.0.0.1' },
      timeoutMs: plan.launch.timeoutMs || 30000,
      logPath: path.join(logDir, 'startup.log')
    });
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.port = port;
    return { command: plan.launch.command, pid: this.handle.pid, port, url: this.baseUrl };
  }

  async waitUntilReady({ plan }) {
    const health = plan.launch?.healthCheck?.path || '/health';
    return waitUntilReady({
      url: new URL(health, this.baseUrl).toString(),
      timeoutMs: plan.launch?.timeoutMs || 30000,
      processRef: this.handle,
      accept: status => status > 0 && status < 500
    });
  }

  async executeScenario({ scenario }) {
    const steps = [];
    for (const [index, action] of (scenario.steps || []).entries()) {
      if (action.action !== 'HTTP') {
        steps.push({ index, action: action.action, status: 'FAIL', error: 'Backend adapter only executes HTTP actions' });
        return { status: RuntimeStatus.FAIL, steps, screenshots: [], failures: [{ code: RuntimeFindingCode.SCENARIO_FAILED, message: 'Unsupported backend action' }] };
      }
      const url = new URL(action.url, this.baseUrl).toString();
      const response = await fetch(url, { method: action.method || 'GET', signal: AbortSignal.timeout(8000) }).catch(error => ({ ok: false, status: 0, error }));
      const accepted = action.acceptStatus || [200, 204];
      const status = accepted.includes(response.status) ? RuntimeStatus.PASS : RuntimeStatus.FAIL;
      steps.push({ index, action: 'HTTP', status, detail: { url, httpStatus: response.status } });
      if (status === RuntimeStatus.FAIL) {
        return { status: RuntimeStatus.FAIL, steps, screenshots: [], failures: [{ code: RuntimeFindingCode.NETWORK_FAILURE, message: `HTTP ${response.status} for ${url}` }] };
      }
    }
    return { status: RuntimeStatus.PASS, steps, screenshots: [], failures: [] };
  }

  async shutdown() {
    if (this.handle) shutdownManagedProcess(this.handle, 'qa_complete');
    this.handle = null;
    return { ok: true };
  }
}
