import { ErrorCode } from '../orchestrator/errors.js';

const TERMINAL = new Set([
  ErrorCode.AUTH_FAILURE,
  ErrorCode.RETRY_NOT_ELIGIBLE,
  ErrorCode.INVALID_STATE_TRANSITION,
  ErrorCode.MAX_ITERATIONS_REACHED,
  ErrorCode.SANDBOX_VIOLATION,
  ErrorCode.SECRET_ACCESS_DENIED,
  ErrorCode.AUTHZ_DENIED,
  ErrorCode.SECRET_DETECTED_IN_SOURCE,
  'JOB_DEAD_LETTERED',
  'INVALID_PROJECT_PATH'
]);

const DELAYED = new Set([
  ErrorCode.PROVIDER_TIMEOUT,
  ErrorCode.RATE_LIMITED,
  ErrorCode.PROVIDER_FAILURE,
  ErrorCode.CURSOR_TIMEOUT,
  ErrorCode.VERIFICATION_PREFLIGHT_FAILED,
  ErrorCode.PROVISIONING_INFRASTRUCTURE_UNAVAILABLE,
  ErrorCode.IOS_PROVISIONING_UNAVAILABLE,
  ErrorCode.SANDBOX_INFRASTRUCTURE_UNAVAILABLE,
  ErrorCode.ALL_PROVIDERS_FAILED,
  ErrorCode.INSUFFICIENT_COUNCIL,
  'DATABASE_UNAVAILABLE'
]);

export function classifyJobError(error) {
  const code = error?.code || ErrorCode.UNEXPECTED_ERROR;
  if (TERMINAL.has(code) || error?.retryable === false && !DELAYED.has(code)) {
    return { retryable: false, delay: false, code };
  }
  if (error?.retryable === false && TERMINAL.has(code)) {
    return { retryable: false, delay: false, code };
  }
  return { retryable: true, delay: DELAYED.has(code) || error?.retryable !== false, code };
}

export function retryDelayMs(attempts, baseMs, maxMs) {
  const exp = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempts - 1)));
  return exp;
}
