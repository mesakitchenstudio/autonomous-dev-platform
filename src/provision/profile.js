import { AppCategory, AppPlatform, ProvisionerId } from './kinds.js';

const FRAMEWORK_ALIASES = {
  vite: ProvisionerId.VITE,
  'vite-react': ProvisionerId.VITE,
  react: ProvisionerId.VITE,
  vue: ProvisionerId.VITE,
  next: ProvisionerId.NEXTJS,
  nextjs: ProvisionerId.NEXTJS,
  'next.js': ProvisionerId.NEXTJS,
  android: ProvisionerId.ANDROID_NATIVE,
  'native-android': ProvisionerId.ANDROID_NATIVE,
  kotlin: ProvisionerId.ANDROID_NATIVE,
  compose: ProvisionerId.ANDROID_NATIVE,
  flutter: ProvisionerId.FLUTTER,
  dart: ProvisionerId.FLUTTER,
  node: ProvisionerId.NODE_BACKEND,
  express: ProvisionerId.NODE_BACKEND,
  fastify: ProvisionerId.NODE_BACKEND,
  python: ProvisionerId.PYTHON_BACKEND,
  fastapi: ProvisionerId.PYTHON_BACKEND,
  flask: ProvisionerId.PYTHON_BACKEND,
  cli: ProvisionerId.CLI,
  rust: ProvisionerId.RUST,
  cargo: ProvisionerId.RUST,
  go: ProvisionerId.GO,
  golang: ProvisionerId.GO,
  dotnet: ProvisionerId.DOTNET,
  'asp.net': ProvisionerId.DOTNET,
  csharp: ProvisionerId.DOTNET,
  ios: ProvisionerId.IOS,
  swift: ProvisionerId.IOS,
  xcode: ProvisionerId.IOS
};

export function emptyProfile() {
  return {
    category: AppCategory.WEB,
    platform: AppPlatform.WEB,
    framework: ProvisionerId.VITE,
    language: 'TYPESCRIPT',
    ui: true,
    backendRequired: false,
    databaseRequired: false
  };
}

export function normalizeProfile(input = {}, idea = '') {
  if (input && typeof input === 'object' && input.category && input.platform && input.framework) {
    return {
      category: normalizeEnum(input.category, AppCategory, AppCategory.WEB),
      platform: normalizeEnum(input.platform, AppPlatform, AppPlatform.WEB),
      framework: normalizeFramework(input.framework),
      language: String(input.language || inferLanguage(input.framework)).toUpperCase(),
      ui: input.ui !== false,
      backendRequired: Boolean(input.backendRequired),
      databaseRequired: Boolean(input.databaseRequired)
    };
  }
  return inferProfileFromSpec(input, idea);
}

export function inferProfileFromSpec(spec = {}, idea = '') {
  const text = [
    idea,
    spec.projectType,
    spec.product?.type,
    spec.architecture?.platform,
    ...(Array.isArray(spec.architecture?.technology) ? spec.architecture.technology : []),
    spec.architectureChoice?.framework,
    spec.architectureChoice?.platform
  ].filter(Boolean).join(' ').toLowerCase();

  const explicit = spec.architectureChoice || {};
  if (explicit.framework || explicit.platform || explicit.category) {
    return normalizeProfile({
      category: explicit.category || inferCategory(text),
      platform: explicit.platform || inferPlatform(text),
      framework: explicit.framework || inferFramework(text),
      language: explicit.language,
      ui: explicit.ui,
      backendRequired: explicit.backendRequired,
      databaseRequired: explicit.databaseRequired
    }, idea);
  }

  return {
    category: inferCategory(text),
    platform: inferPlatform(text),
    framework: inferFramework(text),
    language: inferLanguage(inferFramework(text)),
    ui: !/\b(api|backend|cli|library|service)\b/.test(text) || /\b(web|android|ios|app|ui)\b/.test(text),
    backendRequired: /\b(backend|api|full[- ]?stack|server)\b/.test(text),
    databaseRequired: /\b(database|postgres|sqlite|mongodb)\b/.test(text)
  };
}

export function inferFramework(text) {
  if (/\bflutter\b/.test(text) || (/\bios\b/.test(text) && /\bandroid\b/.test(text))) return ProvisionerId.FLUTTER;
  if (/\bios\b|\biphone\b|\bxcode\b|\bswift\b/.test(text) && !/\bandroid\b/.test(text)) return ProvisionerId.IOS;
  if (/\bandroid\b|\bkotlin\b|\bcompose\b/.test(text)) return ProvisionerId.ANDROID_NATIVE;
  if (/\bnext(?:\.js|js)?\b|\bssr\b|\bapp router\b/.test(text)) return ProvisionerId.NEXTJS;
  if (/\bvite\b|\breact\b|\bvue\b|\bspa\b|\bdashboard\b/.test(text)) return ProvisionerId.VITE;
  if (/\bpython\b|\bfastapi\b|\bflask\b/.test(text)) return ProvisionerId.PYTHON_BACKEND;
  if (/\brust\b|\bcargo\b/.test(text)) return ProvisionerId.RUST;
  if (/\bgolang\b|\bgo module\b|\bgo api\b/.test(text)) return ProvisionerId.GO;
  if (/\bdotnet\b|\bc#\b|\basp\.net\b/.test(text)) return ProvisionerId.DOTNET;
  if (/\bcli\b|\bcommand[- ]line\b/.test(text)) return ProvisionerId.CLI;
  if (/\bapi\b|\bbackend\b|\bservice\b/.test(text) && !/\bweb app\b|\bfrontend\b/.test(text)) return ProvisionerId.NODE_BACKEND;
  if (/\bweb\b|\bapplication\b|\bapp\b/.test(text)) return ProvisionerId.VITE;
  return ProvisionerId.NODE_BACKEND;
}

function inferCategory(text) {
  if (/\bandroid\b|\bios\b|\bflutter\b|\bmobile\b/.test(text)) return AppCategory.MOBILE;
  if (/\bcli\b/.test(text)) return AppCategory.CLI;
  if (/\bdesktop\b|\belectron\b/.test(text)) return AppCategory.DESKTOP;
  if (/\bfull[- ]?stack\b/.test(text)) return AppCategory.FULL_STACK;
  if (/\bapi\b|\bbackend\b|\bservice\b/.test(text) && !/\bweb\b|\bui\b/.test(text)) return AppCategory.BACKEND;
  return AppCategory.WEB;
}

function inferPlatform(text) {
  if (/\bflutter\b/.test(text) || (/\bandroid\b/.test(text) && /\bios\b/.test(text))) return AppPlatform.CROSS_PLATFORM;
  if (/\bios\b/.test(text) && !/\bandroid\b/.test(text)) return AppPlatform.IOS;
  if (/\bandroid\b/.test(text)) return AppPlatform.ANDROID;
  if (/\bcli\b/.test(text) || /\bapi\b|\bbackend\b/.test(text)) return AppPlatform.SERVER;
  if (/\bdesktop\b/.test(text)) return AppPlatform.DESKTOP;
  return AppPlatform.WEB;
}

function inferLanguage(framework) {
  if (framework === ProvisionerId.ANDROID_NATIVE) return 'KOTLIN';
  if (framework === ProvisionerId.FLUTTER) return 'DART';
  if (framework === ProvisionerId.PYTHON_BACKEND) return 'PYTHON';
  if (framework === ProvisionerId.RUST) return 'RUST';
  if (framework === ProvisionerId.GO) return 'GO';
  if (framework === ProvisionerId.DOTNET) return 'CSHARP';
  if (framework === ProvisionerId.IOS) return 'SWIFT';
  return 'TYPESCRIPT';
}

function normalizeFramework(value) {
  const key = String(value || '').trim().toLowerCase();
  if (Object.values(ProvisionerId).includes(String(value || '').toUpperCase())) return String(value).toUpperCase();
  return FRAMEWORK_ALIASES[key] || inferFramework(key);
}

function normalizeEnum(value, table, fallback) {
  const key = String(value || '').toUpperCase().replace(/[\s-]+/g, '_');
  return table[key] || fallback;
}

export function profileFromProject(project) {
  return normalizeProfile(project?.council?.discovery?.spec || {}, project?.idea || '');
}
