import { spawnSync } from 'node:child_process';

const files = [
  'src/server.js',
  'src/worker/main.js',
  'src/worker/worker.js',
  'src/app/runtime.js',
  'src/orchestrator/orchestrator.js',
  'src/orchestrator/states.js',
  'src/council/council.js',
  'src/cursor/acp-client.js',
  'src/cursor/cloud-client.js',
  'src/cursor/contract.js',
  'src/git/worktree.js',
  'src/git/policy.js',
  'src/storage/workspace.js',
  'src/jobs/queue.js',
  'src/storage/durable-store.js',
  'src/verify/pipeline.js',
  'src/verify/runner.js',
  'src/runtime/pipeline.js',
  'src/visual/pipeline.js',
  'src/jobs/queue.js',
  'src/provision/pipeline.js',
  'src/provision/registry.js',
  'src/provision/plan.js',
  'src/provision/git.js',
  'src/provision/architecture.js',
  'src/db/schema-phase7.js',
  'src/db/schema-phase8.js',
  'src/sandbox/index.js',
  'src/secrets/broker.js',
  'src/auth/http.js',
  'src/security/policy.js',
  'src/server.js'
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tests = spawnSync(process.execPath, ['--import', './test/security-env.js', '--test', '--test-concurrency=1', 'test/*.test.js'], { stdio: 'inherit' });
process.exit(tests.status ?? 1);
