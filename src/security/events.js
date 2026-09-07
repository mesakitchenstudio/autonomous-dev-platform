import crypto from 'node:crypto';
import { SecurityEventType } from './kinds.js';
import { redactSecrets } from '../secrets/redact.js';

const memory = [];

export function sanitizeSecurityPayload(payload = {}) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (/secret|token|password|authorization|api[_-]?key|credential/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') out[key] = redactSecrets(value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = sanitizeSecurityPayload(value);
    else out[key] = value;
  }
  delete out.value;
  delete out.secret;
  delete out.token;
  return out;
}

export function recordSecurityEvent(type, payload = {}, { store, projectId } = {}) {
  if (!Object.values(SecurityEventType).includes(type)) {
    throw new Error(`Unknown security event type: ${type}`);
  }
  const event = {
    id: crypto.randomUUID(),
    type,
    projectId: projectId || payload.projectId || null,
    payload: sanitizeSecurityPayload(payload),
    at: new Date().toISOString()
  };
  memory.push(event);
  if (memory.length > 2000) memory.shift();
  if (store?.appendEvent && event.projectId) {
    store.appendEvent(event.projectId, `security.${type.toLowerCase()}`, event.payload).catch(() => {});
  }
  if (store?.adapter?.query) {
    store.adapter.query(
      `INSERT INTO security_events (id, project_id, type, payload, at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.projectId, event.type, JSON.stringify(event.payload), event.at]
    ).catch(() => {});
  }
  return event;
}

export function recentSecurityEvents({ projectId, type, limit = 50 } = {}) {
  return memory
    .filter(item => (!projectId || item.projectId === projectId) && (!type || item.type === type))
    .slice(-limit);
}

export function resetSecurityEventsForTests() {
  memory.length = 0;
}
