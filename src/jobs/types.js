import { ProjectState, isOwnerTerminal } from '../orchestrator/states.js';
import { needsProvisioning, provisioningSucceeded, provisioningIdempotencyKey } from '../provision/plan.js';
import { resolveSecurityProfile, isHardenedProfile } from '../security/policy.js';
import { WorkerCapability } from '../capabilities/kinds.js';

export const JobType = Object.freeze({
  COUNCIL_DISCOVERY: 'COUNCIL_DISCOVERY',
  PROJECT_PROVISIONING: 'PROJECT_PROVISIONING',
  CURSOR_EXECUTION: 'CURSOR_EXECUTION',
  PLATFORM_VERIFICATION: 'PLATFORM_VERIFICATION',
  RUNTIME_VERIFICATION: 'RUNTIME_VERIFICATION',
  VISUAL_VERIFICATION: 'VISUAL_VERIFICATION',
  COUNCIL_REVIEW: 'COUNCIL_REVIEW',
  FINAL_VERIFICATION: 'FINAL_VERIFICATION'
});

export const JobStatus = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  DEAD: 'DEAD'
});

export function nextJobType(project) {
  if (!project || isOwnerTerminal(project.state) || project.state === ProjectState.FAILED) return null;
  if (project.state === ProjectState.IDEA_SUBMITTED || project.state === ProjectState.COUNCIL_DISCOVERY) return JobType.COUNCIL_DISCOVERY;
  if (project.state === ProjectState.SPECIFICATION_READY) {
    if (needsProvisioning(project) && !provisioningSucceeded(project)) return JobType.PROJECT_PROVISIONING;
    return JobType.CURSOR_EXECUTION;
  }
  if (project.state === ProjectState.PROJECT_PROVISIONING) return JobType.PROJECT_PROVISIONING;
  if (project.state === ProjectState.CURSOR_EXECUTING) return JobType.CURSOR_EXECUTION;
  if (project.state === ProjectState.PLATFORM_VERIFICATION) return JobType.PLATFORM_VERIFICATION;
  if (project.state === ProjectState.RUNTIME_VERIFICATION) return JobType.RUNTIME_VERIFICATION;
  if (project.state === ProjectState.VISUAL_VERIFICATION) return JobType.VISUAL_VERIFICATION;
  if (project.state === ProjectState.COUNCIL_REVIEW) return JobType.COUNCIL_REVIEW;
  if (project.state === ProjectState.FINAL_VERIFICATION) return JobType.FINAL_VERIFICATION;
  return null;
}

export function jobIdempotencyKey(project, jobType) {
  if (jobType === JobType.COUNCIL_DISCOVERY) return `project:${project.id}:discovery`;
  if (jobType === JobType.PROJECT_PROVISIONING) {
    return provisioningIdempotencyKey(project, project.provisioningPlan);
  }
  if (jobType === JobType.CURSOR_EXECUTION) {
    const iteration = project.state === ProjectState.SPECIFICATION_READY ? (project.iteration || 0) + 1 : (project.iteration || 1);
    return `project:${project.id}:cursor:${iteration}`;
  }
  if (jobType === JobType.PLATFORM_VERIFICATION) {
    const last = (project.cursorRuns || []).at(-1);
    const sha = last?.checkpointSha || last?.git?.checkpointSha || last?.git?.afterSha || 'none';
    return `project:${project.id}:verification:${project.iteration || 1}:${sha}`;
  }
  if (jobType === JobType.RUNTIME_VERIFICATION) {
    const last = (project.cursorRuns || []).at(-1);
    const sha = last?.checkpointSha || last?.git?.checkpointSha || last?.git?.afterSha || 'none';
    const artifact = latestArtifactHash(project) || 'none';
    return `project:${project.id}:runtime:${project.iteration || 1}:${sha}:${artifact}`;
  }
  if (jobType === JobType.VISUAL_VERIFICATION) {
    const runtime = (project.runtimeRuns || []).at(-1);
    const setHash = runtime?.screenshotSetHash || screenshotSetHash(runtime) || 'none';
    return `project:${project.id}:visual:${runtime?.id || 'none'}:${setHash}`;
  }
  if (jobType === JobType.COUNCIL_REVIEW) return `project:${project.id}:review:${project.iteration || 1}`;
  if (jobType === JobType.FINAL_VERIFICATION) return `project:${project.id}:final:${(project.cursorRuns || []).length}`;
  throw new Error(`Unknown job type ${jobType}`);
}

export function jobPhase(jobType) {
  return jobType;
}

export function plannedJob(project) {
  const jobType = nextJobType(project);
  if (!jobType) return null;
  return {
    jobType,
    phase: jobPhase(jobType),
    iteration: Number(project.iteration || 0),
    idempotencyKey: jobIdempotencyKey(project, jobType),
    requiredCapabilities: requiredCapabilitiesForJob(project, jobType)
  };
}

export function requiredCapabilitiesForJob(project, jobType) {
  const caps = [];
  if (jobType === JobType.PROJECT_PROVISIONING) {
    caps.push(...(project.provisioningPlan?.capabilitiesRequired || []));
  }
  if (jobType === JobType.RUNTIME_VERIFICATION) {
    caps.push(...(project.runtimePlan?.requiredCapabilities || inferRuntimeCapabilities(project)));
  }
  if (jobType === JobType.VISUAL_VERIFICATION) {
    const visual = project.runtimePlan?.visualReview?.required !== false
      && (project.runtimePlan?.applicationKind === 'WEB_UI'
        || project.runtimePlan?.applicationKind === 'ANDROID'
        || project.runtimePlan?.applicationKind === 'IOS'
        || project.runtimePlan?.applicationKind === 'DESKTOP');
    if (visual) caps.push('VISION_REVIEW');
  }
  const profile = resolveSecurityProfile(process.env, project);
  const sandboxed = [
    JobType.PROJECT_PROVISIONING,
    JobType.CURSOR_EXECUTION,
    JobType.PLATFORM_VERIFICATION,
    JobType.RUNTIME_VERIFICATION
  ].includes(jobType);
  if (sandboxed && isHardenedProfile(profile) && !project?.demo) {
    caps.push(WorkerCapability.CONTAINER_SANDBOX);
  }
  return [...new Set(caps)];
}

function latestArtifactHash(project) {
  const run = (project.verificationRuns || []).at(-1);
  const artifact = (run?.artifacts || []).find(item => item.sha256 && (item.kind === 'build_output' || item.type === 'build_output'));
  return artifact?.sha256 || project.runtimePlan?.artifactHash || null;
}

function screenshotSetHash(runtime) {
  const hashes = (runtime?.screenshots || []).map(item => item.sha256).filter(Boolean).sort();
  return hashes.length ? hashes.join(',') : null;
}

function inferRuntimeCapabilities(project) {
  const kind = project.runtimePlan?.applicationKind
    || String(project.council?.discovery?.spec?.projectType || '').toUpperCase();
  if (kind === 'ANDROID') return ['ANDROID_SDK', 'ANDROID_EMULATOR'];
  if (kind === 'IOS' || kind === 'IOS/MACOS' || kind === 'APPLE') return ['MACOS', 'IOS_SIMULATOR'];
  if (kind === 'WEB_UI' || kind === 'WEB' || kind === 'APPLICATION') return ['WEB_CHROMIUM'];
  return [];
}
