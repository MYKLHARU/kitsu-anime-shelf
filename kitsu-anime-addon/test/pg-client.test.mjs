import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPool, parseConnectionString, PgError } from '../src/pg-client.mjs';
import { migrate, pendingMigrations } from '../src/migrate.mjs';
import { createTestDatabase, DATABASE_URL, dbSkip } from './helpers/db.mjs';

test('connection strings follow libpq defaults', () => {
  const remote = parseConnectionString('postgres://user:p%40ss@db.example.com:6543/shelf');
  assert.deepEqual([remote.host, remote.port, remote.user, remote.password, remote.database, remote.sslmode], ['db.example.com', 6543, 'user', 'p@ss', 'shelf', 'verify-full']);
  assert.equal(parseConnectionString('postgresql://u@localhost/x').sslmode, 'prefer');
  assert.equal(parseConnectionString('postgres://u@db/x?sslmode=require').sslmode, 'require');
  assert.equal(parseConnectionString('postgres://u@db/x?options=-c%20search_path%3Dabc').options, '-c search_path=abc');
  assert.throws(() => parseConnectionString('mysql://u@db/x'), TypeError);
  assert.throws(() => parseConnectionString('postgres://u@db/x?sslmode=allow'), TypeError);
  assert.throws(() => parseConnectionString('postgres://u@db/x?sslmode=verify-ca'), /requires sslrootcert/);
  assert.equal(parseConnectionString('postgres://u@db/x?sslmode=verify-ca&sslrootcert=/ca.pem').sslrootcert, '/ca.pem');
});

test('PostgreSQL client: types, parameters, errors, pooling and transactions', { skip: dbSkip }, async () => {
  const pool = createPool(DATABASE_URL, { max: 3 });
  try {
    const { rows } = await pool.query(
      `SELECT $1::int AS n, $2::text AS t, $3::bool AS b, $4::jsonb AS j, $5::text[] AS arr, $6::bytea AS bin,
              $7::timestamptz AS ts, 12.5::numeric AS num, NULL::text AS nothing, 9007199254740993::int8 AS big`,
      [41, 'héllo "quoted" \\ back', true, { a: [1, 'x'] }, ['a', 'b c', null, 'd"e', 'f\\g'], Buffer.from([0, 255, 16]), new Date('2026-01-02T03:04:05.678Z')]);
    assert.deepEqual(rows[0], {
      n: 41, t: 'héllo "quoted" \\ back', b: true, j: { a: [1, 'x'] }, arr: ['a', 'b c', null, 'd"e', 'f\\g'], bin: Buffer.from([0, 255, 16]),
      ts: new Date('2026-01-02T03:04:05.678Z'), num: '12.5', nothing: null, big: '9007199254740993'
    });
    // SQL injection attempts are inert parameters.
    assert.equal((await pool.query('SELECT $1::text AS v', ["'); DROP TABLE x; --"])).rows[0].v, "'); DROP TABLE x; --");
    await assert.rejects(pool.query('SELECT 1/0'), error => error instanceof PgError && error.code === '22012');
    assert.equal((await pool.query('SELECT 2 AS ok')).rows[0].ok, 2, 'connection usable after an error');
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => pool.query('SELECT $1::int AS i, pg_sleep(0.02)', [i])));
    assert.deepEqual(many.map(result => result.rows[0].i), Array.from({ length: 12 }, (_, i) => i));
    assert.ok(pool.stats.total <= 3);

    await pool.query('CREATE TEMP TABLE IF NOT EXISTS t (v int)').catch(() => {});
    await pool.query('DROP TABLE IF EXISTS pg_client_tx_test');
    await pool.query('CREATE TABLE pg_client_tx_test (v int)');
    await assert.rejects(pool.transaction(async tx => {
      await tx.query('INSERT INTO pg_client_tx_test VALUES (1)');
      throw new Error('abort');
    }), /abort/);
    await pool.transaction(async tx => tx.query('INSERT INTO pg_client_tx_test VALUES (2)'));
    assert.deepEqual((await pool.query('SELECT v FROM pg_client_tx_test')).rows, [{ v: 2 }]);
    const result = await pool.query('UPDATE pg_client_tx_test SET v = 3');
    assert.equal(result.rowCount, 1);
    await pool.query('DROP TABLE pg_client_tx_test');
  } finally {
    await pool.end();
  }
});

test('PostgreSQL client rejects bad credentials', { skip: dbSkip }, async () => {
  const url = new URL(DATABASE_URL);
  url.password = 'definitely-wrong-password';
  const pool = createPool(url.href, { max: 1 });
  await assert.rejects(pool.query('SELECT 1'), error => error.code === '28P01' || /password|authentication/i.test(error.message));
  await pool.end();
});

test('migrations apply once, in order, and detect edits', { skip: dbSkip }, async () => {
  const db = await createTestDatabase({ migrated: false });
  const dir = await mkdtemp(join(tmpdir(), 'shelf-migrations-'));
  try {
    const url = new URL(`file://${dir}/`);
    await writeFile(join(dir, '001_first.sql'), 'CREATE TABLE m1 (id int);');
    await writeFile(join(dir, '002_second.sql'), 'CREATE TABLE m2 (id int); INSERT INTO m2 VALUES (1);');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    assert.deepEqual(await pendingMigrations(db.pool, { dir: url }), ['001_first.sql', '002_second.sql']);
    assert.deepEqual(await migrate(db.pool, { dir: url, logger: {} }), ['001_first.sql', '002_second.sql']);
    assert.deepEqual(await migrate(db.pool, { dir: url, logger: {} }), []);
    await writeFile(join(dir, '003_broken.sql'), 'CREATE TABLE m3 (id int); SELECT nope FROM missing;');
    await assert.rejects(migrate(db.pool, { dir: url, logger: {} }), /003_broken\.sql failed/);
    assert.equal((await db.pool.query(`SELECT to_regclass('m3') IS NULL AS absent`)).rows[0].absent, true, 'failed migration rolled back');
    await rm(join(dir, '003_broken.sql'));
    await writeFile(join(dir, '001_first.sql'), 'CREATE TABLE m1 (id bigint);');
    await assert.rejects(migrate(db.pool, { dir: url, logger: {} }), /modified after it was applied/);
    await writeFile(join(dir, '004_tx.sql'), 'BEGIN; SELECT 1; COMMIT;');
    await assert.rejects(migrate(db.pool, { dir: url, logger: {} }), /must not manage its own transaction/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('bundled schema migrates and enforces constraints', { skip: dbSkip }, async () => {
  const db = await createTestDatabase();
  try {
    assert.deepEqual(await pendingMigrations(db.pool), []);
    await assert.rejects(db.pool.query(`INSERT INTO shelf_users (email) VALUES ('UPPER@Example.com')`), /shelf_users_email_format/);
    const user = (await db.pool.query(`INSERT INTO shelf_users (email) VALUES ('a@example.com') RETURNING id`)).rows[0].id;
    await assert.rejects(db.pool.query(`INSERT INTO shelf_users (email) VALUES ('a@example.com')`), error => error.code === '23505');
    await assert.rejects(db.pool.query(`INSERT INTO shelf_sessions (token_hash, user_id, expires_at) VALUES ('\\x00', $1, now())`, [user]), error => error.code === '23514');
    await assert.rejects(db.pool.query(`INSERT INTO shelf_anime (canonical_title, poster_url) VALUES ('x', 'http://insecure')`), error => error.code === '23514');
  } finally {
    await db.drop();
  }
});

// A malicious or broken server, speaking just enough protocol to misbehave.
async function fakeServer(onStartup) {
  const net = await import('node:net');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('data', () => onStartup(socket));
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}
const message = (type, body) => {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const int32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

test('rejects a server that skips SCRAM verification', async () => {
  const server = await fakeServer(socket => {
    socket.write(message('R', Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256\0\0')])));
    socket.once('data', () => socket.write(message('R', int32(0))));
  });
  try {
    const pool = createPool(`postgres://u:p@127.0.0.1:${server.port}/db?sslmode=disable`, { max: 1 });
    await assert.rejects(pool.query('SELECT 1'), /skipped SCRAM verification/);
    await pool.end();
  } finally { server.close(); }
});

test('connection timeout covers a server that never finishes the handshake', async () => {
  const server = await fakeServer(() => { /* never answers */ });
  try {
    const { PgConnection } = await import('../src/pg-client.mjs');
    const connection = new PgConnection(parseConnectionString(`postgres://u:p@127.0.0.1:${server.port}/db?sslmode=disable`), { connectTimeoutMs: 200 });
    const started = Date.now();
    await assert.rejects(connection.connect(), /timed out/);
    assert.ok(Date.now() - started < 2000);
    assert.equal(connection.broken, true);
  } finally { server.close(); }
});
