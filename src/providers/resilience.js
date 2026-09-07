import { ErrorCode, PlatformError, isTimeoutError } from '../orchestrator/errors.js';
import { intEnv } from '../util/env.js';

export const ProviderStatus = Object.freeze({
  SUCCESS: 'SUCCESS',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  AUTH_FAILURE: 'AUTH_FAILURE',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  SKIPPED: 'SKIPPED'
});

export function classifyProviderError(error) {
  const status = error?.details?.httpStatus;
  const message = String(error?.message || '');
  if (error?.code === ErrorCode.PROVIDER_TIMEOUT || isTimeoutError(error)) {
    return { status: ProviderStatus.TIMEOUT, retryable: true, code: ErrorCode.PROVIDER_TIMEOUT };
  }
  if (error?.code === ErrorCode.AUTH_FAILURE || status === 401 || status === 403 || /invalid api key|unauthorized|forbidden/i.test(message)) {
    return { status: ProviderStatus.AUTH_FAILURE, retryable: false, code: ErrorCode.AUTH_FAILURE };
  }
  if (error?.code === ErrorCode.RATE_LIMITED || status === 429) {
    return { status: ProviderStatus.RATE_LIMITED, retryable: true, code: ErrorCode.RATE_LIMITED };
  }
  if (error?.code === ErrorCode.INVALID_RESPONSE) {
    return { status: ProviderStatus.INVALID_RESPONSE, retryable: false, code: ErrorCode.INVALID_RESPONSE };
  }
  if (status >= 500 || /econnreset|fetch failed|network|socket|temporarily unavailable|service unavailable/i.test(message)) {
    return { status: ProviderStatus.PROVIDER_ERROR, retryable: true, code: ErrorCode.PROVIDER_FAILURE };
  }
  return {
    status: ProviderStatus.PROVIDER_ERROR,
    retryable: error?.retryable !== false,
    code: error?.code || ErrorCode.PROVIDER_FAILURE
  };
}

export function throwHttpError(provider, status, body = '') {
  const classified = classifyProviderError({ details: { httpStatus: status }, message: `${provider} ${status}` });
  throw new PlatformError({
    code: classified.code,
    message: `${provider} ${status}${body ? `: ${String(body).slice(0, 180)}` : ''}`,
    phase: 'PROVIDER',
    retryable: classified.retryable,
    details: { httpStatus: status, provider }
  });
}

export function createRetryPolicy(overrides = {}) {
  return {
    maxRetries: overrides.maxRetries ?? intEnv('AI_MAX_RETRIES', 2),
    baseMs: overrides.baseMs ?? intEnv('AI_RETRY_BASE_MS', 400),
    maxMs: overrides.maxMs ?? intEnv('AI_RETRY_MAX_MS', 4000),
    sleep: overrides.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    random: overrides.random || Math.random
  };
}

export async function withRetry(operation, policy = createRetryPolicy()) {
  const { maxRetries, baseMs, maxMs, sleep, random } = createRetryPolicy(policy);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await operation(attempt + 1);
      return { result, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const classified = classifyProviderError(error);
      if (!classified.retryable || attempt === maxRetries) {
        error.attempts = attempt + 1;
        error.providerStatus = classified.status;
        throw error;
      }
      const delay = Math.min(maxMs, baseMs * (2 ** attempt)) + Math.floor(random() * 50);
      await sleep(delay);
    }
  }
  throw lastError;
}
