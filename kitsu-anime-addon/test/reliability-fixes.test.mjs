import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupedCatalog } from '../src/season-groups.mjs';
import { createAnimeMappingLoader } from '../src/anime-mappings.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('grouped catalog keeps a consistent cursor between first and later pages', async () => {
  let requests = 0;
  const api = { request: async (_path, params) => {
    requests++;
    const number = params['page[number]'];
    return { data: Array.from({ length: 20 }, (_, i) => ({ id: String((number - 1) * 20 + i + 1), attributes: {} })), meta: { count: 200 }, links: { next: number < 10 ? 'next' : null } };
  }};
  const grouped = createGroupedCatalog({ api, preview: item => ({ id: `kitsu:${item.id}` }) });
  const index = { byMember: new Map(), byRoot: new Map() };
  const params = { sort: 'popularityRank' };
  const first = await grouped('popular', params, 0, index);
  const second = await grouped('popular', params, 100, index);
  assert.equal(first.metas.length, 100);
  assert.equal(second.metas.length, 100);
  assert.equal(new Set([...first.metas, ...second.metas].map(m => m.id)).size, 200);
  assert.equal(requests, 10);
});

test('mapping loader restores a validated cached mapping after upstream failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitsu-test-'));
  try {
    const cachePath = join(dir, 'mapping.json');
    const original = createAnimeMappingLoader({ cachePath, fetchImpl: async () => new Response(JSON.stringify([{ kitsu_id: 12, type: 'TV', themoviedb_id: { tv: 7 }, season: { tmdb: 1 } }])) });
    assert.equal((await original()).length, 1);
    const restored = createAnimeMappingLoader({ cachePath, fetchImpl: async () => { throw Error('offline'); } });
    assert.equal((await restored())[0].kitsu_id, 12);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent first loads share one disk restore and ignore future-dated or stale cache files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitsu-test-'));
  try {
    const cachePath = join(dir, 'mapping.json');
    const clock = 10 * 86400000;
    // An older copy (two days old): usable during outages, but due a refresh.
    await writeFile(cachePath, JSON.stringify({ saved: clock - 2 * 86400000, rows: [{ kitsu_id: 1 }] }));
    let calls = 0;
    const load = createAnimeMappingLoader({ cachePath, now: () => clock, fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify([{ kitsu_id: 2 }]));
    } });
    const [a, b] = await Promise.all([load(), load()]);
    assert.equal(a, b);
    assert.equal(a[0].kitsu_id, 2);
    assert.equal(calls, 1);

    await writeFile(cachePath, JSON.stringify({ saved: clock + 86400000, rows: [{ kitsu_id: 3 }] }));
    const future = createAnimeMappingLoader({ cachePath, now: () => clock, fetchImpl: async () => new Response(JSON.stringify([{ kitsu_id: 4 }])) });
    assert.equal((await future())[0].kitsu_id, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
