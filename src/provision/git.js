import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitOk } from '../git/exec.js';
import { inspectGit } from '../git/inspect.js';
import { findProtectedSecretFiles, isProtectedSecretFile } from '../git/secrets.js';
import { autonomousBranchName } from '../git/policy.js';
import { isInsideRoot } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

const DEFAULT_GITIGNORE = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.env',
  '.env.local',
  '*.pem',
  '*.key',
  '.venv/',
  'venv/',
  'target/',
  '.dart_tool/',
  'build/',
  '*.iml'
].join('\n') + '\n';

export async function workspaceHasOwnGit(workspacePath) {
  return Boolean(await fs.stat(path.join(workspacePath, '.git')).catch(() => null));
}

export async function ensureProvisioningGit(workspacePath, { workspaceRoot, branch } = {}) {
  if (!isInsideRoot(workspacePath, workspaceRoot || workspacePath)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Provisioning git root escaped the managed workspace.',
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  // Parent-platform repositories must not count. Generators often run inside
  // MANAGED_WORKSPACE_ROOT, which itself lives in the ADP git work tree.
  if (!(await workspaceHasOwnGit(workspacePath))) {
    if (branch) {
      const named = git(['init', '-b', branch], { cwd: workspacePath });
      if (!named.ok) {
        gitOk(['init'], { cwd: workspacePath });
        gitOk(['switch', '-c', branch], { cwd: workspacePath });
      }
    } else {
      gitOk(['init'], { cwd: workspacePath });
    }
    gitOk(['config', 'user.email', 'adp@local'], { cwd: workspacePath });
    gitOk(['config', 'user.name', 'ADP'], { cwd: workspacePath });
  }
  const ignorePath = path.join(workspacePath, '.gitignore');
  if (!(await fs.stat(ignorePath).catch(() => null))) {
    await fs.writeFile(ignorePath, DEFAULT_GITIGNORE, 'utf8');
  }
  if (branch) {
    const current = inspectGit(workspacePath);
    if (current.branch !== branch) {
      const exists = git(['rev-parse', '--verify', branch], { cwd: workspacePath });
      if (exists.ok) gitOk(['switch', branch], { cwd: workspacePath });
      else gitOk(['switch', '-c', branch], { cwd: workspacePath });
    }
  }
}

export async function listWorkspaceFiles(workspacePath, max = 400) {
  const out = [];
  async function walk(dir) {
    if (out.length >= max) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= max) return;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.dart_tool') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(workspacePath, full).replace(/\\/g, '/'));
    }
  }
  await walk(workspacePath);
  return out;
}

export async function assertNoSecrets(workspacePath) {
  const files = await listWorkspaceFiles(workspacePath);
  const secrets = findProtectedSecretFiles(files);
  const extra = files.filter(file => isProtectedSecretFile(file) && !file.endsWith('.example'));
  const blocked = [...new Set([...secrets, ...extra])].filter(file => !file.endsWith('.example'));
  if (blocked.length) {
    throw new PlatformError({
      code: ErrorCode.SECRET_FILE_BLOCKED,
      message: `Provisioning produced protected secret files and will not commit them: ${blocked.join(', ')}`,
      phase: 'PROJECT_PROVISIONING',
      retryable: false,
      details: { files: blocked }
    });
  }
  return files;
}

export async function createProvisioningBaseline(workspacePath, { workspaceRoot, projectId } = {}) {
  await ensureProvisioningGit(workspacePath, {
    workspaceRoot,
    branch: autonomousBranchName(projectId)
  });
  const files = await assertNoSecrets(workspacePath);
  gitOk(['add', '-A'], { cwd: workspacePath });
  const staged = git(['diff', '--cached', '--name-only'], { cwd: workspacePath });
  const stagedSecrets = findProtectedSecretFiles(String(staged.stdout || '').split(/\r?\n/));
  if (stagedSecrets.length) {
    git(['reset', 'HEAD'], { cwd: workspacePath });
    throw new PlatformError({
      code: ErrorCode.SECRET_FILE_BLOCKED,
      message: `Refusing to commit provisioned secret files: ${stagedSecrets.join(', ')}`,
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  const dirty = git(['status', '--porcelain'], { cwd: workspacePath });
  if (dirty.stdout) {
    gitOk(['-c', 'user.email=adp@local', '-c', 'user.name=ADP', 'commit', '-m', 'ADP provisioning baseline'], { cwd: workspacePath });
  }
  const snapshot = inspectGit(workspacePath);
  return {
    baselineSha: snapshot.sha,
    branch: snapshot.branch,
    files,
    dirty: snapshot.dirty
  };
}
