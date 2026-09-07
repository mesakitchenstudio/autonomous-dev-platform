import { AppCategory, AppPlatform, ProvisionerId, SupportStatus } from './kinds.js';
import { WorkerCapability } from '../capabilities/kinds.js';

export const TEMPLATE_REGISTRY = Object.freeze([
  {
    id: 'web.react.vite.typescript',
    provisioner: ProvisionerId.VITE,
    profile: { category: AppCategory.WEB, platform: AppPlatform.WEB, framework: ProvisionerId.VITE, language: 'TYPESCRIPT', ui: true },
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [WorkerCapability.NODE],
    generator: { name: 'create-vite', template: 'react-ts' },
    defaultOptions: { template: 'react-ts', packageManager: 'npm' },
    validation: { files: ['package.json', 'index.html', 'vite.config.ts', 'src/main.tsx'] }
  },
  {
    id: 'web.vue.vite.typescript',
    provisioner: ProvisionerId.VITE,
    profile: { category: AppCategory.WEB, platform: AppPlatform.WEB, framework: ProvisionerId.VITE, language: 'TYPESCRIPT', ui: true },
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [WorkerCapability.NODE],
    generator: { name: 'create-vite', template: 'vue-ts' },
    defaultOptions: { template: 'vue-ts', packageManager: 'npm' },
    validation: { files: ['package.json', 'index.html'] }
  },
  {
    id: 'web.next.typescript',
    provisioner: ProvisionerId.NEXTJS,
    profile: { category: AppCategory.FULL_STACK, platform: AppPlatform.WEB, framework: ProvisionerId.NEXTJS, language: 'TYPESCRIPT', ui: true, backendRequired: true },
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [WorkerCapability.NODE],
    generator: { name: 'create-next-app', template: 'app-router' },
    defaultOptions: { typescript: true, appRouter: true, srcDir: true, eslint: true, packageManager: 'npm' },
    validation: {
      files: ['package.json'],
      anyFiles: [
        ['next.config.ts', 'next.config.mjs', 'next.config.js'],
        ['src/app/page.tsx', 'src/app/page.js', 'app/page.tsx', 'app/page.js']
      ]
    }
  },
  {
    id: 'mobile.android.compose',
    provisioner: ProvisionerId.ANDROID_NATIVE,
    profile: { category: AppCategory.MOBILE, platform: AppPlatform.ANDROID, framework: ProvisionerId.ANDROID_NATIVE, language: 'KOTLIN', ui: true },
    supportStatus: SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.ANDROID_SDK, WorkerCapability.ANDROID_PROJECT_CREATOR, WorkerCapability.JAVA],
    generator: { name: 'android', template: 'empty-activity' },
    defaultOptions: {},
    validation: { files: ['settings.gradle.kts', 'gradlew', 'app/build.gradle.kts'] }
  },
  {
    id: 'mobile.flutter',
    provisioner: ProvisionerId.FLUTTER,
    profile: { category: AppCategory.MOBILE, platform: AppPlatform.CROSS_PLATFORM, framework: ProvisionerId.FLUTTER, language: 'DART', ui: true },
    supportStatus: SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.FLUTTER_SDK],
    generator: { name: 'flutter', template: 'app' },
    defaultOptions: { platforms: ['android'] },
    validation: { files: ['pubspec.yaml', 'lib/main.dart'] }
  },
  {
    id: 'backend.node.typescript',
    provisioner: ProvisionerId.NODE_BACKEND,
    profile: { category: AppCategory.BACKEND, platform: AppPlatform.SERVER, framework: ProvisionerId.NODE_BACKEND, language: 'TYPESCRIPT', ui: false, backendRequired: true },
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [WorkerCapability.NODE],
    generator: { name: 'adp-node-backend', template: '1.0.0' },
    defaultOptions: {},
    validation: { files: ['package.json', 'src/server.js', 'test/server.test.js'] }
  },
  {
    id: 'backend.python',
    provisioner: ProvisionerId.PYTHON_BACKEND,
    profile: { category: AppCategory.BACKEND, platform: AppPlatform.SERVER, framework: ProvisionerId.PYTHON_BACKEND, language: 'PYTHON', ui: false, backendRequired: true },
    supportStatus: SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.PYTHON],
    generator: { name: 'adp-python-backend', template: '1.0.0' },
    defaultOptions: {},
    validation: { files: ['pyproject.toml', 'src/app.py', 'tests/test_app.py'] }
  },
  {
    id: 'cli.node',
    provisioner: ProvisionerId.CLI,
    profile: { category: AppCategory.CLI, platform: AppPlatform.SERVER, framework: ProvisionerId.CLI, language: 'JAVASCRIPT', ui: false },
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [WorkerCapability.NODE],
    generator: { name: 'adp-cli', template: '1.0.0' },
    defaultOptions: {},
    validation: { files: ['package.json', 'src/cli.js'] }
  },
  {
    id: 'lang.rust',
    provisioner: ProvisionerId.RUST,
    profile: { category: AppCategory.CLI, platform: AppPlatform.SERVER, framework: ProvisionerId.RUST, language: 'RUST', ui: false },
    supportStatus: SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.RUST_TOOLCHAIN],
    generator: { name: 'cargo', template: 'bin' },
    defaultOptions: {},
    validation: { files: ['Cargo.toml'] }
  },
  {
    id: 'lang.go',
    provisioner: ProvisionerId.GO,
    profile: { category: AppCategory.BACKEND, platform: AppPlatform.SERVER, framework: ProvisionerId.GO, language: 'GO', ui: false, backendRequired: true },
    supportStatus: SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.GO_TOOLCHAIN],
    generator: { name: 'go', template: 'mod' },
    defaultOptions: {},
    validation: { files: ['go.mod'] }
  },
  {
    id: 'lang.dotnet',
    provisioner: ProvisionerId.DOTNET,
    profile: { category: AppCategory.BACKEND, platform: AppPlatform.SERVER, framework: ProvisionerId.DOTNET, language: 'CSHARP', ui: false, backendRequired: true },
    supportStatus: SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE,
    requiredCapabilities: [WorkerCapability.DOTNET_SDK],
    generator: { name: 'dotnet', template: 'webapi' },
    defaultOptions: {},
    validation: { files: [] }
  },
  {
    id: 'mobile.ios.native',
    provisioner: ProvisionerId.IOS,
    profile: { category: AppCategory.MOBILE, platform: AppPlatform.IOS, framework: ProvisionerId.IOS, language: 'SWIFT', ui: true },
    supportStatus: SupportStatus.DETECTION_ONLY,
    requiredCapabilities: [WorkerCapability.MACOS, WorkerCapability.XCODE],
    generator: { name: 'xcode', template: 'ios-app' },
    defaultOptions: {},
    validation: { files: [] }
  },
  {
    id: 'test.broken.starter',
    provisioner: ProvisionerId.BROKEN_TEST,
    profile: { category: AppCategory.WEB, platform: AppPlatform.WEB, framework: ProvisionerId.BROKEN_TEST, language: 'JAVASCRIPT', ui: false },
    supportStatus: SupportStatus.LIVE_SUPPORTED,
    requiredCapabilities: [],
    generator: { name: 'adp-broken-starter', template: '1.0.0' },
    defaultOptions: {},
    validation: { files: ['package.json'] }
  }
]);

export function templateById(id) {
  return TEMPLATE_REGISTRY.find(item => item.id === id) || null;
}

export function templatesForProvisioner(provisioner) {
  return TEMPLATE_REGISTRY.filter(item => item.provisioner === provisioner);
}

export function selectTemplate(profile) {
  const matches = TEMPLATE_REGISTRY.filter(item => item.provisioner === profile.framework);
  if (profile.framework === ProvisionerId.VITE && /vue/i.test(profile.language || '')) {
    return templateById('web.vue.vite.typescript');
  }
  return matches[0] || null;
}

export function assertKnownTemplate(id) {
  if (!id) return null;
  const found = templateById(id);
  if (!found) {
    const error = new Error(`Unknown or unapproved template id: ${id}`);
    error.code = 'PROVISIONING_TEMPLATE_INVALID';
    throw error;
  }
  return found;
}
