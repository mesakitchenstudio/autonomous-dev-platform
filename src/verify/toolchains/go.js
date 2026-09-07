import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyLevel, ProjectTypes, VerificationKind } from '../kinds.js';

export const GoToolchain = {
  name: ProjectTypes.GO,
  async canHandle(workspace) {
    return exists(path.join(workspace, 'go.mod'));
  },
  async detect() {
    return { toolchain: ProjectTypes.GO };
  },
  dependencyInstallStep() { return null; },
  buildSteps() {
    return [step('build', VerificationKind.BUILD, ['go', 'build', './...'], true)];
  },
  testSteps() {
    return [step('test', VerificationKind.TEST, ['go', 'test', './...'], true)];
  },
  lintSteps() { return []; },
  staticAnalysisSteps() {
    return [step('vet', VerificationKind.STATIC_ANALYSIS, ['go', 'vet', './...'], false)];
  },
  securitySteps() { return []; }
};

function step(id, kind, command, required) {
  return { id, kind, command, required, toolchain: ProjectTypes.GO };
}

export function goPolicy() {
  return {
    build: PolicyLevel.REQUIRED,
    tests: PolicyLevel.REQUIRED,
    lint: PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: PolicyLevel.OPTIONAL,
    security: PolicyLevel.OPTIONAL
  };
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}
