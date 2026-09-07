import { ErrorCode, PlatformError } from './errors.js';

export const ProjectState = Object.freeze({
  IDEA_SUBMITTED: 'IDEA_SUBMITTED',
  COUNCIL_DISCOVERY: 'COUNCIL_DISCOVERY',
  SPECIFICATION_READY: 'SPECIFICATION_READY',
  CURSOR_EXECUTING: 'CURSOR_EXECUTING',
  COUNCIL_REVIEW: 'COUNCIL_REVIEW',
  FINAL_VERIFICATION: 'FINAL_VERIFICATION',
  READY_FOR_OWNER_REVIEW: 'READY_FOR_OWNER_REVIEW',
  OWNER_APPROVED: 'OWNER_APPROVED',
  FAILED: 'FAILED'
});

export const ACTIVE_WORKFLOW_STATES = Object.freeze([
  ProjectState.IDEA_SUBMITTED,
  ProjectState.COUNCIL_DISCOVERY,
  ProjectState.SPECIFICATION_READY,
  ProjectState.CURSOR_EXECUTING,
  ProjectState.COUNCIL_REVIEW,
  ProjectState.FINAL_VERIFICATION
]);

export const OWNER_TERMINAL_STATES = Object.freeze([
  ProjectState.READY_FOR_OWNER_REVIEW,
  ProjectState.OWNER_APPROVED
]);

const transitions = new Map([
  [ProjectState.IDEA_SUBMITTED, new Set([ProjectState.COUNCIL_DISCOVERY, ProjectState.FAILED])],
  [ProjectState.COUNCIL_DISCOVERY, new Set([ProjectState.SPECIFICATION_READY, ProjectState.FAILED])],
  [ProjectState.SPECIFICATION_READY, new Set([ProjectState.CURSOR_EXECUTING, ProjectState.FAILED])],
  [ProjectState.CURSOR_EXECUTING, new Set([ProjectState.COUNCIL_REVIEW, ProjectState.FAILED])],
  [ProjectState.COUNCIL_REVIEW, new Set([ProjectState.CURSOR_EXECUTING, ProjectState.SPECIFICATION_READY, ProjectState.FINAL_VERIFICATION, ProjectState.FAILED])],
  [ProjectState.FINAL_VERIFICATION, new Set([ProjectState.CURSOR_EXECUTING, ProjectState.SPECIFICATION_READY, ProjectState.READY_FOR_OWNER_REVIEW, ProjectState.FAILED])],
  [ProjectState.READY_FOR_OWNER_REVIEW, new Set([ProjectState.OWNER_APPROVED, ProjectState.COUNCIL_DISCOVERY])],
  [ProjectState.OWNER_APPROVED, new Set()],
  [ProjectState.FAILED, new Set([
    ProjectState.IDEA_SUBMITTED,
    ProjectState.COUNCIL_DISCOVERY,
    ProjectState.SPECIFICATION_READY,
    ProjectState.CURSOR_EXECUTING,
    ProjectState.COUNCIL_REVIEW,
    ProjectState.FINAL_VERIFICATION
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
