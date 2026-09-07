import { boolEnv } from '../util/env.js';
import { CursorAcpClient } from './acp-client.js';
import { CursorCloudClient } from './cloud-client.js';
import { MockCursorClient } from './mock-cursor.js';
import { resolvePermissionPolicy } from './permission-policy.js';

export function createCursorClient() {
  if (boolEnv('DEMO_MODE', false)) return new MockCursorClient();
  if ((process.env.CURSOR_MODE || 'acp').toLowerCase() === 'cloud') {
    return new CursorCloudClient({
      apiKey: process.env.CURSOR_API_KEY,
      repoUrl: process.env.CURSOR_REPO_URL,
      startingRef: process.env.CURSOR_STARTING_REF || 'main'
    });
  }
  return new CursorAcpClient({
    bin: process.env.CURSOR_AGENT_BIN || 'agent',
    apiKey: process.env.CURSOR_API_KEY,
    authToken: process.env.CURSOR_AUTH_TOKEN,
    permissionPolicy: resolvePermissionPolicy(process.env.ACP_PERMISSION_POLICY)
  });
}
