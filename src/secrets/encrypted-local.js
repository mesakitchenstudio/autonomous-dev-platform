import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { registerSecretValue } from './redact.js';
import { rememberBrokerValue } from './broker-values.js';

function masterKeyFromEnv(env = process.env) {
  const raw = env.SECRET_MASTER_KEY || '';
  if (!raw) {
    throw new PlatformError({
      code: ErrorCode.SECRET_ACCESS_DENIED,
      message: 'SECRET_MASTER_KEY is required for the encrypted local secret broker.',
      phase: 'SECRET_BROKER',
      retryable: false
    });
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
  if (buf.length !== 32) {
    throw new PlatformError({
      code: ErrorCode.SECRET_ACCESS_DENIED,
      message: 'SECRET_MASTER_KEY must resolve to 32 bytes.',
      phase: 'SECRET_BROKER',
      retryable: false
    });
  }
  return buf;
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    alg: 'aes-256-gcm',
    keyId: 'v1'
  };
}

function decrypt(record, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export class EncryptedLocalSecretBroker {
  constructor({ filePath, env = process.env } = {}) {
    this.filePath = filePath || env.SECRET_STORE_PATH || path.join(process.cwd(), '.adp-secrets', 'store.json');
    this.env = env;
    this.kind = 'encrypted-local';
  }

  key() {
    return masterKeyFromEnv(this.env);
  }

  readStore() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { keyId: 'v1', records: {} };
      throw error;
    }
  }

  writeStore(store) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ keyId: store.keyId || 'v1', records: store.records || {} }));
    fs.renameSync(temp, this.filePath);
  }

  async put({ ref, projectId, cls, value, expiresAt = null }) {
    const store = this.readStore();
    store.records[ref] = {
      projectId,
      class: cls,
      ...encrypt(value, this.key()),
      createdAt: new Date().toISOString(),
      expiresAt,
      revoked: false
    };
    this.writeStore(store);
    registerSecretValue(value);
    rememberBrokerValue(value);
    return { secretRef: ref, class: cls, projectId };
  }

  async get({ ref, projectId, cls }) {
    const store = this.readStore();
    const record = store.records[ref];
    if (!record) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Secret reference was not found.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    if (record.projectId !== projectId) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Secret reference is not authorized for this project.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    if (cls && record.class !== cls) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Secret class mismatch.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    if (record.revoked) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Secret reference has been revoked.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Secret reference has expired.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    try {
      const value = decrypt(record, this.key());
      registerSecretValue(value);
      rememberBrokerValue(value);
      return { secretRef: ref, value, class: record.class, expiresAt: record.expiresAt };
    } catch {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Unable to decrypt secret with the configured master key.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
  }

  async list({ projectId } = {}) {
    const store = this.readStore();
    return Object.entries(store.records)
      .filter(([, record]) => !projectId || record.projectId === projectId)
      .map(([ref, record]) => ({
        secretRef: ref,
        projectId: record.projectId,
        class: record.class,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        revoked: Boolean(record.revoked)
      }));
  }

  async revoke({ ref, projectId }) {
    const store = this.readStore();
    const record = store.records[ref];
    if (!record || record.projectId !== projectId) {
      throw new PlatformError({
        code: ErrorCode.SECRET_ACCESS_DENIED,
        message: 'Secret reference cannot be revoked for this project.',
        phase: 'SECRET_BROKER',
        retryable: false
      });
    }
    record.revoked = true;
    record.revokedAt = new Date().toISOString();
    this.writeStore(store);
    return { secretRef: ref, revoked: true };
  }
}
