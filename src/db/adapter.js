import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

function normalizeResult(result) {
  return { rows: result?.rows || [], rowCount: result?.rowCount ?? result?.rows?.length ?? 0 };
}

export class PgAdapter {
  constructor(pool) {
    this.kind = 'postgres';
    this.pool = pool;
  }

  async query(text, params = []) {
    return normalizeResult(await this.pool.query(text, params));
  }

  async transact(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async (text, params = []) => normalizeResult(await client.query(text, params))
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async ready() {
    await this.query('SELECT 1 AS ok');
    return true;
  }

  async close() {
    await this.pool.end();
  }
}

export class PGliteAdapter {
  constructor(db) {
    this.kind = 'pglite';
    this.db = db;
  }

  async query(text, params = []) {
    return normalizeResult(await this.db.query(text, params));
  }

  async transact(fn) {
    return this.db.transaction(async tx => fn({
      query: async (text, params = []) => normalizeResult(await tx.query(text, params))
    }));
  }

  async ready() {
    await this.query('SELECT 1 AS ok');
    return true;
  }

  async close() {
    if (typeof this.db.close === 'function') await this.db.close();
  }
}

export function createPgPool(connectionString) {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000
  });
}

export async function createPGlite(dataDir) {
  if (!dataDir) return new PGlite();
  // PGlite's NodeFS uses mkdirSync without recursive, so the parent must exist.
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  return new PGlite(dataDir);
}

export function redactDatabaseUrl(url) {
  if (!url) return null;
  return String(url).replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:[redacted]@');
}
