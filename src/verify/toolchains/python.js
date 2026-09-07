import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyLevel, ProjectTypes, VerificationKind } from '../kinds.js';

export const PythonToolchain = {
  name: ProjectTypes.PYTHON,
  async canHandle(workspace) {
    const names = ['pyproject.toml', 'requirements.txt', 'setup.py', 'tox.ini', 'pytest.ini', 'uv.lock', 'poetry.lock'];
    for (const name of names) {
      if (await exists(path.join(workspace, name))) return true;
    }
    return false;
  },
  async detect(workspace) {
    const pyproject = await fs.readFile(path.join(workspace, 'pyproject.toml'), 'utf8').catch(() => '');
    const hasPytest = await exists(path.join(workspace, 'pytest.ini'))
      || pyproject.includes('[tool.pytest')
      || pyproject.includes('pytest');
    const hasRuff = await exists(path.join(workspace, 'ruff.toml')) || pyproject.includes('[tool.ruff');
    const hasFlake = await exists(path.join(workspace, '.flake8')) || pyproject.includes('[tool.flake8');
    return {
      toolchain: ProjectTypes.PYTHON,
      requirements: await exists(path.join(workspace, 'requirements.txt')),
      pyproject: Boolean(pyproject),
      poetry: await exists(path.join(workspace, 'poetry.lock')),
      uv: await exists(path.join(workspace, 'uv.lock')),
      hasPytest,
      hasRuff,
      hasFlake
    };
  },
  dependencyInstallStep(detection) {
    if (detection.uv) return step('install', VerificationKind.DEPENDENCY_INSTALL, ['uv', 'sync'], true);
    if (detection.poetry) return step('install', VerificationKind.DEPENDENCY_INSTALL, ['poetry', 'install', '--no-interaction'], true);
    if (detection.requirements) return step('install', VerificationKind.DEPENDENCY_INSTALL, ['python', '-m', 'pip', 'install', '-r', 'requirements.txt'], true);
    return null;
  },
  buildSteps() { return []; },
  testSteps(detection) {
    if (!detection.hasPytest) return [];
    return [step('test', VerificationKind.TEST, ['python', '-m', 'pytest'], true)];
  },
  lintSteps(detection) {
    if (detection.hasRuff) return [step('lint', VerificationKind.LINT, ['ruff', 'check', '.'], false)];
    if (detection.hasFlake) return [step('lint', VerificationKind.LINT, ['flake8'], false)];
    return [];
  },
  staticAnalysisSteps() { return []; },
  securitySteps() { return []; }
};

function step(id, kind, command, required) {
  return { id, kind, command, required, toolchain: ProjectTypes.PYTHON };
}

export function pythonPolicy(detection) {
  return {
    build: PolicyLevel.NOT_APPLICABLE,
    tests: detection.hasPytest ? PolicyLevel.REQUIRED : PolicyLevel.NOT_APPLICABLE,
    lint: detection.hasRuff || detection.hasFlake ? PolicyLevel.OPTIONAL : PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: PolicyLevel.NOT_APPLICABLE,
    security: PolicyLevel.OPTIONAL
  };
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}
