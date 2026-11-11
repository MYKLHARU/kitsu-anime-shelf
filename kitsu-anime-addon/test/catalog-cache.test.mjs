import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createCatalogCache } from '../src/catalog-cache.mjs';
import { createKitsuService, createApiClient } from '../src/kitsu.mjs';
import { createSeasonGroups } from '../src/season-groups.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cold concurrent category reads share one load and fresh reads reuse the result', async () => {
  const cache = createCatalogCache();
  const gate = deferred();
  let calls = 0;
  const load = async () => { calls += 1; await gate.promise; return 'first'; };
  const a = cache.read('Action', load);
  const b = cache.read('Action', load);
  await setImmediate();
  assert.equal(calls, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b]), ['first', 'first']);
  assert.equal(await cache.read('Action', load), 'first');
  assert.equal(calls, 1);
});

test('stale category data returns before a slow refresh finishes, then updates atomically', async () => {
  let clock = 0;
  const cache = createCatalogCache({ now: () => clock, freshMs: 100, staleMs: 1000 });
  await cache.read('Action', async () => 'old');
  clock = 101;
  const gate = deferred();
  let result;
  const read = cache.read('Action', async () => { await gate.promise; return 'new'; }).then(value => { result = value; });
  await setImmediate();
  assert.equal(result, 'old', 'Category readers must not wait for the upstream refresh');
  gate.resolve();
  await read;
  await setImmediate();
  assert.equal(await cache.read('Action', async () => 'unexpected'), 'new');
});

test('many stale homepage rows refresh one catalog at a time without delaying their cached responses', async () => {
  let clock = 0;
  const cache = createCatalogCache({ now: () => clock, freshMs: 100, staleMs: 1000 });
  for (const name of ['Action', 'Comedy', 'Romance', 'Isekai']) await cache.read(name, async () => name);
  clock = 101;
  const gate = deferred();
  let active = 0;
  let maximum = 0;
  const replies = await Promise.all(['Action', 'Comedy', 'Romance', 'Isekai'].map(name => cache.read(name, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active -= 1;
    return `${name} refreshed`;
  })));
  assert.deepEqual(replies, ['Action', 'Comedy', 'Romance', 'Isekai']);
  assert.equal(maximum, 1);
  gate.resolve();
  await setImmediate();
  assert.equal(maximum, 1);
  assert.equal(await cache.read('Isekai', async () => 'unexpected'), 'Isekai refreshed');
});

test('failed refreshes retain usable categories and retry only after backoff', async () => {
  let clock = 0;
  let calls = 0;
  const cache = createCatalogCache({ now: () => clock, freshMs: 100, staleMs: 1000, retryMs: 50 });
  await cache.read('Action', async () => 'old');
  const fail = async () => { calls += 1; throw new Error('Kitsu unavailable'); };
  clock = 101;
  assert.equal(await cache.read('Action', fail), 'old');
  await setImmediate();
  assert.equal(await cache.read('Action', fail), 'old');
  await setImmediate();
  assert.equal(calls, 1);
  clock = 152;
  assert.equal(await cache.read('Action', fail), 'old');
  await setImmediate();
  assert.equal(calls, 2);
});

test('data past the stale limit waits for a fresh load and bounded storage evicts old entries', async () => {
  let clock = 0;
  const cache = createCatalogCache({ now: () => clock, maxEntries: 2, freshMs: 100, staleMs: 1000 });
  await cache.read('Action', async () => 'old');
  clock = 1001;
  const gate = deferred();
  let settled = false;
  const refresh = cache.read('Action', async () => { await gate.promise; return 'fresh'; }).then(value => { settled = true; return value; });
  await setImmediate();
  assert.equal(settled, false);
  gate.resolve();
  assert.equal(await refresh, 'fresh');
  await cache.read('Comedy', async () => 'comedy');
  await cache.read('Drama', async () => 'drama');
  assert.equal(await cache.read('Action', async () => 'loaded again'), 'loaded again');
});

test('catalog queries are lightweight while filtering, title artwork and detail genres remain available', async () => {
  const calls = [];
  const item = { id: '1', type: 'anime', attributes: { canonicalTitle: 'Anime', subtype: 'TV', episodeCount: 1,
    posterImage: { medium: 'https://media.kitsu.app/1.jpg' } }, relationships: { categories: { data: [{ type: 'categories', id: '1' }] } } };
  const service = createKitsuService({ request: async (path, params) => {
    calls.push({ path, params });
    if (path === 'anime') return { data: [item] };
    if (path.endsWith('/episodes')) return { data: [], meta: { count: 0 } };
    return { data: item, included: [{ id: '1', type: 'categories', attributes: { title: 'Adventure' } }] };
  } });
  const { metas } = await service.catalog('kitsu-category-action');
  assert.equal(calls[0].params.include, undefined);
  assert.equal(calls[0].params['filter[categories]'], 'action');
  assert.ok(calls[0].params['fields[anime]'].includes('posterImage'));
  assert.deepEqual(metas[0].genres, ['Action']);
  assert.equal(metas[0].poster, 'https://media.kitsu.app/1.jpg');
  const { meta } = await service.metadata('kitsu:1');
  assert.equal(calls.find(call => call.path === 'anime/1').params.include, 'categories');
  assert.deepEqual(meta.genres, ['Adventure']);
  await service.catalog('kitsu-category-action');
  assert.equal(calls.filter(call => call.path === 'anime').length, 1);
  await assert.rejects(service.catalog('kitsu-category-action', { skip: 'invalid' }), { status: 400 });
});

test('background ranking refreshes preserve pagination for the first page actually delivered', async () => {
  let clock = 0;
  let ids = Array.from({ length: 300 }, (_, i) => i + 1);
  const service = createKitsuService({ request: async (path, params) => {
    const start = (params['page[number]'] - 1) * 20;
    return { data: ids.slice(start, start + 20).map(id => ({ id: String(id), attributes: { canonicalTitle: `Anime ${id}` } })),
      meta: { count: ids.length }, links: { next: start + 20 < ids.length ? 'next' : null } };
  } }, { now: () => clock, seasonGroups: createSeasonGroups({ loadMappings: async () => [
    { kitsu_id: 1, type: 'TV', themoviedb_id: { tv: 1 }, season: { tmdb: 1 } },
    { kitsu_id: 301, type: 'TV', themoviedb_id: { tv: 1 }, season: { tmdb: 2 } }
  ] }) });
  const first = await service.catalog('kitsu-popular');
  ids = [...ids.slice(100, 200), ...ids.slice(0, 100), ...ids.slice(200)];
  clock = 901000;
  const stale = await service.catalog('kitsu-popular');
  assert.deepEqual(stale, first);
  await setImmediate();
  const second = await service.catalog('kitsu-popular', { skip: 100 });
  const oldIds = new Set(stale.metas.map(meta => meta.id));
  assert.ok(second.metas.every(meta => !oldIds.has(meta.id)));
  assert.equal(second.metas[0].id, 'kitsu:101');
  const updated = await service.catalog('kitsu-popular');
  assert.equal(updated.metas[0].id, 'kitsu:101');
  const next = await service.catalog('kitsu-popular', { skip: 100 });
  const newIds = new Set(updated.metas.map(meta => meta.id));
  assert.ok(next.metas.every(meta => !newIds.has(meta.id)));
});

test('title details and catalog completion run ahead of queued first-page and background work', async () => {
  const gates = [];
  const started = [];
  const api = createApiClient({ fetchImpl: async url => {
    started.push(url.searchParams.get('job'));
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return jsonResponse();
  } });
  function jsonResponse() { return new Response(JSON.stringify({ data: [] })); }
  const initial = Array.from({ length: 3 }, (_, i) => api.request('anime', { job: `active${i}` }));
  await setImmediate();
  const background = api.request('anime', { job: 'background' }, 900, { priority: -2 });
  const first = api.request('anime', { job: 'other-row' });
  const finish = api.request('anime', { job: 'finish-row' }, 900, { priority: 1 });
  const details = api.request('anime/1', { job: 'details' });
  gates[0].resolve();
  await setImmediate();
  assert.equal(started[3], 'details');
  gates[3].resolve();
  await setImmediate();
  assert.equal(started[4], 'finish-row');
  gates[4].resolve();
  await setImmediate();
  assert.equal(started[5], 'other-row');
  gates[5].resolve();
  await setImmediate();
  assert.equal(started[6], 'background');
  for (const gate of gates) gate.resolve();
  await Promise.all([...initial, background, first, finish, details]);
});
