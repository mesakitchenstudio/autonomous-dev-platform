import { inspectGit } from '../git/inspect.js';
import { isGitRepository, isPlatformRepository } from '../git/worktree.js';
import { isProtectedBranch } from '../git/policy.js';
import { isInsideRoot } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { CursorRunStatus } from './contract.js';

export async function cursorPreflight({ project, workspacePath, demo, owns, dbReady, timeoutMs, backend }) {
  if (typeof owns === 'function' && !(await owns())) {
    throw new PlatformError({
      code: ErrorCode.JOB_LEASE_LOST,
      message: 'Worker does not own the Cursor job; execution was not started.',
      phase: 'CURSOR_EXECUTING',
      retryable: true
    });
  }
  if (typeof dbReady === 'function' && !(await dbReady())) {
    throw new PlatformError({
      code: ErrorCode.DATABASE_UNAVAILABLE,
      message: 'Database is unavailable; Cursor execution was not started.',
      phase: 'CURSOR_EXECUTING',
      retryable: true
    });
  }
  if (!timeoutMs) {
    throw new PlatformError({
      code: ErrorCode.CURSOR_PREFLIGHT_FAILED,
      message: 'Cursor timeout is not configured.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  if (!backend) {
    throw new PlatformError({
      code: ErrorCode.CURSOR_PREFLIGHT_FAILED,
      message: 'Cursor backend is not configured.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  if (!workspacePath) {
    throw new PlatformError({
      code: ErrorCode.CURSOR_PREFLIGHT_FAILED,
      message: 'Cursor workspace path is missing.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  const last = (project.cursorRuns || []).find(item => item.iteration === project.iteration && item.status === CursorRunStatus.RECOVERY_REQUIRED);
  if (last && last.uncertainty === 'UNCOMMITTED_CHANGES') {
    // allowed: recovery run
  }
  if (demo) return { ok: true, demo: true };
  const repo = project.repository;
  if (!repo) return { ok: true, isolated: false };
  if (!(await isInsideRoot(workspacePath, repo.workspacePath || workspacePath))) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Cursor cwd is outside the managed workspace.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  if (await isPlatformRepository(workspacePath) && process.env.ADP_ALLOW_PLATFORM_REPO !== 'true') {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Refusing to run Cursor in the platform repository.',
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  if (await isGitRepository(workspacePath)) {
    const snapshot = inspectGit(workspacePath);
    if (repo.workingBranch && snapshot.branch && snapshot.branch !== repo.workingBranch) {
      throw new PlatformError({
        code: ErrorCode.CURSOR_PREFLIGHT_FAILED,
        message: `Workspace branch ${snapshot.branch} does not match autonomous branch ${repo.workingBranch}`,
        phase: 'CURSOR_EXECUTING',
        retryable: true
      });
    }
    if (snapshot.branch && isProtectedBranch(snapshot.branch)) {
      throw new PlatformError({
        code: ErrorCode.GIT_POLICY_VIOLATION,
        message: `Cursor cannot start on protected branch ${snapshot.branch}`,
        phase: 'CURSOR_EXECUTING',
        retryable: false
      });
    }
    if (!repo.baselineSha) {
      throw new PlatformError({
        code: ErrorCode.CURSOR_PREFLIGHT_FAILED,
        message: 'Baseline SHA is missing.',
        phase: 'CURSOR_EXECUTING',
        retryable: true
      });
    }
  }
  return { ok: true, isolated: true };
}
