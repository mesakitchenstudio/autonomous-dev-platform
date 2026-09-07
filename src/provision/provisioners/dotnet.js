import path from 'node:path';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandHelp, commandVersion } from '../versions.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { baseProvisioner, runGenerator } from './base.js';

export const DotnetProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.DOTNET,
    supportStatus: () => commandVersion('dotnet').available
      ? SupportStatus.LIVE_SUPPORTED
      : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.DOTNET_SDK],
    templateFor: () => templateById('lang.dotnet')
  }),
  async provision({ workspacePath, plan, logPath }) {
    if (!commandVersion('dotnet').available) {
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_INFRASTRUCTURE_UNAVAILABLE,
        message: '.NET SDK is not available.',
        phase: 'PROJECT_PROVISIONING',
        retryable: true
      });
    }
    const help = commandHelp('dotnet', ['new', 'webapi', '-h']);
    const template = /webapi/i.test(help.text || '') ? 'webapi' : 'console';
    const argv = ['dotnet', 'new', template, '--name', plan.identity.dotnetNamespace, '--output', '.'];
    const result = await runGenerator({
      argv,
      cwd: workspacePath,
      workspaceRoot: path.dirname(workspacePath),
      logPath
    });
    return {
      generator: { name: 'dotnet', version: commandVersion('dotnet').version, template },
      command: argv,
      exitCode: result.exitCode,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      logPath
    };
  }
};
