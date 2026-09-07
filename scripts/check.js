import { spawnSync } from 'node:child_process';

const files = [
  'src/server.js',
  'src/orchestrator/orchestrator.js',
  'src/orchestrator/states.js',
  'src/council/council.js',
  'src/cursor/acp-client.js',
  'src/cursor/cloud-client.js'
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tests = spawnSync(process.execPath, ['--test'], { stdio: 'inherit' });
process.exit(tests.status ?? 1);
