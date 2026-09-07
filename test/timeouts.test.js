import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../src/orchestrator/timeout.js';
import { ErrorCode } from '../src/orchestrator/errors.js';
import { Council } from '../src/council/council.js';
import { MockProvider } from '../src/providers/mock.js';
import { CursorCloudClient } from '../src/cursor/cloud-client.js';
import { tempStore, orchestratorFor, FakeCursor, FakeCouncil } from './helpers.js';
import { ProjectState } from '../src/orchestrator/states.js';

const noRetry = { maxRetries: 0, sleep: async () => {}, random: () => 0 };

test('provider timeout rejects hanging council members', async () => {
  const hanging = { name: 'openai', model: 'm', async complete() { await new Promise(() => {}); } };
  const council = new Council([hanging], 'openai', { timeoutMs: 40, minResponses: 1, retryPolicy: noRetry });
  await assert.rejects(() => council.discover('idea'), err => err.code === ErrorCode.ALL_PROVIDERS_FAILED || err.code === ErrorCode.CHAIR_FAILURE || err.code === ErrorCode.PROVIDER_TIMEOUT);
});

test('chair timeout cannot silently continue', async () => {
  const openai = new MockProvider('openai');
  const anthropic = new MockProvider('anthropic');
  const original = anthropic.complete.bind(anthropic);
  anthropic.complete = async request => {
    if (request.prompt.includes('CHAIR_SYNTHESIS')) await new Promise(() => {});
    return original(request);
  };
  const council = new Council([openai, anthropic], 'anthropic', { timeoutMs: 40, minResponses: 2, retryPolicy: noRetry });
  await assert.rejects(() => council.discover('idea'), err => err.code === ErrorCode.CHAIR_FAILURE);
});

test('Cursor timeout fails the project instead of leaving it executing', async () => {
  const { store } = await tempStore();
  const orch = orchestratorFor(store, { cursor: new FakeCursor({ hang: true }), cursorTimeoutMs: 40, council: new FakeCouncil() });
  const created = await store.create({ idea: 'idea' });
  await orch.run(created.id);
  const project = await store.get(created.id);
  assert.equal(project.state, ProjectState.FAILED);
  assert.equal(project.error.code, ErrorCode.CURSOR_TIMEOUT);
  assert.notEqual(project.state, ProjectState.CURSOR_EXECUTING);
});

test('Cloud polling cannot continue forever', async () => {
  const client = new CursorCloudClient({ apiKey: 'test', repoUrl: 'https://example.com/repo', timeoutMs: 60, pollMs: 15, requestTimeoutMs: 50 });
  client.request = async () => ({ status: 'RUNNING' });
  await assert.rejects(() => client.wait('agent', 'run'), err => err.code === ErrorCode.CURSOR_TIMEOUT);
});

test('withTimeout wraps generic operations', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, { code: ErrorCode.PROVIDER_TIMEOUT, message: 'timed out' }),
    err => err.code === ErrorCode.PROVIDER_TIMEOUT
  );
});
