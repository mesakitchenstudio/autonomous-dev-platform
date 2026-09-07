import fs from 'node:fs/promises';
import path from 'node:path';
import { runVerificationCommand } from '../../verify/runner.js';
import { buildVerificationEnv } from '../../verify/env.js';
import { intEnv } from '../../util/env.js';
import { isInsideRoot, resolveCanonicalSync } from '../../git/boundary.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { SupportStatus } from '../kinds.js';

export function provisioningTimeoutMs() {
  return intEnv('PROVISIONING_TIMEOUT_MS', 300000);
}

export async function writeFiles(workspacePath, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const dest = path.join(workspacePath, rel);
    if (!isInsideRoot(dest, workspacePath)) {
      throw new PlatformError({
        code: ErrorCode.WORKSPACE_UNSAFE,
        message: `Provisioner refused to write outside the workspace: ${rel}`,
        phase: 'PROJECT_PROVISIONING',
        retryable: false
      });
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, contents, 'utf8');
  }
}

export async function runGenerator({ argv, cwd, workspaceRoot, logPath }) {
  if (!Array.isArray(argv) || !argv.length) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_COMMAND_INVALID,
      message: 'Generator command must be an argument array from the provisioner.',
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  if (typeof argv[0] !== 'string' || argv.some(item => typeof item !== 'string')) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_COMMAND_INVALID,
      message: 'Generator arguments must be strings.',
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  const workdir = resolveCanonicalSync(cwd);
  const root = resolveCanonicalSync(workspaceRoot || cwd);
  if (!isInsideRoot(workdir, root)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Generator cwd is outside the managed workspace.',
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  return runVerificationCommand({
    argv,
    cwd: workdir,
    workspaceRoot: root,
    timeoutMs: provisioningTimeoutMs(),
    env: buildVerificationEnv(),
    logPath,
    kind: 'DEPENDENCY_INSTALL'
  });
}

export function baseProvisioner({
  id,
  supportStatus,
  requiredCapabilities = [],
  templateFor,
  inspectResult,
  verificationHints = () => [],
  restartSafe = true
}) {
  return {
    id,
    supportStatus: typeof supportStatus === 'function' ? supportStatus : () => supportStatus || SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: typeof requiredCapabilities === 'function' ? requiredCapabilities : () => requiredCapabilities,
    templateFor,
    validatePlan(plan) {
      if (!plan?.identity?.projectName) {
        throw new PlatformError({
          code: ErrorCode.PROVISIONING_PLAN_INVALID,
          message: 'Provisioning plan is missing a sanitized project name.',
          phase: 'PROJECT_PROVISIONING',
          retryable: false
        });
      }
      return true;
    },
    inspectResult,
    verificationHints,
    restartSafe
  };
}
