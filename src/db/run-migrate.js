import { createPgPool, PgAdapter, redactDatabaseUrl } from './adapter.js';
import { migrate } from './migrate.js';

export async function migrateFromUrl(databaseUrl, { close = true } = {}) {
  if (!databaseUrl || !String(databaseUrl).trim()) {
    throw new Error('DATABASE_URL is required for migrations. AI provider keys are not required.');
  }
  const adapter = new PgAdapter(createPgPool(databaseUrl));
  try {
    await adapter.ready().catch(error => {
      throw new Error(`Database is unavailable (${redactDatabaseUrl(databaseUrl) || 'DATABASE_URL'}): ${error.message}`);
    });
    const result = await migrate(adapter);
    return { engine: 'postgres', id: result.id, applied: result.applied, adapter: close ? null : adapter };
  } finally {
    if (close) await adapter.close();
  }
}
