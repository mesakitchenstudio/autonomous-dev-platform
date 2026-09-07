import { ProvisionerId, SupportStatus } from './kinds.js';
import { ViteProvisioner } from './provisioners/vite.js';
import { NextJsProvisioner } from './provisioners/nextjs.js';
import { AndroidNativeProvisioner } from './provisioners/android.js';
import { FlutterProvisioner } from './provisioners/flutter.js';
import { NodeBackendProvisioner } from './provisioners/node-backend.js';
import { PythonBackendProvisioner } from './provisioners/python-backend.js';
import { CliProvisioner } from './provisioners/cli.js';
import { RustProvisioner } from './provisioners/rust.js';
import { GoProvisioner } from './provisioners/go.js';
import { DotnetProvisioner } from './provisioners/dotnet.js';
import { IosProvisioner } from './provisioners/ios.js';
import { MockProvisioner } from './provisioners/mock.js';
import { BrokenTestProvisioner } from './provisioners/broken.js';
import { UnsupportedProvisioner } from './provisioners/unsupported.js';

export const PROVISIONERS = Object.freeze({
  [ProvisionerId.VITE]: ViteProvisioner,
  [ProvisionerId.NEXTJS]: NextJsProvisioner,
  [ProvisionerId.ANDROID_NATIVE]: AndroidNativeProvisioner,
  [ProvisionerId.FLUTTER]: FlutterProvisioner,
  [ProvisionerId.NODE_BACKEND]: NodeBackendProvisioner,
  [ProvisionerId.PYTHON_BACKEND]: PythonBackendProvisioner,
  [ProvisionerId.CLI]: CliProvisioner,
  [ProvisionerId.RUST]: RustProvisioner,
  [ProvisionerId.GO]: GoProvisioner,
  [ProvisionerId.DOTNET]: DotnetProvisioner,
  [ProvisionerId.IOS]: IosProvisioner,
  [ProvisionerId.MOCK]: MockProvisioner,
  [ProvisionerId.BROKEN_TEST]: BrokenTestProvisioner,
  [ProvisionerId.UNSUPPORTED]: UnsupportedProvisioner
});

export function getProvisioner(id) {
  return PROVISIONERS[id] || UnsupportedProvisioner;
}

export function listProvisioners() {
  return Object.values(PROVISIONERS).map(item => ({
    id: item.id,
    supportStatus: item.supportStatus?.() || SupportStatus.UNSUPPORTED,
    requiredCapabilities: item.requiredCapabilities?.() || []
  }));
}

export function resolveProvisioner(profile, { demo = false, templateId = null } = {}) {
  if (demo) return MockProvisioner;
  if (templateId === 'test.broken.starter') return BrokenTestProvisioner;
  const id = profile?.framework || ProvisionerId.UNSUPPORTED;
  return getProvisioner(id);
}

export function supportedAlternatives(profile = {}) {
  const category = profile.category;
  return listProvisioners().filter(item => {
    if (item.id === ProvisionerId.MOCK || item.id === ProvisionerId.BROKEN_TEST || item.id === ProvisionerId.UNSUPPORTED) return false;
    if (item.supportStatus === SupportStatus.UNSUPPORTED || item.supportStatus === SupportStatus.DETECTION_ONLY) return false;
    if (category === 'MOBILE') return [ProvisionerId.ANDROID_NATIVE, ProvisionerId.FLUTTER].includes(item.id);
    if (category === 'WEB' || category === 'FULL_STACK') return [ProvisionerId.VITE, ProvisionerId.NEXTJS].includes(item.id);
    if (category === 'BACKEND') return [ProvisionerId.NODE_BACKEND, ProvisionerId.PYTHON_BACKEND, ProvisionerId.GO, ProvisionerId.DOTNET].includes(item.id);
    if (category === 'CLI') return [ProvisionerId.CLI, ProvisionerId.RUST, ProvisionerId.GO].includes(item.id);
    return item.supportStatus === SupportStatus.LIVE_SUPPORTED;
  });
}

export function isLiveSupported(provisioner) {
  const status = typeof provisioner.supportStatus === 'function' ? provisioner.supportStatus() : provisioner.supportStatus;
  return status === SupportStatus.LIVE_SUPPORTED;
}
