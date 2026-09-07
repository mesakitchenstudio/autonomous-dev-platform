import path from 'node:path';
import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';

const DEVICE = /^\\\\.\\|^\/dev\/|^[\\/]{2}/;
const UNC = /^\\\\[^.?]/;

export function assertSafeMountSource(source, allowedRoots = [], { projectId, store } = {}) {
  const raw = String(source || '');
  if (!raw) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Sandbox mount source is empty.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  if (DEVICE.test(raw) || (process.platform === 'win32' && UNC.test(raw))) {
    recordSecurityEvent(SecurityEventType.PROTECTED_PATH_DENIED, { projectId, path: raw, reason: 'device_or_unc' }, { store, projectId });
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Sandbox refused a device or UNC mount source.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  const canonical = resolveCanonicalSync(raw);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Sandbox refused a path containing parent segments.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  const ok = allowedRoots.some(root => isInsideRoot(canonical, resolveCanonicalSync(root)));
  if (!ok) {
    recordSecurityEvent(SecurityEventType.PROTECTED_PATH_DENIED, { projectId, path: canonical, reason: 'outside_allowlist' }, { store, projectId });
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Sandbox mount source is outside approved roots.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  return canonical;
}

export function approvedRootsFor(project, extras = {}) {
  const roots = [];
  if (project?.repository?.workspacePath) roots.push(project.repository.workspacePath);
  if (extras.workspaceRoot) roots.push(extras.workspaceRoot);
  if (extras.artifactDir) roots.push(extras.artifactDir);
  if (extras.cacheDir) roots.push(extras.cacheDir);
  return roots.filter(Boolean);
}

export function defaultMounts({ workspaceRoot, artifactDir, cacheDir, writableWorkspace = true } = {}) {
  const mounts = [];
  if (workspaceRoot) {
    mounts.push({
      source: workspaceRoot,
      target: '/workspace',
      readOnly: writableWorkspace === false,
      kind: 'workspace'
    });
  }
  if (artifactDir) {
    mounts.push({ source: artifactDir, target: '/artifacts', readOnly: false, kind: 'artifacts' });
  }
  if (cacheDir) {
    mounts.push({ source: cacheDir, target: '/cache', readOnly: false, kind: 'cache' });
  }
  return mounts;
}

export function validateMounts(mounts, allowedRoots, extras = {}) {
  return (mounts || []).map(mount => ({
    ...mount,
    source: assertSafeMountSource(mount.source, allowedRoots, extras),
    target: mount.target || path.posix.join('/workspace', path.basename(mount.source)),
    readOnly: mount.readOnly !== false && mount.kind !== 'workspace' && mount.kind !== 'artifacts' && mount.kind !== 'cache'
  }));
}
