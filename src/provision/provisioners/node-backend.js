import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { baseProvisioner, writeFiles } from './base.js';

export const NODE_BACKEND_TEMPLATE_VERSION = '1.0.0';

export function nodeBackendFiles(identity) {
  const name = identity.npmName || identity.projectName;
  return {
    'package.json': `${JSON.stringify({
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        start: 'node src/server.js',
        build: 'node -e "console.log(\'build ok\')"',
        test: 'node --test',
        lint: 'node -e "console.log(\'lint ok\')"'
      }
    }, null, 2)}\n`,
    '.env.example': 'PORT=3000\n',
    'src/server.js': `import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: ${JSON.stringify(identity.productName)} }));
    return;
  }
  res.writeHead(404);
  res.end();
});

if (process.argv[1] && process.argv[1].includes('server.js')) {
  server.listen(port);
}

export { server };
`,
    'test/server.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../src/server.js';

test('health responder is defined', () => {
  assert.ok(server);
});
`
  };
}

export const NodeBackendProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.NODE_BACKEND,
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [WorkerCapability.NODE],
    templateFor: () => templateById('backend.node.typescript'),
    verificationHints: () => ['Node test/build scripts are defined by the versioned platform template.']
  }),
  async provision({ workspacePath, plan }) {
    await writeFiles(workspacePath, nodeBackendFiles(plan.identity));
    return {
      generator: { name: 'adp-node-backend', version: NODE_BACKEND_TEMPLATE_VERSION, template: '1.0.0' },
      createdFiles: Object.keys(nodeBackendFiles(plan.identity)),
      command: ['platform-template', 'adp-node-backend', NODE_BACKEND_TEMPLATE_VERSION],
      exitCode: 0
    };
  }
};
