const ALLOWED_TEST_DB = /^(adp_phase3_test|adp_test|test_adp|.+_test)$/i;
const PRODUCTIONISH = /^(prod|production|live|main)$/i;

export function parseDatabaseName(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid PostgreSQL connection string.');
  }
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    throw new Error(`TEST_DATABASE_URL must use a postgres:// connection string, got ${parsed.protocol}`);
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
}

export function assertTestDatabaseUrl(connectionString) {
  if (!connectionString || !String(connectionString).trim()) {
    throw new Error(
      'PostgreSQL integration tests refuse to run without TEST_DATABASE_URL. ' +
      'Start a dedicated test instance or run `npm run test:postgres` (it can launch an isolated embedded PostgreSQL cluster).'
    );
  }
  const name = parseDatabaseName(connectionString);
  if (!name) {
    throw new Error('TEST_DATABASE_URL is missing a database name.');
  }
  if (PRODUCTIONISH.test(name) || (/prod|production|live/i.test(name) && !/test/i.test(name))) {
    throw new Error(
      `PostgreSQL integration tests refuse to run against database "${name}". ` +
      'Use an isolated test database (recommended: adp_phase3_test).'
    );
  }
  if (!ALLOWED_TEST_DB.test(name) && !/test/i.test(name)) {
    throw new Error(
      `PostgreSQL integration tests refuse to run against database "${name}". ` +
      'The target database name must include "test" (recommended: adp_phase3_test).'
    );
  }
  return { name, connectionString };
}

export function redactDatabaseUrl(url) {
  if (!url) return null;
  return String(url).replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:[redacted]@');
}
