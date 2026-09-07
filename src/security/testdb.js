import crypto from 'node:crypto';
import { SecretClass } from './kinds.js';
import { createProjectSecretRef, defaultSecretBroker } from '../secrets/broker.js';

const resources = new Map();

export async function provisionTestDatabase({ projectId, iteration, type = 'postgres' } = {}) {
  const id = crypto.randomUUID();
  const password = `test-${crypto.randomBytes(8).toString('hex')}`;
  const ref = createProjectSecretRef(projectId, SecretClass.PROJECT_TEST_SECRET, `db-${id}`);
  const broker = defaultSecretBroker();
  await broker.put({
    ref,
    projectId,
    cls: SecretClass.PROJECT_TEST_SECRET,
    value: `postgres://project_${id.slice(0, 8)}:${password}@127.0.0.1:5432/adp_proj_${id.slice(0, 8)}`
  });
  const record = {
    id,
    projectId,
    iteration: Number(iteration || 0),
    databaseType: type,
    connectionSecretRef: ref,
    lifecycle: 'ACTIVE',
    createdAt: new Date().toISOString(),
    destroyedAt: null
  };
  resources.set(id, record);
  return record;
}

export async function destroyTestDatabase(id, { projectId } = {}) {
  const record = resources.get(id);
  if (!record) return { destroyed: false };
  if (projectId && record.projectId !== projectId) return { destroyed: false, reason: 'cross_project' };
  await defaultSecretBroker().backend.revoke?.({ ref: record.connectionSecretRef, projectId: record.projectId }).catch(() => {});
  record.lifecycle = 'DESTROYED';
  record.destroyedAt = new Date().toISOString();
  return { destroyed: true, record };
}

export function listTestDatabases({ projectId } = {}) {
  return [...resources.values()].filter(item => !projectId || item.projectId === projectId);
}

export function resetTestDatabasesForTests() {
  resources.clear();
}
