export const VerificationKind = Object.freeze({
  DEPENDENCY_INSTALL: 'DEPENDENCY_INSTALL',
  BUILD: 'BUILD',
  TEST: 'TEST',
  LINT: 'LINT',
  STATIC_ANALYSIS: 'STATIC_ANALYSIS',
  SECURITY_CHECK: 'SECURITY_CHECK'
});

export const VerificationStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  PARTIAL: 'PARTIAL',
  SKIPPED: 'SKIPPED'
});

export const StepStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_RUN: 'NOT_RUN',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNKNOWN: 'UNKNOWN'
});

export const PolicyLevel = Object.freeze({
  REQUIRED: 'REQUIRED',
  OPTIONAL: 'OPTIONAL',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

export const ProjectTypes = Object.freeze({
  NODE: 'node',
  GRADLE: 'gradle',
  MAVEN: 'maven',
  PYTHON: 'python',
  RUST: 'rust',
  GO: 'go',
  DOTNET: 'dotnet',
  UNKNOWN: 'unknown',
  UNPROVISIONED: 'unprovisioned'
});
