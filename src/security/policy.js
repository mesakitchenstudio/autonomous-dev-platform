import { boolEnv } from '../util/env.js';
import { SecurityProfile, SandboxMode } from './kinds.js';

export function resolveSecurityProfile(env = process.env, project = null) {
  const fromProject = project?.securityPolicy?.profile;
  if (fromProject && SecurityProfile[fromProject]) return fromProject;
  const raw = String(env.SECURITY_PROFILE || '').trim().toUpperCase();
  if (raw && SecurityProfile[raw]) return raw;
  if (boolEnv('DEMO_MODE', false) || project?.demo) return SecurityProfile.DEVELOPMENT;
  return SecurityProfile.STANDARD;
}

export function resolveRequiredSandboxMode({ project, demo, env = process.env } = {}) {
  if (demo || project?.demo || env.DEMO_MODE === 'true') return SandboxMode.MOCK;
  const profile = resolveSecurityProfile(env, project);
  if (profile === SecurityProfile.DEVELOPMENT) return SandboxMode.LOCAL_DEVELOPMENT_UNSAFE;
  return SandboxMode.CONTAINER_HARDENED;
}

export function isHardenedProfile(profile) {
  return profile === SecurityProfile.STANDARD || profile === SecurityProfile.HARDENED;
}

export function sandboxModeMayMasquerade(actual, claimed) {
  if (claimed === SandboxMode.CONTAINER_HARDENED && actual !== SandboxMode.CONTAINER_HARDENED) return true;
  return false;
}

export function projectSecurityPolicy(project, env = process.env) {
  const profile = resolveSecurityProfile(env, project);
  const requiredMode = resolveRequiredSandboxMode({ project, demo: project?.demo, env });
  return {
    profile,
    requiredSandboxMode: requiredMode,
    networkPolicy: env.SANDBOX_NETWORK_POLICY || defaultNetworkPolicy(profile),
    sandboxRequired: env.SANDBOX_REQUIRED || (isHardenedProfile(profile) ? SandboxMode.CONTAINER_HARDENED : ''),
    source: 'platform_operator',
    aiEditable: false
  };
}

export function defaultNetworkPolicy(profile) {
  if (profile === SecurityProfile.HARDENED) return 'PACKAGE_REGISTRY_ONLY';
  if (profile === SecurityProfile.STANDARD) return 'TEST_LOCAL';
  return 'TEST_LOCAL';
}

export function assertPolicyNotAiEditable(candidate) {
  if (!candidate || typeof candidate !== 'object') return true;
  const forbidden = ['sandboxMode', 'secretPolicy', 'allowedRoots', 'protectedNetworks', 'authRequirements', 'securityProfile'];
  const attempted = forbidden.filter(key => candidate[key] != null && candidate[key] !== undefined);
  return { ok: attempted.length === 0, attempted };
}
