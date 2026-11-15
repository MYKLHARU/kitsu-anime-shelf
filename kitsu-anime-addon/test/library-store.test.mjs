import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryService, createMemoryLibraryAdapter } from '../src/library-store.mjs';

test('library service isolates entries by user', async () => {
  const service = createLibraryService(createMemoryLibraryAdapter());
  await service.save('user_a', 'kitsu:1', { status: 'watching', progress: 4 });
  await service.save('user_b', 'kitsu:1', { status: 'completed', progress: 12 });
  assert.equal((await service.get('user_a', 'kitsu:1')).progress, 4);
  assert.equal((await service.get('user_b', 'kitsu:1')).progress, 12);
  assert.equal(await service.get('user_c', 'kitsu:1'), null);
});

test('rejects invalid IDs and preserves stored data on invalid updates', async () => {
  const service = createLibraryService(createMemoryLibraryAdapter());
  await service.save('user_a', 'kitsu:1', { progress: 3 });
  await assert.rejects(service.save('user_a', 'kitsu:1', { progress: -1 }), RangeError);
  await assert.rejects(service.get('../bad', 'kitsu:1'), TypeError);
  assert.equal((await service.get('user_a', 'kitsu:1')).progress, 3);
});

test('requires an adapter and validates its returned entries', async () => {
  assert.throws(() => createLibraryService(null), TypeError);
  const service = createLibraryService({ get: async () => null, put: async () => ({ animeId: 'kitsu:1', progress: -2 }) });
  await assert.rejects(service.save('user_a', 'kitsu:1'), RangeError);
});
