import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { baseProvisioner, writeFiles } from './base.js';

export const BrokenTestProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.BROKEN_TEST,
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [],
    templateFor: () => templateById('test.broken.starter')
  }),
  async provision({ workspacePath, plan }) {
    const files = {
      'package.json': `${JSON.stringify({
        name: plan.identity.npmName,
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: {
          build: 'node -e "process.exit(1)"',
          test: 'node -e "process.exit(1)"'
        }
      }, null, 2)}\n`,
      'src/index.js': 'export const broken = true;\n'
    };
    await writeFiles(workspacePath, files);
    return {
      generator: { name: 'adp-broken-starter', version: '1.0.0', template: '1.0.0' },
      createdFiles: Object.keys(files),
      command: ['platform-template', 'adp-broken-starter'],
      exitCode: 0
    };
  }
};
