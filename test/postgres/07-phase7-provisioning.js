import test from 'node:test';
import assert from 'node:assert/strict';
import { pgDurable, recordEvidence } from './harness.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { ProjectState } from '../../src/orchestrator/states.js';
import { specFixture } from '../helpers.js';

test('PostgreSQL capability-aware claiming skips Android provisioning on web-only workers', async () => {
  const { adapter, store } = await pgDurable();
  try {
    const queue = new JobQueue(adapter, { leaseMs: 5000 });
    const project = await store.create({ idea: 'Android cooker', demo: true });
    project.state = ProjectState.PROJECT_PROVISIONING;
    project.council = { discovery: { spec: specFixture() } };
    project.provisioningPlan = {
      hash: 'android-plan',
      provisioner: 'ANDROID_NATIVE',
      capabilitiesRequired: ['ANDROID_SDK', 'ANDROID_PROJECT_CREATOR', 'JAVA']
    };
    await store.save(project);
    const job = await queue.enqueue(project);
    assert.ok(job);
    assert.deepEqual(job.requiredCapabilities, ['ANDROID_SDK', 'ANDROID_PROJECT_CREATOR', 'JAVA']);
    const webClaim = await queue.claim('web-worker', ['WEB_CHROMIUM', 'NODE']);
    assert.equal(webClaim, null);
    const androidClaim = await queue.claim('android-worker', ['ANDROID_SDK', 'ANDROID_PROJECT_CREATOR', 'JAVA']);
    assert.ok(androidClaim);
    assert.equal(androidClaim.id, job.id);
    await recordEvidence({
      phase7Claiming: {
        jobId: job.id,
        required: job.requiredCapabilities,
        webClaimed: false,
        androidClaimed: true
      }
    });
  } finally {
    await adapter.close();
  }
});
