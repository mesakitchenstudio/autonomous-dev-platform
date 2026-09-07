import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { baseProvisioner, writeFiles } from './base.js';
import { commandVersion } from '../versions.js';

export const PYTHON_TEMPLATE_VERSION = '1.0.0';

export function pythonFiles(identity) {
  const pkg = identity.pythonName;
  return {
    'pyproject.toml': `[project]
name = "${pkg}"
version = "0.1.0"
description = "${identity.productName}"
requires-python = ">=3.10"

[tool.pytest.ini_options]
pythonpath = ["src"]
`,
    'src/app.py': `def health():
    return {"ok": True, "name": "${identity.productName}"}


if __name__ == "__main__":
    print(health())
`,
    'tests/test_app.py': `from app import health

def test_health():
    assert health()["ok"] is True
`,
    '.env.example': 'APP_ENV=development\n'
  };
}

export const PythonBackendProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.PYTHON_BACKEND,
    supportStatus: () => commandVersion('python', ['--version']).available
      ? SupportStatus.LIVE_SUPPORTED
      : SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.PYTHON],
    templateFor: () => templateById('backend.python')
  }),
  async provision({ workspacePath, plan }) {
    const files = pythonFiles(plan.identity);
    await writeFiles(workspacePath, files);
    return {
      generator: { name: 'adp-python-backend', version: PYTHON_TEMPLATE_VERSION, template: '1.0.0' },
      createdFiles: Object.keys(files),
      command: ['platform-template', 'adp-python-backend', PYTHON_TEMPLATE_VERSION],
      exitCode: 0
    };
  }
};
