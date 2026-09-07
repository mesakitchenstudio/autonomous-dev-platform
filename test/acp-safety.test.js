import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePermission, resolvePermissionPolicy, PermissionPolicy } from '../src/cursor/permission-policy.js';
import { buildCursorChildEnv, assertNoCouncilSecrets, BLOCKED_CURSOR_ENV } from '../src/cursor/child-env.js';

test('default ACP permission policy is not allow-all', () => {
  assert.equal(resolvePermissionPolicy(undefined), PermissionPolicy.SAFE_DEVELOPMENT);
  assert.notEqual(resolvePermissionPolicy(process.env.ACP_PERMISSION_POLICY), PermissionPolicy.ALLOW_ALL);
});

test('safe-development denies unknown and execute permissions', () => {
  const denied = decidePermission('safe-development', { params: { toolCall: { kind: 'execute' }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] } });
  assert.equal(denied.decision, 'deny');
  const unknown = decidePermission('safe-development', { params: { options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] } });
  assert.equal(unknown.decision, 'deny');
});

test('safe-development allows file reads', () => {
  const allowed = decidePermission('safe-development', { params: { toolCall: { kind: 'read' }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] } });
  assert.equal(allowed.decision, 'allow');
});

test('safe-development allows project-local npm test and still denies unknown execute', () => {
  const npmTest = decidePermission('safe-development', {
    params: { toolCall: { kind: 'execute', command: 'npm test' }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  });
  assert.equal(npmTest.decision, 'allow');
  const bare = decidePermission('safe-development', {
    params: { toolCall: { kind: 'execute' }, options: [{ optionId: 'allow-once' }, { optionId: 'reject' }] }
  });
  assert.equal(bare.decision, 'deny');
});

test('allow-all exists only as an explicit override', () => {
  const allowed = decidePermission('allow-all', { params: { toolCall: { kind: 'execute' }, options: [{ optionId: 'allow-once' }] } });
  assert.equal(allowed.decision, 'allow');
});

test('Council provider API keys are not inherited into Cursor child env', () => {
  const env = buildCursorChildEnv({
    PATH: '/bin',
    OPENAI_API_KEY: 'secret-openai',
    ANTHROPIC_API_KEY: 'secret-anthropic',
    GEMINI_API_KEY: 'secret-gemini',
    XAI_API_KEY: 'secret-xai',
    CURSOR_API_KEY: 'cursor-ok',
    DATABASE_URL: 'postgres://adp:secret@localhost/adp',
    CURSOR_CHILD_ENV_ALLOW: 'OPENAI_API_KEY'
  });
  for (const key of BLOCKED_CURSOR_ENV) assert.equal(env[key], undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.CURSOR_API_KEY, 'cursor-ok');
  assert.equal(env.PATH, '/bin');
  assert.doesNotThrow(() => assertNoCouncilSecrets(env));
});
