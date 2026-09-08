import { boolEnvFrom } from '../util/env.js';
import { CursorAcpClient } from './acp-client.js';
import { CursorCloudClient } from './cloud-client.js';
import { MockCursorClient } from './mock-cursor.js';
import { resolvePermissionPolicy } from './permission-policy.js';
import { CursorMode } from './contract.js';
import { assertMockBackendAllowed } from '../security/mock-backends.js';

export function defaultCursorMode(env = process.env) {
  if (boolEnvFrom(env, 'DEMO_MODE', false)) return CursorMode.MOCK;
  const raw = String(env.CURSOR_MODE || 'acp').toLowerCase();
  if (raw === 'cloud') return CursorMode.CLOUD;
  if (raw === 'mock') return CursorMode.MOCK;
  return CursorMode.ACP;
}

export function createCursorClient(overrides = {}) {
  const env = overrides.env || process.env;
  const mode = overrides.mode || defaultCursorMode(env);
  if (mode === CursorMode.MOCK || mode === 'mock') {
    assertMockBackendAllowed('MockCursor', env, { demo: overrides.demo });
    return new MockCursorClient(overrides);
  }
  if (mode === CursorMode.CLOUD || mode === 'cloud') {
    return new CursorCloudClient({
      apiKey: overrides.apiKey || env.CURSOR_API_KEY || env.CURSOR_CLOUD_API_KEY,
      repoUrl: overrides.repoUrl || null,
      startingRef: overrides.startingRef || env.CURSOR_STARTING_REF || 'main'
    });
  }
  return new CursorAcpClient({
    bin: overrides.bin || env.CURSOR_AGENT_BIN || 'agent',
    apiKey: overrides.apiKey || env.CURSOR_API_KEY,
    authToken: overrides.authToken || env.CURSOR_AUTH_TOKEN,
    permissionPolicy: resolvePermissionPolicy(overrides.permissionPolicy || env.CURSOR_PERMISSION_POLICY || env.ACP_PERMISSION_POLICY)
  });
}

export { CursorMode };
