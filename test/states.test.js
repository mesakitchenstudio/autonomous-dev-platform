import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectState, assertTransition, isLegalTransition, legalTargets, TRANSITIONS, isBootResumable, isOwnerTerminal } from '../src/orchestrator/states.js';
import { ErrorCode } from '../src/orchestrator/errors.js';

test('every declared transition is legal', () => {
  for (const [from, targets] of TRANSITIONS.entries()) {
    for (const to of targets) assert.equal(isLegalTransition(from, to), true, `${from} -> ${to}`);
  }
});

test('representative illegal transitions are rejected', () => {
  const illegal = [
    [ProjectState.CURSOR_EXECUTING, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.CURSOR_EXECUTING, ProjectState.COUNCIL_REVIEW],
    [ProjectState.PLATFORM_VERIFICATION, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.RUNTIME_VERIFICATION, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.VISUAL_VERIFICATION, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.PLATFORM_VERIFICATION, ProjectState.CURSOR_EXECUTING],
    [ProjectState.IDEA_SUBMITTED, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.SPECIFICATION_READY, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.COUNCIL_REVIEW, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.FINAL_VERIFICATION, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.FAILED, ProjectState.READY_FOR_OWNER_REVIEW],
    [ProjectState.OWNER_APPROVED, ProjectState.FAILED],
    [ProjectState.DONE, ProjectState.COUNCIL_DISCOVERY]
  ];
  for (const [from, to] of illegal) {
    assert.equal(isLegalTransition(from, to), false, `${from} -> ${to}`);
    assert.throws(() => assertTransition(from, to), err => err.code === ErrorCode.INVALID_STATE_TRANSITION);
  }
});

test('owner is only exposed after delivery preparation', () => {
  assert.doesNotThrow(() => assertTransition(ProjectState.FINAL_VERIFICATION, ProjectState.DELIVERY_PREPARATION));
  assert.doesNotThrow(() => assertTransition(ProjectState.DELIVERY_PREPARATION, ProjectState.READY_FOR_OWNER_REVIEW));
  assert.throws(() => assertTransition(ProjectState.FINAL_VERIFICATION, ProjectState.READY_FOR_OWNER_REVIEW));
  assert.throws(() => assertTransition(ProjectState.CURSOR_EXECUTING, ProjectState.READY_FOR_OWNER_REVIEW));
});

test('review can return to cursor', () => {
  assert.doesNotThrow(() => assertTransition(ProjectState.COUNCIL_REVIEW, ProjectState.CURSOR_EXECUTING));
});

test('failed retry has explicit recovery targets', () => {
  const targets = legalTargets(ProjectState.FAILED);
  for (const state of [ProjectState.COUNCIL_DISCOVERY, ProjectState.SPECIFICATION_READY, ProjectState.PROJECT_PROVISIONING, ProjectState.CURSOR_EXECUTING, ProjectState.PLATFORM_VERIFICATION, ProjectState.RUNTIME_VERIFICATION, ProjectState.VISUAL_VERIFICATION, ProjectState.COUNCIL_REVIEW, ProjectState.FINAL_VERIFICATION]) {
    assert.ok(targets.includes(state), state);
  }
});

test('boot resume and owner terminal classification', () => {
  assert.equal(isBootResumable(ProjectState.CURSOR_EXECUTING), true);
  assert.equal(isBootResumable(ProjectState.FAILED), false);
  assert.equal(isBootResumable(ProjectState.READY_FOR_OWNER_REVIEW), false);
  assert.equal(isBootResumable(ProjectState.DELIVERY_PREPARATION), true);
  assert.equal(isBootResumable(ProjectState.OWNER_CHANGES_REQUESTED), true);
  assert.equal(isOwnerTerminal(ProjectState.READY_FOR_OWNER_REVIEW), true);
  assert.equal(isOwnerTerminal(ProjectState.OWNER_APPROVED), true);
  assert.equal(isOwnerTerminal(ProjectState.DONE), true);
});
