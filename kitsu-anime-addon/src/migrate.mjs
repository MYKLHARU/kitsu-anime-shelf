// Ordered, checksummed SQL migrations. Each file runs in its own transaction
// under a PostgreSQL advisory lock, so concurrent deploys cannot double-apply.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 7314159265; // Arbitrary, stable advisory-lock key for this app.

export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter(name => FILE.test(name)).sort();
  return Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, dir), 'utf8');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) throw new Error(`${name} must not manage its own transaction`);
    return { version: name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS shelf_schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

async function applied(connection) {
  const exists = await connection.query(`SELECT to_regclass('shelf_schema_migrations') IS NOT NULL AS present`);
  if (!exists.rows[0].present) return new Map();
  const result = await connection.query('SELECT version, checksum FROM shelf_schema_migrations');
  return new Map(result.rows.map(row => [row.version, row.checksum]));
}

function verifyChecksums(done, migrations) {
  for (const migration of migrations) {
    const checksum = done.get(migration.version);
    if (checksum && checksum !== migration.checksum) {
      throw new Error(`Migration ${migration.version} was modified after it was applied`);
    }
  }
}

export async function pendingMigrations(pool, { dir } = {}) {
  const migrations = await loadMigrations(dir);
  return pool.withConnection(async connection => {
    const done = await applied(connection);
    verifyChecksums(done, migrations);
    return migrations.filter(migration => !done.has(migration.version)).map(migration => migration.version);
  });
}

export async function migrate(pool, { dir, logger = console } = {}) {
  const migrations = await loadMigrations(dir);
  return pool.withConnection(async connection => {
    await connection.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    // Schema changes may take longer than the application's statement timeout.
    await connection.query('SET statement_timeout = 0');
    try {
      await connection.query(ENSURE_TABLE);
      const done = await applied(connection);
      verifyChecksums(done, migrations);
      const ran = [];
      for (const migration of migrations) {
        if (done.has(migration.version)) continue;
        await connection.simpleQuery('BEGIN');
        try {
          await connection.simpleQuery(migration.sql);
          await connection.query('INSERT INTO shelf_schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
          await connection.simpleQuery('COMMIT');
        } catch (error) {
          await connection.simpleQuery('ROLLBACK').catch(() => {});
          throw new Error(`Migration ${migration.version} failed: ${error.message}`);
        }
        logger.log?.(`Applied migration ${migration.version}`);
        ran.push(migration.version);
      }
      return ran;
    } finally {
      await connection.query('RESET statement_timeout').catch(() => {});
      await connection.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  });
}
