import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { abortSignal, mapAbortToTimeout } from '../orchestrator/timeout.js';
import { intEnv } from '../util/env.js';

export class ModelProvider {
  constructor({ name, model, timeoutMs }) {
    this.name = name;
    this.model = model;
    this.timeoutMs = timeoutMs ?? intEnv('AI_REQUEST_TIMEOUT_MS', 120000);
  }
  async complete(_request) { throw new Error('Not implemented'); }
}

export async function providerFetch(url, options, timeoutMs) {
  try {
    const response = await fetch(url, { ...options, signal: abortSignal(timeoutMs) });
    return response;
  } catch (error) {
    mapAbortToTimeout(error, {
      code: ErrorCode.PROVIDER_TIMEOUT,
      message: `Provider request timed out after ${timeoutMs}ms`,
      phase: 'PROVIDER',
      timeoutMs
    });
    throw new PlatformError({
      code: ErrorCode.PROVIDER_FAILURE,
      message: error.message,
      phase: 'PROVIDER',
      retryable: true
    });
  }
}

export function extractJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error(`Model did not return valid JSON: ${cleaned.slice(0, 300)}`);
}
