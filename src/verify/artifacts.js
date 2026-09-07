import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { redactSecrets } from '../orchestrator/errors.js';

export function artifactRoot() {
  return path.resolve(process.env.ARTIFACT_ROOT || path.join(process.cwd(), 'artifacts'));
}

export function verificationArtifactDir(projectId, iteration) {
  return path.join(artifactRoot(), projectId, 'verification', `iteration-${iteration}`);
}

export async function writeLogArtifact({ projectId, iteration, kind, contents }) {
  const dir = verificationArtifactDir(projectId, iteration);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${kind.toLowerCase()}.log`);
  const text = redactSecrets(String(contents || ''));
  await fs.writeFile(file, text, 'utf8');
  const stat = await fs.stat(file);
  return {
    id: crypto.randomUUID(),
    projectId,
    iteration,
    kind,
    type: 'log',
    path: file,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    createdAt: new Date().toISOString()
  };
}

export async function hashFile(filePath, workspaceRoot) {
  if (workspaceRoot && !isInsideRoot(filePath, workspaceRoot)) return null;
  const resolved = resolveCanonicalSync(filePath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > 50 * 1024 * 1024) {
    return { path: resolved, size: stat.size, sha256: null, skipped: 'too_large' };
  }
  const data = await fs.readFile(resolved);
  return {
    path: resolved,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(data).digest('hex')
  };
}

const OUTPUT_GLOBS = [
  ['dist', ['.js', '.mjs', '.cjs', '.css', '.html']],
  ['build', ['.js', '.css', '.html', '.jar', '.war']],
  ['.next', []],
  ['target', ['.jar', '.war']],
  [path.join('app', 'build', 'outputs', 'apk'), ['.apk']],
  [path.join('app', 'build', 'outputs', 'bundle'), ['.aab']],
  [path.join('bin', 'Release'), ['.dll', '.exe']],
  [path.join('target', 'release'), []]
];

export async function discoverBuildOutputs(workspacePath, limit = 20) {
  const found = [];
  for (const [rel, exts] of OUTPUT_GLOBS) {
    const dir = path.join(workspacePath, rel);
    const entries = await walkFiles(dir, 4, 40);
    for (const file of entries) {
      if (exts.length && !exts.includes(path.extname(file).toLowerCase())) continue;
      const hashed = await hashFile(file, workspacePath);
      if (hashed) found.push({ ...hashed, kind: 'build_output' });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

async function walkFiles(dir, depth, max) {
  if (depth < 0) return [];
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) return [dir];
  const names = await fs.readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const next = path.join(dir, name);
    const child = await fs.stat(next).catch(() => null);
    if (!child) continue;
    if (child.isFile()) out.push(next);
    else if (child.isDirectory()) out.push(...await walkFiles(next, depth - 1, max));
    if (out.length >= max) break;
  }
  return out;
}
