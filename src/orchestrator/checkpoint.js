import crypto from 'node:crypto';

export const OperationStatus = Object.freeze({
  NOT_STARTED: 'not_started',
  STARTED: 'started',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

export const OperationType = Object.freeze({
  DISCOVERY: 'council_discovery',
  PROJECT_PROVISIONING: 'project_provisioning',
  CURSOR: 'cursor_execution',
  PLATFORM_VERIFICATION: 'platform_verification',
  RUNTIME_VERIFICATION: 'runtime_verification',
  VISUAL_VERIFICATION: 'visual_verification',
  REVIEW: 'council_review',
  FINAL: 'final_verification'
});

export function emptyCheckpoint() {
  return {
    type: null,
    status: OperationStatus.NOT_STARTED,
    iteration: 0,
    operationId: null,
    startedAt: null,
    completedAt: null,
    error: null
  };
}

export function beginOperation(project, type, extra = {}) {
  const now = new Date().toISOString();
  const op = {
    id: crypto.randomUUID(),
    type,
    status: OperationStatus.STARTED,
    iteration: project.iteration || 0,
    startedAt: now,
    completedAt: null,
    error: null,
    ...extra
  };
  project.operations = project.operations || [];
  project.operations.push(op);
  project.checkpoint = {
    type,
    status: OperationStatus.STARTED,
    iteration: op.iteration,
    operationId: op.id,
    startedAt: now,
    completedAt: null,
    error: null
  };
  return op;
}

export function completeOperation(project, op) {
  const now = new Date().toISOString();
  if (op) {
    op.status = OperationStatus.COMPLETED;
    op.completedAt = now;
  }
  project.checkpoint = {
    ...(project.checkpoint || emptyCheckpoint()),
    status: OperationStatus.COMPLETED,
    completedAt: now,
    error: null
  };
}

export function failOperation(project, op, error) {
  const now = new Date().toISOString();
  if (op) {
    op.status = OperationStatus.FAILED;
    op.completedAt = now;
    op.error = error;
  }
  project.checkpoint = {
    ...(project.checkpoint || emptyCheckpoint()),
    status: OperationStatus.FAILED,
    completedAt: now,
    error
  };
}

export function currentOperation(project) {
  const id = project?.checkpoint?.operationId;
  if (!id) return null;
  return (project.operations || []).find(op => op.id === id) || null;
}
