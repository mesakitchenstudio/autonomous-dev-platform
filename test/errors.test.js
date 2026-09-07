import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PlatformError, toErrorRecord, ErrorCode, redactSecrets } from '../src/orchestrator/errors.js';
import { JsonStore } from '../src/storage/json-store.js';

test('structured error records include code phase retryable and timestamp', () => {
  const error = new PlatformError({
    code: ErrorCode.CURSOR_TIMEOUT,
    message: 'Cursor timed out',
    phase: 'CURSOR_EXECUTING',
    retryable: true,
    details: { timeoutMs: 10 }
  });
  const record = error.toRecord();
  assert.equal(record.code, ErrorCode.CURSOR_TIMEOUT);
  assert.equal(record.phase, 'CURSOR_EXECUTING');
  assert.equal(record.retryable, true);
  assert.ok(record.at);
  assert.equal(record.details.timeoutMs, 10);
});

test('error records redact secrets', () => {
  const error = new PlatformError({
    code: ErrorCode.PROVIDER_FAILURE,
    message: 'failed with sk-abcdefghijklmnopqrstuvwxyz',
    details: { apiKey: 'should-not-persist', note: 'ok' }
  });
  assert.match(error.message, /\[redacted\]/);
  assert.equal(error.details.apiKey, '[redacted]');
  assert.equal(error.details.note, 'ok');
  assert.equal(redactSecrets('gsk_abcdefghijklmnop'), '[redacted]');
});

test('toErrorRecord normalizes unknown errors', () => {
  const record = toErrorRecord(new Error('boom'), 'COUNCIL_DISCOVERY');
  assert.equal(record.code, ErrorCode.UNEXPECTED_ERROR);
  assert.equal(record.phase, 'COUNCIL_DISCOVERY');
});

test('json store can read BOM-prefixed project files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-bom-'));
  const store = new JsonStore(dir);
  await store.init();
  const id = '22222222-2222-4222-8222-222222222222';
  await fs.writeFile(path.join(dir, `${id}.json`), `\uFEFF${JSON.stringify({ id, idea: 'bom', state: 'FAILED', createdAt: '2026-01-01T00:00:00.000Z' })}`);
  const project = await store.get(id);
  assert.equal(project.idea, 'bom');
  const listed = await store.list();
  assert.equal(listed[0].id, id);
});
