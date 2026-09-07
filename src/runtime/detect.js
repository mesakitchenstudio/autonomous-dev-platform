import fs from 'node:fs/promises';
import path from 'node:path';
import { ApplicationKind, RuntimeAdapterName } from './kinds.js';

export async function detectApplicationKind(workspacePath, project = {}) {
  const specType = String(project.council?.discovery?.spec?.projectType || project.council?.discovery?.spec?.product?.type || '').toLowerCase();
  const platform = String(project.council?.discovery?.spec?.architecture?.platform || '').toLowerCase();
  const files = await listTop(workspacePath);

  if (files.has('androidmanifest.xml') || files.has('build.gradle') && (files.has('src/main') || await exists(path.join(workspacePath, 'app', 'src', 'main')))) {
    if (platform.includes('android') || specType.includes('android') || await exists(path.join(workspacePath, 'app', 'src', 'main', 'AndroidManifest.xml'))) {
      return { applicationKind: ApplicationKind.ANDROID, runtimeAdapter: RuntimeAdapterName.ANDROID, visual: true };
    }
  }
  if (files.has('info.plist') || files.has('project.pbxproj') || specType.includes('ios') || platform.includes('ios')) {
    return { applicationKind: ApplicationKind.IOS, runtimeAdapter: RuntimeAdapterName.IOS, visual: true };
  }
  if (specType.includes('cli') || platform.includes('cli') || await hasCliBin(workspacePath)) {
    if (!await looksLikeWeb(workspacePath, files)) {
      return { applicationKind: ApplicationKind.CLI, runtimeAdapter: RuntimeAdapterName.CLI, visual: false };
    }
  }
  if (await looksLikeWeb(workspacePath, files) || specType === 'web' || specType === 'web_ui' || platform.includes('web')) {
    return { applicationKind: ApplicationKind.WEB_UI, runtimeAdapter: RuntimeAdapterName.PLAYWRIGHT_WEB, visual: true };
  }
  if (specType.includes('desktop') || files.has('electron') || files.has('tauri.conf.json')) {
    return { applicationKind: ApplicationKind.DESKTOP, runtimeAdapter: RuntimeAdapterName.DESKTOP, visual: true };
  }
  if (await looksLikeBackend(workspacePath, files) || specType.includes('api') || specType.includes('backend') || platform.includes('api')) {
    return { applicationKind: ApplicationKind.BACKEND, runtimeAdapter: RuntimeAdapterName.BACKEND, visual: false };
  }
  if (specType.includes('android')) return { applicationKind: ApplicationKind.ANDROID, runtimeAdapter: RuntimeAdapterName.ANDROID, visual: true };
  if (specType.includes('ios')) return { applicationKind: ApplicationKind.IOS, runtimeAdapter: RuntimeAdapterName.IOS, visual: true };
  return { applicationKind: ApplicationKind.UNKNOWN, runtimeAdapter: RuntimeAdapterName.GENERIC, visual: false };
}

export async function detectLaunchCommand(workspacePath, { preferProduction = true } = {}) {
  const pkg = await readJson(path.join(workspacePath, 'package.json'));
  const scripts = pkg?.scripts || {};
  const order = preferProduction ? ['start', 'preview', 'serve', 'dev'] : ['start', 'preview', 'serve', 'dev'];
  for (const name of order) {
    if (scripts[name]) return { command: launchArgv(name), script: name, source: 'package.json' };
  }
  if (await exists(path.join(workspacePath, 'index.html')) || await exists(path.join(workspacePath, 'dist', 'index.html'))) {
    return { command: ['__PLATFORM_STATIC_SERVER__'], script: null, source: 'static-html' };
  }
  return null;
}

export async function detectHealthPath(workspacePath) {
  const candidates = ['/health', '/api/health', '/ready', '/'];
  const pkg = await readJson(path.join(workspacePath, 'package.json'));
  const configured = pkg?.adp?.healthPath || pkg?.healthCheck;
  if (typeof configured === 'string') return configured.startsWith('/') ? configured : `/${configured}`;
  return candidates[candidates.length - 1];
}

function launchArgv(script) {
  return ['npm', 'run', script];
}

async function looksLikeWeb(workspacePath, files) {
  if (files.has('index.html') || files.has('vite.config.js') || files.has('vite.config.ts') || files.has('next.config.js')) return true;
  const pkg = await readJson(path.join(workspacePath, 'package.json'));
  const scripts = Object.keys(pkg?.scripts || {});
  if (scripts.some(name => ['start', 'dev', 'preview', 'serve'].includes(name))) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.react || deps.vue || deps.svelte || deps.next || deps.vite || deps['@angular/core']) return true;
    if (await exists(path.join(workspacePath, 'public', 'index.html'))) return true;
    if (await exists(path.join(workspacePath, 'index.html'))) return true;
  }
  return Boolean(await exists(path.join(workspacePath, 'public', 'index.html')));
}

async function looksLikeBackend(workspacePath, files) {
  const pkg = await readJson(path.join(workspacePath, 'package.json'));
  if (pkg?.bin) return false;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return Boolean(deps?.express || deps?.fastify || deps?.koa || files.has('go.mod') || files.has('requirements.txt') || files.has('pyproject.toml'));
}

async function hasCliBin(workspacePath) {
  const pkg = await readJson(path.join(workspacePath, 'package.json'));
  return Boolean(pkg?.bin);
}

async function listTop(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  const set = new Set(names.map(name => name.toLowerCase()));
  if (names.includes('app')) set.add('src/main');
  return set;
}

async function exists(file) {
  return Boolean(await fs.stat(file).catch(() => null));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
