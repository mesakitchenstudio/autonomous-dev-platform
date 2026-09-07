export const PermissionPolicy = Object.freeze({
  DENY: 'deny',
  SAFE_DEVELOPMENT: 'safe-development',
  ALLOW_ALL: 'allow-all'
});

const DENY_KINDS = new Set(['execute', 'terminal', 'shell', 'network', 'mcp', 'command']);
const SAFE_KINDS = new Set(['read', 'edit', 'write', 'delete', 'glob', 'grep', 'search', 'list']);

export function resolvePermissionPolicy(name) {
  const value = String(name || PermissionPolicy.SAFE_DEVELOPMENT).toLowerCase().trim();
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

export function decidePermission(policy, request) {
  const ids = optionIds(request);
  const allowId = pickOption(ids, ['allow-once', 'allow', 'approve', 'allow-always']) || 'allow-once';
  const denyId = pickOption(ids, ['reject', 'deny', 'cancel', 'decline']) || 'reject';
  const kind = extractPermissionKind(request);
  const resolved = resolvePermissionPolicy(policy);

  let decision = 'deny';
  if (resolved === PermissionPolicy.ALLOW_ALL) decision = 'allow';
  else if (resolved === PermissionPolicy.DENY) decision = 'deny';
  else if (SAFE_KINDS.has(kind) && !DENY_KINDS.has(kind)) decision = 'allow';
  else decision = 'deny';

  return {
    policy: resolved,
    kind: kind || null,
    decision,
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
