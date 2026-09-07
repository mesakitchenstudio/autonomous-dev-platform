import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'lpt1', 'lpt2',
  'node_modules', 'src', 'test', 'tests', 'dist', 'build', 'vendor'
]);

export function defaultOrganization() {
  return String(process.env.DEFAULT_APP_ORGANIZATION || 'com.autonomous.generated')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '')
    .replace(/^\.+|\.+$/g, '') || 'com.autonomous.generated';
}

export function filesystemName(value, fallback = 'generated-app') {
  const raw = String(value || '');
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\') || raw.includes('\0')) {
    assertSafeIdentifier(raw, 'filesystem project name');
  }
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  let slug = ascii || fallback;
  if (/^\d/.test(slug)) slug = `app-${slug}`;
  if (RESERVED.has(slug)) slug = `${slug}-app`;
  assertSafeIdentifier(slug, 'filesystem project name');
  return slug;
}

export function npmPackageName(value) {
  return filesystemName(value).replace(/_/g, '-');
}

export function dartPackageName(value) {
  let name = filesystemName(value).replace(/-/g, '_');
  if (!/^[a-z]/.test(name)) name = `app_${name}`;
  return name;
}

export function pythonPackageName(value) {
  return dartPackageName(value);
}

export function rustCrateName(value) {
  return filesystemName(value);
}

export function androidPackageId(value, organization = defaultOrganization()) {
  const org = String(organization || defaultOrganization())
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '')
    .replace(/^\.+|\.+$/g, '');
  const leaf = filesystemName(value).replace(/-/g, '');
  const id = `${org}.${leaf}`.replace(/\.+/g, '.');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(id)) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_IDENTITY_INVALID,
      message: `Invalid Android package identifier: ${id}`,
      phase: 'PROJECT_PROVISIONING',
      retryable: false,
      details: { id }
    });
  }
  return id;
}

export function dotnetNamespace(value) {
  return filesystemName(value)
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function assertSafeIdentifier(value, label = 'identifier') {
  const text = String(value || '');
  if (!text || text.includes('..') || text.includes('/') || text.includes('\\') || text.includes('\0')) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_IDENTITY_INVALID,
      message: `Unsafe ${label}: path traversal or empty identifier is not allowed.`,
      phase: 'PROJECT_PROVISIONING',
      retryable: false,
      details: { value: text }
    });
  }
  return text;
}

export function buildIdentity(productName, organization) {
  const displayName = String(productName || 'Generated Application').trim() || 'Generated Application';
  return {
    productName: displayName,
    projectName: filesystemName(displayName),
    npmName: npmPackageName(displayName),
    dartName: dartPackageName(displayName),
    pythonName: pythonPackageName(displayName),
    rustName: rustCrateName(displayName),
    packageId: androidPackageId(displayName, organization),
    dotnetNamespace: dotnetNamespace(displayName)
  };
}
