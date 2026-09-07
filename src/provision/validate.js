import fs from 'node:fs/promises';
import path from 'node:path';
import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export async function validateScaffold({ workspacePath, workspaceRoot, expectedFiles = [], anyFiles = [], identity, plan }) {
  const root = resolveCanonicalSync(workspacePath);
  if (!isInsideRoot(root, workspaceRoot || root)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Generator output is outside the managed workspace.',
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_VALIDATION_FAILED,
      message: 'Provisioned workspace root does not exist.',
      phase: 'PROJECT_PROVISIONING',
      retryable: true
    });
  }
  const missing = [];
  for (const file of expectedFiles) {
    const candidate = path.join(root, file);
    if (!isInsideRoot(candidate, root)) {
      throw new PlatformError({
        code: ErrorCode.WORKSPACE_UNSAFE,
        message: `Validation path escaped workspace: ${file}`,
        phase: 'PROJECT_PROVISIONING',
        retryable: false
      });
    }
    if (!(await fs.stat(candidate).catch(() => null))) missing.push(file);
  }
  const groups = anyFiles.length ? anyFiles : (plan?.expectedAnyOutputs || []);
  for (const group of groups) {
    const options = Array.isArray(group) ? group : [group];
    let found = false;
    for (const file of options) {
      const candidate = path.join(root, file);
      if (!isInsideRoot(candidate, root)) {
        throw new PlatformError({
          code: ErrorCode.WORKSPACE_UNSAFE,
          message: `Validation path escaped workspace: ${file}`,
          phase: 'PROJECT_PROVISIONING',
          retryable: false
        });
      }
      if (await fs.stat(candidate).catch(() => null)) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(options.join(' or '));
  }
  if (missing.length) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_VALIDATION_FAILED,
      message: `Generator did not produce required files: ${missing.join(', ')}`,
      phase: 'PROJECT_PROVISIONING',
      retryable: true,
      details: { missing, templateId: plan?.templateId || null }
    });
  }
  if (identity?.projectName && /[\\/]/.test(identity.projectName)) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_IDENTITY_INVALID,
      message: 'Project identity contains a path separator.',
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  return { ok: true, missing: [], identity };
}

export function detectArchitectureReplacement(changedFiles = [], plan) {
  const files = changedFiles.map(item => String(item.path || item).replace(/\\/g, '/'));
  const highInterest = [];
  const manifests = ['package.json', 'pubspec.yaml', 'Cargo.toml', 'go.mod', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'pom.xml', 'pyproject.toml'];
  for (const file of files) {
    const base = file.split('/').pop();
    if (manifests.includes(base) && /deleted|removed/i.test(String(file.status || ''))) {
      highInterest.push({ path: file, reason: 'primary_manifest_deleted' });
    }
  }
  if (plan?.provisioner === 'VITE' && files.some(file => file.includes('next.config'))) {
    highInterest.push({ path: 'next.config', reason: 'incompatible_framework_scaffold' });
  }
  if (plan?.provisioner === 'ANDROID_NATIVE' && files.some(file => file === 'pubspec.yaml')) {
    highInterest.push({ path: 'pubspec.yaml', reason: 'incompatible_framework_scaffold' });
  }
  return {
    highRisk: highInterest.length > 0,
    files: highInterest
  };
}
