export const SandboxBackend = Object.freeze({
  CONTAINER: 'CONTAINER',
  LOCAL_UNSAFE: 'LOCAL_UNSAFE',
  MOCK: 'MOCK'
});

export const NetworkMode = Object.freeze({
  NONE: 'NONE',
  PACKAGE_REGISTRY_ONLY: 'PACKAGE_REGISTRY_ONLY',
  TEST_LOCAL: 'TEST_LOCAL',
  PROJECT_ALLOWLIST: 'PROJECT_ALLOWLIST',
  UNRESTRICTED_EXPLICIT: 'UNRESTRICTED_EXPLICIT'
});

export const SandboxOperation = Object.freeze({
  PROVISION: 'PROVISION',
  VERIFY: 'VERIFY',
  RUNTIME: 'RUNTIME',
  CURSOR_PROJECT_COMMAND: 'CURSOR_PROJECT_COMMAND',
  PACKAGE_INSTALL: 'PACKAGE_INSTALL',
  TEST: 'TEST'
});

export const CommandRouteClass = Object.freeze({
  PROJECT_BUILD: 'PROJECT_BUILD',
  PROJECT_TEST: 'PROJECT_TEST',
  PACKAGE_MANAGER: 'PACKAGE_MANAGER',
  PROJECT_RUNTIME: 'PROJECT_RUNTIME',
  PROJECT_SCRIPT: 'PROJECT_SCRIPT'
});

export const APPROVED_REGISTRIES = Object.freeze([
  'registry-1.docker.io',
  'docker.io',
  'ghcr.io',
  'public.ecr.aws'
]);

export function emptyIsolationCapabilities() {
  return {
    engineAvailable: false,
    engine: null,
    engineVersion: null,
    os: null,
    rootless: false,
    nonRootUser: false,
    seccomp: false,
    noNewPrivileges: false,
    capDrop: false,
    readOnlyRoot: false,
    resourceLimits: false,
    pidsLimit: false,
    networkPolicy: false,
    hostnameAllowlistEnforced: false,
    privilegedProhibited: true,
    dockerSocketMounted: false,
    hostNamespaces: false
  };
}
