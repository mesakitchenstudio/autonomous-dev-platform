import path from 'node:path';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandHelp, commandVersion } from '../versions.js';
import { baseProvisioner, runGenerator } from './base.js';

export const NextJsProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.NEXTJS,
    supportStatus: () => commandVersion('npx').available ? SupportStatus.LIVE_SUPPORTED : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.NODE],
    templateFor: () => templateById('web.next.typescript')
  }),
  async provision({ workspacePath, plan, logPath }) {
    const help = commandHelp('npx', ['--yes', 'create-next-app@latest', '--help']);
    const argv = [
      'npx', '--yes', 'create-next-app@latest', '.',
      '--ts',
      '--eslint',
      '--app',
      '--src-dir',
      '--use-npm',
      '--import-alias', '@/*'
    ];
    if (/--yes\b/.test(help.text || '')) argv.push('--yes');
    if (/--turbopack/.test(help.text || '')) argv.push('--turbopack');
    if (!/--no-tailwind|--tailwind/.test(help.text || '')) {
      // keep generator default when flags are unknown
    } else if (/--no-tailwind/.test(help.text || '')) {
      argv.push('--no-tailwind');
    }
    const result = await runGenerator({
      argv,
      cwd: workspacePath,
      workspaceRoot: path.dirname(workspacePath),
      logPath
    });
    return {
      generator: {
        name: 'create-next-app',
        version: commandVersion('npx', ['--yes', 'create-next-app@latest', '--version']).version || 'latest-resolved',
        template: 'app-router'
      },
      command: argv,
      exitCode: result.exitCode,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      durationMs: result.durationMs,
      truncated: result.truncated,
      logPath
    };
  }
};
