import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { buildVerificationEnv } from '../../verify/env.js';
import { ApplicationKind, RuntimeAdapterName, RuntimeFindingCode, RuntimeStatus } from '../kinds.js';
import { allocatePort, launchManagedProcess, shutdownManagedProcess, waitUntilReady } from '../process.js';
import { resolveTestContext } from '../context.js';
import { PlaywrightHarness } from '../web/harness.js';
import { RuntimeAdapter } from './base.js';
import { runtimeArtifactDir } from '../artifacts.js';
import fs from 'node:fs/promises';

const STATIC_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static-server.js');

export class WebRuntimeAdapter extends RuntimeAdapter {
  constructor() {
    super(RuntimeAdapterName.PLAYWRIGHT_WEB);
    this.handle = null;
    this.server = null;
    this.harness = null;
  }

  canHandle(plan) {
    return plan?.applicationKind === ApplicationKind.WEB_UI && plan?.runtimeAdapter === RuntimeAdapterName.PLAYWRIGHT_WEB;
  }

  async prepare({ workspacePath, plan }) {
    if (!plan.launch?.command?.length) {
      return { ok: false, code: RuntimeFindingCode.RUNTIME_START_FAILED, message: 'No deterministic web launch command was detected.' };
    }
    return { ok: true };
  }

  async launch({ workspacePath, project, plan }) {
    const port = await allocatePort();
    const extraEnv = { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' };
    let argv = plan.launch.command;
    if (argv[0] === '__PLATFORM_STATIC_SERVER__') {
      const root = await staticRoot(workspacePath);
      argv = [process.execPath, STATIC_SERVER, '--root', root, '--port', String(port)];
    }
    const logDir = runtimeArtifactDir(project.id, project.iteration || 1);
    await fs.mkdir(logDir, { recursive: true });
    this.handle = await launchManagedProcess({
      argv,
      cwd: workspacePath,
      workspaceRoot: workspacePath,
      env: buildVerificationEnv(),
      extraEnv,
      timeoutMs: plan.launch.timeoutMs || 30000,
      logPath: path.join(logDir, 'startup.log')
    });
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.port = port;
    return {
      command: argv,
      pid: this.handle.pid,
      port,
      url: this.baseUrl
    };
  }

  async waitUntilReady({ plan }) {
    const health = plan.launch?.healthCheck?.path || '/';
    const ready = await waitUntilReady({
      url: new URL(health, this.baseUrl).toString(),
      timeoutMs: plan.launch?.timeoutMs || 30000,
      processRef: this.handle
    });
    return { ...ready, stdout: this.handle?.stdout || '', stderr: this.handle?.stderr || '' };
  }

  async executeScenario({ project, plan, scenario, viewport, recordTrace }) {
    const context = resolveTestContext(project, scenario);
    if (!context.ok) {
      return {
        status: RuntimeStatus.FAIL,
        failures: [{ code: context.code, message: context.message }],
        steps: [],
        screenshots: [],
        accessibility: [],
        layoutFindings: []
      };
    }
    this.harness = new PlaywrightHarness({
      projectId: project.id,
      iteration: project.iteration || 1,
      checkpointSha: plan.checkpointSha,
      artifactHash: plan.artifactHash
    });
    await this.harness.open({ baseUrl: this.baseUrl, viewport, recordTrace });
    const steps = [];
    const screenshots = [];
    let failed = false;
    for (const [index, action] of (scenario.steps || []).entries()) {
      const result = await this.harness.runAction(action);
      steps.push({ index, action: action.action, ...result });
      if (result.screenshot) screenshots.push(result.screenshot);
      if (result.status === 'FAIL') {
        failed = true;
        break;
      }
    }
    if (!screenshots.length) {
      screenshots.push(await this.harness.captureScreenshot({
        name: `${scenario.id}-${viewport?.name || 'desktop'}`,
        viewport,
        scenarioId: scenario.id,
        step: 'end'
      }));
    }
    const diagnostics = await this.harness.collectDiagnostics();
    const accessibility = await this.harness.accessibility();
    const layoutFindings = await this.harness.layoutFindings(viewport);
    const blockingNetwork = diagnostics.pageErrors.length > 0
      || diagnostics.networkFailures.some(item => item.severity === 'CRITICAL');
    if (blockingNetwork) failed = true;
    const trace = await this.harness.stopTrace(failed || scenario.priority === 'CRITICAL');
    await this.harness.close();
    this.harness = null;
    return {
      status: failed ? RuntimeStatus.FAIL : RuntimeStatus.PASS,
      steps,
      screenshots,
      diagnostics,
      accessibility,
      layoutFindings,
      artifacts: trace ? [trace] : [],
      failures: failed ? [{ code: RuntimeFindingCode.SCENARIO_FAILED, message: `Scenario ${scenario.id} failed` }] : []
    };
  }

  async collectDiagnostics() {
    return this.harness ? this.harness.collectDiagnostics() : { consoleErrors: [], pageErrors: [], networkFailures: [] };
  }

  async shutdown() {
    if (this.harness) await this.harness.close().catch(() => {});
    if (this.handle) shutdownManagedProcess(this.handle, 'qa_complete');
    this.handle = null;
    return { ok: true };
  }
}

async function staticRoot(workspacePath) {
  const fsPromises = await import('node:fs/promises');
  const dist = path.join(workspacePath, 'dist', 'index.html');
  if (await fsPromises.stat(dist).catch(() => null)) return path.join(workspacePath, 'dist');
  return workspacePath;
}

export { PlatformError };
