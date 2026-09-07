import { RuntimeFindingCode } from './kinds.js';

export function resolveTestContext(project = {}, scenario = {}) {
  const configured = project.runtimeTestContext || project.council?.discovery?.spec?.runtimeTestContext || {};
  const missing = [];
  if (scenario.requiresAuth && !configured.auth && !configured.users?.length) {
    missing.push('auth');
  }
  if (scenario.requiresTestData && !configured.data && !configured.fixtures?.length) {
    missing.push('testData');
  }
  if (configured.useProduction === true) {
    return {
      ok: false,
      code: RuntimeFindingCode.MISSING_RUNTIME_TEST_CONFIGURATION,
      message: 'Production accounts or databases are not allowed for runtime testing.'
    };
  }
  if (missing.length) {
    return {
      ok: false,
      code: RuntimeFindingCode.MISSING_RUNTIME_TEST_CONFIGURATION,
      message: `Missing runtime test configuration: ${missing.join(', ')}`,
      missing
    };
  }
  return {
    ok: true,
    auth: configured.auth || null,
    users: configured.users || [],
    data: configured.data || configured.fixtures || [],
    synthetic: configured.synthetic !== false
  };
}
