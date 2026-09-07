import crypto from 'node:crypto';
import { ProvisioningStatus, VersionPolicy } from './kinds.js';
import { buildIdentity, defaultOrganization } from './names.js';
import { inferProfileFromSpec, normalizeProfile } from './profile.js';
import { selectTemplate, templateById } from './templates.js';
import { resolveProvisioner } from './registry.js';
import { validateProvisioningSecurity } from '../security/ai-policy.js';

export function hashPlan(plan) {
  const material = {
    provisioner: plan.provisioner,
    templateId: plan.templateId,
    identity: plan.identity,
    options: plan.generator?.options || {},
    components: (plan.components || []).map(item => ({ id: item.id, provisioner: item.provisioner, path: item.path }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function createProvisioningPlan(project, extras = {}) {
  const spec = project.council?.discovery?.spec || {};
  const profile = extras.profile || inferProfileFromSpec(spec, project.idea);
  const identity = extras.identity || buildIdentity(spec.productName || spec.product?.name || project.idea, extras.organization || defaultOrganization());
  const provisioner = extras.provisioner || resolveProvisioner(profile, { demo: project.demo });
  const template = extras.template || templateById(extras.templateId) || provisioner.templateFor?.(profile) || selectTemplate(profile);
  const supportStatus = provisioner.supportStatus?.(profile) || template?.supportStatus;
  const capabilitiesRequired = [...new Set([
    ...(provisioner.requiredCapabilities?.(profile) || []),
    ...(template?.requiredCapabilities || [])
  ])];
  const component = {
    id: extras.componentId || 'primary',
    path: extras.componentPath || '.',
    profile,
    provisioner: provisioner.id,
    templateId: template?.id || null,
    status: 'PLANNED'
  };
  const plan = {
    profile,
    provisioner: provisioner.id,
    supportStatus,
    templateId: template?.id || null,
    generator: {
      name: template?.generator?.name || provisioner.id,
      version: extras.generatorVersion || null,
      template: template?.generator?.template || null,
      options: { ...(template?.defaultOptions || {}), ...(extras.options || {}) }
    },
    identity,
    capabilitiesRequired,
    steps: [
      { id: 'prepare', kind: 'PREPARE_WORKSPACE', required: true },
      { id: 'generate', kind: 'GENERATE', required: true },
      { id: 'validate', kind: 'VALIDATE', required: true },
      { id: 'secrets', kind: 'SECRET_CHECK', required: true },
      { id: 'baseline', kind: 'GIT_BASELINE', required: true },
      { id: 'starter-verify', kind: 'STARTER_VERIFICATION', required: !project.demo }
    ],
    expectedOutputs: template?.validation?.files || [],
    expectedAnyOutputs: template?.validation?.anyFiles || [],
    verification: provisioner.verificationHints?.(profile) || [],
    components: extras.components || [component],
    versionPolicy: process.env.PROVISIONER_VERSION_POLICY || VersionPolicy.CURRENT_SUPPORTED,
    createdAt: new Date().toISOString()
  };
  plan.hash = hashPlan(plan);
  plan.status = ProvisioningStatus.NOT_RUN;
  validateProvisioningSecurity(plan);
  return plan;
}

export function provisioningIdempotencyKey(project, plan) {
  return `project:${project.id}:provision:${plan?.hash || 'none'}`;
}

export function needsProvisioning(project) {
  if (isExistingRepositoryProject(project)) return false;
  if (project.provisioning?.status === ProvisioningStatus.NOT_APPLICABLE) return false;
  return true;
}

export function isExistingRepositoryProject(project) {
  const type = project.repository?.repositoryType;
  if (type === 'EXISTING_LOCAL' || type === 'EXISTING_REMOTE') return true;
  return Boolean(project.projectPath);
}

export function provisioningSucceeded(project) {
  const run = latestProvisioningRun(project);
  return Boolean(
    run?.status === ProvisioningStatus.PASS
    && (run.baselineSha || project.repository?.provisioningBaselineSha)
  );
}

export function latestProvisioningRun(project) {
  const runs = project.provisioningRuns || [];
  return runs.length ? runs[runs.length - 1] : null;
}

export function findReusableProvisioning(project, plan) {
  const hash = plan?.hash;
  return (project.provisioningRuns || []).find(item => (
    item.planHash === hash
    && item.status === ProvisioningStatus.PASS
    && item.baselineSha
    && item.completedAt
  )) || null;
}

export { normalizeProfile };
