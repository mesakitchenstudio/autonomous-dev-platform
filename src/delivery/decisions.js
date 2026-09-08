import crypto from 'node:crypto';
import { DeliveryStatus, OwnerDecision, WorktreeLifecycle } from './kinds.js';
import { currentDelivery, deliveryIsCurrent, finalCheckpointSha } from './lineage.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

const locks = new Map();

export function withProjectLock(projectId, fn) {
  const previous = locks.get(projectId) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const chain = previous.catch(() => {}).then(() => next);
  locks.set(projectId, chain);
  return previous.catch(() => {}).then(fn).finally(() => {
    release();
    if (locks.get(projectId) === chain) locks.delete(projectId);
  });
}

export function recordOwnerDecision(project, { delivery, decision, feedback }) {
  if (!delivery) {
    throw new PlatformError({
      code: ErrorCode.STALE_DELIVERY,
      message: 'No current delivery is available for an owner decision.',
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: false
    });
  }
  if (delivery.status !== DeliveryStatus.READY || !deliveryIsCurrent(project, delivery)) {
    delivery.status = delivery.status === DeliveryStatus.APPROVED ? delivery.status : DeliveryStatus.STALE;
    throw new PlatformError({
      code: ErrorCode.STALE_DELIVERY,
      message: 'This delivery is no longer current and cannot be approved.',
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: false
    });
  }
  project.ownerReviews = project.ownerReviews || [];
  const existing = project.ownerReviews.find(item => item.deliveryId === delivery.id);
  if (existing) {
    throw new PlatformError({
      code: ErrorCode.OWNER_DECISION_CONFLICT,
      message: `This delivery already has an owner decision (${existing.decision}).`,
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: false,
      details: { decision: existing.decision }
    });
  }
  const review = {
    id: crypto.randomUUID(),
    projectId: project.id,
    deliveryId: delivery.id,
    decision,
    feedback: decision === OwnerDecision.CHANGES_REQUESTED ? String(feedback || '').trim() : null,
    createdAt: new Date().toISOString()
  };
  if (decision === OwnerDecision.CHANGES_REQUESTED && !review.feedback) {
    throw new PlatformError({
      code: ErrorCode.INVALID_OWNER_FEEDBACK,
      message: 'Request Changes requires a high-level feedback message.',
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: false
    });
  }
  project.ownerReviews.push(review);
  if (decision === OwnerDecision.APPROVED) {
    delivery.status = DeliveryStatus.APPROVED;
    delivery.current = true;
    project.approvedAt = review.createdAt;
    project.completion = {
      completed: true,
      deliveryVersion: delivery.version,
      approvedAt: review.createdAt,
      finalCheckpoint: delivery.checkpointSha,
      ownerReviewId: review.id,
      artifactHashes: (delivery.artifacts || []).map(item => item.sha256)
    };
    if (project.repository) {
      project.repository.lifecycleStatus = WorktreeLifecycle.APPROVED;
    }
  } else {
    delivery.status = DeliveryStatus.SUPERSEDED;
    delivery.current = false;
    project.pendingOwnerFeedback = {
      reviewId: review.id,
      deliveryId: delivery.id,
      feedback: review.feedback,
      createdAt: review.createdAt
    };
    project.ownerFeedback = project.ownerFeedback || [];
    project.ownerFeedback.push({ ...review });
  }
  return review;
}

export function assertCurrentDelivery(project, deliveryId) {
  const delivery = (project.deliveries || []).find(item => item.id === deliveryId) || currentDelivery(project);
  const sha = finalCheckpointSha(project);
  if (delivery && sha && delivery.checkpointSha !== sha) {
    delivery.status = DeliveryStatus.STALE;
    delivery.current = false;
  }
  return delivery;
}
