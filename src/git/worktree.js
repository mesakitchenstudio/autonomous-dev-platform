import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitOk } from './exec.js';
import { inspectGit } from './inspect.js';
import { autonomousBranchName, isProtectedBranch } from './policy.js';
import { resolveCanonical, isInsideRoot } from './boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export const RepositoryType = Object.freeze({
  EXISTING_LOCAL: 'EXISTING_LOCAL',
  EXISTING_REMOTE: 'EXISTING_REMOTE',
  UNPROVISIONED_NEW_PROJECT: 'UNPROVISIONED_NEW_PROJECT',
  PROVISIONED_NEW_PROJECT: 'PROVISIONED_NEW_PROJECT'
});

export const LifecycleStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  READY: 'READY',
  APPROVED: 'APPROVED',
  ARCHIVABLE: 'ARCHIVABLE',
  CLEANED: 'CLEANED'
});

export function managedWorkspaceRoot() {
  return path.resolve(process.env.MANAGED_WORKSPACE_ROOT || process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspaces'));
}

export async function isGitRepository(target) {
  const result = git(['rev-parse', '--is-inside-work-tree'], { cwd: target });
  return result.ok && result.stdout === 'true';
}

export async function resolveRepoRoot(target) {
  const stdout = gitOk(['rev-parse', '--show-toplevel'], { cwd: target });
  return resolveCanonical(stdout);
}

export async function isPlatformRepository(target) {
  try {
    const root = await resolveRepoRoot(target);
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return pkg.name === 'autonomous-ai-development-platform';
  } catch {
    return false;
  }
}

export async function assertSafeSourceRepo(ownerPath) {
  const exists = await fs.stat(ownerPath).catch(() => null);
  if (!exists) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: `Repository path does not exist: ${ownerPath}`,
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  if (!(await isGitRepository(ownerPath))) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Existing-repository Cursor mode requires a Git repository.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  const root = await resolveRepoRoot(ownerPath);
  const head = git(['rev-parse', 'HEAD'], { cwd: root });
  if (!head.ok) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Repository HEAD cannot be resolved; a committed baseline is required.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  if (await isPlatformRepository(root) && process.env.ADP_ALLOW_PLATFORM_REPO !== 'true') {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Refusing to isolate the autonomous platform repository itself.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  return { root, baselineSha: head.stdout };
}

export async function isolateExistingRepository(project, ownerPath, workspaceRoot = managedWorkspaceRoot()) {
  const { root, baselineSha } = await assertSafeSourceRepo(ownerPath);
  const owner = inspectGit(root);
  const workingBranch = autonomousBranchName(project.id);
  if (isProtectedBranch(workingBranch)) {
    throw new PlatformError({
      code: ErrorCode.GIT_POLICY_VIOLATION,
      message: `Computed autonomous branch ${workingBranch} is protected.`,
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  const workspacePath = path.join(workspaceRoot, project.id, 'repo');
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  const already = await isGitRepository(workspacePath);
  if (!already) {
    const existingBranch = git(['rev-parse', '--verify', workingBranch], { cwd: root });
    if (existingBranch.ok) {
      gitOk(['worktree', 'add', workspacePath, workingBranch], { cwd: root, timeoutMs: 30000 });
    } else {
      gitOk(['worktree', 'add', '-b', workingBranch, workspacePath, baselineSha], { cwd: root, timeoutMs: 30000 });
    }
  }
  const isolated = inspectGit(workspacePath);
  if (isolated.branch !== workingBranch) {
    gitOk(['switch', workingBranch], { cwd: workspacePath });
  }
  return {
    repositoryType: RepositoryType.EXISTING_LOCAL,
    repositorySource: 'local',
    canonicalPath: root,
    ownerPath: root,
    remoteUrl: git(['config', '--get', 'remote.origin.url'], { cwd: root }).stdout || null,
    cloudRepositoryUrl: project.repository?.cloudRepositoryUrl || null,
    remoteProvider: null,
    baseRef: owner.branch || 'HEAD',
    baselineSha,
    workingBranch,
    workspacePath,
    ownerWorkingTreeDirty: owner.dirty,
    cursorBackend: project.repository?.cursorBackend || null,
    lifecycleStatus: project.repository?.lifecycleStatus || LifecycleStatus.ACTIVE,
    cleanupStatus: null,
    createdAt: project.repository?.createdAt || new Date().toISOString()
  };
}

export async function provisionNewWorkspace(project, workspaceRoot = managedWorkspaceRoot()) {
  const workspacePath = path.join(workspaceRoot, project.id, 'repo');
  await fs.mkdir(workspacePath, { recursive: true });
  if (!(await isGitRepository(workspacePath))) {
    gitOk(['init'], { cwd: workspacePath });
    gitOk(['config', 'user.email', 'adp@local'], { cwd: workspacePath });
    gitOk(['config', 'user.name', 'ADP'], { cwd: workspacePath });
    await fs.writeFile(path.join(workspacePath, 'PROJECT_IDEA.md'), `# Owner idea\n\n${project.idea || ''}\n`, 'utf8');
    gitOk(['add', 'PROJECT_IDEA.md'], { cwd: workspacePath });
    gitOk(['commit', '-m', 'ADP workspace baseline'], { cwd: workspacePath });
  }
  const snapshot = inspectGit(workspacePath);
  const workingBranch = snapshot.branch && snapshot.branch !== 'HEAD' ? snapshot.branch : autonomousBranchName(project.id);
  if (snapshot.branch !== workingBranch) {
    const exists = git(['rev-parse', '--verify', workingBranch], { cwd: workspacePath });
    if (exists.ok) gitOk(['switch', workingBranch], { cwd: workspacePath });
    else gitOk(['switch', '-c', workingBranch], { cwd: workspacePath });
  }
  return {
    repositoryType: RepositoryType.UNPROVISIONED_NEW_PROJECT,
    repositorySource: 'managed',
    canonicalPath: workspacePath,
    ownerPath: null,
    remoteUrl: null,
    cloudRepositoryUrl: project.repository?.cloudRepositoryUrl || null,
    remoteProvider: null,
    baseRef: workingBranch,
    baselineSha: inspectGit(workspacePath).sha,
    workingBranch,
    workspacePath,
    ownerWorkingTreeDirty: false,
    cursorBackend: project.repository?.cursorBackend || null,
    lifecycleStatus: LifecycleStatus.ACTIVE,
    cleanupStatus: null,
    createdAt: new Date().toISOString()
  };
}

export async function cleanupManagedWorktree(repository, workspaceRoot = managedWorkspaceRoot()) {
  const workspacePath = repository?.workspacePath;
  if (!workspacePath) throw new Error('No managed workspace to clean');
  if (!(await isInsideRoot(workspacePath, workspaceRoot))) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Refusing to clean a path outside the managed workspace root.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  if (repository.ownerPath && await isInsideRoot(workspacePath, repository.ownerPath) === false) {
    const owner = repository.canonicalPath || repository.ownerPath;
    git(['worktree', 'remove', '--force', workspacePath], { cwd: owner, timeoutMs: 20000 });
  }
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  return { ...repository, lifecycleStatus: LifecycleStatus.CLEANED, cleanupStatus: 'CLEANED' };
}

export async function createRetryFromCheckpoint(repository, sha, workspaceRoot = managedWorkspaceRoot()) {
  if (!repository?.canonicalPath || !sha) {
    throw new PlatformError({
      code: ErrorCode.RECOVERY_FAILED,
      message: 'Rollback requires a known autonomous checkpoint SHA.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  const branch = `${repository.workingBranch}-from-${String(sha).slice(0, 8)}`;
  const workspacePath = path.join(workspaceRoot, path.basename(path.dirname(repository.workspacePath)) + '-retry', 'repo');
  gitOk(['worktree', 'add', '-b', branch, workspacePath, sha], { cwd: repository.canonicalPath, timeoutMs: 30000 });
  return { ...repository, workingBranch: branch, workspacePath };
}
