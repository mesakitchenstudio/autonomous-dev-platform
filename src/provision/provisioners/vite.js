import fs from 'node:fs/promises';
import path from 'node:path';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandHelp, commandVersion } from '../versions.js';
import { baseProvisioner, runGenerator } from './base.js';

async function resolvedPackageVersion(workspacePath, names) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspacePath, 'package.json'), 'utf8'));
    for (const name of names) {
      const version = pkg.devDependencies?.[name] || pkg.dependencies?.[name];
      if (version) return String(version).replace(/^[^\d]*/, '') || version;
    }
  } catch {}
  return null;
}

const ALLOWED_TEMPLATES = new Set(['react-ts', 'vue-ts', 'react', 'vanilla-ts']);

export const ViteProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.VITE,
    supportStatus: () => commandVersion('npm').available ? SupportStatus.LIVE_SUPPORTED : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.NODE],
    templateFor: (profile) => /vue/i.test(profile?.language || profile?.framework || '')
      ? templateById('web.vue.vite.typescript')
      : templateById('web.react.vite.typescript')
  }),
  async provision({ workspacePath, plan, logPath }) {
    const template = plan.generator?.options?.template || plan.generator?.template || 'react-ts';
    if (!ALLOWED_TEMPLATES.has(template)) {
      const error = new Error(`Unapproved Vite template: ${template}`);
      error.code = 'PROVISIONING_TEMPLATE_INVALID';
      throw error;
    }
    const help = commandHelp('npm', ['create', 'vite@latest', '--', '--help']);
    const argv = ['npm', 'create', 'vite@latest', '.', '--', '--template', template];
    if (/--yes|non-interactive/i.test(help.text || '')) argv.splice(2, 0, '--yes');
    const result = await runGenerator({
      argv,
      cwd: workspacePath,
      workspaceRoot: path.dirname(workspacePath),
      logPath
    });
    return {
      generator: {
        name: 'create-vite',
        version: await resolvedPackageVersion(workspacePath, ['vite', 'create-vite'])
          || result.stdoutPreview?.match(/vite@(\d+\.\d+\.\d+)/)?.[1]
          || commandVersion('npm', ['--version']).version
          || 'latest-resolved',
        template
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
