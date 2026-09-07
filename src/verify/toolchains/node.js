import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyLevel, ProjectTypes, VerificationKind } from '../kinds.js';

const LOCKS = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' }
];

export const NodeToolchain = {
  name: ProjectTypes.NODE,
  async canHandle(workspace) {
    return exists(path.join(workspace, 'package.json'));
  },
  async detect(workspace) {
    const raw = await fs.readFile(path.join(workspace, 'package.json'), 'utf8').catch(() => null);
    const pkg = raw ? JSON.parse(raw) : {};
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const present = [];
    for (const lock of LOCKS) {
      if (await exists(path.join(workspace, lock.file))) present.push(lock);
    }
    const managers = [...new Set(present.map(item => item.manager))];
    const conflict = managers.length > 1;
    return {
      toolchain: ProjectTypes.NODE,
      packageManager: conflict ? null : (managers[0] || 'npm'),
      lockfiles: present.map(item => item.file),
      lockfileConflict: conflict,
      scripts: Object.keys(scripts),
      hasDependencies: Boolean(
        Object.keys(pkg.dependencies || {}).length
        || Object.keys(pkg.devDependencies || {}).length
      ),
      tsconfig: await exists(path.join(workspace, 'tsconfig.json'))
    };
  },
  dependencyInstallStep(detection) {
    if (detection.lockfileConflict) return null;
    if (!detection.hasDependencies && !detection.lockfiles.length) return null;
    const pm = detection.packageManager || 'npm';
    const command = pm === 'npm' && detection.lockfiles.some(name => name.startsWith('package-lock') || name === 'npm-shrinkwrap.json')
      ? ['npm', 'ci']
      : pm === 'pnpm' ? ['pnpm', 'install', '--frozen-lockfile']
        : pm === 'yarn' ? ['yarn', 'install', '--frozen-lockfile']
          : pm === 'bun' ? ['bun', 'install', '--frozen-lockfile']
            : ['npm', 'install'];
    return step('install', VerificationKind.DEPENDENCY_INSTALL, command, true);
  },
  buildSteps(detection) {
    return scriptStep(detection, 'build', VerificationKind.BUILD, true);
  },
  testSteps(detection) {
    return scriptStep(detection, 'test', VerificationKind.TEST, true);
  },
  lintSteps(detection) {
    return scriptStep(detection, 'lint', VerificationKind.LINT, false);
  },
  staticAnalysisSteps(detection) {
    return scriptStep(detection, 'typecheck', VerificationKind.STATIC_ANALYSIS, false);
  },
  securitySteps(detection) {
    if (process.env.VERIFY_SECURITY_ENABLED === 'false') return [];
    if (detection.lockfileConflict) return [];
    const pm = detection.packageManager || 'npm';
    if (pm !== 'npm' || !detection.lockfiles.length) return [];
    return [step('security', VerificationKind.SECURITY_CHECK, ['npm', 'audit', '--omit=dev'], false)];
  }
};

function scriptStep(detection, script, kind, required) {
  if (!detection.scripts.includes(script)) return [];
  const pm = detection.packageManager || 'npm';
  const command = pm === 'yarn' ? ['yarn', script]
    : pm === 'pnpm' ? ['pnpm', 'run', script]
      : pm === 'bun' ? ['bun', 'run', script]
        : ['npm', 'run', script];
  return [step(script, kind, command, required)];
}

function step(id, kind, command, required) {
  return { id, kind, command, required, toolchain: ProjectTypes.NODE };
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}

export function nodePolicy(detection) {
  return {
    build: detection.scripts.includes('build') ? PolicyLevel.REQUIRED : PolicyLevel.NOT_APPLICABLE,
    tests: detection.scripts.includes('test') ? PolicyLevel.REQUIRED : PolicyLevel.NOT_APPLICABLE,
    lint: detection.scripts.includes('lint') ? PolicyLevel.OPTIONAL : PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: detection.scripts.includes('typecheck') ? PolicyLevel.OPTIONAL : PolicyLevel.NOT_APPLICABLE,
    security: PolicyLevel.OPTIONAL
  };
}
