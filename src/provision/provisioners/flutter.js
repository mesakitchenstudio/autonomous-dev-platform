import path from 'node:path';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandHelp, commandVersion } from '../versions.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { baseProvisioner, runGenerator } from './base.js';

export const FlutterProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.FLUTTER,
    supportStatus: () => commandVersion('flutter').available
      ? SupportStatus.LIVE_SUPPORTED
      : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.FLUTTER_SDK],
    templateFor: () => templateById('mobile.flutter')
  }),
  async provision({ workspacePath, plan, logPath }) {
    if (!commandVersion('flutter').available) {
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_INFRASTRUCTURE_UNAVAILABLE,
        message: 'Flutter SDK is not available on this worker.',
        phase: 'PROJECT_PROVISIONING',
        retryable: true
      });
    }
    const help = commandHelp('flutter', ['create', '--help']);
    const platforms = plan.profile?.platform === 'CROSS_PLATFORM' ? ['android', 'ios'] : ['android'];
    const argv = ['flutter', 'create', '.', '--project-name', plan.identity.dartName, '--org', plan.identity.packageId.split('.').slice(0, -1).join('.')];
    if (/--platforms/.test(help.text || '')) argv.push('--platforms', platforms.join(','));
    const result = await runGenerator({
      argv,
      cwd: workspacePath,
      workspaceRoot: path.dirname(workspacePath),
      logPath
    });
    return {
      generator: {
        name: 'flutter',
        version: commandVersion('flutter').version,
        template: 'app'
      },
      command: argv,
      exitCode: result.exitCode,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      durationMs: result.durationMs,
      logPath
    };
  }
};
