import fs from 'node:fs';
import path from 'node:path';

export function resolveCanonicalSync(target) {
  const resolved = path.resolve(String(target || ''));
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolveThroughExisting(resolved);
  }
}

function resolveThroughExisting(resolved) {
  const missing = [];
  let current = resolved;
  while (true) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function resolveCanonical(target) {
  return resolveCanonicalSync(target);
}

function normalize(value) {
  const resolved = resolveCanonicalSync(value);
  const withSep = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
  return process.platform === 'win32' ? withSep.toLowerCase() : withSep;
}

export function isInsideRoot(target, root) {
  if (!target || !root) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(String(target))) return false;
  const child = normalize(target);
  const parent = normalize(root);
  return child === parent || child.startsWith(parent);
}

export function assertInsideWorkspace(target, workspaceRoot) {
  return isInsideRoot(target, workspaceRoot);
}
