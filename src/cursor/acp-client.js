import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { decidePermission, decidePlan, resolvePermissionPolicy, PermissionPolicy } from './permission-policy.js';
import { buildCursorChildEnv } from './child-env.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
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
  }

  async run({ cwd, prompt, sessionId = null }) {
    if (!cwd) throw new PlatformError({ code: ErrorCode.CURSOR_EXECUTION_FAILED, message: 'Cursor ACP requires a project path.', phase: 'CURSOR_EXECUTING', retryable: false });
    try {
      return await withTimeout(this.execute({ cwd, prompt, sessionId }), this.timeoutMs, {
        code: ErrorCode.CURSOR_TIMEOUT,
        message: `Cursor ACP timed out after ${this.timeoutMs}ms`,
        phase: 'CURSOR_EXECUTING'
      });
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

  async execute({ cwd, prompt, sessionId }) {
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
    child.stderr.on('data', d => stderr.push(String(d)));
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
        const decision = decidePermission(this.permissionPolicy, msg);
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
    const close = () => {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    };
    try {
      await send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'autonomous-dev-platform', version: '0.1.0' } });
      if (!this.apiKey && !this.authToken) { try { await send('authenticate', { methodId: 'cursor_login' }); } catch {} }
      const session = sessionId ? await send('session/load', { sessionId, cwd, mcpServers: [] }) : await send('session/new', { cwd, mcpServers: [] });
      const resolvedSessionId = sessionId || session.sessionId;
      const result = await send('session/prompt', { sessionId: resolvedSessionId, prompt: [{ type: 'text', text: prompt }] });
      const text = updates.flatMap(x => x?.params?.update?.content?.text ? [x.params.update.content.text] : []).join('');
      const payload = { sessionId: resolvedSessionId, stopReason: result?.stopReason, output: text, updates, stderr: stderr.join(''), permissionLog };
      payload.evidence = evidenceFromCursorResult(payload);
      return payload;
    } finally {
      close();
    }
  }
}

export { PermissionPolicy };
