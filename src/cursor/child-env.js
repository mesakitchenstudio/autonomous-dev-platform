const PLATFORM_SECRETS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'CHAIR_PROVIDER',
  'SECRET_MASTER_KEY',
  'VAULT_TOKEN',
  'VAULT_TOKEN_FILE',
  'OWNER_TOKEN_BOOTSTRAP',
  'WORKER_TOKEN',
  'SECRET_BROKER_TOKEN'
]);

const BASE_ALLOW = Object.freeze([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'CURSOR_AGENT_BIN',
  'CURSOR_MODE',
  'CURSOR_CHILD_ENV_ALLOW',
  'NODE_ENV'
]);

export const BLOCKED_CURSOR_ENV = PLATFORM_SECRETS;
export const PLATFORM_SECRET_ENV = PLATFORM_SECRETS;

export function projectEnvAllowlist(source = process.env) {
  return String(source.CURSOR_PROJECT_ENV_ALLOW || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function buildCursorChildEnv(source = process.env, extraAllow = []) {
  const extras = [
    ...String(source.CURSOR_CHILD_ENV_ALLOW || '').split(',').map(v => v.trim()).filter(Boolean),
    ...projectEnvAllowlist(source),
    ...extraAllow
  ];
  const allow = new Set([...BASE_ALLOW, ...extras]);
  const env = {};
  for (const key of allow) {
    if (PLATFORM_SECRETS.includes(key)) continue;
    if (source[key] != null) env[key] = source[key];
  }
  return env;
}

export function assertNoCouncilSecrets(env) {
  const leaked = PLATFORM_SECRETS.filter(key => Object.prototype.hasOwnProperty.call(env, key) && env[key]);
  if (leaked.length) throw new Error(`Cursor child environment leaked platform secrets: ${leaked.join(', ')}`);
  return true;
}

export function projectEnvNamesOnly(source = process.env) {
  return projectEnvAllowlist(source);
}
