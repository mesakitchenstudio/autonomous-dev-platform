import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { createEvidence, EvidenceProvenance, EvidenceStatus, VerificationLevel } from '../orchestrator/evidence.js';
import { managedWorkspaceRoot, RepositoryType, LifecycleStatus } from '../git/worktree.js';
import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { autonomousBranchName } from '../git/policy.js';
import { writeLogArtifact } from '../verify/artifacts.js';
import { runPlatformVerification } from '../verify/pipeline.js';
import { ProvisioningStatus, SupportStatus } from './kinds.js';
import { createProvisioningPlan, findReusableProvisioning, hashPlan } from './plan.js';
import { resolveUnsupportedArchitecture } from './architecture.js';
import { createProvisioningBaseline, listWorkspaceFiles } from './git.js';
import { validateScaffold } from './validate.js';
import { discoverToolchainVersions } from './versions.js';
import { applyProvisioningToCursorPrompt } from './cursor-context.js';
import { assertKnownTemplate } from './templates.js';

export function latestProvisioningRun(project) {
  const runs = project.provisioningRuns || [];
  return runs.length ? runs[runs.length - 1] : null;
}

export async function prepareEmptyWorkspace(project, workspaceRoot = managedWorkspaceRoot()) {
  const root = resolveCanonicalSync(workspaceRoot);
  const workspacePath = path.join(root, project.id, 'repo');
  await fs.mkdir(workspacePath, { recursive: true });
  const resolved = resolveCanonicalSync(workspacePath);
  if (!isInsideRoot(resolved, root)) {
    throw new PlatformError({
      code: ErrorCode.WORKSPACE_UNSAFE,
      message: 'Managed workspace path escaped the platform root.',
      phase: 'PROJECT_PROVISIONING',
      retryable: false
    });
  }
  return {
    repositoryType: RepositoryType.UNPROVISIONED_NEW_PROJECT,
    repositorySource: 'managed',
    canonicalPath: resolved,
    ownerPath: null,
    remoteUrl: null,
    cloudRepositoryUrl: project.repository?.cloudRepositoryUrl || null,
    remoteProvider: null,
    baseRef: autonomousBranchName(project.id),
    baselineSha: project.repository?.baselineSha || null,
    provisioningBaselineSha: project.repository?.provisioningBaselineSha || null,
    workingBranch: autonomousBranchName(project.id),
    workspacePath: resolved,
    ownerWorkingTreeDirty: false,
    cursorBackend: project.repository?.cursorBackend || null,
    lifecycleStatus: LifecycleStatus.ACTIVE,
    cleanupStatus: null,
    createdAt: project.repository?.createdAt || new Date().toISOString()
  };
}

export async function runProjectProvisioning({
  project,
  workspace,
  council,
  demo,
  owns,
  dbReady
} = {}) {
  if (typeof owns === 'function' && !(await owns())) {
    throw new PlatformError({
      code: ErrorCode.JOB_LEASE_LOST,
      message: 'Worker does not own the provisioning job.',
      phase: 'PROJECT_PROVISIONING',
      retryable: true
    });
  }
  if (typeof dbReady === 'function' && !(await dbReady())) {
    throw new PlatformError({
      code: ErrorCode.DATABASE_UNAVAILABLE,
      message: 'Database is unavailable; provisioning was not started.',
      phase: 'PROJECT_PROVISIONING',
      retryable: true
    });
  }

  const architecture = await resolveUnsupportedArchitecture(project, council, { demo: demo || project.demo });
  if (!architecture.supported && !demo && !project.demo) {
    throw new PlatformError({
      code: architecture.blockedByInfrastructure ? ErrorCode.PROVISIONING_INFRASTRUCTURE_UNAVAILABLE : ErrorCode.PROVISIONING_UNSUPPORTED,
      message: architecture.blockedByInfrastructure
        ? 'The requested platform requires infrastructure this worker does not have. The product requirement was not changed.'
        : 'The selected stack is not supported by available provisioning infrastructure.',
      phase: 'PROJECT_PROVISIONING',
      retryable: architecture.blockedByInfrastructure,
      details: { profile: architecture.profile, alternatives: architecture.alternatives }
    });
  }

  const plan = project.provisioningPlan?.hash
    ? project.provisioningPlan
    : createProvisioningPlan(project, { profile: architecture.profile, provisioner: architecture.provisioner });
  if (project.council?.discovery?.spec?.templateId) {
    assertKnownTemplate(project.council.discovery.spec.templateId);
  }
  const reused = findReusableProvisioning(project, plan);
  if (reused) return { ...reused, reused: true, plan };

  const existing = latestProvisioningRun(project);
  if (existing?.status === ProvisioningStatus.PASS && existing.baselineSha && existing.planHash === plan.hash) {
    return { ...existing, reused: true, plan };
  }

  const provisioner = architecture.provisioner;
  provisioner.validatePlan?.(plan);
  const workspaceRoot = workspace?.root || managedWorkspaceRoot();
  project.repository = await prepareEmptyWorkspace(project, workspaceRoot);
  const workspacePath = project.repository.workspacePath;
  const entries = await fs.readdir(workspacePath).catch(() => []);
  if (existing && entries.length && !existing.baselineSha && provisioner.restartSafe === false) {
    return recoveryRun(project, plan, 'Generator started but completion was not recorded.');
  }

  const run = {
    id: crypto.randomUUID(),
    projectId: project.id,
    planHash: plan.hash,
    provisioner: provisioner.id,
    templateId: plan.templateId,
    status: ProvisioningStatus.FAIL,
    supportStatus: provisioner.supportStatus?.(plan.profile) || SupportStatus.UNSUPPORTED,
    identity: plan.identity,
    capabilitiesRequired: plan.capabilitiesRequired,
    steps: [],
    toolchainVersions: discoverToolchainVersions(plan.capabilitiesRequired),
    createdFiles: [],
    baselineSha: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    blockingFailures: [],
    reused: false
  };

  const log = await writeLogArtifact({
    projectId: project.id,
    iteration: 0,
    kind: 'provisioning',
    contents: `Provisioning ${provisioner.id} for ${plan.identity.productName}\n`
  }).catch(() => null);

  let generated;
  try {
    generated = await provisioner.provision({
      workspacePath,
      plan,
      project,
      logPath: log?.path
    });
    if (generated?.exitCode != null && generated.exitCode !== 0) {
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_FAILED,
        message: `Generator exited ${generated.exitCode}`,
        phase: 'PROJECT_PROVISIONING',
        retryable: true,
        details: { stderr: generated.stderrPreview || null }
      });
    }
    run.steps.push(step('generate', 'GENERATE', 'PASS', generated?.command, generated?.exitCode, generated?.durationMs, generated?.stdoutPreview, generated?.stderrPreview));
  } catch (error) {
    run.steps.push(step('generate', 'GENERATE', 'FAIL', error.details?.command, error.details?.exitCode, null, null, error.message));
    run.blockingFailures.push({ code: error.code || ErrorCode.PROVISIONING_FAILED, message: error.message });
    run.completedAt = new Date().toISOString();
    throw error;
  }

  plan.generator = { ...plan.generator, ...(generated?.generator || {}) };
  plan.hash = hashPlan(plan);
  run.planHash = plan.hash;
  run.generator = generated?.generator || plan.generator;
  run.createdFiles = generated?.createdFiles || await listWorkspaceFiles(workspacePath);

  await validateScaffold({
    workspacePath,
    workspaceRoot,
    expectedFiles: plan.expectedOutputs,
    anyFiles: plan.expectedAnyOutputs,
    identity: plan.identity,
    plan
  });
  run.steps.push(step('validate', 'VALIDATE', 'PASS'));

  const baseline = await createProvisioningBaseline(workspacePath, {
    workspaceRoot,
    projectId: project.id
  });
  run.baselineSha = baseline.baselineSha;
  run.createdFiles = baseline.files;
  run.steps.push(step('baseline', 'GIT_BASELINE', 'PASS'));

  project.repository = {
    ...project.repository,
    repositoryType: 'PROVISIONED_NEW_PROJECT',
    baselineSha: baseline.baselineSha,
    provisioningBaselineSha: baseline.baselineSha,
    workingBranch: baseline.branch,
    baseRef: baseline.branch
  };

  let starter = null;
  if (!demo && !project.demo && !generated?.mock) {
    starter = await runPlatformVerification({
      project: {
        ...project,
        iteration: 0,
        demo: false,
        repository: { ...project.repository, repositoryType: 'PROVISIONED_NEW_PROJECT' },
        cursorRuns: [{ checkpointSha: baseline.baselineSha, git: { afterSha: baseline.baselineSha, checkpointSha: baseline.baselineSha } }]
      },
      workspacePath,
      demo: false
    });
    const failed = (starter.blockingFailures || []).length > 0 || starter.status === 'FAIL';
    run.steps.push(step('starter-verify', 'STARTER_VERIFICATION', failed ? 'FAIL' : 'PASS'));
    run.starterVerification = {
      id: starter.id,
      status: starter.status,
      blockingFailures: starter.blockingFailures,
      policy: starter.policy
    };
    if (failed) {
      run.completedAt = new Date().toISOString();
      run.blockingFailures.push({ code: 'STARTER_VERIFICATION_FAILED', message: 'Generated starter failed platform verification.' });
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_STARTER_INVALID,
        message: 'Generator completed but the starter failed independent platform verification. Feature implementation will not start.',
        phase: 'PROJECT_PROVISIONING',
        retryable: false,
        details: { blockingFailures: starter.blockingFailures }
      });
    }
  } else {
    run.steps.push(step('starter-verify', 'STARTER_VERIFICATION', 'NOT_APPLICABLE'));
  }

  run.status = ProvisioningStatus.PASS;
  run.completedAt = new Date().toISOString();
  run.evidence = {
    status: ProvisioningStatus.PASS,
    provenance: generated?.mock || demo || project.demo ? EvidenceProvenance.MOCK : EvidenceProvenance.PLATFORM_VERIFIED,
    templateId: plan.templateId,
    baselineSha: baseline.baselineSha,
    generatorVersion: run.generator?.version || null
  };
  run.plan = plan;
  return run;
}

export function applyProvisioningResult(project, run) {
  project.provisioningPlan = run.plan || project.provisioningPlan;
  project.provisioningRuns = [...(project.provisioningRuns || []).filter(item => item.id !== run.id), run];
  project.components = (run.plan?.components || [{ id: 'primary', path: '.', provisioner: run.provisioner }]).map(item => ({
    ...item,
    status: run.status === ProvisioningStatus.PASS ? 'PROVISIONED' : item.status
  }));
  project.provisioning = {
    status: run.status,
    provenance: run.evidence?.provenance || EvidenceProvenance.PLATFORM_VERIFIED,
    templateId: run.templateId,
    baselineSha: run.baselineSha,
    generatorVersion: run.generator?.version || null,
    planHash: run.planHash
  };
  if (run.baselineSha) {
    project.repository = {
      ...(project.repository || {}),
      repositoryType: 'PROVISIONED_NEW_PROJECT',
      provisioningBaselineSha: run.baselineSha,
      baselineSha: project.repository?.baselineSha || run.baselineSha
    };
  }
  if (run.status === ProvisioningStatus.PASS) {
    project.activePrompt = applyProvisioningToCursorPrompt(project, run);
  }
  if (project.evidence) {
    project.evidence = createEvidence({
      ...project.evidence,
      provisioning: {
        status: run.status === ProvisioningStatus.PASS ? EvidenceStatus.PASS : EvidenceStatus.FAIL,
        provenance: run.evidence?.provenance || EvidenceProvenance.PLATFORM_VERIFIED,
        detail: `template=${run.templateId || 'none'} baseline=${run.baselineSha || 'none'}`
      }
    });
  }
  return project;
}

function recoveryRun(project, plan, message) {
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    planHash: plan.hash,
    status: ProvisioningStatus.RECOVERY_REQUIRED,
    message,
    completedAt: new Date().toISOString()
  };
}

function step(id, kind, status, command, exitCode, durationMs, stdoutPreview, stderrPreview) {
  return {
    id,
    kind,
    required: true,
    status,
    provenance: EvidenceProvenance.PLATFORM_VERIFIED,
    command: command || [],
    exitCode: exitCode ?? null,
    durationMs: durationMs ?? null,
    stdoutPreview: stdoutPreview || null,
    stderrPreview: stderrPreview || null
  };
}

export { hashPlan };
