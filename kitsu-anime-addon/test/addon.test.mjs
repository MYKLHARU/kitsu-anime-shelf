import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CATEGORIES, CATEGORY_NAMES } from '../src/categories.mjs';
import { ApiError, createApiClient, createKitsuService } from '../src/kitsu.mjs';
import { createAddonServer, manifest } from '../src/addon.mjs';

function anime(id, attributes = {}) {
  return {
    id: String(id), type: 'anime',
    attributes: { canonicalTitle: `Anime ${id}`, episodeCount: 3, posterImage: { medium: 'https://media.kitsu.app/poster.jpg' }, ...attributes }
  };
}
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('manifest advertises all 40 categories as main catalogs and isolates search', () => {
  assert.equal(manifest.catalogs.length, 45);
  assert.deepEqual(manifest.types, ['series']);
  assert.deepEqual(manifest.resources[0].types, ['series']);
  assert.match(manifest.logo, /^https:\/\/.+\/logo\.png$/);
  assert.equal(CATEGORY_NAMES.length, 40);
  assert.deepEqual(manifest.catalogs.slice(0, 40).map(catalog => catalog.name), CATEGORY_NAMES);
  assert.equal(new Set(manifest.catalogs.map(catalog => catalog.id)).size, 45);
  for (const catalog of manifest.catalogs) {
    assert.equal(catalog.extra.some(extra => extra.name === 'genre'), false);
    assert.equal(catalog.type, 'series');
  }
  assert.equal(manifest.catalogs.filter(catalog => catalog.extra.some(extra => extra.name === 'search' && extra.isRequired)).length, 1);
  assert.deepEqual(manifest.resources.map(resource => resource.name), ['catalog', 'meta']);
});

test('catalog bridges Kitsu pages into 100-item Stremio pages without losing the next page', async () => {
  const offsets = [];
  const api = createApiClient({ fetchImpl: async url => {
    const offset = (Number(url.searchParams.get('page[number]')) - 1) * 20;
    offsets.push(offset);
    assert.equal(url.searchParams.get('page[size]'), '20');
    assert.equal(url.searchParams.has('page[offset]'), false);
    const length = Math.min(20, Math.max(0, 220 - offset));
    return jsonResponse({ data: Array.from({ length }, (_, index) => anime(offset + index + 1)), meta: { count: 220 }, links: { next: offset + 20 < 220 ? 'next' : null } });
  } });
  const service = createKitsuService(api);
  const first = await service.catalog('kitsu-popular');
  assert.equal(first.metas.length, 100);
  assert.deepEqual(offsets.sort((a, b) => a - b), [0, 20, 40, 60, 80]);
  assert.equal(first.metas[0].id, 'kitsu:1');
  assert.equal(first.metas[99].id, 'kitsu:100');
  const second = await service.catalog('kitsu-popular', { skip: '100' });
  assert.equal(second.metas[0].id, 'kitsu:101');
  const last = await service.catalog('kitsu-popular', { skip: '200' });
  assert.equal(last.metas.length, 20);
  const uneven = await service.catalog('kitsu-popular', { skip: '13' });
  assert.equal(uneven.metas.length, 100);
  assert.equal(uneven.metas[0].id, 'kitsu:14');
  assert.equal(uneven.metas[99].id, 'kitsu:113');
});

test('main category catalogs map to Kitsu while movie and airing catalogs keep their filters', async () => {
  const urls = [];
  const service = createKitsuService(createApiClient({ fetchImpl: async url => {
    urls.push(url);
    return jsonResponse({ data: [], meta: { count: 0 } });
  } }));
  for (const slug of Object.values(CATEGORIES)) {
    await service.catalog(`kitsu-category-${slug}`);
    assert.equal(urls.at(-1).searchParams.get('filter[categories]'), slug);
  }
  await service.catalog('kitsu-movies');
  assert.equal(urls.at(-1).searchParams.get('filter[subtype]'), 'movie');
  await service.catalog('kitsu-airing');
  assert.equal(urls.at(-1).searchParams.get('filter[status]'), 'current');
});

test('search preserves punctuation and Kitsu relevance ordering; empty search does not call upstream', async () => {
  let calls = 0;
  const service = createKitsuService(createApiClient({ fetchImpl: async url => {
    calls += 1;
    assert.equal(url.searchParams.get('filter[text]'), 'A & B + C');
    assert.equal(url.searchParams.has('sort'), false);
    return jsonResponse({ data: [anime(1)] });
  } }));
  assert.deepEqual(await service.catalog('kitsu-search'), { metas: [] });
  await service.catalog('kitsu-search', { search: 'A & B + C' });
  assert.equal(calls, 1);
  await assert.rejects(service.catalog('kitsu-category-unknown'), { status: 404 });
  await assert.rejects(service.catalog('kitsu-popular', { skip: '-1' }), { status: 400 });
  await assert.rejects(service.catalog('kitsu-popular', { search: 'x'.repeat(201) }), { status: 400 });
});

test('metadata includes all pages of episodes with absolute Kitsu IDs and numbered gaps', async () => {
  const service = createKitsuService(createApiClient({ fetchImpl: async url => {
    if (url.pathname.endsWith('/anime/1')) return jsonResponse({ data: anime(1, { episodeCount: 26 }) });
    const offset = Number(url.searchParams.get('page[offset]'));
    const data = Array.from({ length: Math.min(20, 26 - offset) }, (_, index) => ({
      id: String(index + offset), type: 'episodes',
      attributes: { number: offset + index + 1, canonicalTitle: `Title ${offset + index + 1}`, airdate: '2020-01-01' }
    })).filter(item => item.attributes.number !== 7);
    return jsonResponse({ data, meta: { count: 26 } });
  } }));
  const { meta } = await service.metadata('kitsu:1');
  assert.equal(meta.videos.length, 26);
  assert.equal(meta.type, 'series');
  assert.equal(meta.videos[0].id, 'kitsu:1:1');
  assert.equal(meta.videos[25].title, 'Title 26');
  assert.equal(meta.videos[6].title, 'Episode 7');
  assert.equal(meta.videos[6].released, undefined);
  assert.equal(meta.videos[0].season, 1);
});

test('unknown episode counts use actual numbers and omit unknown dates', async () => {
  const service = createKitsuService({ request: async path => path.endsWith('/episodes')
    ? { data: [2, 5].map(number => ({ attributes: { number, airdate: null } })), meta: { count: 2 } }
    : { data: anime(1, { episodeCount: null }) } });
  const { meta } = await service.metadata('kitsu:1');
  assert.deepEqual(meta.videos.map(video => video.episode), [2, 5]);
  assert.equal(meta.videos[0].released, undefined);
});

test('airing series with more episodes than the detail page limit list every episode', async () => {
  const requested = [];
  const service = createKitsuService({ request: async (path, params) => {
    if (!path.endsWith('/episodes')) return { data: anime(12, { episodeCount: null, status: 'current' }) };
    const offset = params['page[offset]'];
    requested.push(offset);
    return { data: Array.from({ length: 20 }, (_, index) => ({ attributes: { number: offset + index + 1, canonicalTitle: `Title ${offset + index + 1}` } })),
      meta: { count: 1410 } };
  } });
  const { meta } = await service.metadata('kitsu:12');
  assert.equal(requested.length, 10);
  assert.equal(meta.videos.length, 1410);
  assert.equal(meta.videos[199].title, 'Title 200');
  assert.equal(meta.videos[200].id, 'kitsu:12:201');
  assert.equal(meta.videos[200].title, 'Episode 201');
  assert.equal(meta.videos.at(-1).id, 'kitsu:12:1410');
});

test('known-count metadata remains playable during an episode endpoint outage', async () => {
  const service = createKitsuService({ request: async path => {
    if (path.endsWith('/episodes')) throw new ApiError('Temporary outage.');
    return { data: anime(1, { episodeCount: 1, subtype: 'movie' }) };
  } });
  const { meta } = await service.metadata('kitsu:1');
  assert.equal(meta.videos[0].id, 'kitsu:1:1');
  assert.deepEqual(meta.behaviorHints, { defaultVideoId: 'kitsu:1:1' });
  await assert.rejects(service.metadata('tt123'), { status: 404 });
});

test('API cache deduplicates requests, bounds concurrency, and serves cached data during outage', async () => {
  let clock = 0;
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let fail = false;
  const api = createApiClient({ now: () => clock, fetchImpl: async () => {
    if (fail) throw new Error('Network unavailable.');
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(5);
    active -= 1;
    return jsonResponse({ data: [anime(1)] });
  } });
  await Promise.all(Array.from({ length: 8 }, () => api.request('anime', {}, 1)));
  assert.equal(calls, 1);
  await Promise.all(Array.from({ length: 8 }, (_, index) => api.request('anime', { page: index }, 1)));
  assert.ok(maximum <= 3);
  clock = 2000;
  fail = true;
  assert.equal((await api.request('anime', {}, 1)).data[0].id, '1');
  clock = 90000000;
  await assert.rejects(api.request('anime', {}, 1), { status: 502 });
});

test('HTTP contract includes CORS, encoded extras, metadata errors and install assets', async t => {
  let received;
  const server = createAddonServer({ service: {
    catalog: async (id, extra) => { received = { id, extra }; return { metas: [] }; },
    metadata: async () => { throw new ApiError('Anime not found.', 404); }
  }, logger: { error() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const manifestResponse = await fetch(`${base}/manifest.json`);
  assert.equal(manifestResponse.headers.get('access-control-allow-origin'), '*');
  assert.equal((await manifestResponse.json()).id, manifest.id);
  assert.equal((await fetch(`${base}/manifest.json`, { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(`${base}/manifest.json`, { method: 'POST' })).status, 405);
  await fetch(`${base}/catalog/series/kitsu-search/search=A%20%26%20B%20%2B%20C&skip=100.json`);
  assert.deepEqual(received, { id: 'kitsu-search', extra: { search: 'A & B + C', skip: '100' } });
  assert.equal((await fetch(`${base}/catalog/series/kitsu-popular/genre=Action.json`)).status, 400);
  assert.equal((await fetch(`${base}/catalog/series/kitsu-search/search=%FF.json`)).status, 400);
  assert.equal((await fetch(`${base}/meta/series/kitsu:999.json`)).status, 404);
  assert.equal((await fetch(`${base}/stream/series/kitsu:1:1.json`)).status, 404);
  const logo = await fetch(`${base}/logo.png`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /^image\/png/);
  assert.ok((await logo.arrayBuffer()).byteLength > 100);
  // Preserve support for any previously cached anime catalog URLs.
  assert.equal((await fetch(`${base}/catalog/anime/kitsu-popular.json`)).status, 200);
  const setup = await fetch(base);
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /Install in Stremio/);
});

// A Stremio series catalog should lead to metadata containing episode videos.
test('series catalog items can open episode metadata through the HTTP contract', async t => {
  const server = createAddonServer({ service: {
    catalog: async () => ({ metas: [{ id: 'kitsu:1', type: 'series', name: 'Anime 1', poster: 'https://media.kitsu.app/poster.jpg' }] }),
    metadata: async () => ({ meta: { id: 'kitsu:1', type: 'series', name: 'Anime 1', videos: [{ id: 'kitsu:1:1', season: 1, episode: 1, title: 'Episode 1' }] } })
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { metas } = await (await fetch(`${base}/catalog/series/kitsu-popular.json`)).json();
  assert.equal(metas[0].type, 'series');
  const { meta } = await (await fetch(`${base}/meta/series/${metas[0].id}.json`)).json();
  assert.equal(meta.videos[0].id, 'kitsu:1:1');
});
