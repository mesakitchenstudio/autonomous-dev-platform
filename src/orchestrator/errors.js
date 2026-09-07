const SECRET_NAME = /api[_-]?key|token|secret|password|authorization|auth/i;
const SECRET_VALUE = /(sk-|gsk_|xai-|AIza)[a-zA-Z0-9_-]{8,}/g;

export const ErrorCode = Object.freeze({
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  ALL_PROVIDERS_FAILED: 'ALL_PROVIDERS_FAILED',
  CHAIR_FAILURE: 'CHAIR_FAILURE',
  CURSOR_TIMEOUT: 'CURSOR_TIMEOUT',
  CURSOR_EXECUTION_FAILED: 'CURSOR_EXECUTION_FAILED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  MAX_ITERATIONS_REACHED: 'MAX_ITERATIONS_REACHED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  COMPLETION_GATE_REJECTED: 'COMPLETION_GATE_REJECTED',
  RETRY_NOT_ELIGIBLE: 'RETRY_NOT_ELIGIBLE',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR'
});

export function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_VALUE, '[redacted]');
}

export function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_NAME.test(key)) out[key] = '[redacted]';
    else if (typeof value === 'string') out[key] = redactSecrets(value);
    else out[key] = value;
  }
  return out;
}

export class PlatformError extends Error {
  constructor({ code, message, phase = null, retryable = true, details = {} }) {
    super(redactSecrets(message || code));
    this.name = 'PlatformError';
    this.code = code || ErrorCode.UNEXPECTED_ERROR;
    this.phase = phase;
    this.retryable = retryable !== false;
    this.details = sanitizeDetails(details);
    this.at = new Date().toISOString();
  }

  toRecord() {
    return {
      code: this.code,
      message: this.message,
      phase: this.phase,
      retryable: this.retryable,
      at: this.at,
      details: this.details
    };
  }
}

export function toErrorRecord(error, phase = null) {
  if (error instanceof PlatformError) {
    const record = error.toRecord();
    if (phase && !record.phase) record.phase = phase;
    return record;
  }
  const code = typeof error?.code === 'string' && Object.values(ErrorCode).includes(error.code)
    ? error.code
    : ErrorCode.UNEXPECTED_ERROR;
  return {
    code,
    message: redactSecrets(error?.message || String(error)),
    phase: phase || error?.phase || null,
    retryable: error?.retryable !== false,
    at: new Date().toISOString(),
    details: sanitizeDetails(error?.details || {})
  };
}

export function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === ErrorCode.PROVIDER_TIMEOUT || error?.code === ErrorCode.CURSOR_TIMEOUT;
}
