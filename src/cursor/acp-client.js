import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { decidePermission, decidePlan, resolvePermissionPolicy, PermissionPolicy } from './permission-policy.js';
import { buildCursorChildEnv } from './child-env.js';
import { createCursorContract, CursorMode, CursorRunStatus, CursorUncertainty } from './contract.js';
import { ErrorCode, PlatformError, redactSecrets } from '../orchestrator/errors.js';
import { withTimeout } from '../orchestrator/timeout.js';
import { intEnv } from '../util/env.js';
import { evidenceFromCursorResult } from '../orchestrator/evidence.js';

export class CursorAcpClient {
  constructor({ bin = 'agent', apiKey, authToken, permissionPolicy, timeoutMs } = {}) {
    this.bin = bin;
    this.apiKey = apiKey;
    this.authToken = authToken;
    this.permissionPolicy = resolvePermissionPolicy(permissionPolicy);
    this.timeoutMs = timeoutMs ?? intEnv('CURSOR_REQUEST_TIMEOUT_MS', 600000);
    this.active = null;
  }

  async run(input = {}) {
    const cwd = input.cwd || input.workspace?.workspacePath;
    if (!cwd) {
      throw new PlatformError({
        code: ErrorCode.CURSOR_EXECUTION_FAILED,
        message: 'Cursor ACP requires an isolated workspace path.',
        phase: 'CURSOR_EXECUTING',
        retryable: false
      });
    }
    try {
      return await withTimeout(this.execute(input, cwd), this.timeoutMs, {
        code: ErrorCode.CURSOR_TIMEOUT,
        message: `Cursor ACP timed out after ${this.timeoutMs}ms`,
        phase: 'CURSOR_EXECUTING'
      });
    } catch (error) {
      await this.cancel(error?.code === ErrorCode.CURSOR_TIMEOUT ? 'timeout' : 'error').catch(() => {});
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.CURSOR_EXECUTION_FAILED,
        message: error.message,
        phase: 'CURSOR_EXECUTING',
        retryable: true,
        details: { uncertainty: this.active?.uncertainty || CursorUncertainty.PROCESS_FAILED_BEFORE_EXECUTION }
      });
    }
  }

  async cancel(reason = 'cancelled') {
    const active = this.active;
    if (!active) return { attempted: false, reason };
    active.cancelled = true;
    if (active.sessionId && active.send) {
      try { await active.send('session/cancel', { sessionId: active.sessionId }); } catch {}
    }
    try { active.child?.stdin?.end(); } catch {}
    try { active.child?.kill(); } catch {}
    return { attempted: true, reason };
  }

  async execute(input, cwd) {
    const args = [];
    if (this.apiKey) args.push('--api-key', this.apiKey);
    if (this.authToken) args.push('--auth-token', this.authToken);
    args.push('acp');
    const child = spawn(this.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: buildCursorChildEnv(process.env) });
    const rl = readline.createInterface({ input: child.stdout });
    let id = 1;
    const pending = new Map();
    const updates = [];
    const stderr = [];
    const permissionLog = [];
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = id++;
      pending.set(requestId, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    const respond = (requestId, result) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }) + '\n');
    const context = {
      workspaceRoot: cwd,
      ownerPath: input.workspace?.repository || input.ownerPath || null,
      branch: input.workspace?.workingBranch || null
    };
    child.stderr.on('data', d => stderr.push(redactSecrets(String(d))));
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { updates.push({ type: 'raw', line }); return; }
      if (msg.id != null && (msg.result !== undefined || msg.error)) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'session/request_permission') {
        const decision = decidePermission(this.permissionPolicy, msg, context);
        permissionLog.push({ at: new Date().toISOString(), method: msg.method, ...decision });
        respond(msg.id, { outcome: decision.outcome });
        return;
      }
      if (msg.method === 'cursor/create_plan') {
        const decision = decidePlan(this.permissionPolicy);
        permissionLog.push({ at: new Date().toISOString(), method: msg.method, ...decision });
        respond(msg.id, { outcome: decision.outcome });
        return;
      }
      updates.push(msg);
    });

    const startedAt = new Date().toISOString();
    this.active = {
      child,
      send,
      sessionId: input.sessionId || null,
      cancelled: false,
      uncertainty: CursorUncertainty.PROCESS_FAILED_BEFORE_EXECUTION
    };
    const ownership = setInterval(async () => {
      if (typeof input.shouldContinue !== 'function') return;
      const owned = await input.shouldContinue().catch(() => false);
      if (!owned) {
        await this.cancel('lease_lost');
      }
    }, 1000);
    if (ownership.unref) ownership.unref();

    const close = () => {
      clearInterval(ownership);
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      this.active = null;
    };

    try {
      await send('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'autonomous-dev-platform', version: '0.1.0' }
      });
      if (!this.apiKey && !this.authToken) {
        try { await send('authenticate', { methodId: 'cursor_login' }); } catch {}
      }
      let sessionId = input.sessionId || null;
      let restarted = false;
      if (sessionId) {
        try {
          await send('session/load', { sessionId, cwd, mcpServers: [] });
        } catch {
          restarted = true;
          sessionId = null;
        }
      }
      if (!sessionId) {
        const session = await send('session/new', { cwd, mcpServers: [] });
        sessionId = session.sessionId;
      }
      this.active.sessionId = sessionId;
      this.active.uncertainty = CursorUncertainty.EXECUTION_MAY_HAVE_STARTED;
      if (typeof input.onSession === 'function') await input.onSession(sessionId, { restarted });
      const result = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] });
      this.active.uncertainty = CursorUncertainty.EXECUTION_COMPLETED;
      const text = updates.flatMap(x => x?.params?.update?.content?.text ? [x.params.update.content.text] : []).join('');
      const contract = createCursorContract({
        projectId: input.projectId,
        cursorRunId: input.cursorRunId,
        iteration: input.iteration,
        executionMode: CursorMode.ACP,
        workspace: { ...input.workspace, workspacePath: cwd },
        task: { prompt: input.prompt, acceptanceCriteria: input.acceptanceCriteria || [] },
        session: { sessionId, restarted },
        result: {
          status: this.active.cancelled ? CursorRunStatus.CANCELLED : CursorRunStatus.COMPLETED,
          stopReason: result?.stopReason,
          summary: text.slice(0, 1500)
        },
        output: text,
        stderr: stderr.join(''),
        updates,
        permissionLog,
        uncertainty: restarted ? CursorUncertainty.SESSION_RESTARTED : CursorUncertainty.EXECUTION_COMPLETED,
        timestamps: { startedAt, completedAt: new Date().toISOString() }
      });
      contract.sessionId = sessionId;
      contract.stopReason = result?.stopReason;
      contract.evidence = evidenceFromCursorResult(contract, { demo: false });
      if (this.active.cancelled) {
        throw new PlatformError({
          code: ErrorCode.JOB_LEASE_LOST,
          message: 'Cursor ACP was cancelled because the worker no longer owned the job.',
          phase: 'CURSOR_EXECUTING',
          retryable: true
        });
      }
      return contract;
    } finally {
      close();
    }
  }
}

export { PermissionPolicy };
