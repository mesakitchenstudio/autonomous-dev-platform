import path from 'node:path';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandHelp, commandVersion, firstAvailableBin } from '../versions.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { baseProvisioner, runGenerator } from './base.js';

function androidCreator() {
  return firstAvailableBin(['android']) || commandHelp('android', ['create', '--help']);
}

export const AndroidNativeProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.ANDROID_NATIVE,
    supportStatus: () => {
      const creator = commandHelp('android', ['create', '--help']);
      return creator.available && /empty-activity|create/i.test(creator.text || '')
        ? SupportStatus.LIVE_SUPPORTED
        : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE;
    },
    requiredCapabilities: [WorkerCapability.ANDROID_SDK, WorkerCapability.ANDROID_PROJECT_CREATOR, WorkerCapability.JAVA],
    templateFor: () => templateById('mobile.android.compose')
  }),
  async provision({ workspacePath, plan, logPath }) {
    const help = commandHelp('android', ['create', '--help']);
    if (!help.available || !/empty-activity|activity/i.test(help.text || '')) {
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_INFRASTRUCTURE_UNAVAILABLE,
        message: 'Installed Android CLI cannot create the required empty-activity template.',
        phase: 'PROJECT_PROVISIONING',
        retryable: true,
        details: { helpPreview: String(help.text || '').slice(0, 400) }
      });
    }
    const argv = ['android', 'create', 'empty-activity'];
    if (/--name/.test(help.text)) argv.push('--name', plan.identity.productName.replace(/[^A-Za-z0-9 ]/g, ''));
    if (/--package/.test(help.text)) argv.push('--package', plan.identity.packageId);
    if (/--path/.test(help.text)) argv.push('--path', workspacePath);
    const result = await runGenerator({
      argv,
      cwd: workspacePath,
      workspaceRoot: path.dirname(workspacePath),
      logPath
    });
    return {
      generator: {
        name: 'android',
        version: commandVersion('android', ['--version']).version || 'detected',
        template: 'empty-activity'
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
