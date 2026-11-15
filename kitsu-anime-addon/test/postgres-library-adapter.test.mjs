import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresLibraryAdapter } from '../src/postgres-library-adapter.mjs';

const user = 'd6a1cbf8-56df-4c2e-9b0e-2242e8297642';

test('queries scoped to a user and resolves provider ID', async () => {
  const calls = [];
  const adapter = createPostgresLibraryAdapter({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ status: 'watching', progress: 7, score: '8.5' }] };
    }
  });
  const entry = await adapter.get(user, 'kitsu:11469');
  assert.equal(entry.progress, 7);
  assert.equal(entry.score, 8.5);
  assert.deepEqual(calls[0].params, [user, 'kitsu', '11469']);
  assert.ok(calls[0].sql.includes('l.user_id'));
});

test('atomically upserts known IDs', async () => {
  let statement = '';
  const adapter = createPostgresLibraryAdapter({
    async query(sql, params) {
      statement = sql;
      assert.deepEqual(params, [user, 'kitsu', '1', 'watching', 2, null]);
      return { rows: [{ status: 'watching', progress: 2, score: null }] };
    }
  });
  const entry = await adapter.put(user, { animeId: 'kitsu:1', status: 'watching', progress: 2 });
  assert.equal(entry.progress, 2);
  assert.ok(statement.includes('ON CONFLICT'));
});

test('rejects invalid identifiers before querying', async () => {
  let called = false;
  const adapter = createPostgresLibraryAdapter({
    async query() { called = true; return { rows: [] }; }
  });
  await assert.rejects(adapter.get('bad-user', 'kitsu:1'), TypeError);
  await assert.rejects(adapter.get(user, 'invalid'), TypeError);
  await assert.rejects(adapter.put(user, { animeId: 'kitsu:1', progress: -1 }), RangeError);
  assert.equal(called, false);
});
