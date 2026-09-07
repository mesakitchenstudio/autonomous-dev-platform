import { classifyGitCommand, gitPolicyAllowsCursor, GitAction } from '../git/policy.js';

export const CommandCategory = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  PROJECT_BUILD: 'PROJECT_BUILD',
  PROJECT_TEST: 'PROJECT_TEST',
  PACKAGE_MANAGER: 'PACKAGE_MANAGER',
  PROJECT_RUNTIME: 'PROJECT_RUNTIME',
  PROJECT_SCRIPT: 'PROJECT_SCRIPT',
  GIT_SAFE: 'GIT_SAFE',
  GIT_MUTATING: 'GIT_MUTATING',
  NETWORK: 'NETWORK',
  SYSTEM: 'SYSTEM',
  DESTRUCTIVE: 'DESTRUCTIVE',
  UNKNOWN: 'UNKNOWN'
});

const READ = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'pwd', 'echo', 'which', 'where', 'env']);
const BUILD = new Set(['node', 'tsc', 'eslint', 'prettier', 'python', 'python3', 'ruby', 'go', 'java', 'javac', 'dotnet', 'make', 'cmake']);
const TEST = new Set(['jest', 'vitest', 'mocha', 'pytest', 'phpunit', 'rspec']);
const PKG = new Set(['npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'composer', 'bundle', 'cargo']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'telnet']);
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'del', 'rd', 'format', 'mkfs', 'shutdown', 'reboot', 'diskpart']);
const SYSTEM = new Set(['sudo', 'su', 'chmod', 'chown', 'icacls', 'reg', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh']);
const RUNTIME = new Set(['serve']);
const SANDBOX_ROUTED = new Set([
  CommandCategory.PROJECT_BUILD,
  CommandCategory.PROJECT_TEST,
  CommandCategory.PACKAGE_MANAGER,
  CommandCategory.PROJECT_RUNTIME,
  CommandCategory.PROJECT_SCRIPT
]);

export function extractCommand(request) {
  const params = request?.params || request || {};
  return params.toolCall?.command
    || params.toolCall?.input?.command
    || params.command
    || params.args?.command
    || params.title
    || '';
}

export function extractRequestedPath(request) {
  const params = request?.params || request || {};
  return params.toolCall?.path
    || params.toolCall?.input?.path
    || params.toolCall?.input?.file
    || params.path
    || params.file
    || null;
}

export function classifyCommand(command) {
  const text = String(command || '').trim();
  if (!text) return { category: CommandCategory.UNKNOWN, command: text };
  const tokens = text.split(/\s+/);
  const bin = tokens[0].replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (bin === 'git' || text.startsWith('git ')) {
    const git = classifyGitCommand(text);
    if (git.action === GitAction.SAFE) return { category: CommandCategory.GIT_SAFE, command: text, git };
    if (git.action === GitAction.MUTATING) return { category: CommandCategory.GIT_MUTATING, command: text, git };
    if (git.action === GitAction.DESTRUCTIVE) return { category: CommandCategory.DESTRUCTIVE, command: text, git };
    if (git.action === GitAction.NETWORK) return { category: CommandCategory.NETWORK, command: text, git };
    return { category: CommandCategory.UNKNOWN, command: text, git };
  }
  if (READ.has(bin)) return { category: CommandCategory.READ_ONLY, command: text };
  if (TEST.has(bin) || /test|lint/.test(tokens.slice(1).join(' '))) return { category: CommandCategory.PROJECT_TEST, command: text };
  if (PKG.has(bin)) {
    const rest = tokens.slice(1).join(' ');
    if (/\b(publish|login|token|config set)\b/i.test(rest)) return { category: CommandCategory.NETWORK, command: text };
    if (/\b(test|lint)\b/i.test(rest)) return { category: CommandCategory.PROJECT_TEST, command: text };
    if (/\b(start|preview|serve)\b/i.test(rest)) return { category: CommandCategory.PROJECT_RUNTIME, command: text };
    if (/\b(run build|run|build)\b/i.test(rest)) return { category: CommandCategory.PROJECT_BUILD, command: text };
    return { category: CommandCategory.PACKAGE_MANAGER, command: text };
  }
  if (RUNTIME.has(bin)) return { category: CommandCategory.PROJECT_RUNTIME, command: text };
  if (BUILD.has(bin)) return { category: CommandCategory.PROJECT_BUILD, command: text };
  if (NETWORK.has(bin) || /\bhttps?:\/\//i.test(text)) return { category: CommandCategory.NETWORK, command: text };
  if (DESTRUCTIVE.has(bin) || /rm\s+-rf\s+[\\/]/.test(text) || /del\s+\/s/.test(text)) {
    return { category: CommandCategory.DESTRUCTIVE, command: text };
  }
  if (SYSTEM.has(bin)) return { category: CommandCategory.SYSTEM, command: text };
  return { category: CommandCategory.UNKNOWN, command: text };
}

export function commandAllowed(command, context = {}) {
  const classified = classifyCommand(command);
  if (SANDBOX_ROUTED.has(classified.category) || classified.category === CommandCategory.GIT_SAFE || classified.category === CommandCategory.READ_ONLY) {
    return { allow: true, classified, route: SANDBOX_ROUTED.has(classified.category) ? 'sandbox' : 'platform' };
  }
  if (classified.category === CommandCategory.GIT_MUTATING) {
    return { allow: gitPolicyAllowsCursor(command, context).allow, classified };
  }
  return { allow: false, classified };
}
