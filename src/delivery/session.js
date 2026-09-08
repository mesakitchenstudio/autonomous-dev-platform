import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { DeliveryArtifactKind, ReviewSessionStatus } from './kinds.js';
import { currentDelivery } from './lineage.js';
import { startStaticServer } from '../runtime/static-server.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { deliveryDir } from './archive.js';
import { isDemoDelivery } from './demo-app.js';

const live = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

export async function startReviewSession(project, { ttlMs = 30 * 60 * 1000, publicBaseUrl = null } = {}) {
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
  const existing = (project.reviewSessions || []).find(item =>
    item.status === ReviewSessionStatus.ACTIVE
    && item.deliveryId === delivery.id
    && item.artifactHash === delivery.manifestHash
  );
  if (existing) {
    await attachLive(existing, delivery, { publicBaseUrl, project });
    return publicSession(existing);
  }

  for (const session of project.reviewSessions || []) {
    if (session.status === ReviewSessionStatus.ACTIVE) {
      await stopReviewSession(project, session.id);
    }
  }

  const reviewRoot = reviewRootFor(delivery);
  if (!reviewRoot || !fs.existsSync(reviewRoot)) {
    throw new PlatformError({
      code: ErrorCode.DELIVERY_PREPARATION_FAILED,
      message: 'Verified review artifact is missing.',
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: true
    });
  }

  const session = {
    id: crypto.randomUUID(),
    projectId: project.id,
    deliveryId: delivery.id,
    artifactHash: delivery.manifestHash,
    checkpointSha: delivery.checkpointSha,
    backend: 'verified-static',
    reviewUrl: null,
    url: null,
    status: ReviewSessionStatus.ACTIVE,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    stoppedAt: null,
    runtime: { host: '127.0.0.1', port: null, mutatesSource: false, hardened: false, verifiedArtifact: true }
  };
  await attachLive(session, delivery, { publicBaseUrl, project, reviewRoot, create: true });
  project.reviewSessions = project.reviewSessions || [];
  project.reviewSessions.push(session);
  return publicSession(session);
}

export async function stopReviewSession(project, sessionId) {
  const session = (project.reviewSessions || []).find(item => item.id === sessionId);
  if (!session) return null;
  await closeLive(sessionId);
  session.status = ReviewSessionStatus.STOPPED;
  session.stoppedAt = new Date().toISOString();
  return session;
}

export function expireSessions(project, now = Date.now()) {
  for (const session of project.reviewSessions || []) {
    if (session.status !== ReviewSessionStatus.ACTIVE) continue;
    if (Date.parse(session.expiresAt) <= now) {
      closeLiveSync(session.id);
      session.status = ReviewSessionStatus.EXPIRED;
      session.stoppedAt = new Date().toISOString();
    }
  }
}

export function liveReviewHandleCount() {
  return live.size;
}

export function hydrateReviewSession(project, sessionId) {
  const session = (project.reviewSessions || []).find(item => item.id === sessionId);
  if (!session || session.status !== ReviewSessionStatus.ACTIVE) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) return null;
  const delivery = (project.deliveries || []).find(item => item.id === session.deliveryId) || currentDelivery(project);
  const root = reviewRootFor(delivery);
  if (!root || !fs.existsSync(root)) return null;
  if (!live.has(sessionId)) {
    live.set(sessionId, { root, projectId: project.id, backend: session.backend || 'demo-static' });
  }
  return session;
}

export async function readReviewFile(sessionId, requestPath = '/') {
  const held = live.get(sessionId);
  if (!held?.root) return { status: 404, body: 'Review session not found' };
  let rel = decodeURIComponent(requestPath || '/');
  if (!rel || rel === '/') rel = '/index.html';
  if (!rel.startsWith('/')) rel = `/${rel}`;
  const root = path.resolve(held.root);
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(root)) return { status: 403, body: 'Forbidden' };
  try {
    const data = await fsPromises.readFile(file);
    return { status: 200, body: data, type: TYPES[path.extname(file)] || 'application/octet-stream' };
  } catch {
    try {
      const data = await fsPromises.readFile(path.join(root, 'index.html'));
      return { status: 200, body: data, type: 'text/html; charset=utf-8' };
    } catch {
      return { status: 404, body: 'Not found' };
    }
  }
}

function publicSession(session) {
  const url = session.url || session.reviewUrl;
  return { ...session, url, reviewUrl: session.reviewUrl || url };
}

async function attachLive(session, delivery, { publicBaseUrl, project, reviewRoot, create = false } = {}) {
  if (live.has(session.id) && session.reviewUrl) {
    session.url = session.url || session.reviewUrl;
    return session;
  }
  const root = reviewRoot || reviewRootFor(delivery);
  if (!root || !fs.existsSync(root)) {
    throw new PlatformError({
      code: ErrorCode.DELIVERY_PREPARATION_FAILED,
      message: 'Verified review artifact is missing.',
      phase: 'READY_FOR_OWNER_REVIEW',
      retryable: true
    });
  }
  const demoStatic = Boolean(publicBaseUrl) && isDemoDelivery(project);
  if (demoStatic) {
    live.set(session.id, { root, projectId: project.id, backend: 'demo-static' });
    const origin = String(publicBaseUrl).replace(/\/$/, '');
    session.backend = 'demo-static';
    session.reviewUrl = `${origin}/review/${session.id}/`;
    session.url = session.reviewUrl;
    session.runtime = { host: '127.0.0.1', port: null, mutatesSource: false, hardened: false, verifiedArtifact: true, inProcess: true };
    return session;
  }
  if (!create && live.has(session.id)) return session;
  const server = await startStaticServer(root, 0);
  const port = server.address().port;
  live.set(session.id, { server, root, projectId: project.id, backend: 'verified-static' });
  session.backend = 'verified-static';
  session.reviewUrl = `http://127.0.0.1:${port}/`;
  session.url = session.reviewUrl;
  session.runtime = { host: '127.0.0.1', port, mutatesSource: false, hardened: false, verifiedArtifact: true };
  return session;
}

async function closeLive(sessionId) {
  const held = live.get(sessionId);
  if (held?.server) {
    await new Promise(resolve => held.server.close(resolve));
  }
  live.delete(sessionId);
}

function closeLiveSync(sessionId) {
  const held = live.get(sessionId);
  if (held?.server) held.server.close();
  live.delete(sessionId);
}

function reviewRootFor(delivery) {
  const page = (delivery.artifacts || []).find(item => item.kind === DeliveryArtifactKind.REVIEW_PAGE && item.storedPath);
  if (page?.storedPath) return path.dirname(page.storedPath);
  const appDir = path.join(deliveryDir(delivery.projectId, delivery.version), 'app');
  if (fs.existsSync(path.join(appDir, 'index.html'))) return appDir;
  return path.join(deliveryDir(delivery.projectId, delivery.version), 'review');
}
