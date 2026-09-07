import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { abortSignal, mapAbortToTimeout } from '../orchestrator/timeout.js';
import { evidenceFromCursorResult } from '../orchestrator/evidence.js';
import { createCursorContract, CursorMode, CursorRunStatus, CursorUncertainty } from './contract.js';
import { intEnv } from '../util/env.js';
import { isProtectedBranch } from '../git/policy.js';

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
    this.active = null;
    this.cancellationSupported = null;
    this.apiVersion = 'v1';
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
        await this.cancel('timeout').catch(() => {});
        throw new PlatformError({
          code: ErrorCode.CURSOR_TIMEOUT,
          message: `Cursor Cloud polling timed out after ${this.timeoutMs}ms`,
          phase: 'CURSOR_EXECUTING',
          retryable: true,
          details: { agentId, runId, timeoutMs: this.timeoutMs }
        });
      }
      if (typeof this.active?.shouldContinue === 'function') {
        const owned = await this.active.shouldContinue().catch(() => false);
        if (!owned) {
          await this.cancel('lease_lost');
          throw new PlatformError({
            code: ErrorCode.JOB_LEASE_LOST,
            message: 'Cursor Cloud run cancelled after lease loss.',
            phase: 'CURSOR_EXECUTING',
            retryable: true
          });
        }
      }
      const run = await this.request(`/v1/agents/${agentId}/runs/${runId}`);
      if (terminal.has(run.status)) return run;
      const remaining = deadline - Date.now();
      await sleep(Math.min(this.pollMs, Math.max(0, remaining)));
    }
  }

  async cancel(reason = 'cancelled') {
    const active = this.active;
    if (!active?.agentId) return { attempted: false, supported: this.cancellationSupported, reason };
    const paths = [
      `/v1/agents/${active.agentId}/cancel`,
      active.runId ? `/v1/agents/${active.agentId}/runs/${active.runId}/cancel` : null
    ].filter(Boolean);
    for (const path of paths) {
      try {
        await this.request(path, { method: 'POST', body: JSON.stringify({ reason }) });
        this.cancellationSupported = true;
        return { attempted: true, supported: true, reason, path };
      } catch (error) {
        if (!/404|405|not found/i.test(error.message || '')) {
          this.cancellationSupported = false;
        }
      }
    }
    this.cancellationSupported = false;
    return {
      attempted: true,
      supported: false,
      reason,
      limitation: 'Cursor Cloud cancellation endpoint was not available; timeout/lease loss was recorded without confirmed remote cancel.'
    };
  }

  async run(input = {}) {
    const startedAt = new Date().toISOString();
    try {
      const repoUrl = input.workspace?.cloudRepositoryUrl || input.repoUrl || input.workspace?.remoteUrl || this.repoUrl;
      const startingRef = input.workspace?.baseRef || input.startingRef || this.startingRef;
      let agentId = input.sessionId || input.agentId || input.session?.agentId || null;
      let run = null;
      this.active = { agentId, runId: input.runId || input.session?.runId || null, shouldContinue: input.shouldContinue };

      if (input.resumePoll && this.active.agentId && this.active.runId) {
        run = await this.wait(this.active.agentId, this.active.runId);
        agentId = this.active.agentId;
      } else if (!agentId) {
        if (!repoUrl) {
          throw new Error('Per-project Cloud repository URL is required for the first Cursor Cloud run.');
        }
        const created = await this.request('/v1/agents', {
          method: 'POST',
          body: JSON.stringify({
            prompt: { text: input.prompt },
            mode: 'agent',
            repos: [{ url: repoUrl, startingRef }],
            autoCreatePR: false,
            workOnCurrentBranch: false
          })
        });
        agentId = created.agent.id;
        run = created.run;
        this.active.agentId = agentId;
        this.active.runId = run.id;
        if (typeof input.onSession === 'function') await input.onSession(agentId, { runId: run.id, agentId });
      } else {
        const created = await this.request(`/v1/agents/${agentId}/runs`, {
          method: 'POST',
          body: JSON.stringify({ prompt: { text: input.prompt }, mode: 'agent' })
        });
        run = created.run;
        this.active.runId = run.id;
        if (typeof input.onSession === 'function') await input.onSession(agentId, { runId: run.id, agentId });
      }

      const done = run && terminal.has(run.status) ? run : await this.wait(agentId, run.id);
      if (done.status !== 'FINISHED') {
        throw new PlatformError({
          code: ErrorCode.CURSOR_EXECUTION_FAILED,
          message: `Cursor Cloud run ended as ${done.status}: ${done.result || 'no result'}`,
          phase: 'CURSOR_EXECUTING',
          retryable: true
        });
      }
      const resultingBranch = done.branch || done.target?.branch || done.git?.branch || null;
      const resultingSha = done.commitSha || done.git?.sha || done.target?.sha || null;
      if (resultingBranch && isProtectedBranch(resultingBranch)) {
        throw new PlatformError({
          code: ErrorCode.GIT_POLICY_VIOLATION,
          message: `Cloud result reported protected branch ${resultingBranch}`,
          phase: 'CURSOR_EXECUTING',
          retryable: false
        });
      }
      const contract = createCursorContract({
        projectId: input.projectId,
        cursorRunId: input.cursorRunId,
        iteration: input.iteration,
        executionMode: CursorMode.CLOUD,
        workspace: {
          repository: repoUrl,
          workspacePath: input.workspace?.workspacePath || null,
          baseRef: startingRef,
          baselineSha: input.workspace?.baselineSha || null,
          workingBranch: resultingBranch || input.workspace?.workingBranch || null
        },
        task: { prompt: input.prompt, acceptanceCriteria: input.acceptanceCriteria || [] },
        session: { sessionId: agentId, agentId, runId: done.id },
        result: { status: CursorRunStatus.COMPLETED, stopReason: done.status, summary: String(done.result || '').slice(0, 1500) },
        git: {
          beforeSha: input.workspace?.baselineSha || null,
          afterSha: resultingSha,
          branch: resultingBranch,
          changedFiles: done.git?.changedFiles || [],
          diffStat: done.git?.diffStat || {},
          dirty: false
        },
        output: done.result || '',
        uncertainty: CursorUncertainty.EXECUTION_COMPLETED,
        timestamps: { startedAt, completedAt: new Date().toISOString() }
      });
      contract.sessionId = agentId;
      contract.stopReason = done.status;
      contract.apiVersion = this.apiVersion;
      contract.evidence = evidenceFromCursorResult({
        ...contract,
        evidence: { git: done.git || null, durationMs: done.durationMs || null, runId: done.id }
      });
      return contract;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.CURSOR_EXECUTION_FAILED,
        message: error.message,
        phase: 'CURSOR_EXECUTING',
        retryable: true
      });
    } finally {
      this.active = null;
    }
  }
}
