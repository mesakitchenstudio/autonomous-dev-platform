import path from 'node:path';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandVersion } from '../versions.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { baseProvisioner, runGenerator, writeFiles } from './base.js';

export const GoProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.GO,
    supportStatus: () => commandVersion('go', ['version']).available
      ? SupportStatus.LIVE_SUPPORTED
      : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.GO_TOOLCHAIN],
    templateFor: () => templateById('lang.go')
  }),
  async provision({ workspacePath, plan, logPath }) {
    if (!commandVersion('go', ['version']).available) {
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_INFRASTRUCTURE_UNAVAILABLE,
        message: 'Go toolchain is not available.',
        phase: 'PROJECT_PROVISIONING',
        retryable: true
      });
    }
    const module = `example.com/${plan.identity.projectName}`;
    const result = await runGenerator({
      argv: ['go', 'mod', 'init', module],
      cwd: workspacePath,
      workspaceRoot: path.dirname(workspacePath),
      logPath
    });
    await writeFiles(workspacePath, {
      'main.go': `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("ok")\n}\n`
    });
    return {
      generator: { name: 'go', version: commandVersion('go', ['version']).version, template: 'mod' },
      command: ['go', 'mod', 'init', module],
      exitCode: result.exitCode,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      logPath
    };
  }
};
