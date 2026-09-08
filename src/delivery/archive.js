import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { git } from '../git/exec.js';
import { isProtectedSecretFile } from '../git/secrets.js';
import { highConfidenceSecretFindings, scanFilesForSecrets, scanTextForSecrets } from '../secrets/scan.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { artifactRoot } from '../verify/artifacts.js';
import { isDemoDelivery, writeDemoAppFiles } from './demo-app.js';

const ARCHIVE_SKIP = new Set(['.git', 'node_modules', '.adp-secrets', '.pglite', 'artifacts']);

export function deliveryDir(projectId, version) {
  return path.join(artifactRoot(), projectId, 'deliveries', `v${version}`);
}

export async function createSourceArchive({ project, checkpointSha, version, workspacePath }) {
  const destDir = deliveryDir(project.id, version);
  await fsPromises.mkdir(destDir, { recursive: true });
  const archivePath = path.join(destDir, 'source.zip');
  let files = [];
  const mockArchive = Boolean(isDemoDelivery(project));
  if (mockArchive) {
    files = await writeDemoAppArchive(archivePath, project, { version });
  } else if (workspacePath && fs.existsSync(path.join(workspacePath, '.git')) && checkpointSha && !String(checkpointSha).startsWith('unverified:')) {
    const archived = git(['archive', '--format=zip', '-o', archivePath, checkpointSha], { cwd: workspacePath });
    if (!archived.ok) {
      throw new PlatformError({
        code: ErrorCode.DELIVERY_PREPARATION_FAILED,
        message: `git archive failed for checkpoint ${checkpointSha}`,
        phase: 'DELIVERY_PREPARATION',
        retryable: true,
        details: { stderr: archived.stderr }
      });
    }
    files = listGitArchiveNames(workspacePath, checkpointSha);
  } else {
    files = await writeGeneratedArchive(archivePath, project, workspacePath);
  }
  const findings = [
    ...scanArchivePaths(files, mockArchive ? null : workspacePath),
    ...scanWorkspaceTree(workspacePath)
  ];
  const high = highConfidenceSecretFindings(findings);
  if (high.length) {
    await fsPromises.unlink(archivePath).catch(() => {});
    throw new PlatformError({
      code: ErrorCode.SECRET_DETECTED_IN_SOURCE,
      message: 'Source archive blocked by high-confidence secret scan.',
      phase: 'DELIVERY_PREPARATION',
      retryable: false,
      details: { files: high.map(item => path.basename(item.path)), rules: high.map(item => item.id) }
    });
  }
  const bytes = await fsPromises.readFile(archivePath);
  return {
    path: archivePath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    fileName: 'source.zip',
    files
  };
}

function listGitArchiveNames(cwd, sha) {
  const listed = git(['ls-tree', '-r', '--name-only', sha], { cwd });
  return String(listed.stdout || '').split(/\r?\n/).filter(Boolean);
}

async function writeGeneratedArchive(archivePath, project, workspacePath) {
  const staging = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'adp-src-'));
  const files = [];
  if (workspacePath && fs.existsSync(workspacePath)) {
    await copyOwnerSafeTree(workspacePath, staging, '', files);
  }
  if (!files.length) {
    const readme = [
      `# ${project.council?.discovery?.spec?.productName || 'Application'}`,
      '',
      project.idea || '',
      '',
      'This archive was packaged from the verified delivery checkpoint.'
    ].join('\n');
    await fsPromises.writeFile(path.join(staging, 'README.md'), readme);
    files.push('README.md');
  }
  const zipped = await zipDirectory(staging, archivePath);
  await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => {});
  if (!zipped) {
    throw new PlatformError({
      code: ErrorCode.DELIVERY_PREPARATION_FAILED,
      message: 'Unable to create owner source archive.',
      phase: 'DELIVERY_PREPARATION',
      retryable: true
    });
  }
  return files;
}

async function writeDemoAppArchive(archivePath, project, { version } = {}) {
  const staging = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'adp-demo-src-'));
  const files = await writeDemoAppFiles(staging, project, { version });
  const zipped = await zipDirectory(staging, archivePath);
  await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => {});
  if (!zipped) {
    throw new PlatformError({
      code: ErrorCode.DELIVERY_PREPARATION_FAILED,
      message: 'Unable to create owner source archive.',
      phase: 'DELIVERY_PREPARATION',
      retryable: true
    });
  }
  return files;
}

async function copyOwnerSafeTree(from, to, rel, files) {
  const entries = await fsPromises.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (ARCHIVE_SKIP.has(entry.name) || isProtectedSecretFile(entry.name)) continue;
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fsPromises.mkdir(dest, { recursive: true });
      await copyOwnerSafeTree(src, dest, nextRel, files);
    } else if (entry.isFile()) {
      await fsPromises.copyFile(src, dest);
      files.push(nextRel);
    }
  }
}

async function zipDirectory(source, dest) {
  if (await runCommand('tar', ['-a', '-cf', dest, '-C', source, '.'], 30000) && fs.existsSync(dest)) return true;
  if (process.platform === 'win32') {
    const ok = await runCommand('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path (Join-Path '${source}' '*') -DestinationPath '${dest}' -Force`], 30000);
    return ok && fs.existsSync(dest);
  }
  return false;
}

function runCommand(command, args, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function scanArchivePaths(files, workspacePath) {
  const findings = [];
  for (const rel of files) {
    const name = path.basename(rel);
    if (isProtectedSecretFile(name) || /\.adp-secrets|secret-store|\.env$/i.test(rel)) {
      findings.push({ id: 'protected_env_file', path: rel, confidence: 'high', rule: 'filename' });
    }
    const full = workspacePath ? path.join(workspacePath, rel) : null;
    if (full && fs.existsSync(full)) findings.push(...scanFilesForSecrets([{ path: full }]));
    else findings.push(...scanTextForSecrets('', rel));
  }
  return findings;
}

function scanWorkspaceTree(workspacePath) {
  if (!workspacePath || !fs.existsSync(workspacePath)) return [];
  const files = [];
  collectWorkspaceFiles(workspacePath, '', files);
  return scanFilesForSecrets(files.map(rel => ({ path: path.join(workspacePath, rel) })));
}

function collectWorkspaceFiles(from, rel, files) {
  let entries = [];
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (ARCHIVE_SKIP.has(entry.name) || isProtectedSecretFile(entry.name)) continue;
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    const src = path.join(from, entry.name);
    if (entry.isDirectory()) collectWorkspaceFiles(src, nextRel, files);
    else if (entry.isFile()) files.push(nextRel);
  }
}

export function inspectArchiveEntries(archivePath) {
  const tar = spawnSync('tar', ['-tf', archivePath], { encoding: 'utf8', windowsHide: true });
  if (tar.status === 0) return String(tar.stdout || '').split(/\r?\n/).filter(Boolean);
  return [];
}
