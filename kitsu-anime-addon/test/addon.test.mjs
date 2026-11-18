import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CATEGORIES, CATEGORY_NAMES } from '../src/categories.mjs';
import { ApiError, createApiClient, createKitsuService } from '../src/kitsu.mjs';
import { buildManifest, createAddonServer, manifest } from '../src/addon.mjs';
import { CATALOG_OPTIONS, GENRE_NAMES, encodeConfig, normalizeCatalogIds, parseConfig } from '../src/catalog-config.mjs';

function anime(id, attributes = {}) {
  return {
    id: String(id), type: 'anime',
    attributes: { canonicalTitle: `Anime ${id}`, episodeCount: 3, posterImage: { medium: 'https://media.kitsu.app/poster.jpg' }, ...attributes }
  };
}
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('plain manifest shows no rows and asks Stremio to configure', () => {
  assert.equal(manifest.id, 'personal.kitsu.anime.shelf');
  assert.deepEqual(manifest.catalogs.map(catalog => catalog.id), ['kitsu-search'], 'search only, which is never a row');
  assert.deepEqual(manifest.behaviorHints, { adult: false, p2p: false, configurable: true, configurationRequired: true });
  assert.deepEqual(manifest.types, ['series']);
  assert.deepEqual(manifest.idPrefixes, ['kitsu:']);
  assert.match(manifest.logo, /^https:\/\/.+\/logo\.png$/);
  assert.deepEqual(manifest.resources.map(resource => resource.name), ['catalog', 'meta']);
});

test('configured manifest offers five lists and the 32 chosen genres, plus search', () => {
  assert.equal(CATEGORY_NAMES.length, 40, 'full Kitsu taxonomy is still known');
  assert.equal(GENRE_NAMES.length, 32);
  assert.equal(CATALOG_OPTIONS.length, 37);
  for (const removed of ['Asia', 'Children', 'Japan', 'Josei', 'Shoujo', 'Shoujo Ai', 'Shounen Ai', 'Yaoi']) assert.ok(!GENRE_NAMES.includes(removed), removed);
  const all = buildManifest(CATALOG_OPTIONS.map(option => option.id));
  assert.equal(all.id, manifest.id, 'same add-on ID, so installs replace each other');
  assert.equal(all.catalogs.length, 38);
  assert.deepEqual(all.catalogs.slice(0, 5).map(catalog => [catalog.id, catalog.name]), [
    ['kitsu-trending', 'Kitsu · Trending This Week'], ['kitsu-airing', 'Kitsu · Top Airing'], ['kitsu-upcoming', 'Kitsu · Top Upcoming'],
    ['kitsu-top-rated', 'Kitsu · Highest Rated'], ['kitsu-popular', 'Kitsu · Most Popular']]);
  assert.deepEqual(all.catalogs.slice(5, 37).map(catalog => catalog.name), GENRE_NAMES);
  assert.equal(new Set(all.catalogs.map(catalog => catalog.id)).size, 38);
  for (const catalog of all.catalogs) {
    assert.equal(catalog.extra.some(extra => extra.name === 'genre'), false);
    assert.equal(catalog.type, 'series');
  }
  assert.equal(all.catalogs.filter(catalog => catalog.extra.some(extra => extra.name === 'search' && extra.isRequired)).length, 1);
  assert.deepEqual(all.behaviorHints, { adult: false, p2p: false, configurable: true });
});

test('install-link configuration is short, canonical and strict', () => {
  assert.deepEqual(parseConfig('isekai.trending.action.isekai'), ['kitsu-trending', 'kitsu-category-action', 'kitsu-category-isekai']);
  assert.equal(encodeConfig(['kitsu-category-isekai', 'kitsu-trending', 'kitsu-category-super-power']), 'trending.isekai.super-power');
  // Links made before the row list was curated keep working, minus retired rows.
  assert.deepEqual(parseConfig('top10.movies.asia.kids.yaoi.isekai'), ['kitsu-category-isekai']);
  assert.deepEqual(parseConfig('top10'), []);
  assert.deepEqual(normalizeCatalogIds(['kitsu-top10', 'kitsu-category-josei', 'kitsu-upcoming']), ['kitsu-upcoming']);
  for (const bad of ['', 'nope', 'action..isekai', 'Action', 'action/isekai', 'a'.repeat(1001)]) assert.equal(parseConfig(bad), null, bad);
  assert.deepEqual(normalizeCatalogIds(['kitsu-category-isekai', 'kitsu-popular']), ['kitsu-popular', 'kitsu-category-isekai']);
  assert.equal(normalizeCatalogIds(['kitsu-search']), null);
  assert.equal(normalizeCatalogIds('kitsu-popular'), null);
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

test('configured install links route catalogs, metadata and the configure page', async t => {
  const calls = [];
  const server = createAddonServer({ service: {
    catalog: async (id, extra) => { calls.push({ id, extra }); return { metas: [] }; },
    metadata: async id => ({ meta: { id, type: 'series', name: 'x', videos: [{ id: `${id}:1` }] } })
  }, logger: { error() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const configured = await (await fetch(`${base}/c/isekai.trending/manifest.json`)).json();
  assert.deepEqual(configured.catalogs.map(catalog => catalog.id), ['kitsu-trending', 'kitsu-category-isekai', 'kitsu-search']);
  const old = await (await fetch(`${base}/c/top10.isekai.asia/manifest.json`)).json();
  assert.deepEqual(old.catalogs.map(catalog => catalog.id), ['kitsu-category-isekai', 'kitsu-search'], 'older link still installs');
  assert.equal(configured.behaviorHints.configurationRequired, undefined);
  assert.equal((await fetch(`${base}/c/not-a-genre/manifest.json`)).status, 404);
  await fetch(`${base}/c/isekai/catalog/series/kitsu-category-isekai/skip=100.json`);
  assert.deepEqual(calls.at(-1), { id: 'kitsu-category-isekai', extra: { skip: '100' } });
  const meta = await (await fetch(`${base}/c/isekai/meta/series/kitsu:7.json`)).json();
  assert.equal(meta.meta.videos[0].id, 'kitsu:7:1', 'same IDs for configured installs');
  const page = await fetch(`${base}/c/isekai.trending/configure`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/c/isekai.trending/app.js`)).status, 200);
  const options = await (await fetch(`${base}/catalog-options.json`)).json();
  assert.equal(options.options.length, 37);
  assert.equal((await fetch(`${base}/manifest.json`).then(response => response.json())).behaviorHints.configurationRequired, true);
});

test('Trending This Week uses Kitsu trending and falls back to Top Airing', async () => {
  const calls = [];
  let trendingFails = false;
  const api = { request: async (path, params) => {
    calls.push(path);
    if (path === 'trending/anime') {
      if (trendingFails) throw new Error('down');
      return { data: [anime(7), anime(3), anime(7)] };
    }
    return { data: [anime(1), anime(2)], links: {}, meta: { count: 2 } };
  } };
  const trending = await createKitsuService(api).catalog('kitsu-trending', {});
  assert.deepEqual(trending.metas.map(meta => meta.id), ['kitsu:7', 'kitsu:3'], 'trending order, duplicates removed');
  assert.deepEqual(await createKitsuService(api).catalog('kitsu-trending', { skip: '100' }), { metas: [] });
  trendingFails = true;
  const fallback = await createKitsuService(api).catalog('kitsu-trending', {});
  assert.deepEqual(fallback.metas.map(meta => meta.id), ['kitsu:1', 'kitsu:2']);
  const upcoming = [];
  await createKitsuService({ request: async (path, params) => { upcoming.push(params); return { data: [], links: {}, meta: { count: 0 } }; } }).catalog('kitsu-upcoming', {});
  assert.equal(upcoming[0]['filter[status]'], 'upcoming');
});

test('Top 10 Airing (retired, still served for old links) is the first ten of Top Airing', async () => {
  const pages = [];
  const api = { request: async (path, params) => {
    pages.push(params);
    const page = Number(params['page[number]']);
    return { data: Array.from({ length: 20 }, (_, i) => anime((page - 1) * 20 + i + 1)), links: { next: 'x' }, meta: { count: 200 } };
  } };
  const service = createKitsuService(api);
  const top = await service.catalog('kitsu-top10', {});
  assert.deepEqual(top.metas.map(meta => meta.id), Array.from({ length: 10 }, (_, i) => `kitsu:${i + 1}`));
  assert.equal(pages[0]['filter[status]'], 'current');
  assert.deepEqual(await service.catalog('kitsu-top10', { skip: '100' }), { metas: [] });
});
