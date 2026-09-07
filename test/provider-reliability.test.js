import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, classifyProviderError, throwHttpError, ProviderStatus, createRetryPolicy } from '../src/providers/resilience.js';
import { PlatformError, ErrorCode } from '../src/orchestrator/errors.js';
import { normalizeUsage } from '../src/providers/usage.js';
import { resolveModelName, resolveChairProvider } from '../src/providers/config.js';
import { MockProvider } from '../src/providers/mock.js';

test('429 and 500 are retryable, auth is not', () => {
  assert.equal(classifyProviderError({ details: { httpStatus: 429 } }).status, ProviderStatus.RATE_LIMITED);
  assert.equal(classifyProviderError({ details: { httpStatus: 500 } }).retryable, true);
  assert.equal(classifyProviderError({ details: { httpStatus: 401 } }).retryable, false);
  assert.equal(classifyProviderError({ details: { httpStatus: 403 } }).status, ProviderStatus.AUTH_FAILURE);
});

test('withRetry retries rate limits with backoff and then succeeds', async () => {
  const delays = [];
  let calls = 0;
  const { result, attempts } = await withRetry(async () => {
    calls += 1;
    if (calls < 3) {
      throw new PlatformError({ code: ErrorCode.RATE_LIMITED, message: 'slow down', retryable: true, details: { httpStatus: 429 } });
    }
    return 'ok';
  }, { maxRetries: 3, baseMs: 10, maxMs: 40, sleep: async ms => { delays.push(ms); }, random: () => 0 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.ok(delays[1] >= delays[0]);
});

test('permanent auth errors are not repeatedly retried', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throwHttpError('OpenAI', 401, 'invalid api key');
  }, { maxRetries: 4, sleep: async () => {}, random: () => 0 }), err => err.code === ErrorCode.AUTH_FAILURE);
  assert.equal(calls, 1);
});

test('retry exhaustion preserves the last error', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throwHttpError('OpenAI', 500, 'nope');
  }, { maxRetries: 2, sleep: async () => {}, random: () => 0 }), err => err.code === ErrorCode.PROVIDER_FAILURE);
  assert.equal(calls, 3);
});

test('timeout classification is retryable', () => {
  const classified = classifyProviderError(new PlatformError({ code: ErrorCode.PROVIDER_TIMEOUT, message: 't' }));
  assert.equal(classified.status, ProviderStatus.TIMEOUT);
  assert.equal(classified.retryable, true);
});

test('usage metadata is normalized and missing usage stays null', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 3, output_tokens: 5 }), { inputTokens: 3, outputTokens: 5, totalTokens: 8 });
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
});

test('empty or invalid model configuration is rejected without inventing a model', () => {
  const previous = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = ' ';
  assert.throws(() => resolveModelName('OPENAI_MODEL', 'gpt-5'));
  process.env.OPENAI_MODEL = 'undefined';
  assert.throws(() => resolveModelName('OPENAI_MODEL', 'gpt-5'));
  if (previous == null) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = previous;
});

test('chair provider must be a configured council member', () => {
  const providers = [new MockProvider('openai')];
  assert.throws(() => resolveChairProvider(providers, 'anthropic'));
  const chair = resolveChairProvider(providers, 'openai');
  assert.equal(chair.name, 'openai');
});

test('createRetryPolicy reads defaults', () => {
  const policy = createRetryPolicy({ maxRetries: 1, baseMs: 5, maxMs: 9, random: () => 0, sleep: async () => {} });
  assert.equal(policy.maxRetries, 1);
  assert.equal(policy.maxMs, 9);
});
