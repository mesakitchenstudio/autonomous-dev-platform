import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyLevel, ProjectTypes, VerificationKind } from '../kinds.js';

export const RustToolchain = {
  name: ProjectTypes.RUST,
  async canHandle(workspace) {
    return exists(path.join(workspace, 'Cargo.toml'));
  },
  async detect(workspace) {
    const cargo = await fs.readFile(path.join(workspace, 'Cargo.toml'), 'utf8').catch(() => '');
    return {
      toolchain: ProjectTypes.RUST,
      clippy: await exists(path.join(workspace, 'clippy.toml')) || await exists(path.join(workspace, '.clippy.toml')),
      workspace: cargo.includes('[workspace]')
    };
  },
  dependencyInstallStep() { return null; },
  buildSteps() {
    return [step('build', VerificationKind.BUILD, ['cargo', 'build'], true)];
  },
  testSteps() {
    return [step('test', VerificationKind.TEST, ['cargo', 'test'], true)];
  },
  lintSteps(detection) {
    if (!detection.clippy) return [];
    return [step('lint', VerificationKind.LINT, ['cargo', 'clippy', '--', '-D', 'warnings'], false)];
  },
  staticAnalysisSteps() {
    return [step('check', VerificationKind.STATIC_ANALYSIS, ['cargo', 'check'], false)];
  },
  securitySteps() { return []; }
};

function step(id, kind, command, required) {
  return { id, kind, command, required, toolchain: ProjectTypes.RUST };
}

export function rustPolicy(detection) {
  return {
    build: PolicyLevel.REQUIRED,
    tests: PolicyLevel.REQUIRED,
    lint: detection.clippy ? PolicyLevel.OPTIONAL : PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: PolicyLevel.OPTIONAL,
    security: PolicyLevel.OPTIONAL
  };
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}
