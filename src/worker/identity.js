import crypto from 'node:crypto';
import os from 'node:os';

export function createWorkerId() {
  return `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
}
