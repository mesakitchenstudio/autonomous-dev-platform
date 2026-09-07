import { NodeToolchain, nodePolicy } from './toolchains/node.js';
import { GradleToolchain, gradlePolicy } from './toolchains/gradle.js';
import { MavenToolchain, mavenPolicy } from './toolchains/maven.js';
import { PythonToolchain, pythonPolicy } from './toolchains/python.js';
import { RustToolchain, rustPolicy } from './toolchains/rust.js';
import { GoToolchain, goPolicy } from './toolchains/go.js';
import { DotnetToolchain, dotnetPolicy } from './toolchains/dotnet.js';
import { PolicyLevel, ProjectTypes } from './kinds.js';
import { RepositoryType } from '../git/worktree.js';

const TOOLCHAINS = [
  GradleToolchain,
  NodeToolchain,
  MavenToolchain,
  PythonToolchain,
  RustToolchain,
  GoToolchain,
  DotnetToolchain
];

const POLICIES = {
  [ProjectTypes.NODE]: nodePolicy,
  [ProjectTypes.GRADLE]: gradlePolicy,
  [ProjectTypes.MAVEN]: mavenPolicy,
  [ProjectTypes.PYTHON]: pythonPolicy,
  [ProjectTypes.RUST]: rustPolicy,
  [ProjectTypes.GO]: goPolicy,
  [ProjectTypes.DOTNET]: dotnetPolicy
};

export async function detectToolchains(workspacePath) {
  const detected = [];
  for (const toolchain of TOOLCHAINS) {
    if (await toolchain.canHandle(workspacePath)) {
      detected.push({
        adapter: toolchain,
        detection: await toolchain.detect(workspacePath)
      });
    }
  }
  return detected;
}

export function mergePolicy(detections, { unprovisioned = false } = {}) {
  if (unprovisioned) {
    return {
      build: PolicyLevel.NOT_APPLICABLE,
      tests: PolicyLevel.NOT_APPLICABLE,
      lint: PolicyLevel.NOT_APPLICABLE,
      staticAnalysis: PolicyLevel.NOT_APPLICABLE,
      security: PolicyLevel.NOT_APPLICABLE,
      unprovisioned: true
    };
  }
  if (!detections.length) {
    return {
      build: PolicyLevel.NOT_APPLICABLE,
      tests: PolicyLevel.NOT_APPLICABLE,
      lint: PolicyLevel.NOT_APPLICABLE,
      staticAnalysis: PolicyLevel.NOT_APPLICABLE,
      security: PolicyLevel.OPTIONAL
    };
  }
  const empty = {
    build: PolicyLevel.NOT_APPLICABLE,
    tests: PolicyLevel.NOT_APPLICABLE,
    lint: PolicyLevel.NOT_APPLICABLE,
    staticAnalysis: PolicyLevel.NOT_APPLICABLE,
    security: PolicyLevel.OPTIONAL
  };
  return detections.reduce((policy, item) => {
    const next = POLICIES[item.adapter.name]?.(item.detection) || empty;
    return {
      build: stronger(policy.build, next.build),
      tests: stronger(policy.tests, next.tests),
      lint: stronger(policy.lint, next.lint),
      staticAnalysis: stronger(policy.staticAnalysis, next.staticAnalysis),
      security: stronger(policy.security, next.security)
    };
  }, empty);
}

function stronger(a, b) {
  const rank = { [PolicyLevel.REQUIRED]: 3, [PolicyLevel.OPTIONAL]: 2, [PolicyLevel.NOT_APPLICABLE]: 1 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

export function primaryProjectType(detections, repository) {
  if (repository?.repositoryType === RepositoryType.UNPROVISIONED_NEW_PROJECT) return ProjectTypes.UNPROVISIONED;
  return detections[0]?.adapter.name || ProjectTypes.UNKNOWN;
}

export { TOOLCHAINS };
