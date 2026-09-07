export { SecretClass } from '../security/kinds.js';

export const SecretBrokerKind = Object.freeze({
  ENCRYPTED_LOCAL: 'encrypted-local',
  VAULT: 'vault',
  ENVIRONMENT_BOOTSTRAP: 'environment-bootstrap',
  MOCK: 'mock'
});

export function secretRef(projectId, cls, name) {
  return `project/${projectId}/${String(cls).replace(/_SECRET$/, '').toLowerCase()}/${name}`;
}

export function parseSecretRef(ref) {
  const parts = String(ref || '').split('/');
  if (parts[0] !== 'project' || parts.length < 4) return null;
  return { projectId: parts[1], cls: parts[2], name: parts.slice(3).join('/') };
}

export const CONTROL_PLANE_ISSUE_DENIED = 'Projects must never receive CONTROL_PLANE_SECRET values.';
