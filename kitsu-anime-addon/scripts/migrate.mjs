// Apply pending database migrations: DATABASE_URL=postgres://... npm run migrate
// Use --status to list pending migrations without applying them.
import { createPool } from '../src/pg-client.mjs';
import { migrate, pendingMigrations } from '../src/migrate.mjs';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to a postgres:// connection string.');
  process.exit(2);
}
const pool = createPool(process.env.DATABASE_URL, { max: 1, statementTimeoutMs: 0 });
try {
  if (process.argv.includes('--status')) {
    const pending = await pendingMigrations(pool);
    console.log(pending.length ? `Pending migrations:\n${pending.join('\n')}` : 'Database schema is up to date.');
    process.exitCode = pending.length ? 1 : 0;
  } else {
    const ran = await migrate(pool);
    console.log(ran.length ? `Applied ${ran.length} migration(s).` : 'Database schema is already up to date.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
