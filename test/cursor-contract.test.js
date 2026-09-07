import test from 'node:test';
import assert from 'node:assert/strict';
import { createCursorContract, slimCursorReviewInput, CursorMode } from '../src/cursor/contract.js';
import { MockCursorClient } from '../src/cursor/mock-cursor.js';
import { CursorAcpClient } from '../src/cursor/acp-client.js';
import { CursorCloudClient } from '../src/cursor/cloud-client.js';

function assertContractShape(value) {
  assert.ok(value.projectId);
  assert.ok(value.executionMode);
  assert.ok(value.workspace);
  assert.ok(value.task);
  assert.ok(value.session);
  assert.ok(value.result);
  assert.ok(value.git);
  assert.ok(value.timestamps);
}

test('mock client normalizes into the unified Cursor contract', async () => {
  const client = new MockCursorClient();
  const result = await client.run({
    projectId: 'p1',
    cursorRunId: 'r1',
    iteration: 1,
    prompt: 'do the thing',
    workspace: { workspacePath: '/ws', workingBranch: 'adp/p1', baselineSha: 'abc' }
  });
  assertContractShape(result);
  assert.equal(result.executionMode, CursorMode.MOCK);
  const slim = slimCursorReviewInput({ result, evidence: result.evidence, status: 'COMPLETED' }, result);
  assert.ok(slim.git);
  assert.ok(Array.isArray(slim.changedFiles));
});

test('ACP and Cloud adapters expose the same run/cancel contract surface', () => {
  const acp = new CursorAcpClient({ bin: 'agent' });
  assert.equal(typeof acp.run, 'function');
  assert.equal(typeof acp.cancel, 'function');
  const cloud = Object.create(CursorCloudClient.prototype);
  assert.equal(typeof cloud.run, 'function');
  assert.equal(typeof cloud.cancel, 'function');
});

test('Cloud create payload uses per-project repo and isolation flags', () => {
  const captured = [];
  const client = new CursorCloudClient({ apiKey: 'test-key', repoUrl: 'https://example.com/global.git' });
  client.request = async (path, options = {}) => {
    captured.push({ path, options });
    if (path === '/v1/agents') {
      return { agent: { id: 'agent-1' }, run: { id: 'run-1', status: 'FINISHED', result: 'ok', branch: 'cursor/work', commitSha: 'def' } };
    }
    return { status: 'FINISHED', result: 'ok', id: 'run-1', branch: 'cursor/work', commitSha: 'def' };
  };
  return client.run({
    projectId: 'p1',
    prompt: 'harmless',
    workspace: { cloudRepositoryUrl: 'https://example.com/project.git', baseRef: 'develop' }
  }).then(result => {
    const created = captured.find(item => item.path === '/v1/agents');
    const body = JSON.parse(created.options.body);
    assert.equal(body.repos[0].url, 'https://example.com/project.git');
    assert.equal(body.repos[0].startingRef, 'develop');
    assert.equal(body.autoCreatePR, false);
    assert.equal(body.workOnCurrentBranch, false);
    assert.equal(result.session.agentId, 'agent-1');
    assert.equal(result.session.runId, 'run-1');
    assert.equal(result.executionMode, CursorMode.CLOUD);
  });
});

test('createCursorContract fills a stable shape from partial input', () => {
  const contract = createCursorContract({ projectId: 'p', executionMode: 'ACP', iteration: 2 });
  assertContractShape({ ...contract, projectId: 'p' });
  assert.equal(contract.git.dirty, false);
});
