import { git, gitOk } from './exec.js';
import { inspectGit, parsePorcelain, changedFileManifest, diffStatAgainst } from './inspect.js';
import path from 'node:path';
import { findProtectedSecretFiles } from './secrets.js';
import { isProtectedBranch } from './policy.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { scanFilesForSecrets, highConfidenceSecretFindings } from '../secrets/scan.js';
import { SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';

export async function collectGitEvidence(cwd, { baselineSha, workspaceRoot } = {}) {
  const snapshot = inspectGit(cwd);
  const manifest = await changedFileManifest(cwd, workspaceRoot || cwd, snapshot.porcelain);
  const uncommitted = parsePorcelain(snapshot.porcelain);
  const againstBaseline = diffStatAgainst(cwd, baselineSha);
  return {
    snapshot,
    manifest,
    uncommitted,
    diffStat: againstBaseline,
    secrets: findProtectedSecretFiles(manifest.map(item => item.path))
  };
}

export async function createCheckpointCommit(cwd, { iteration, branch, workspaceRoot } = {}) {
  const current = inspectGit(cwd);
  if (current.branch && isProtectedBranch(current.branch)) {
    throw new PlatformError({
      code: ErrorCode.GIT_POLICY_VIOLATION,
      message: `Refusing to commit on protected branch ${current.branch}`,
      phase: 'CURSOR_EXECUTING',
      retryable: false,
      details: { branch: current.branch }
    });
  }
  if (branch && current.branch !== branch) {
    throw new PlatformError({
      code: ErrorCode.GIT_POLICY_VIOLATION,
      message: `Workspace is on ${current.branch}, expected autonomous branch ${branch}`,
      phase: 'CURSOR_EXECUTING',
      retryable: false
    });
  }
  const collected = await collectGitEvidence(cwd, { workspaceRoot });
  if (collected.secrets.length) {
    throw new PlatformError({
      code: ErrorCode.SECRET_FILE_BLOCKED,
      message: `Refusing to commit protected secret files: ${collected.secrets.join(', ')}`,
      phase: 'CURSOR_EXECUTING',
      retryable: true,
      details: { files: collected.secrets }
    });
  }
  if (!collected.snapshot.dirty) {
    return { committed: false, sha: collected.snapshot.sha, evidence: collected };
  }
  const escaped = collected.manifest.filter(item => item.withinWorkspace === false);
  if (escaped.length) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Changed files escaped the managed workspace boundary.',
      phase: 'CURSOR_EXECUTING',
      retryable: false,
      details: { files: escaped.map(item => item.path) }
    });
  }
  gitOk(['add', '-A'], { cwd });
  const staged = git(['diff', '--cached', '--name-only'], { cwd });
  const stagedNames = String(staged.stdout || '').split(/\r?\n/).filter(Boolean);
  const stagedSecrets = findProtectedSecretFiles(stagedNames);
  if (stagedSecrets.length) {
    git(['reset', 'HEAD'], { cwd });
    throw new PlatformError({
      code: ErrorCode.SECRET_FILE_BLOCKED,
      message: `Staged secret files blocked: ${stagedSecrets.join(', ')}`,
      phase: 'CURSOR_EXECUTING',
      retryable: true
    });
  }
  const scanned = scanFilesForSecrets(stagedNames.map(rel => ({ path: path.join(cwd, rel) })));
  const high = highConfidenceSecretFindings(scanned);
  if (high.length) {
    git(['reset', 'HEAD'], { cwd });
    recordSecurityEvent(SecurityEventType.SECRET_DETECTED_IN_SOURCE, {
      files: high.map(item => path.basename(item.path)),
      rules: high.map(item => item.id)
    });
    throw new PlatformError({
      code: ErrorCode.SECRET_DETECTED_IN_SOURCE,
      message: `High-confidence secret content blocked before checkpoint (${high.map(item => item.id).join(', ')}).`,
      phase: 'CURSOR_EXECUTING',
      retryable: true,
      details: { files: high.map(item => path.basename(item.path)), rules: high.map(item => item.id) }
    });
  }
  gitOk(['-c', 'user.email=adp@local', '-c', 'user.name=ADP', 'commit', '-m', `ADP iteration ${iteration}`], { cwd });
  const after = inspectGit(cwd);
  return { committed: true, sha: after.sha, evidence: await collectGitEvidence(cwd, { workspaceRoot }) };
}
