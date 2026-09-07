import crypto from 'node:crypto';
import { SandboxMode } from '../security/kinds.js';

const sessions = new Map();

export function createSandboxSessionRecord({
  projectId,
  iteration,
  backend,
  mode,
  imageDigest,
  policy,
  networkPolicy,
  resourceLimits
} = {}) {
  const record = {
    sandboxRunId: crypto.randomUUID(),
    projectId,
    iteration: Number(iteration || 0),
    backend,
    mode,
    imageDigest: imageDigest || null,
    policy: {
      profile: policy?.profile,
      mode: policy?.mode,
      unsafe: policy?.unsafe === true,
      hardened: policy?.hardened === true
    },
    networkPolicy: networkPolicy || policy?.networkMode || null,
    resourceLimits: resourceLimits || policy?.limits || null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'STARTED'
  };
  sessions.set(record.sandboxRunId, { record, sandbox: null });
  return record;
}

export function bindSandboxSession(sandboxRunId, sandbox) {
  const current = sessions.get(sandboxRunId);
  if (current) current.sandbox = sandbox;
  return current;
}

export function getSandboxSession(sandboxRunId) {
  return sessions.get(sandboxRunId) || null;
}

export function completeSandboxSession(sandboxRunId, status = 'COMPLETED') {
  const current = sessions.get(sandboxRunId);
  if (!current) return null;
  current.record.completedAt = new Date().toISOString();
  current.record.status = status;
  return current.record;
}

export function sessionsForProject(projectId) {
  return [...sessions.values()].filter(item => item.record.projectId === projectId).map(item => item.record);
}

export function assertSessionProjectBound(session, projectId) {
  if (!session || session.record.projectId !== projectId) return false;
  return true;
}

export function sandboxProvenance(sessionOrResult) {
  const mode = sessionOrResult?.mode || sessionOrResult?.sandboxMode || SandboxMode.MOCK;
  return {
    sandboxMode: mode,
    sandboxBackend: sessionOrResult?.backend || sessionOrResult?.sandboxBackend || null,
    isolationCapabilities: sessionOrResult?.isolationCapabilities || null,
    hardened: mode === SandboxMode.CONTAINER_HARDENED,
    unsafe: mode === SandboxMode.LOCAL_DEVELOPMENT_UNSAFE
  };
}
