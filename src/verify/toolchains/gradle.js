import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyLevel, ProjectTypes, VerificationKind } from '../kinds.js';

export const GradleToolchain = {
  name: ProjectTypes.GRADLE,
  async canHandle(workspace) {
    const names = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradlew', 'gradlew.bat'];
    for (const name of names) {
      if (await exists(path.join(workspace, name))) return true;
    }
    return false;
  },
  async detect(workspace) {
    const wrapperUnix = await exists(path.join(workspace, 'gradlew'));
    const wrapperWin = await exists(path.join(workspace, 'gradlew.bat'));
    const android = await fileContainsAny(workspace, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], [
      'com.android.application', 'com.android.library', 'org.jetbrains.kotlin.android'
    ]);
    const lintConfigured = await fileContainsAny(workspace, ['build.gradle', 'build.gradle.kts'], ['lint {', 'lint {', '"lint"', "'lint'"]);
    return {
      toolchain: ProjectTypes.GRADLE,
      wrapper: wrapperWin || wrapperUnix,
      wrapperCommand: process.platform === 'win32' && wrapperWin ? 'gradlew.bat' : (wrapperUnix ? 'gradlew' : null),
      android,
      lintConfigured
    };
  },
  dependencyInstallStep() {
    return null;
  },
  buildSteps(detection) {
    const bin = wrapper(detection);
    if (!bin) return [];
    return [step('build', VerificationKind.BUILD, [bin, 'build', '-q'], true)];
  },
  testSteps(detection) {
    const bin = wrapper(detection);
    if (!bin) return [];
    return [step('test', VerificationKind.TEST, [bin, 'test', '-q'], true)];
  },
  lintSteps(detection) {
    if (!detection.lintConfigured && !detection.android) return [];
    const bin = wrapper(detection);
    if (!bin) return [];
    return [step('lint', VerificationKind.LINT, [bin, 'lint', '-q'], false)];
  },
  staticAnalysisSteps() { return []; },
  securitySteps() { return []; }
};

function wrapper(detection) {
  if (!detection.wrapperCommand) return null;
  return detection.wrapperCommand === 'gradlew.bat' ? 'gradlew.bat' : './gradlew';
}

function step(id, kind, command, required) {
  return { id, kind, command, required, toolchain: ProjectTypes.GRADLE };
}

export function gradlePolicy(detection) {
  if (!detection.wrapper) {
    return {
      build: PolicyLevel.NOT_APPLICABLE,
      tests: PolicyLevel.NOT_APPLICABLE,
      lint: PolicyLevel.NOT_APPLICABLE,
      staticAnalysis: PolicyLevel.NOT_APPLICABLE,
      security: PolicyLevel.OPTIONAL
    };
  }
  return {
    build: PolicyLevel.REQUIRED,
    tests: PolicyLevel.REQUIRED,
    lint: detection.lintConfigured || detection.android ? PolicyLevel.OPTIONAL : PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: PolicyLevel.NOT_APPLICABLE,
    security: PolicyLevel.OPTIONAL
  };
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}

async function fileContainsAny(workspace, files, needles) {
  for (const file of files) {
    const raw = await fs.readFile(path.join(workspace, file), 'utf8').catch(() => '');
    if (needles.some(needle => raw.includes(needle))) return true;
  }
  return false;
}
