import os from 'node:os';
import { WorkerCapability } from './kinds.js';
import { browserAvailability } from '../runtime/web/browsers.js';
import { discoverAndroid } from '../runtime/adapters/android.js';
import { discoverIos } from '../runtime/adapters/ios.js';
import { providerSupportsVision } from '../providers/vision.js';
import { commandHelp, commandVersion } from '../provision/versions.js';
import { discoverContainerCapabilities } from '../sandbox/discover.js';
import { SecretBrokerKind } from '../secrets/kinds.js';

export async function discoverWorkerCapabilities({ env = process.env } = {}) {
  const browsers = await browserAvailability().catch(() => ({ chromium: false, firefox: false, webkit: false, versions: {} }));
  const android = discoverAndroid();
  const ios = discoverIos();
  const capabilities = [];
  if (browsers.chromium) capabilities.push(WorkerCapability.WEB_CHROMIUM);
  if (browsers.firefox) capabilities.push(WorkerCapability.WEB_FIREFOX);
  if (browsers.webkit) capabilities.push(WorkerCapability.WEB_WEBKIT);
  if (android.sdk) capabilities.push(WorkerCapability.ANDROID_SDK);
  if (android.emulator) capabilities.push(WorkerCapability.ANDROID_EMULATOR);
  if (os.platform() === 'darwin') capabilities.push(WorkerCapability.MACOS);
  if (ios.available) capabilities.push(WorkerCapability.IOS_SIMULATOR);
  if (hasVisionConfig(env)) capabilities.push(WorkerCapability.VISION_REVIEW);
  if (commandVersion('node').available) capabilities.push(WorkerCapability.NODE);
  if (commandVersion('java').available) capabilities.push(WorkerCapability.JAVA);
  if (commandHelp('android', ['create', '--help']).available) capabilities.push(WorkerCapability.ANDROID_PROJECT_CREATOR);
  if (commandVersion('flutter').available) capabilities.push(WorkerCapability.FLUTTER_SDK);
  if (commandVersion('python', ['--version']).available) capabilities.push(WorkerCapability.PYTHON);
  if (commandVersion('cargo').available) capabilities.push(WorkerCapability.RUST_TOOLCHAIN);
  if (commandVersion('go', ['version']).available) capabilities.push(WorkerCapability.GO_TOOLCHAIN);
  if (commandVersion('dotnet').available) capabilities.push(WorkerCapability.DOTNET_SDK);
  if (os.platform() === 'darwin' && commandVersion('xcodebuild', ['-version']).available) {
    capabilities.push(WorkerCapability.XCODE);
  }
  const container = discoverContainerCapabilities({ env });
  if (container.available) {
    capabilities.push(WorkerCapability.CONTAINER_SANDBOX);
    if (container.capabilities.rootless) capabilities.push(WorkerCapability.ROOTLESS_CONTAINER);
    if (container.capabilities.seccomp) capabilities.push(WorkerCapability.SECCOMP);
    if (container.capabilities.resourceLimits) capabilities.push(WorkerCapability.RESOURCE_LIMITS);
    if (container.capabilities.networkPolicy) capabilities.push(WorkerCapability.NETWORK_POLICY);
  }
  if (env.SECRET_MASTER_KEY || env.SECRET_BROKER === SecretBrokerKind.ENCRYPTED_LOCAL || env.DEMO_MODE === 'true') {
    capabilities.push(WorkerCapability.SECRET_BROKER_LOCAL);
  }
  if (env.VAULT_ADDR) capabilities.push(WorkerCapability.SECRET_BROKER_VAULT);

  return {
    os: os.platform(),
    arch: os.arch(),
    capabilities,
    details: {
      browsers: browsers.versions,
      sandbox: container.capabilities,
      android: {
        sdk: android.sdk,
        emulator: android.emulator,
        java: android.java
      },
      ios: {
        macos: ios.macos,
        xcode: ios.xcode,
        simctl: ios.simctl
      },
      visionConfigured: hasVisionConfig(env)
    }
  };
}

function hasVisionConfig(env) {
  const providers = [
    ['openai', env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-5'],
    ['anthropic', env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || 'claude-opus-5'],
    ['gemini', env.GEMINI_API_KEY, env.GEMINI_MODEL || 'gemini-3.7-flash'],
    ['xai', env.XAI_API_KEY, env.XAI_MODEL || 'grok-4.6']
  ];
  if (env.DEMO_MODE === 'true') return true;
  return providers.some(([name, key, model]) => key && providerSupportsVision(name, model, env));
}
