import crypto from 'node:crypto';
import { SecurityRole } from '../security/kinds.js';

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function tokensEqual(provided, expectedHash) {
  if (!provided || !expectedHash) return false;
  const actual = Buffer.from(hashToken(provided), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

const tokenStore = [];

export function rememberHashedToken({ hash, role = SecurityRole.OWNER, label = 'bootstrap', expiresAt = null } = {}) {
  const record = {
    id: crypto.randomUUID(),
    hash,
    role,
    label,
    createdAt: new Date().toISOString(),
    expiresAt,
    revoked: false
  };
  tokenStore.push(record);
  return record;
}

export function lookupToken(raw) {
  if (!raw) return null;
  const now = Date.now();
  for (const record of tokenStore) {
    if (record.revoked) continue;
    if (record.expiresAt && Date.parse(record.expiresAt) < now) continue;
    if (tokensEqual(raw, record.hash)) return record;
  }
  return null;
}

export function bootstrapOwnerToken(env = process.env) {
  const existing = tokenStore.find(item => item.label === 'bootstrap' && !item.revoked);
  if (existing) return existing;
  let raw = env.OWNER_TOKEN_BOOTSTRAP;
  if (!raw && env.DEMO_MODE === 'true') raw = 'adp-demo-owner-token';
  if (!raw) return null;
  return rememberHashedToken({
    hash: hashToken(raw),
    role: SecurityRole.OWNER,
    label: env.DEMO_MODE === 'true' && raw === 'adp-demo-owner-token' ? 'demo-bootstrap' : 'bootstrap'
  });
}

export function bootstrapWorkerToken(env = process.env) {
  if (!env.WORKER_TOKEN) return null;
  const existing = tokenStore.find(item => item.label === 'worker' && !item.revoked);
  if (existing) return existing;
  return rememberHashedToken({
    hash: hashToken(env.WORKER_TOKEN),
    role: SecurityRole.WORKER,
    label: 'worker'
  });
}

export function resetAuthTokensForTests() {
  tokenStore.length = 0;
}

export function listTokenMetadata() {
  return tokenStore.map(item => ({
    id: item.id,
    role: item.role,
    label: item.label,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    revoked: item.revoked
  }));
}

export { tokenStore };
