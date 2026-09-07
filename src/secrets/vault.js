import crypto from 'node:crypto';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { registerSecretValue } from './redact.js';
import { rememberBrokerValue } from './broker-values.js';

export class VaultSecretBroker {
  constructor({ addr, token, fetchImpl, env = process.env } = {}) {
    this.addr = String(addr || env.VAULT_ADDR || '').replace(/\/$/, '');
    this.token = token || env.VAULT_TOKEN || null;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.kind = 'vault';
    this.leases = new Map();
  }

  headers() {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers['X-Vault-Token'] = this.token;
    return headers;
  }

  async request(method, vaultPath, body) {
    if (!this.addr) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'VAULT_ADDR is not configured.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    const response = await this.fetchImpl(`${this.addr}/v1/${vaultPath.replace(/^\//, '')}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: `Vault request failed (${response.status}).`,
        phase: 'SECRET_BROKER',
        retryable: response.status >= 500,
        details: { status: response.status }
      });
    }
    return json;
  }

  async get({ ref, projectId }) {
    const data = await this.request('GET', ref);
    const value = data?.data?.data?.value || data?.data?.value;
    if (typeof value !== 'string') {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Vault secret value was not present.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    registerSecretValue(value);
    rememberBrokerValue(value);
    const leaseId = data.lease_id || null;
    if (leaseId) {
      this.leases.set(leaseId, {
        leaseId,
        projectId,
        secretRef: ref,
        renewable: Boolean(data.renewable),
        leaseDuration: data.lease_duration || null,
        issuedAt: new Date().toISOString()
      });
    }
    return {
      secretRef: ref,
      value,
      leaseId,
      expiresAt: data.lease_duration ? new Date(Date.now() + data.lease_duration * 1000).toISOString() : null
    };
  }

  async put({ ref, value }) {
    await this.request('POST', ref, { data: { value } });
    return { secretRef: ref };
  }

  async list() {
    return [...this.leases.values()].map(item => ({
      secretRef: item.secretRef,
      leaseId: item.leaseId,
      projectId: item.projectId,
      issuedAt: item.issuedAt
    }));
  }

  async revoke({ leaseId, ref }) {
    if (leaseId) {
      await this.request('PUT', 'sys/leases/revoke', { lease_id: leaseId });
      this.leases.delete(leaseId);
      return { leaseId, revoked: true };
    }
    if (ref) {
      await this.request('DELETE', ref);
      return { secretRef: ref, revoked: true };
    }
    return { revoked: false };
  }

  async renew({ leaseId }) {
    const data = await this.request('PUT', 'sys/leases/renew', { lease_id: leaseId });
    return { leaseId, leaseDuration: data.lease_duration || null, id: crypto.randomUUID() };
  }
}
