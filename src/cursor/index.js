import { boolEnv } from '../util/env.js';
import { CursorAcpClient } from './acp-client.js';
import { CursorCloudClient } from './cloud-client.js';
import { MockCursorClient } from './mock-cursor.js';
import { resolvePermissionPolicy } from './permission-policy.js';
import { CursorMode } from './contract.js';

export function defaultCursorMode() {
  if (boolEnv('DEMO_MODE', false)) return CursorMode.MOCK;
  return (process.env.CURSOR_MODE || 'acp').toLowerCase() === 'cloud' ? CursorMode.CLOUD : CursorMode.ACP;
}

export function createCursorClient(overrides = {}) {
  const mode = overrides.mode || defaultCursorMode();
  if (mode === CursorMode.MOCK || mode === 'mock') return new MockCursorClient(overrides);
  if (mode === CursorMode.CLOUD || mode === 'cloud') {
    return new CursorCloudClient({
      apiKey: overrides.apiKey || process.env.CURSOR_API_KEY || process.env.CURSOR_CLOUD_API_KEY,
      repoUrl: overrides.repoUrl || null,
      startingRef: overrides.startingRef || process.env.CURSOR_STARTING_REF || 'main'
    });
  }
  return new CursorAcpClient({
    bin: overrides.bin || process.env.CURSOR_AGENT_BIN || 'agent',
    apiKey: overrides.apiKey || process.env.CURSOR_API_KEY,
    authToken: overrides.authToken || process.env.CURSOR_AUTH_TOKEN,
    permissionPolicy: resolvePermissionPolicy(overrides.permissionPolicy || process.env.CURSOR_PERMISSION_POLICY || process.env.ACP_PERMISSION_POLICY)
  });
}

export { CursorMode };
