import test from 'node:test';
import assert from 'node:assert/strict';
import { Council } from '../src/council/council.js';
import { MockProvider } from '../src/providers/mock.js';
import { ErrorCode } from '../src/orchestrator/errors.js';

const noRetry = { maxRetries: 0, sleep: async () => {}, random: () => 0 };

test('four-model mock council produces a Cursor specification', async () => {
  const c = new Council(['openai', 'anthropic', 'gemini', 'xai'].map(x => new MockProvider(x)), 'openai', { retryPolicy: noRetry });
  const out = await c.discover('Build a cooking Android application');
  assert.equal(out.analyses.length, 4);
  assert.ok(out.spec.cursorPrompt);
  assert.ok(Array.isArray(out.failures));
  assert.ok(out.history.some(round => round.purpose === 'independent_analysis'));
  assert.ok(out.history.some(round => round.purpose === 'critique'));
  assert.ok(out.history.some(round => round.purpose === 'chair_synthesis'));
});

test('partial member failure is acceptable when minimum participation remains', async () => {
  const council = new Council([
    new MockProvider('openai'),
    new MockProvider('gemini'),
    { name: 'anthropic', model: 'm', async complete() { throw new Error('down'); } }
  ], 'openai', { retryPolicy: noRetry, minResponses: 2 });
  const out = await council.discover('idea');
  assert.equal(out.analyses.length, 2);
  assert.ok(out.failures.some(item => item.provider === 'anthropic'));
  assert.ok(out.spec.cursorPrompt);
});

test('one surviving opinion is insufficient for a multi-model council', async () => {
  const ok = new MockProvider('openai');
  const bad = { name: 'anthropic', model: 'm', async complete() { throw new Error('down'); } };
  const council = new Council([ok, bad], 'openai', { retryPolicy: noRetry });
  await assert.rejects(() => council.discover('idea'), err => err.code === ErrorCode.INSUFFICIENT_COUNCIL);
});

test('all-member failure cannot continue', async () => {
  const bad = { name: 'openai', model: 'm', async complete() { throw new Error('down'); } };
  const council = new Council([bad], 'openai', { minResponses: 1, retryPolicy: noRetry });
  await assert.rejects(() => council.discover('idea'), err => err.code === ErrorCode.ALL_PROVIDERS_FAILED);
});
