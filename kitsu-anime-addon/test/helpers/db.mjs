// Database helpers for integration tests.
// Set TEST_DATABASE_URL to a disposable PostgreSQL 13+ database. Each test file
// gets its own schema, so files can run in parallel. Without the variable the
// database tests are skipped, unless REQUIRE_DB_TESTS=1 (as in CI).
import { randomBytes } from 'node:crypto';
import { createPool } from '../../src/pg-client.mjs';
import { migrate } from '../../src/migrate.mjs';

export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const dbSkip = DATABASE_URL ? false : (process.env.REQUIRE_DB_TESTS === '1' ? false : 'TEST_DATABASE_URL is not set');

if (!DATABASE_URL && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set');
}

export function schemaUrl(schema) {
  const url = new URL(DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.href;
}

// Creates an isolated, migrated schema. Returns { pool, url, schema, drop }.
export async function createTestDatabase({ migrated = true } = {}) {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(DATABASE_URL, { max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = schemaUrl(schema);
  const pool = createPool(url, { max: 8 });
  if (migrated) await migrate(pool, { logger: {} });
  return {
    pool, url, schema,
    async drop() {
      await pool.end();
      const cleanup = createPool(DATABASE_URL, { max: 1 });
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    }
  };
}
