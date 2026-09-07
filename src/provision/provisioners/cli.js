import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { baseProvisioner, writeFiles } from './base.js';

export const CLI_TEMPLATE_VERSION = '1.0.0';

export function cliFiles(identity) {
  const name = identity.npmName || identity.projectName;
  return {
    'package.json': `${JSON.stringify({
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      bin: { [name]: 'src/cli.js' },
      scripts: {
        start: 'node src/cli.js',
        test: 'node --test',
        build: 'node -e "console.log(\'build ok\')"'
      }
    }, null, 2)}\n`,
    'src/cli.js': `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log(${JSON.stringify(identity.productName)} + ' — usage: ' + ${JSON.stringify(name)} + ' [--help]');
  process.exit(0);
}
console.log(args.join(' '));
`,
    'test/cli.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('cli prints help', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
});
`
  };
}

export const CliProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.CLI,
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [WorkerCapability.NODE],
    templateFor: () => templateById('cli.node')
  }),
  async provision({ workspacePath, plan }) {
    const files = cliFiles(plan.identity);
    await writeFiles(workspacePath, files);
    return {
      generator: { name: 'adp-cli', version: CLI_TEMPLATE_VERSION, template: '1.0.0' },
      createdFiles: Object.keys(files),
      command: ['platform-template', 'adp-cli', CLI_TEMPLATE_VERSION],
      exitCode: 0
    };
  }
};
