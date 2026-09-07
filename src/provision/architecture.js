import { ProvisionerId, SupportStatus } from './kinds.js';
import { inferProfileFromSpec, normalizeProfile } from './profile.js';
import { getProvisioner, resolveProvisioner, supportedAlternatives } from './registry.js';
import { architectureResolutionPrompt } from '../council/prompts.js';
import { architectureChoiceSchema } from '../council/schemas.js';

export function explicitOwnerPlatform(idea = '', spec = {}) {
  const text = `${idea} ${spec.projectType || ''} ${spec.architecture?.platform || ''}`.toLowerCase();
  if (/\bios\b|\biphone\b|\bipad\b/.test(text) && !/\bandroid\b/.test(text)) return 'IOS';
  if (/\bandroid\b/.test(text) && !/\bios\b/.test(text)) return 'ANDROID';
  return null;
}

export function evaluateArchitecture(project, { demo = false } = {}) {
  const spec = project.council?.discovery?.spec || {};
  const profile = inferProfileFromSpec(spec, project.idea);
  const provisioner = resolveProvisioner(profile, { demo, templateId: spec.templateId });
  const status = provisioner.supportStatus?.(profile) || SupportStatus.UNSUPPORTED;
  const ownerPlatform = explicitOwnerPlatform(project.idea, spec);
  const supported = status === SupportStatus.LIVE_SUPPORTED
    || (status === SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE && (provisioner.requiredCapabilities?.() || []).length >= 0);
  return {
    profile,
    provisioner,
    supportStatus: status,
    supported: status !== SupportStatus.UNSUPPORTED && status !== SupportStatus.DETECTION_ONLY || demo,
    ownerPlatform,
    alternatives: supportedAlternatives(profile)
  };
}

export async function resolveUnsupportedArchitecture(project, council, { demo = false } = {}) {
  const first = evaluateArchitecture(project, { demo });
  if (demo) return first;
  if (first.supportStatus === SupportStatus.LIVE_SUPPORTED || first.supportStatus === SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE) {
    if (first.provisioner.id !== ProvisionerId.IOS && first.provisioner.id !== ProvisionerId.UNSUPPORTED) return first;
  }
  if (first.ownerPlatform === 'IOS' && first.provisioner.id === ProvisionerId.IOS) {
    return { ...first, supported: false, blockedByInfrastructure: true };
  }
  if (!council?.resolveArchitecture) {
    const fallback = first.alternatives.find(item => item.supportStatus === SupportStatus.LIVE_SUPPORTED);
    if (!fallback) return { ...first, supported: false };
    const profile = normalizeProfile({ ...first.profile, framework: fallback.id }, project.idea);
    return {
      profile,
      provisioner: getProvisioner(fallback.id),
      supportStatus: fallback.supportStatus,
      supported: true,
      resolved: true,
      alternatives: first.alternatives
    };
  }
  const choice = await council.resolveArchitecture({
    idea: project.idea,
    spec: project.council?.discovery?.spec,
    requested: first.profile,
    available: first.alternatives,
    ownerPlatform: first.ownerPlatform
  });
  const profile = normalizeProfile(choice, project.idea);
  if (first.ownerPlatform && profile.platform !== first.ownerPlatform && profile.platform !== 'CROSS_PLATFORM') {
    return { ...first, supported: false, blockedByInfrastructure: first.ownerPlatform === 'IOS' };
  }
  const provisioner = resolveProvisioner(profile, { demo });
  return {
    profile,
    provisioner,
    supportStatus: provisioner.supportStatus?.(profile),
    supported: provisioner.id !== ProvisionerId.UNSUPPORTED,
    resolved: true,
    choice,
    alternatives: first.alternatives
  };
}

export { architectureResolutionPrompt, architectureChoiceSchema };
