import { MIGRATION_ID, MIGRATION_STATEMENTS } from './schema.js';
import { PHASE4_MIGRATION_ID, PHASE4_STATEMENTS } from './schema-phase4.js';
import { PHASE5_MIGRATION_ID, PHASE5_STATEMENTS } from './schema-phase5.js';
import { PHASE6_MIGRATION_ID, PHASE6_STATEMENTS } from './schema-phase6.js';
import { PHASE7_MIGRATION_ID, PHASE7_STATEMENTS } from './schema-phase7.js';
import { PHASE8_MIGRATION_ID, PHASE8_STATEMENTS } from './schema-phase8.js';
import { PHASE9_MIGRATION_ID, PHASE9_STATEMENTS } from './schema-phase9.js';

export const MIGRATIONS = [
  { id: MIGRATION_ID, statements: MIGRATION_STATEMENTS },
  { id: PHASE4_MIGRATION_ID, statements: PHASE4_STATEMENTS },
  { id: PHASE5_MIGRATION_ID, statements: PHASE5_STATEMENTS },
  { id: PHASE6_MIGRATION_ID, statements: PHASE6_STATEMENTS },
  { id: PHASE7_MIGRATION_ID, statements: PHASE7_STATEMENTS },
  { id: PHASE8_MIGRATION_ID, statements: PHASE8_STATEMENTS },
  { id: PHASE9_MIGRATION_ID, statements: PHASE9_STATEMENTS }
];

export async function migrate(adapter) {
  await adapter.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  let last = null;
  let appliedAny = false;
  for (const migration of MIGRATIONS) {
    const applied = await adapter.query('SELECT id FROM schema_migrations WHERE id = $1', [migration.id]);
    if (applied.rows.length) {
      last = { applied: false, id: migration.id };
      continue;
    }
    try {
      await adapter.transact(async tx => {
        for (const statement of migration.statements) {
          await tx.query(statement);
        }
        await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      });
    } catch (error) {
      throw new Error(`Migration ${migration.id} failed: ${error.message}`);
    }
    last = { applied: true, id: migration.id };
    appliedAny = true;
  }
  return last || { applied: appliedAny, id: MIGRATION_ID };
}

export async function migrationStatus(adapter) {
  try {
    const rows = await adapter.query('SELECT id, applied_at FROM schema_migrations ORDER BY applied_at');
    return rows.rows.map(row => ({ id: row.id, appliedAt: toIso(row.applied_at) }));
  } catch (error) {
    throw new Error(`Unable to read migration history: ${error.message}`);
  }
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
