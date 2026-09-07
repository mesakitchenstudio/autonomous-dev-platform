import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  './node_modules/playwright/cli.js',
  'install',
  'chromium'
], { stdio: 'inherit' });

process.exit(result.status ?? 1);
