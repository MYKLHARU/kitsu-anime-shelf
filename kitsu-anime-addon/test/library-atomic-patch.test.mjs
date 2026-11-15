import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryService } from '../src/library-store.mjs';
import { createPostgresLibraryAdapter } from '../src/postgres-library-adapter.mjs';

const user = 'd6a1cbf8-56df-4c2e-9b0e-2242e8297642';

test('service delegates partial writes to atomic adapter patch', async () => {
  let read = false;
  let patchArgs;
  const service = createLibraryService({
    async get() { read = true; throw new Error('must not read before patch'); },
    async put() { throw new Error('must not put'); },
    async patch(...args) {
      patchArgs = args;
      return { animeId: 'kitsu:1', status: 'watching', progress: 9, score: null };
    }
  });
  const result = await service.save(user, 'kitsu:1', { progress: 9 });
  assert.equal(read, false);
  assert.equal(result.progress, 9);
  assert.deepEqual(patchArgs.slice(0, 3), [user, 'kitsu:1', { progress: 9 }]);
});

test('PostgreSQL patch preserves omitted fields using conditional SQL', async () => {
  let statement, values;
  const adapter = createPostgresLibraryAdapter({
    async query(sql, params) {
      statement = sql;
      values = params;
      return { rows: [{ status: 'completed', progress: 5, score: '9.0' }] };
    }
  });
  const result = await adapter.patch(user, 'kitsu:1', { progress: 5 });
  assert.equal(result.status, 'completed');
  assert.equal(result.score, 9);
  assert.deepEqual(values.slice(-3), [false, true, false]);
  assert.ok(statement.includes('CASE WHEN'));
  assert.ok(statement.includes('ON CONFLICT'));
});

test('invalid patch does not touch database', async () => {
  let queries = 0;
  const adapter = createPostgresLibraryAdapter({ async query() { queries++; return { rows: [] }; } });
  await assert.rejects(adapter.patch(user, 'kitsu:1', { progress: -1 }), RangeError);
  await assert.rejects(adapter.patch(user, 'kitsu:1', { animeId: 'kitsu:2' }));
  await assert.rejects(adapter.patch(user, 'kitsu:1', { isAdmin: true }), TypeError);
  assert.equal(queries, 0);
});
