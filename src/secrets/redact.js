const PATTERNS = [
  /(sk-|gsk_|xai-|AIza)[a-zA-Z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  /(postgres|postgresql|mysql|mongodb|redis|https?):\/\/[^:\s]+:[^@\s]+@\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g
];

const SENSITIVE_ENV_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'CURSOR_API_KEY',
  'CURSOR_CLOUD_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'SECRET_MASTER_KEY',
  'VAULT_TOKEN',
  'OWNER_TOKEN_BOOTSTRAP',
  'WORKER_TOKEN',
  'SECRET_BROKER_TOKEN'
];

const knownValues = new Set();

export function registerSecretValue(value) {
  if (typeof value === 'string' && value.length >= 4) knownValues.add(value);
}

export function unregisterSecretValue(value) {
  knownValues.delete(value);
}

export function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const secret of knownValues) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  for (const name of SENSITIVE_ENV_NAMES) {
    const re = new RegExp(`(${name}\\s*[=:]\\s*)([^\\s,;]+)`, 'gi');
    out = out.replace(re, '$1[redacted]');
  }
  return out;
}

export function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|password|authorization|api[_-]?key|credential|connectionString/i.test(key)) {
        out[key] = typeof item === 'string' && /Ref$|reference|lease|class|name/i.test(key) ? item : '[redacted]';
        if (/Ref$|reference|leaseId|class|name|status/i.test(key)) out[key] = typeof item === 'string' ? item : item;
        else out[key] = '[redacted]';
      } else {
        out[key] = redactDeep(item);
      }
    }
    return out;
  }
  return value;
}

export { SENSITIVE_ENV_NAMES };
