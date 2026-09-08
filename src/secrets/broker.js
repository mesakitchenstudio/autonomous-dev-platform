import crypto from 'node:crypto';
import { SecretClass } from '../security/kinds.js';
import { SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { EncryptedLocalSecretBroker } from './encrypted-local.js';
import { VaultSecretBroker } from './vault.js';
import { MockSecretBroker } from './mock.js';
import { CONTROL_PLANE_SECRET_NAMES } from '../security/kinds.js';
import { secretRef } from './kinds.js';
import { assertMockBackendAllowed } from '../security/mock-backends.js';

const leases = new Map();

export class EnvironmentBootstrapBroker {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.kind = 'environment-bootstrap';
  }

  async get({ ref, cls }) {
    if (cls !== SecretClass.CONTROL_PLANE_SECRET && cls !== SecretClass.OWNER_AUTH_SECRET) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Environment bootstrap broker only serves control-plane startup secrets.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    const name = String(ref || '').split('/').pop();
    const value = this.env[name];
    if (!value) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: `Bootstrap secret ${name} is not present.`,
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    return { secretRef: ref, value, class: cls };
  }

  async put() {
    throw new PlatformError({
      code: ErrorCode.SECRET_ACCESS_DENIED,
      message: 'Environment bootstrap broker is read-only.',
      phase: 'SECRET_BROKER',
      retryable: false
    });
  }

  async list() {
    return CONTROL_PLANE_SECRET_NAMES.filter(name => this.env[name]).map(name => ({
      secretRef: `control-plane/${name}`,
      class: SecretClass.CONTROL_PLANE_SECRET
    }));
  }

  async revoke() {
    return { revoked: false };
  }
}

export function createSecretBroker({ kind, env = process.env, ...rest } = {}) {
  const resolved = kind || env.SECRET_BROKER || 'encrypted-local';
  if (resolved === 'mock') {
    assertMockBackendAllowed('MockSecretBroker', env, rest);
    return new MockSecretBroker();
  }
  if (resolved === 'vault') return new VaultSecretBroker({ env, ...rest });
  if (resolved === 'environment-bootstrap') return new EnvironmentBootstrapBroker({ env });
  return new EncryptedLocalSecretBroker({ env, ...rest });
}

export class SecretBroker {
  constructor(backend, { store } = {}) {
    this.backend = backend;
    this.store = store;
    this.bootstrap = new EnvironmentBootstrapBroker();
  }

  async put(input) {
    return this.backend.put(input);
  }

  async issue({ projectId, ref, cls, operation, ttlMs = 3_600_000 } = {}) {
    if (cls === SecretClass.CONTROL_PLANE_SECRET || cls === SecretClass.OWNER_AUTH_SECRET) {
      recordSecurityEvent(SecurityEventType.SECRET_ACCESS_DENIED, {
        projectId,
        secretRef: ref,
        class: cls,
        operation
      }, { store: this.store, projectId });
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'A project must never receive CONTROL_PLANE_SECRET or OWNER_AUTH_SECRET values.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    const issued = await this.backend.get({ ref, projectId, cls });
    const lease = {
      id: crypto.randomUUID(),
      projectId,
      operation: operation || null,
      secretRef: ref,
      class: cls,
      issuedAt: new Date().toISOString(),
      expiresAt: issued.expiresAt || new Date(Date.now() + ttlMs).toISOString(),
      leaseId: issued.leaseId || null,
      revoked: false
    };
    leases.set(lease.id, lease);
    recordSecurityEvent(SecurityEventType.SECRET_ISSUED, {
      projectId,
      secretRef: ref,
      class: cls,
      operation,
      leaseId: lease.leaseId || lease.id
    }, { store: this.store, projectId });
    return { ...issued, lease };
  }

  async controlPlane(name) {
    return this.bootstrap.get({
      ref: `control-plane/${name}`,
      cls: SecretClass.CONTROL_PLANE_SECRET
    });
  }

  async revokeLease(leaseOrId, { projectId } = {}) {
    const lease = typeof leaseOrId === 'string' ? leases.get(leaseOrId) : leaseOrId;
    if (!lease) return { revoked: false };
    if (projectId && lease.projectId !== projectId) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Lease does not belong to this project.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    if (this.backend.revoke) {
      await this.backend.revoke({ ref: lease.secretRef, leaseId: lease.leaseId, projectId: lease.projectId });
    }
    lease.revoked = true;
    lease.revokedAt = new Date().toISOString();
    recordSecurityEvent(SecurityEventType.SECRET_REVOKED, {
      projectId: lease.projectId,
      secretRef: lease.secretRef,
      class: lease.class,
      leaseId: lease.leaseId || lease.id
    }, { store: this.store, projectId: lease.projectId });
    return { revoked: true, leaseId: lease.id };
  }

  async listMetadata({ projectId } = {}) {
    const listed = this.backend.list ? await this.backend.list({ projectId }) : [];
    return listed.map(item => {
      const copy = { ...item };
      delete copy.value;
      return copy;
    });
  }

  activeLeases({ projectId } = {}) {
    return [...leases.values()].filter(item => (!projectId || item.projectId === projectId) && !item.revoked);
  }

  requiredRevocationPending({ projectId } = {}) {
    return this.activeLeases({ projectId }).filter(item => Date.parse(item.expiresAt) > Date.now());
  }
}

export function createProjectSecretRef(projectId, cls, name) {
  return secretRef(projectId, cls, name);
}

export function resetSecretLeasesForTests() {
  leases.clear();
}

let singleton = null;
export function defaultSecretBroker(options) {
  if (!singleton || options?.reset) {
    singleton = new SecretBroker(createSecretBroker(options), options);
  }
  return singleton;
}
