import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export const GitAction = Object.freeze({
  SAFE: 'GIT_SAFE',
  MUTATING: 'GIT_MUTATING',
  DESTRUCTIVE: 'DESTRUCTIVE',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN'
});

const DEFAULT_PROTECTED = ['main', 'master', 'production', 'release/*'];

export function protectedBranchPatterns() {
  const raw = process.env.PROTECTED_BRANCH_PATTERNS;
  if (!raw) return DEFAULT_PROTECTED;
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

export function autonomousBranchPrefix() {
  return process.env.AUTONOMOUS_BRANCH_PREFIX || 'adp';
}

export function autonomousBranchName(projectId) {
  const id = String(projectId || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return `${autonomousBranchPrefix()}/${id}`;
}

export function isProtectedBranch(name, patterns = protectedBranchPatterns()) {
  const branch = String(name || '').replace(/^refs\/heads\//, '').trim();
  if (!branch) return false;
  return patterns.some(pattern => matchBranch(branch, pattern));
}

function matchBranch(branch, pattern) {
  if (pattern.endsWith('/*')) return branch === pattern.slice(0, -2) || branch.startsWith(pattern.slice(0, -1));
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return regex.test(branch);
  }
  return branch === pattern;
}

export function tokenizeCommand(command) {
  return String(command || '').trim().split(/\s+/).filter(Boolean);
}

export function classifyGitCommand(commandOrArgs) {
  const tokens = Array.isArray(commandOrArgs) ? commandOrArgs : tokenizeCommand(commandOrArgs);
  const args = tokens[0] === 'git' ? tokens.slice(1) : tokens;
  const verb = args.find(token => !token.startsWith('-')) || '';
  const flags = args.filter(token => token.startsWith('-'));
  const joined = args.join(' ');

  if (['status', 'diff', 'log', 'show', 'rev-parse', 'describe', 'ls-files', 'blame'].includes(verb)) {
    return { action: GitAction.SAFE, verb };
  }
  if (verb === 'branch' && (flags.includes('--show-current') || args.includes('--show-current'))) {
    return { action: GitAction.SAFE, verb };
  }
  if (['add', 'commit'].includes(verb)) {
    if (flags.includes('--amend') || joined.includes('reset')) return { action: GitAction.DESTRUCTIVE, verb };
    return { action: GitAction.MUTATING, verb };
  }
  if (['push', 'fetch', 'clone', 'pull'].includes(verb)) {
    if (flags.some(flag => flag === '--force' || flag === '-f' || flag.startsWith('--force'))) {
      return { action: GitAction.DESTRUCTIVE, verb, reason: 'force_push' };
    }
    return { action: GitAction.NETWORK, verb };
  }
  if (verb === 'reset' && (flags.includes('--hard') || flags.includes('--merge') || joined.includes('--hard'))) {
    return { action: GitAction.DESTRUCTIVE, verb, reason: 'reset_hard' };
  }
  if (verb === 'clean' && (joined.includes('-fd') || joined.includes('-f') && joined.includes('-d') || joined.includes('-x'))) {
    return { action: GitAction.DESTRUCTIVE, verb, reason: 'clean' };
  }
  if (['checkout', 'switch', 'rebase', 'merge'].includes(verb)) {
    const target = args.filter(token => !token.startsWith('-')).slice(1)[0];
    if (target && isProtectedBranch(target)) {
      return { action: GitAction.DESTRUCTIVE, verb, reason: 'protected_branch', target };
    }
    return { action: GitAction.MUTATING, verb, target };
  }
  if (verb === 'branch' && (flags.includes('-D') || flags.includes('-d') || flags.includes('--delete'))) {
    return { action: GitAction.DESTRUCTIVE, verb, reason: 'delete_branch' };
  }
  if (verb === 'worktree' && /remove|prune/.test(joined)) {
    return { action: GitAction.DESTRUCTIVE, verb, reason: 'worktree_remove' };
  }
  if (!verb) return { action: GitAction.UNKNOWN, verb: null };
  return { action: GitAction.UNKNOWN, verb };
}

export function assertAutonomousGit(commandOrArgs, { branch, workspaceRoot } = {}) {
  const classified = classifyGitCommand(commandOrArgs);
  if (classified.action === GitAction.DESTRUCTIVE) {
    throw new PlatformError({
      code: ErrorCode.GIT_POLICY_VIOLATION,
      message: `Git operation rejected: ${classified.reason || classified.verb}`,
      phase: 'CURSOR_EXECUTING',
      retryable: false,
      details: { ...classified, branch, workspaceRoot }
    });
  }
  if (classified.action === GitAction.NETWORK && classified.verb === 'push') {
    throw new PlatformError({
      code: ErrorCode.GIT_POLICY_VIOLATION,
      message: 'Autonomous Cursor must not push from the ACP workspace unless explicitly configured.',
      phase: 'CURSOR_EXECUTING',
      retryable: false,
      details: classified
    });
  }
  if (branch && isProtectedBranch(branch) && classified.action === GitAction.MUTATING) {
    throw new PlatformError({
      code: ErrorCode.GIT_POLICY_VIOLATION,
      message: `Refusing to mutate protected branch ${branch}`,
      phase: 'CURSOR_EXECUTING',
      retryable: false,
      details: { branch, ...classified }
    });
  }
  return classified;
}

export function gitPolicyAllowsCursor(command, context = {}) {
  try {
    const classified = classifyGitCommand(command);
    if (classified.action === GitAction.DESTRUCTIVE) return { allow: false, classified };
    if (classified.action === GitAction.NETWORK && /push/i.test(command)) return { allow: false, classified };
    if (context.branch && isProtectedBranch(context.branch) && classified.action !== GitAction.SAFE) {
      return { allow: false, classified };
    }
    if (classified.action === GitAction.UNKNOWN) return { allow: false, classified };
    return { allow: true, classified };
  } catch {
    return { allow: false, classified: { action: GitAction.UNKNOWN } };
  }
}
