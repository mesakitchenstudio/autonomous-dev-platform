import { ErrorCode, PlatformError } from './errors.js';

export const ProjectState = Object.freeze({
  IDEA_SUBMITTED: 'IDEA_SUBMITTED',
  COUNCIL_DISCOVERY: 'COUNCIL_DISCOVERY',
  SPECIFICATION_READY: 'SPECIFICATION_READY',
  PROJECT_PROVISIONING: 'PROJECT_PROVISIONING',
  CURSOR_EXECUTING: 'CURSOR_EXECUTING',
  PLATFORM_VERIFICATION: 'PLATFORM_VERIFICATION',
  RUNTIME_VERIFICATION: 'RUNTIME_VERIFICATION',
  VISUAL_VERIFICATION: 'VISUAL_VERIFICATION',
  COUNCIL_REVIEW: 'COUNCIL_REVIEW',
  FINAL_VERIFICATION: 'FINAL_VERIFICATION',
  DELIVERY_PREPARATION: 'DELIVERY_PREPARATION',
  READY_FOR_OWNER_REVIEW: 'READY_FOR_OWNER_REVIEW',
  OWNER_CHANGES_REQUESTED: 'OWNER_CHANGES_REQUESTED',
  OWNER_APPROVED: 'OWNER_APPROVED',
  DONE: 'DONE',
  FAILED: 'FAILED'
});

export const ACTIVE_WORKFLOW_STATES = Object.freeze([
  ProjectState.IDEA_SUBMITTED,
  ProjectState.COUNCIL_DISCOVERY,
  ProjectState.SPECIFICATION_READY,
  ProjectState.PROJECT_PROVISIONING,
  ProjectState.CURSOR_EXECUTING,
  ProjectState.PLATFORM_VERIFICATION,
  ProjectState.RUNTIME_VERIFICATION,
  ProjectState.VISUAL_VERIFICATION,
  ProjectState.COUNCIL_REVIEW,
  ProjectState.FINAL_VERIFICATION,
  ProjectState.DELIVERY_PREPARATION,
  ProjectState.OWNER_CHANGES_REQUESTED
]);

export const OWNER_TERMINAL_STATES = Object.freeze([
  ProjectState.READY_FOR_OWNER_REVIEW,
  ProjectState.OWNER_APPROVED,
  ProjectState.DONE
]);

const transitions = new Map([
  [ProjectState.IDEA_SUBMITTED, new Set([ProjectState.COUNCIL_DISCOVERY, ProjectState.FAILED])],
  [ProjectState.COUNCIL_DISCOVERY, new Set([ProjectState.SPECIFICATION_READY, ProjectState.FAILED])],
  [ProjectState.SPECIFICATION_READY, new Set([ProjectState.PROJECT_PROVISIONING, ProjectState.CURSOR_EXECUTING, ProjectState.FAILED])],
  [ProjectState.PROJECT_PROVISIONING, new Set([ProjectState.CURSOR_EXECUTING, ProjectState.FAILED])],
  [ProjectState.CURSOR_EXECUTING, new Set([ProjectState.PLATFORM_VERIFICATION, ProjectState.FAILED])],
  [ProjectState.PLATFORM_VERIFICATION, new Set([
    ProjectState.RUNTIME_VERIFICATION,
    ProjectState.COUNCIL_REVIEW,
    ProjectState.FAILED
  ])],
  [ProjectState.RUNTIME_VERIFICATION, new Set([
    ProjectState.VISUAL_VERIFICATION,
    ProjectState.COUNCIL_REVIEW,
    ProjectState.FAILED
  ])],
  [ProjectState.VISUAL_VERIFICATION, new Set([ProjectState.COUNCIL_REVIEW, ProjectState.FAILED])],
  [ProjectState.COUNCIL_REVIEW, new Set([ProjectState.CURSOR_EXECUTING, ProjectState.SPECIFICATION_READY, ProjectState.FINAL_VERIFICATION, ProjectState.FAILED])],
  [ProjectState.FINAL_VERIFICATION, new Set([ProjectState.CURSOR_EXECUTING, ProjectState.SPECIFICATION_READY, ProjectState.DELIVERY_PREPARATION, ProjectState.FAILED])],
  [ProjectState.DELIVERY_PREPARATION, new Set([ProjectState.READY_FOR_OWNER_REVIEW, ProjectState.FAILED])],
  [ProjectState.READY_FOR_OWNER_REVIEW, new Set([ProjectState.OWNER_APPROVED, ProjectState.OWNER_CHANGES_REQUESTED])],
  [ProjectState.OWNER_CHANGES_REQUESTED, new Set([ProjectState.COUNCIL_DISCOVERY, ProjectState.FAILED])],
  [ProjectState.OWNER_APPROVED, new Set([ProjectState.DONE])],
  [ProjectState.DONE, new Set()],
  [ProjectState.FAILED, new Set([
    ProjectState.IDEA_SUBMITTED,
    ProjectState.COUNCIL_DISCOVERY,
    ProjectState.SPECIFICATION_READY,
    ProjectState.CURSOR_EXECUTING,
    ProjectState.PROJECT_PROVISIONING,
    ProjectState.PLATFORM_VERIFICATION,
    ProjectState.RUNTIME_VERIFICATION,
    ProjectState.VISUAL_VERIFICATION,
    ProjectState.COUNCIL_REVIEW,
    ProjectState.FINAL_VERIFICATION,
    ProjectState.DELIVERY_PREPARATION
  ])]
]);

export function isLegalTransition(from, to) {
  return Boolean(transitions.get(from)?.has(to));
}

export function legalTargets(from) {
  return [...(transitions.get(from) || [])];
}

export function assertTransition(from, to) {
  if (!isLegalTransition(from, to)) {
    throw new PlatformError({
      code: ErrorCode.INVALID_STATE_TRANSITION,
      message: `Invalid project transition: ${from} -> ${to}`,
      phase: from,
      retryable: false,
      details: { from, to, legal: legalTargets(from) }
    });
  }
}

export function isBootResumable(state) {
  return ACTIVE_WORKFLOW_STATES.includes(state);
}

export function isOwnerTerminal(state) {
  return OWNER_TERMINAL_STATES.includes(state);
}

export { transitions as TRANSITIONS };
