import { ProvisionerId, SupportStatus } from '../kinds.js';
import { baseProvisioner, writeFiles } from './base.js';

export const MockProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.MOCK,
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [],
    templateFor: () => ({ id: 'demo.mock', validation: { files: ['package.json'] } })
  }),
  async provision({ workspacePath, plan, project }) {
    const files = {
      'package.json': `${JSON.stringify({
        name: plan.identity.npmName,
        version: '0.0.0',
        private: true,
        description: 'Demo mock foundation — not a live generator scaffold'
      }, null, 2)}\n`,
      'PROJECT_IDEA.md': `# ${plan.identity.productName}\n\n${project?.idea || ''}\n`,
      'README.md': `# ${plan.identity.productName}\n\nMock provisioned workspace for demo mode.\n`
    };
    await writeFiles(workspacePath, files);
    return {
      generator: { name: 'adp-mock', version: '1.0.0', template: 'demo' },
      createdFiles: Object.keys(files),
      command: ['platform-template', 'adp-mock'],
      exitCode: 0,
      mock: true
    };
  }
};
