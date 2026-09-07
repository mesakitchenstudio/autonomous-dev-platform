import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { registerSecretValue } from './redact.js';
import { rememberBrokerValue } from './broker-values.js';

export class MockSecretBroker {
  constructor() {
    this.kind = 'mock';
    this.records = new Map();
  }

  async put({ ref, projectId, cls, value, expiresAt = null }) {
    this.records.set(ref, {
      projectId,
      class: cls,
      value,
      createdAt: new Date().toISOString(),
      expiresAt,
      revoked: false
    });
    registerSecretValue(value);
    rememberBrokerValue(value);
    return { secretRef: ref, class: cls, projectId };
  }

  async get({ ref, projectId }) {
    const record = this.records.get(ref);
    if (!record || record.projectId !== projectId || record.revoked) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Mock broker denied the secret reference.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    return { secretRef: ref, value: record.value, class: record.class, expiresAt: record.expiresAt };
  }

  async list({ projectId } = {}) {
    return [...this.records.entries()]
      .filter(([, record]) => !projectId || record.projectId === projectId)
      .map(([ref, record]) => ({
        secretRef: ref,
        projectId: record.projectId,
        class: record.class,
        revoked: record.revoked,
        createdAt: record.createdAt
      }));
  }

  async revoke({ ref }) {
    const record = this.records.get(ref);
    if (!record) return { revoked: false };
    record.revoked = true;
    return { secretRef: ref, revoked: true };
  }
}
