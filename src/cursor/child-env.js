const BLOCKED = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY'
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
  'CURSOR_CHILD_ENV_ALLOW'
]);

export const BLOCKED_CURSOR_ENV = BLOCKED;

export function buildCursorChildEnv(source = process.env, extraAllow = []) {
  const extras = [
    ...String(source.CURSOR_CHILD_ENV_ALLOW || '').split(',').map(v => v.trim()).filter(Boolean),
    ...extraAllow
  ];
  const allow = new Set([...BASE_ALLOW, ...extras]);
  const env = {};
  for (const key of allow) {
    if (BLOCKED.includes(key)) continue;
    if (source[key] != null) env[key] = source[key];
  }
  return env;
}

export function assertNoCouncilSecrets(env) {
  const leaked = BLOCKED.filter(key => Object.prototype.hasOwnProperty.call(env, key) && env[key]);
  if (leaked.length) throw new Error(`Cursor child environment leaked council secrets: ${leaked.join(', ')}`);
  return true;
}
