import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { abortSignal, mapAbortToTimeout } from '../orchestrator/timeout.js';
import { evidenceFromCursorResult } from '../orchestrator/evidence.js';
import { intEnv } from '../util/env.js';

const terminal = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class CursorCloudClient {
  constructor({ apiKey, repoUrl, startingRef = 'main', pollMs = 3000, timeoutMs, requestTimeoutMs } = {}) {
    if (!apiKey) throw new Error('CURSOR_API_KEY is required for cloud mode.');
    this.apiKey = apiKey;
    this.repoUrl = repoUrl;
    this.startingRef = startingRef;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs ?? intEnv('CURSOR_CLOUD_RUN_TIMEOUT_MS', 1800000);
    this.requestTimeoutMs = requestTimeoutMs ?? intEnv('CURSOR_REQUEST_TIMEOUT_MS', 600000);
  }

  headers() { return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }; }

  async request(path, options = {}) {
    let response;
    try {
      response = await fetch(`https://api.cursor.com${path}`, {
        ...options,
        headers: { ...this.headers(), ...(options.headers || {}) },
        signal: abortSignal(this.requestTimeoutMs)
      });
    } catch (error) {
      mapAbortToTimeout(error, {
        code: ErrorCode.CURSOR_TIMEOUT,
        message: `Cursor Cloud HTTP request timed out after ${this.requestTimeoutMs}ms`,
        phase: 'CURSOR_EXECUTING',
        timeoutMs: this.requestTimeoutMs
      });
    }
    if (!response.ok) throw new Error(`Cursor Cloud ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async wait(agentId, runId) {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      if (Date.now() > deadline) {
        throw new PlatformError({
          code: ErrorCode.CURSOR_TIMEOUT,
          message: `Cursor Cloud polling timed out after ${this.timeoutMs}ms`,
          phase: 'CURSOR_EXECUTING',
          retryable: true,
          details: { agentId, runId, timeoutMs: this.timeoutMs }
        });
      }
      const run = await this.request(`/v1/agents/${agentId}/runs/${runId}`);
      if (terminal.has(run.status)) return run;
      const remaining = deadline - Date.now();
      await sleep(Math.min(this.pollMs, Math.max(0, remaining)));
    }
  }

  async run({ prompt, sessionId = null }) {
    try {
      let agentId = sessionId;
      let run;
      if (!agentId) {
        if (!this.repoUrl) throw new Error('CURSOR_REPO_URL is required for first Cursor Cloud run.');
        const created = await this.request('/v1/agents', { method: 'POST', body: JSON.stringify({ prompt: { text: prompt }, mode: 'agent', repos: [{ url: this.repoUrl, startingRef: this.startingRef }], autoCreatePR: true }) });
        agentId = created.agent.id;
        run = created.run;
      } else {
        const created = await this.request(`/v1/agents/${agentId}/runs`, { method: 'POST', body: JSON.stringify({ prompt: { text: prompt }, mode: 'agent' }) });
        run = created.run;
      }
      const done = await this.wait(agentId, run.id);
      if (done.status !== 'FINISHED') {
        throw new PlatformError({
          code: ErrorCode.CURSOR_EXECUTION_FAILED,
          message: `Cursor Cloud run ended as ${done.status}: ${done.result || 'no result'}`,
          phase: 'CURSOR_EXECUTING',
          retryable: true
        });
      }
      const payload = {
        sessionId: agentId,
        stopReason: done.status,
        output: done.result || '',
        updates: [],
        stderr: '',
        evidence: null
      };
      payload.evidence = evidenceFromCursorResult({
        ...payload,
        evidence: { git: done.git || null, durationMs: done.durationMs || null, runId: done.id }
      });
      return payload;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.CURSOR_EXECUTION_FAILED,
        message: error.message,
        phase: 'CURSOR_EXECUTING',
        retryable: true
      });
    }
  }
}
