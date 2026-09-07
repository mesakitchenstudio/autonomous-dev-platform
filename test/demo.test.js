import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('demo launch mechanism does not depend on POSIX env assignment syntax', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.demo, 'node scripts/demo.js');
  assert.doesNotMatch(pkg.scripts.demo, /DEMO_MODE=true node/);
  const launcher = fs.readFileSync(path.join(root, 'scripts/demo.js'), 'utf8');
  assert.match(launcher, /DEMO_MODE/);
  assert.match(launcher, /server\.js/);
  assert.doesNotMatch(launcher, /DEMO_MODE=true node/);
});

test('gitignore keeps runtime data and secrets out of version control', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const line of ['.env', 'data/', 'workspaces/', 'node_modules/', '.pglite/', '.adp-secrets/']) {
    assert.ok(ignore.includes(line), `missing ${line}`);
  }
  assert.ok(ignore.includes('!.env.example'));
});
