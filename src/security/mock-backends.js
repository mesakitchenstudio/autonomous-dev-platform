import { boolEnvFrom } from '../util/env.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export const MOCK_BACKEND_NOT_ALLOWED = 'MOCK_BACKEND_NOT_ALLOWED';

export function isRecognizedTestEnvironment(env = process.env) {
  if (env?.NODE_TEST_CONTEXT) return true;
  if (String(env?.NODE_ENV || '').toLowerCase() === 'test') return true;
  if (boolEnvFrom(env, 'ADP_TEST', false)) return true;
  return false;
}

export function isDemoOrTestContext(env = process.env, { demo, project } = {}) {
  if (demo || project?.demo) return true;
  if (boolEnvFrom(env, 'DEMO_MODE', false)) return true;
  return isRecognizedTestEnvironment(env);
}

export function assertMockBackendAllowed(kind, env = process.env, extras = {}) {
  if (isDemoOrTestContext(env, extras)) return true;
  throw new PlatformError({
    code: ErrorCode.MOCK_BACKEND_NOT_ALLOWED,
    message: `${kind} is permitted only in DEMO_MODE or a recognized automated test. Refusing to start a live runtime with mock backends.`,
    phase: 'CONFIGURATION',
    retryable: false,
    details: { kind, demoMode: boolEnvFrom(env, 'DEMO_MODE', false) }
  });
}
