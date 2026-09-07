import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyLevel, ProjectTypes, VerificationKind } from '../kinds.js';

export const MavenToolchain = {
  name: ProjectTypes.MAVEN,
  async canHandle(workspace) {
    return exists(path.join(workspace, 'pom.xml'));
  },
  async detect(workspace) {
    const wrapper = await exists(path.join(workspace, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'))
      || await exists(path.join(workspace, 'mvnw'))
      || await exists(path.join(workspace, 'mvnw.cmd'));
    return {
      toolchain: ProjectTypes.MAVEN,
      wrapper,
      wrapperCommand: process.platform === 'win32' && await exists(path.join(workspace, 'mvnw.cmd')) ? 'mvnw.cmd' : (await exists(path.join(workspace, 'mvnw')) ? './mvnw' : null)
    };
  },
  dependencyInstallStep() { return null; },
  buildSteps(detection) {
    const bin = detection.wrapperCommand || 'mvn';
    return [step('build', VerificationKind.BUILD, [bin, '-q', '-DskipTests', 'package'], true)];
  },
  testSteps(detection) {
    const bin = detection.wrapperCommand || 'mvn';
    return [step('test', VerificationKind.TEST, [bin, '-q', 'test'], true)];
  },
  lintSteps() { return []; },
  staticAnalysisSteps() { return []; },
  securitySteps() { return []; }
};

function step(id, kind, command, required) {
  return { id, kind, command, required, toolchain: ProjectTypes.MAVEN };
}

export function mavenPolicy() {
  return {
    build: PolicyLevel.REQUIRED,
    tests: PolicyLevel.REQUIRED,
    lint: PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: PolicyLevel.NOT_APPLICABLE,
    security: PolicyLevel.OPTIONAL
  };
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}
