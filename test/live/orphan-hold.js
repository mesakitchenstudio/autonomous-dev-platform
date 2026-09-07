import { makeSandbox, prepareSandbox } from './helpers.js';
import { NetworkMode } from '../../src/sandbox/kinds.js';

const workspace = process.argv[2];
if (!workspace) {
  console.error('workspace required');
  process.exit(2);
}

const projectId = '00000000-0000-4000-8000-00000000orph';
const sandbox = makeSandbox({ projectId });
await prepareSandbox(sandbox, { workspace, projectId, networkMode: NetworkMode.NONE });
await sandbox.launch({
  argv: ['node', '-e', 'setTimeout(() => {}, 120000)'],
  cwd: workspace,
  workspaceRoot: workspace,
  env: { PATH: '/usr/bin:/bin' },
  networkMode: NetworkMode.NONE
});
process.stdout.write(`CONTAINER:${sandbox.containerName}\n`);
await new Promise(() => {});
