import { buildCursorChildEnv, PLATFORM_SECRET_ENV } from '../cursor/child-env.js';

const EXTRA_BLOCK = Object.freeze([
  'CURSOR_API_KEY',
  'CURSOR_CLOUD_API_KEY',
  'CURSOR_AUTH_TOKEN'
]);

export function buildVerificationEnv(source = process.env, extraAllow = []) {
  const env = buildCursorChildEnv(source, extraAllow);
  for (const key of EXTRA_BLOCK) delete env[key];
  env.CI = 'true';
  env.FORCE_COLOR = '0';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  return env;
}

export function assertNoPlatformSecrets(env) {
  const leaked = [...PLATFORM_SECRET_ENV, ...EXTRA_BLOCK]
    .filter(key => Object.prototype.hasOwnProperty.call(env, key) && env[key]);
  if (leaked.length) throw new Error(`Verification environment leaked platform secrets: ${leaked.join(', ')}`);
  return true;
}
