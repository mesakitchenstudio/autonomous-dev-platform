import crypto from 'node:crypto';
import { SecurityRole, SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';
import { bootstrapOwnerToken, bootstrapWorkerToken, lookupToken } from './tokens.js';
import { clientKey, rateLimit } from './rate-limit.js';
import { ErrorCode } from '../orchestrator/errors.js';

const sessions = new Map();

export function allowedOrigins(env = process.env) {
  return String(env.ALLOWED_ORIGINS || 'http://127.0.0.1:4317,http://localhost:4317')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function applyCors(req, res, env = process.env) {
  const origin = req.headers.origin;
  const allowed = allowedOrigins(env);
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function extractBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header) return null;
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function authenticateRequest(req, { env = process.env, store } = {}) {
  bootstrapOwnerToken(env);
  bootstrapWorkerToken(env);
  const bearer = extractBearer(req);
  if (bearer) {
    const record = lookupToken(bearer);
    if (!record) {
      recordSecurityEvent(SecurityEventType.AUTH_FAILURE, { reason: 'invalid_token' }, { store });
      return { ok: false, code: ErrorCode.AUTH_FAILURE, status: 401 };
    }
    return { ok: true, role: record.role, via: 'bearer', tokenId: record.id };
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.adp_session && sessions.has(cookies.adp_session)) {
    const session = sessions.get(cookies.adp_session);
    if (session.expiresAt && Date.parse(session.expiresAt) < Date.now()) {
      sessions.delete(cookies.adp_session);
      recordSecurityEvent(SecurityEventType.AUTH_FAILURE, { reason: 'session_expired' }, { store });
      return { ok: false, code: ErrorCode.AUTH_FAILURE, status: 401 };
    }
    return { ok: true, role: session.role, via: 'cookie', csrf: session.csrf, sessionId: cookies.adp_session };
  }
  recordSecurityEvent(SecurityEventType.AUTH_FAILURE, { reason: 'missing_credentials' }, { store });
  return { ok: false, code: ErrorCode.AUTH_FAILURE, status: 401 };
}

export function authorize(auth, action) {
  const ownerActions = new Set([
    'project.create',
    'project.retry',
    'project.export',
    'project.read',
    'project.list',
    'artifact.read',
    'admin.status'
  ]);
  if (!auth?.ok) return false;
  if (auth.role === SecurityRole.SYSTEM) return true;
  if (auth.role === SecurityRole.OWNER) return ownerActions.has(action) || action.startsWith('project.');
  if (auth.role === SecurityRole.WORKER) return action === 'admin.status' || action.startsWith('job.');
  return false;
}

export function applyCsrf(req, auth, env = process.env) {
  if (!auth?.ok) return false;
  if (auth.via === 'bearer') return true;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin || '';
  const allowed = allowedOrigins(env);
  if (origin && !allowed.includes(origin)) return false;
  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfHeader || csrfHeader !== auth.csrf) return false;
  return true;
}

export function limitSensitive(req, action) {
  const limits = {
    auth: { max: 10, windowMs: 300_000 },
    'project.create': { max: 20, windowMs: 600_000 },
    'project.retry': { max: 20, windowMs: 600_000 },
    'project.export': { max: 30, windowMs: 600_000 }
  };
  const cfg = limits[action];
  if (!cfg) return { ok: true, remaining: Infinity };
  return rateLimit({ key: clientKey(req, action), windowMs: cfg.windowMs, max: cfg.max });
}

export function createCookieSession({ role = SecurityRole.OWNER, ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const id = cryptoRandom();
  const csrf = cryptoRandom();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  sessions.set(id, { role, csrf, expiresAt });
  return { id, csrf, expiresAt };
}

function cryptoRandom() {
  return crypto.randomBytes(24).toString('hex');
}

export function sessionCookieHeaders(session, { secure = false } = {}) {
  const parts = [
    `adp_session=${session.id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`,
    `adp_csrf=${session.csrf}; Path=/; SameSite=Lax; Max-Age=43200`
  ];
  if (secure) {
    parts[0] += '; Secure';
    parts[1] += '; Secure';
  }
  return parts;
}

export function resetSessionsForTests() {
  sessions.clear();
}
