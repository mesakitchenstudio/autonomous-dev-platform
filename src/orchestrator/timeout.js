import { ErrorCode, PlatformError, isTimeoutError } from './errors.js';

export async function withTimeout(operation, ms, { code = ErrorCode.UNEXPECTED_ERROR, message, phase = null, details = {} } = {}) {
  const timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PlatformError({
        code,
        message: message || `Operation timed out after ${timeoutMs}ms`,
        phase,
        retryable: true,
        details: { timeoutMs, ...details }
      }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function abortSignal(ms) {
  const timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

export function mapAbortToTimeout(error, { code, message, phase, timeoutMs }) {
  if (isTimeoutError(error) || error?.name === 'TimeoutError') {
    throw new PlatformError({
      code,
      message: message || `Operation timed out after ${timeoutMs}ms`,
      phase,
      retryable: true,
      details: { timeoutMs }
    });
  }
  throw error;
}
