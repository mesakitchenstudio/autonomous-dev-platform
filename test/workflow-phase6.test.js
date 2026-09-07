import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectState, isLegalTransition } from '../src/orchestrator/states.js';
import { shouldSkipRuntime } from '../src/runtime/pipeline.js';
import { shouldSkipVisual } from '../src/visual/pipeline.js';
import { JobType, nextJobType } from '../src/jobs/types.js';
import { PolicyLevel } from '../src/verify/kinds.js';

test('runtime follows technical verification; visual follows runtime', () => {
  assert.equal(isLegalTransition(ProjectState.PLATFORM_VERIFICATION, ProjectState.RUNTIME_VERIFICATION), true);
  assert.equal(isLegalTransition(ProjectState.RUNTIME_VERIFICATION, ProjectState.VISUAL_VERIFICATION), true);
  assert.equal(isLegalTransition(ProjectState.VISUAL_VERIFICATION, ProjectState.COUNCIL_REVIEW), true);
  assert.equal(isLegalTransition(ProjectState.CURSOR_EXECUTING, ProjectState.RUNTIME_VERIFICATION), false);
  assert.equal(isLegalTransition(ProjectState.PLATFORM_VERIFICATION, ProjectState.VISUAL_VERIFICATION), false);
});

test('failed technical verification never reaches runtime', () => {
  const project = { demo: false, evidence: { verificationLevel: 'PLATFORM_VERIFIED' } };
  assert.equal(shouldSkipRuntime(project, { blockingFailures: [{ code: 'COMMAND_FAILED' }] }), true);
  assert.equal(shouldSkipRuntime(project, { blockingFailures: [], mock: false }), false);
});

test('failed runtime goes to Council and skips visual when launch failed', () => {
  assert.equal(shouldSkipVisual({ demo: false }, {
    status: 'FAIL',
    policy: { visual: PolicyLevel.REQUIRED },
    blockingFailures: [{ code: 'RUNTIME_START_FAILED' }],
    screenshots: []
  }), true);
});

test('correction returns through Phase 5 before Phase 6', () => {
  assert.equal(isLegalTransition(ProjectState.COUNCIL_REVIEW, ProjectState.CURSOR_EXECUTING), true);
  assert.equal(isLegalTransition(ProjectState.CURSOR_EXECUTING, ProjectState.PLATFORM_VERIFICATION), true);
  assert.equal(isLegalTransition(ProjectState.COUNCIL_REVIEW, ProjectState.RUNTIME_VERIFICATION), false);
});

test('durable job types follow the new stages', () => {
  assert.equal(nextJobType({ state: ProjectState.RUNTIME_VERIFICATION }), JobType.RUNTIME_VERIFICATION);
  assert.equal(nextJobType({ state: ProjectState.VISUAL_VERIFICATION }), JobType.VISUAL_VERIFICATION);
});
