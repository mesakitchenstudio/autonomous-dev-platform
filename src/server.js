import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, intEnv, boolEnv } from './util/env.js';
import { createRuntime } from './app/runtime.js';
import { Worker } from './worker/worker.js';
import { importJsonProjects } from './storage/json-import.js';
import { ErrorCode } from './orchestrator/errors.js';
import { migrationStatus } from './db/migrate.js';
import { applyCors, authenticateRequest, authorize, applyCsrf, limitSensitive } from './auth/http.js';
import { bootstrapOwnerToken } from './auth/tokens.js';
import { sanitizeExport } from './security/export.js';
import { resolveProjectArtifact } from './security/artifacts.js';
import { SecurityEventType } from './security/kinds.js';
import { recordSecurityEvent } from './security/events.js';
import { cleanupOrphanSandboxes } from './sandbox/cleanup.js';
import { startReviewSession, expireSessions, stopReviewSession } from './delivery/session.js';
import { markNotificationRead } from './notifications/index.js';
import { ownerDeliveryView } from './delivery/prepare.js';
import { currentDelivery } from './delivery/lineage.js';
import { ProjectState } from './orchestrator/states.js';

loadDotEnv();
bootstrapOwnerToken();
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const demo = boolEnv('DEMO_MODE', false);
const role = process.env.APP_ROLE || (demo ? 'combined' : 'api');
const runtime = await createRuntime({ role, demo });
const { store, queue, orchestrator, adapter } = runtime;
const publicDir = path.join(root, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

if (boolEnv('IMPORT_JSON_ON_START', false)) {
  const imported = await importJsonProjects(store, runtime.jsonDir);
  if (imported.length) console.log(`JSON import: ${imported.filter(item => item.status === 'imported').length} imported, ${imported.filter(item => item.status === 'already_imported').length} already present.`);
}

const resumed = await orchestrator.recoverOnBoot();
const worker = (role === 'combined' || role === 'worker') ? new Worker({ store, queue, orchestrator }) : null;
if (worker && role !== 'worker') await worker.start();
cleanupOrphanSandboxes().catch(() => {});

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function requireOwner(req, res, action) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return null;
  }
  const limited = limitSensitive(req, action);
  if (!limited.ok) {
    recordSecurityEvent(SecurityEventType.AUTHZ_DENIED, { action, reason: 'rate_limited' }, { store });
    json(res, 429, { error: 'rate limited', code: ErrorCode.RATE_LIMITED });
    return null;
  }
  const auth = authenticateRequest(req, { store });
  if (!auth.ok) {
    const failed = limitSensitive(req, 'auth');
    if (!failed.ok) {
      recordSecurityEvent(SecurityEventType.AUTHZ_DENIED, { action, reason: 'rate_limited' }, { store });
      json(res, 429, { error: 'rate limited', code: ErrorCode.RATE_LIMITED });
      return null;
    }
    json(res, 401, { error: 'authentication required', code: ErrorCode.AUTH_FAILURE });
    return null;
  }
  if (!authorize(auth, action)) {
    recordSecurityEvent(SecurityEventType.AUTHZ_DENIED, { action, role: auth.role }, { store });
    json(res, 403, { error: 'not authorized', code: ErrorCode.AUTHZ_DENIED });
    return null;
  }
  if (!applyCsrf(req, auth)) {
    json(res, 403, { error: 'csrf validation failed', code: ErrorCode.AUTHZ_DENIED });
    return null;
  }
  return auth;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      applyCors(req, res);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, role, demo, engine: runtime.engine });
    }
    if (req.method === 'GET' && url.pathname === '/ready') {
      try {
        await adapter.ready();
        const auth = authenticateRequest(req, { store });
        if (!auth.ok) return json(res, 200, { ok: true, engine: runtime.engine });
        const jobs = await queue.counts();
        const migrations = await migrationStatus(adapter);
        return json(res, 200, { ok: true, engine: runtime.engine, jobs, migrations });
      } catch (error) {
        return json(res, 503, { ok: false, error: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      if (!requireOwner(req, res, 'project.read')) return;
      const projects = await store.list();
      const items = projects.flatMap(project => (project.notifications || []).map(item => ({
        ...item,
        projectName: project.delivery?.productName || project.council?.discovery?.spec?.productName || 'Project'
      })));
      items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json(res, 200, items);
    }
    const readNote = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (req.method === 'POST' && readNote) {
      if (!requireOwner(req, res, 'project.read')) return;
      const projects = await store.list();
      for (const project of projects) {
        const found = markNotificationRead(project, readNote[1]);
        if (found) {
          if (found.projectId && found.projectId !== project.id) return json(res, 403, { error: 'not authorized', code: ErrorCode.AUTHZ_DENIED });
          await store.save(project);
          return json(res, 200, found);
        }
      }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      if (!requireOwner(req, res, 'project.list')) return;
      const list = await store.list();
      return json(res, 200, list.map(projectView));
    }
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      if (!requireOwner(req, res, 'project.create')) return;
      const b = await body(req);
      if (!b.idea?.trim()) return json(res, 400, { error: 'idea is required' });
      const p = await orchestrator.submit({ idea: b.idea.trim(), projectPath: b.projectPath?.trim() || null });
      return json(res, 202, p);
    }
    const exported = url.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
    if (req.method === 'GET' && exported) {
      if (!requireOwner(req, res, 'project.export')) return;
      return json(res, 200, sanitizeExport(await store.exportProject(exported[1])));
    }
    const artifact = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/);
    if (req.method === 'GET' && artifact) {
      if (!requireOwner(req, res, 'artifact.read')) return;
      const project = await store.get(artifact[1]);
      const found = resolveProjectArtifact(project, artifact[2]);
      if (!found.path) return json(res, 404, { error: 'artifact has no stored path' });
      recordSecurityEvent(SecurityEventType.OWNER_ARTIFACT_DOWNLOADED, { projectId: project.id, artifactId: found.id }, { store });
      const data = await fs.readFile(found.path);
      const name = sanitizeFileName(found.fileName || found.name || path.basename(found.path));
      res.writeHead(200, {
        'content-type': found.mimeType || 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`
      });
      return res.end(data);
    }
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      if (!requireOwner(req, res, 'project.read')) return;
      let project = await store.get(match[1]);
      if (project.state === ProjectState.DELIVERY_PREPARATION) {
        await orchestrator.finishDelivery(project).catch(() => {});
        project = await store.get(match[1]);
      }
      if (project.state === ProjectState.READY_FOR_OWNER_REVIEW) {
        recordSecurityEvent(SecurityEventType.OWNER_REVIEW_OPENED, { projectId: project.id, deliveryId: currentDelivery(project)?.id }, { store });
      }
      expireSessions(project);
      return json(res, 200, projectView(project));
    }
    const approve = url.pathname.match(/^\/api\/projects\/([^/]+)\/approve$/);
    if (req.method === 'POST' && approve) {
      if (!requireOwner(req, res, 'project.approve')) return;
      try {
        return json(res, 200, projectView(await orchestrator.approve(approve[1])));
      } catch (error) {
        const status = error?.code === ErrorCode.OWNER_DECISION_CONFLICT || error?.code === ErrorCode.STALE_DELIVERY ? 409 : 500;
        return json(res, status, { error: error.message, code: error.code });
      }
    }
    const changes = url.pathname.match(/^\/api\/projects\/([^/]+)\/changes$/);
    if (req.method === 'POST' && changes) {
      if (!requireOwner(req, res, 'project.changes')) return;
      try {
        const b = await body(req);
        return json(res, 202, projectView(await orchestrator.requestChanges(changes[1], b.feedback)));
      } catch (error) {
        const status = error?.code === ErrorCode.OWNER_DECISION_CONFLICT || error?.code === ErrorCode.STALE_DELIVERY || error?.code === ErrorCode.INVALID_OWNER_FEEDBACK ? 409 : 500;
        return json(res, status, { error: error.message, code: error.code });
      }
    }
    const session = url.pathname.match(/^\/api\/projects\/([^/]+)\/review-session$/);
    if (req.method === 'POST' && session) {
      if (!requireOwner(req, res, 'project.review')) return;
      const project = await store.get(session[1]);
      expireSessions(project);
      const started = await startReviewSession(project);
      await store.save(project);
      recordSecurityEvent(SecurityEventType.OWNER_REVIEW_SESSION_STARTED, { projectId: project.id, sessionId: started.id }, { store });
      return json(res, 201, started);
    }
    const stopSession = url.pathname.match(/^\/api\/review-sessions\/([^/]+)\/stop$/);
    if (req.method === 'POST' && stopSession) {
      if (!requireOwner(req, res, 'project.review')) return;
      const projects = await store.list();
      for (const project of projects) {
        const found = (project.reviewSessions || []).find(item => item.id === stopSession[1]);
        if (!found) continue;
        await stopReviewSession(project, stopSession[1]);
        await store.save(project);
        return json(res, 200, found);
      }
      return json(res, 404, { error: 'not found' });
    }
    const retry = url.pathname.match(/^\/api\/projects\/([^/]+)\/retry$/);
    if (req.method === 'POST' && retry) {
      if (!requireOwner(req, res, 'project.retry')) return;
      try {
        const p = await orchestrator.retry(retry[1]);
        return json(res, 202, { ok: true, id: p.id, resumeTarget: p.state });
      } catch (error) {
        const status = error?.code === ErrorCode.RETRY_NOT_ELIGIBLE ? 409 : 500;
        return json(res, status, { error: error.message, code: error.code });
      }
    }
    let target = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.resolve(publicDir, target);
    if (!full.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
    const data = await fs.readFile(full);
    res.writeHead(200, { 'content-type': mime[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    json(res, 500, { error: error.message });
  }
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close();
  if (worker) await worker.stop();
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const port = intEnv('PORT', 4317);
if (role !== 'worker') {
  server.listen(port, () => {
    const mode = demo ? 'DEMO (MOCK verification)' : 'live';
    console.log(`Autonomous Dev Platform (${mode}, ${runtime.engine}, ${role}) running at http://localhost:${port}`);
    if (demo && !process.env.OWNER_TOKEN_BOOTSTRAP) {
      console.log('Owner auth is token-first. Demo bootstrap token is the explicit value adp-demo-owner-token.');
    }
    if (resumed.length) console.log(`Reconciled ${resumed.length} in-flight project(s) into the durable queue.`);
  });
} else if (worker) {
  await worker.start();
  console.log(`Autonomous worker ${worker.workerId} (${runtime.engine}) polling jobs.`);
}

function projectView(project) {
  expireSessions(project);
  return {
    ...project,
    delivery: ownerDeliveryView(project) || project.delivery,
    ownerStage: ownerStage(project)
  };
}

function ownerStage(project) {
  if (project.state === ProjectState.READY_FOR_OWNER_REVIEW) return 'ready';
  if (project.state === ProjectState.DONE || project.state === ProjectState.OWNER_APPROVED) return 'done';
  if (project.state === ProjectState.FAILED) return 'failed';
  if (project.state === ProjectState.OWNER_CHANGES_REQUESTED) return 'changes';
  return 'active';
}

function sanitizeFileName(name) {
  return String(name || 'download').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

export { runtime, server, worker };
