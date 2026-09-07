import path from 'node:path';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandVersion } from '../versions.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { baseProvisioner, runGenerator } from './base.js';

export const RustProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.RUST,
    supportStatus: () => commandVersion('cargo').available
      ? SupportStatus.LIVE_SUPPORTED
      : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.RUST_TOOLCHAIN],
    templateFor: () => templateById('lang.rust')
  }),
  async provision({ workspacePath, plan, logPath }) {
    if (!commandVersion('cargo').available) {
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_INFRASTRUCTURE_UNAVAILABLE,
        message: 'Rust toolchain (cargo) is not available.',
        phase: 'PROJECT_PROVISIONING',
        retryable: true
      });
    }
    const result = await runGenerator({
      argv: ['cargo', 'init', '--name', plan.identity.rustName, '--bin'],
      cwd: workspacePath,
      workspaceRoot: path.dirname(workspacePath),
      logPath
    });
    return {
      generator: { name: 'cargo', version: commandVersion('cargo').version, template: 'bin' },
      command: ['cargo', 'init', '--name', plan.identity.rustName, '--bin'],
      exitCode: result.exitCode,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      logPath
    };
  }
};
