import { redactDeep, redactSecrets } from '../secrets/redact.js';

const DROP_KEYS = new Set([
  'value', 'secret', 'password', 'apiKey', 'token', 'authorization',
  'DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
  'XAI_API_KEY', 'CURSOR_API_KEY', 'SECRET_MASTER_KEY', 'VAULT_TOKEN',
  'OWNER_TOKEN_BOOTSTRAP', 'WORKER_TOKEN'
]);

export function sanitizeExport(dump) {
  return walk(dump);
}

function walk(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROP_KEYS.has(key) || /(_SECRET|_TOKEN|_PASSWORD|apiKey|secretValue)$/i.test(key)) {
        if (/Ref$|reference|leaseId|class|name|status/i.test(key)) out[key] = item;
        else out[key] = '[redacted]';
        continue;
      }
      out[key] = walk(item);
    }
    return redactDeep(out);
  }
  return value;
}
