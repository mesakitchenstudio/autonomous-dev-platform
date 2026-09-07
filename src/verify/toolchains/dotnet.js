import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyLevel, ProjectTypes, VerificationKind } from '../kinds.js';

export const DotnetToolchain = {
  name: ProjectTypes.DOTNET,
  async canHandle(workspace) {
    const names = await fs.readdir(workspace).catch(() => []);
    return names.some(name => name.endsWith('.sln') || name.endsWith('.csproj'));
  },
  async detect(workspace) {
    const names = await fs.readdir(workspace).catch(() => []);
    return {
      toolchain: ProjectTypes.DOTNET,
      solutions: names.filter(name => name.endsWith('.sln')),
      projects: names.filter(name => name.endsWith('.csproj'))
    };
  },
  dependencyInstallStep() {
    return step('restore', VerificationKind.DEPENDENCY_INSTALL, ['dotnet', 'restore'], true);
  },
  buildSteps() {
    return [step('build', VerificationKind.BUILD, ['dotnet', 'build', '--no-restore'], true)];
  },
  testSteps() {
    return [step('test', VerificationKind.TEST, ['dotnet', 'test', '--no-build'], true)];
  },
  lintSteps() { return []; },
  staticAnalysisSteps() { return []; },
  securitySteps() { return []; }
};

function step(id, kind, command, required) {
  return { id, kind, command, required, toolchain: ProjectTypes.DOTNET };
}

export function dotnetPolicy() {
  return {
    build: PolicyLevel.REQUIRED,
    tests: PolicyLevel.REQUIRED,
    lint: PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: PolicyLevel.NOT_APPLICABLE,
    security: PolicyLevel.OPTIONAL
  };
}
