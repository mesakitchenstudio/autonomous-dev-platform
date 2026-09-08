import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DeliveryArtifactKind, ReviewSessionStatus } from './kinds.js';
import { currentDelivery } from './lineage.js';
import { startStaticServer } from '../runtime/static-server.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { deliveryDir } from './archive.js';

const live = new Map();

export async function startReviewSession(project, { ttlMs = 30 * 60 * 1000 } = {}) {
  const delivery = currentDelivery(project);
  if (!delivery || delivery.status !== 'READY' && delivery.status !== 'APPROVED') {
    throw new PlatformError({
      code: ErrorCode.STALE_DELIVERY,
      message: 'A verified delivery is required before opening the application.',
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: false
    });
  }
  expireSessions(project);
  const reviewRoot = reviewRootFor(delivery);
  if (!reviewRoot || !fs.existsSync(reviewRoot)) {
    throw new PlatformError({
      code: ErrorCode.DELIVERY_PREPARATION_FAILED,
      message: 'Verified review artifact is missing.',
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: true
    });
  }
  const server = await startStaticServer(reviewRoot, 0);
  const port = server.address().port;
  const session = {
    id: crypto.randomUUID(),
    projectId: project.id,
    deliveryId: delivery.id,
    artifactHash: delivery.manifestHash,
    checkpointSha: delivery.checkpointSha,
    backend: 'verified-static',
    reviewUrl: `http://127.0.0.1:${port}/`,
    status: ReviewSessionStatus.ACTIVE,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    stoppedAt: null,
    runtime: { host: '127.0.0.1', port, mutatesSource: false, hardened: false, verifiedArtifact: true }
  };
  project.reviewSessions = project.reviewSessions || [];
  project.reviewSessions.push(session);
  live.set(session.id, { server, projectId: project.id });
  return session;
}

export async function stopReviewSession(project, sessionId) {
  const session = (project.reviewSessions || []).find(item => item.id === sessionId);
  if (!session) return null;
  const held = live.get(sessionId);
  if (held?.server) {
    await new Promise(resolve => held.server.close(resolve));
    live.delete(sessionId);
  }
  session.status = ReviewSessionStatus.STOPPED;
  session.stoppedAt = new Date().toISOString();
  return session;
}

export function expireSessions(project, now = Date.now()) {
  for (const session of project.reviewSessions || []) {
    if (session.status !== ReviewSessionStatus.ACTIVE) continue;
    if (Date.parse(session.expiresAt) <= now) {
      const held = live.get(session.id);
      if (held?.server) {
        held.server.close();
        live.delete(session.id);
      }
      session.status = ReviewSessionStatus.EXPIRED;
      session.stoppedAt = new Date().toISOString();
    }
  }
}

function reviewRootFor(delivery) {
  const page = (delivery.artifacts || []).find(item => item.kind === DeliveryArtifactKind.REVIEW_PAGE && item.storedPath);
  if (page?.storedPath) return path.dirname(page.storedPath);
  return path.join(deliveryDir(delivery.projectId, delivery.version), 'review');
}
