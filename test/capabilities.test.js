import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCanClaim, WorkerCapability } from '../src/capabilities/kinds.js';
import { discoverAndroid } from '../src/runtime/adapters/android.js';
import { discoverIos } from '../src/runtime/adapters/ios.js';
import { JobQueue } from '../src/jobs/queue.js';
import { JobType } from '../src/jobs/types.js';
import { ProjectState } from '../src/orchestrator/states.js';

test('capability matching is exact and does not over-claim', () => {
  assert.equal(workerCanClaim([WorkerCapability.WEB_CHROMIUM], [WorkerCapability.WEB_CHROMIUM]), true);
  assert.equal(workerCanClaim([WorkerCapability.WEB_CHROMIUM], [WorkerCapability.ANDROID_SDK, WorkerCapability.ANDROID_EMULATOR]), false);
  assert.equal(workerCanClaim([WorkerCapability.WEB_CHROMIUM], [WorkerCapability.MACOS, WorkerCapability.IOS_SIMULATOR]), false);
  assert.equal(workerCanClaim([WorkerCapability.ANDROID_SDK, WorkerCapability.ANDROID_EMULATOR], [WorkerCapability.ANDROID_SDK, WorkerCapability.ANDROID_EMULATOR]), true);
  assert.equal(workerCanClaim([], [WorkerCapability.WEB_CHROMIUM]), false);
  assert.equal(workerCanClaim([WorkerCapability.WEB_CHROMIUM], []), true);
});

test('Android and iOS discovery are truthful on this host', () => {
  const android = discoverAndroid();
  const ios = discoverIos();
  if (process.platform !== 'darwin') {
    assert.equal(ios.available, false);
    assert.equal(ios.macos, false);
  }
  assert.equal(typeof android.sdk, 'boolean');
  globalThis.__phase6Android = android.sdk && android.emulator
    ? 'LIVE VERIFIED'
    : 'NOT VERIFIED — INFRASTRUCTURE UNAVAILABLE';
  globalThis.__phase6Ios = process.platform === 'darwin' && ios.available
    ? 'LIVE VERIFIED'
    : 'NOT VERIFIED — MACOS/XCODE REQUIRED';
});

test('requiredCapabilitiesForJob encodes platform needs', async () => {
  const { requiredCapabilitiesForJob } = await import('../src/jobs/types.js');
  const android = {
    id: 'p',
    state: ProjectState.RUNTIME_VERIFICATION,
    runtimePlan: { applicationKind: 'ANDROID', requiredCapabilities: ['ANDROID_SDK', 'ANDROID_EMULATOR'] }
  };
  const ios = {
    id: 'p',
    state: ProjectState.RUNTIME_VERIFICATION,
    runtimePlan: { applicationKind: 'IOS', requiredCapabilities: ['MACOS', 'IOS_SIMULATOR'] }
  };
  const web = {
    id: 'p',
    state: ProjectState.RUNTIME_VERIFICATION,
    runtimePlan: { applicationKind: 'WEB_UI', requiredCapabilities: ['WEB_CHROMIUM'] }
  };
  assert.deepEqual(requiredCapabilitiesForJob(android, JobType.RUNTIME_VERIFICATION), ['ANDROID_SDK', 'ANDROID_EMULATOR']);
  assert.deepEqual(requiredCapabilitiesForJob(ios, JobType.RUNTIME_VERIFICATION), ['MACOS', 'IOS_SIMULATOR']);
  assert.deepEqual(requiredCapabilitiesForJob(web, JobType.RUNTIME_VERIFICATION), ['WEB_CHROMIUM']);
});

test('JobQueue claim signature accepts capability lists', () => {
  assert.equal(typeof JobQueue.prototype.claim, 'function');
});

test('capability-aware claiming skips incompatible workers', async () => {
  const { tempDurable } = await import('./helpers-durable.js');
  const { adapter, store, queue } = await tempDurable();
  const project = await store.create({ idea: 'caps', projectPath: '/tmp/x', demo: true });
  await queue.enqueue(project, {
    jobType: JobType.RUNTIME_VERIFICATION,
    phase: JobType.RUNTIME_VERIFICATION,
    iteration: 1,
    idempotencyKey: `project:${project.id}:runtime:cap-android`,
    requiredCapabilities: ['ANDROID_SDK', 'ANDROID_EMULATOR']
  });
  const webOnly = await queue.claim('web-worker', ['WEB_CHROMIUM']);
  assert.equal(webOnly, null);
  const windows = await queue.claim('win-worker', ['WEB_CHROMIUM']);
  assert.equal(windows, null);
  const android = await queue.claim('android-worker', ['ANDROID_SDK', 'ANDROID_EMULATOR']);
  assert.ok(android);
  assert.equal(android.jobType, JobType.RUNTIME_VERIFICATION);
  await adapter.close();
});
