import { assertInsideWorkspace } from '../git/boundary.js';
import { commandAllowed, extractCommand, extractRequestedPath, CommandCategory } from './command-policy.js';
import { isProtectedSecretFile } from '../git/secrets.js';

export const PermissionPolicy = Object.freeze({
  DENY: 'deny',
  SAFE_DEVELOPMENT: 'safe-development',
  ALLOW_ALL: 'allow-all'
});

const SAFE_KINDS = new Set(['read', 'edit', 'write', 'delete', 'glob', 'grep', 'search', 'list']);
const EXEC_KINDS = new Set(['execute', 'terminal', 'shell', 'command']);

export function resolvePermissionPolicy(name) {
  const value = String(name || process.env.CURSOR_PERMISSION_POLICY || process.env.ACP_PERMISSION_POLICY || PermissionPolicy.SAFE_DEVELOPMENT).toLowerCase().trim();
  if (value === 'allow-all' || value === 'allowall') return PermissionPolicy.ALLOW_ALL;
  if (value === 'deny') return PermissionPolicy.DENY;
  return PermissionPolicy.SAFE_DEVELOPMENT;
}

function optionIds(request) {
  const options = request?.params?.options || request?.options || [];
  return options.map(option => option?.optionId || option?.id).filter(Boolean);
}

function pickOption(ids, candidates) {
  return candidates.find(id => ids.includes(id)) || null;
}

export function extractPermissionKind(request) {
  const params = request?.params || request || {};
  const raw = params.toolCall?.kind
    || params.toolCall?.type
    || params.permission?.kind
    || params.kind
    || params.tool
    || '';
  return String(raw).toLowerCase();
}

export function decidePermission(policy, request, context = {}) {
  const ids = optionIds(request);
  const allowId = pickOption(ids, ['allow-once', 'allow', 'approve', 'allow-always']) || 'allow-once';
  const denyId = pickOption(ids, ['reject', 'deny', 'cancel', 'decline']) || 'reject';
  const kind = extractPermissionKind(request);
  const resolved = resolvePermissionPolicy(policy);
  const command = extractCommand(request);
  const requestedPath = extractRequestedPath(request);

  let decision = 'deny';
  let reason = 'default_deny';
  if (resolved === PermissionPolicy.ALLOW_ALL) {
    decision = 'allow';
    reason = 'allow_all';
  } else if (resolved === PermissionPolicy.DENY) {
    decision = 'deny';
    reason = 'policy_deny';
  } else if (requestedPath && context.workspaceRoot && !assertInsideWorkspace(requestedPath, context.workspaceRoot)) {
    decision = 'deny';
    reason = 'workspace_escape';
  } else if (requestedPath && context.ownerPath && context.workspaceRoot
    && assertInsideWorkspace(requestedPath, context.ownerPath)
    && !assertInsideWorkspace(requestedPath, context.workspaceRoot)) {
    decision = 'deny';
    reason = 'owner_worktree';
  } else if (requestedPath && isProtectedSecretFile(requestedPath) && /edit|write|delete/.test(kind)) {
    decision = 'deny';
    reason = 'secret_file';
  } else if (SAFE_KINDS.has(kind) && !EXEC_KINDS.has(kind)) {
    decision = 'allow';
    reason = 'safe_kind';
  } else if (EXEC_KINDS.has(kind) || command) {
    const verdict = commandAllowed(command, { branch: context.branch });
    if (verdict.allow && verdict.classified.category !== CommandCategory.UNKNOWN) {
      decision = 'allow';
      reason = verdict.route === 'sandbox' ? `sandbox:${verdict.classified.category}` : verdict.classified.category;
    } else {
      decision = 'deny';
      reason = verdict.classified.category || 'unknown_command';
    }
  } else {
    decision = 'deny';
    reason = 'unknown_permission';
  }

  return {
    policy: resolved,
    kind: kind || null,
    command: command || null,
    path: requestedPath,
    decision,
    reason,
    outcome: { outcome: 'selected', optionId: decision === 'allow' ? allowId : denyId }
  };
}

export function decidePlan(policy) {
  const resolved = resolvePermissionPolicy(policy);
  const accepted = resolved !== PermissionPolicy.DENY;
  return {
    policy: resolved,
    decision: accepted ? 'allow' : 'deny',
    outcome: { outcome: accepted ? 'accepted' : 'rejected' }
  };
}
