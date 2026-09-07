process.env.SECURITY_PROFILE = process.env.ADP_TEST_SECURITY_PROFILE || 'DEVELOPMENT';
if (!process.env.OWNER_TOKEN_BOOTSTRAP) process.env.OWNER_TOKEN_BOOTSTRAP = 'adp-test-owner-token';
if (!process.env.SECRET_MASTER_KEY) process.env.SECRET_MASTER_KEY = '00'.repeat(32);
if (!process.env.ALLOWED_ORIGINS) process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:4317,http://localhost:4317';
export const TEST_OWNER_TOKEN = process.env.OWNER_TOKEN_BOOTSTRAP;
export function ownerAuthHeaders(extra = {}) {
  return {
    authorization: `Bearer ${TEST_OWNER_TOKEN}`,
    ...extra
  };
}
