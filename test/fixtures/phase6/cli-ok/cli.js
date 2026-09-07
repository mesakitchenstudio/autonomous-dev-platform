#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.stdout.write('phase6-cli — disposable fixture\n');
  process.exit(0);
}
process.stdout.write('ok\n');
