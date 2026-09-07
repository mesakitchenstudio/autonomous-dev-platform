import test from 'node:test';
import assert from 'node:assert/strict';
import { Council } from '../src/council/council.js';
import { MockProvider } from '../src/providers/mock.js';
import { ErrorCode } from '../src/orchestrator/errors.js';

test('four-model mock council produces a Cursor specification', async () => {
  const c = new Council(['openai', 'anthropic', 'gemini', 'xai'].map(x => new MockProvider(x)), 'openai');
  const out = await c.discover('Build a cooking Android application');
  assert.equal(out.analyses.length, 4);
  assert.ok(out.spec.cursorPrompt);
  assert.ok(Array.isArray(out.failures));
});

test('partial member failure is acceptable', async () => {
  const ok = new MockProvider('openai');
  const bad = { name: 'anthropic', async complete() { throw new Error('down'); } };
  const council = new Council([ok, bad], 'openai');
  const out = await council.discover('idea');
  assert.equal(out.analyses.length, 1);
  assert.equal(out.failures.length, 1);
  assert.ok(out.spec.cursorPrompt);
});

test('all-member failure cannot continue', async () => {
  const bad = { name: 'openai', async complete() { throw new Error('down'); } };
  const council = new Council([bad], 'openai');
  await assert.rejects(() => council.discover('idea'), err => err.code === ErrorCode.ALL_PROVIDERS_FAILED);
});
