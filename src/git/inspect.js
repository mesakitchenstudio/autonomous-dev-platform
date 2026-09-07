import path from 'node:path';
import { git } from './exec.js';
import { isInsideRoot } from './boundary.js';

export function inspectGit(cwd) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const sha = git(['rev-parse', 'HEAD'], { cwd });
  const status = git(['status', '--porcelain'], { cwd });
  const dirty = Boolean(status.ok && status.stdout);
  return {
    ok: branch.ok && sha.ok,
    branch: branch.ok ? branch.stdout : null,
    sha: sha.ok ? sha.stdout : null,
    dirty,
    porcelain: status.ok ? status.stdout : '',
    error: branch.ok && sha.ok ? null : (branch.stderr || sha.stderr)
  };
}

export function diffStatAgainst(cwd, baselineSha) {
  if (!baselineSha) return { raw: '', filesChanged: 0, insertions: 0, deletions: 0 };
  const result = git(['diff', '--stat', `${baselineSha}...HEAD`], { cwd });
  const raw = result.ok ? result.stdout : '';
  const summary = raw.split('\n').filter(Boolean).at(-1) || '';
  const filesChanged = Number((/(\d+) files? changed/.exec(summary) || [])[1] || 0);
  const insertions = Number((/(\d+) insertion/.exec(summary) || [])[1] || 0);
  const deletions = Number((/(\d+) deletion/.exec(summary) || [])[1] || 0);
  return { raw, filesChanged, insertions, deletions };
}

export function parsePorcelain(porcelain) {
  return String(porcelain || '').split(/\r?\n/).filter(Boolean).map(line => {
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const renamed = rest.includes(' -> ') ? rest.split(' -> ') : null;
    const filePath = renamed ? renamed[1] : rest;
    return {
      path: filePath,
      status: statusFromCode(code, Boolean(renamed)),
      tracked: code[0] !== '?' && code[1] !== '?',
      code
    };
  });
}

function statusFromCode(code, renamed) {
  if (renamed || code.includes('R')) return 'renamed';
  if (code.includes('A') || code === '??') return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

export async function changedFileManifest(cwd, workspaceRoot, porcelain) {
  const entries = parsePorcelain(porcelain);
  const out = [];
  for (const item of entries) {
    const absolute = path.resolve(cwd, item.path);
    out.push({
      path: item.path,
      status: item.status,
      tracked: item.tracked,
      withinWorkspace: await isInsideRoot(absolute, workspaceRoot || cwd)
    });
  }
  return out;
}
