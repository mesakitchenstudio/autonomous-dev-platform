import { SandboxBackend, emptyIsolationCapabilities } from './kinds.js';
import { SandboxMode } from '../security/kinds.js';

export class MockSandbox {
  constructor(policy) {
    this.policy = policy;
    this.prepared = false;
    this.destroyed = false;
    this.lastCommand = null;
  }

  async prepare() {
    this.prepared = true;
    return { sandboxRunId: 'mock', mode: SandboxMode.MOCK };
  }

  async execute(request = {}) {
    this.lastCommand = request.argv || [];
    return {
      argv: request.argv || [],
      cwd: request.cwd || '/workspace',
      exitCode: 0,
      signal: null,
      timedOut: false,
      missingExecutable: false,
      stdout: '',
      stderr: '',
      stdoutPreview: '',
      stderrPreview: '',
      truncated: false,
      durationMs: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      sandboxMode: SandboxMode.MOCK,
      sandboxBackend: SandboxBackend.MOCK,
      isolationCapabilities: { ...emptyIsolationCapabilities(), engine: 'mock' },
      mock: true
    };
  }

  async launch(request = {}) {
    const executed = await this.execute(request);
    return {
      ...executed,
      pid: 0,
      exited: false,
      child: null,
      mock: true,
      shutdown() {
        return { attempted: true, reason: 'mock' };
      }
    };
  }

  async cancel() {
    return { attempted: false, reason: 'mock' };
  }

  async copyIn() {
    return { copied: 0 };
  }

  async collectArtifacts() {
    return [];
  }

  async destroy() {
    this.destroyed = true;
    return { destroyed: true };
  }

  capabilities() {
    return { ...emptyIsolationCapabilities(), engine: 'mock' };
  }
}
