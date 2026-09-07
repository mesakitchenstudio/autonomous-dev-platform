import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactRoot } from '../verify/artifacts.js';

export function runtimeArtifactDir(projectId, iteration) {
  return path.join(artifactRoot(), projectId, 'runtime', `iteration-${iteration}`);
}

export async function writeBinaryArtifact({ projectId, iteration, kind, fileName, bytes, extra = {} }) {
  const dir = runtimeArtifactDir(projectId, iteration);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  await fs.writeFile(file, buffer);
  const stat = await fs.stat(file);
  return {
    id: crypto.randomUUID(),
    projectId,
    iteration,
    kind,
    type: kind,
    path: file,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    createdAt: new Date().toISOString(),
    ...extra
  };
}

export function screenshotSetHash(screenshots = []) {
  const hashes = screenshots.map(item => item.sha256).filter(Boolean).sort();
  if (!hashes.length) return 'none';
  return crypto.createHash('sha256').update(hashes.join('|')).digest('hex');
}
