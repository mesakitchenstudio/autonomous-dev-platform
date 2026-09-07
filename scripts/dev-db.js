import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.PGLITE_DATA_DIR || path.join(root, '.pglite', 'dev');
const port = Number(process.env.PG_PORT || 5432);
const db = new PGlite(dataDir);
const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port });
await server.start();
console.log(`PGlite development database listening on 127.0.0.1:${port}`);
console.log('Set DATABASE_URL=postgres://postgres:postgres@127.0.0.1:' + port + '/postgres');
console.log('This is a local Postgres-compatible engine for development, not a production cluster.');
