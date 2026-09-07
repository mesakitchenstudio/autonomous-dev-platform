import path from 'node:path';
import { git } from '../git/exec.js';

const PATTERNS = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^tsconfig.*\.json$/i,
  /^\.eslintrc/i,
  /^eslint\.config/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^pytest\.ini$/i,
  /^pyproject\.toml$/i,
  /^tox\.ini$/i,
  /^Cargo\.toml$/i,
  /^go\.mod$/i,
  /^pom\.xml$/i,
  /build\.gradle(\.kts)?$/i,
  /settings\.gradle(\.kts)?$/i,
  /\.csproj$/i,
  /\.sln$/i,
  /^\.github\/workflows\//i
];

export function isVerificationConfigPath(filePath) {
  const rel = String(filePath || '').replace(/\\/g, '/');
  const base = path.posix.basename(rel);
  return PATTERNS.some(pattern => pattern.test(rel) || pattern.test(base));
}

export function detectVerificationConfigChanges(cwd, baselineSha) {
  if (!baselineSha) return { changed: false, files: [] };
  const diff = git(['diff', '--name-only', `${baselineSha}...HEAD`], { cwd });
  const files = String(diff.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const interesting = files.filter(isVerificationConfigPath);
  return {
    changed: interesting.length > 0,
    files: interesting,
    allChanged: files
  };
}
