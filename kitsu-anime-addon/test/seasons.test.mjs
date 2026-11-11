import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnimeMappingLoader } from '../src/anime-mappings.mjs';
import { buildSeasonIndex, createSeasonGroups } from '../src/season-groups.mjs';
import { createKitsuService, ApiError } from '../src/kitsu.mjs';
import { createAddonServer } from '../src/addon.mjs';
import { createArtworkService } from '../src/artwork.mjs';

const row = (id, season, show = 100, extra = {}) => ({ kitsu_id: id, type: 'TV', themoviedb_id: { tv: show }, season: { tmdb: season }, ...extra });
const anime = (id, extra = {}) => ({ id: String(id), type: 'anime', attributes: {
  canonicalTitle: `Anime ${id}`, subtype: 'TV', episodeCount: 2, startDate: '2020-01-01', endDate: '2020-12-31',
  posterImage: { medium: `https://media.kitsu.app/${id}.jpg` }, ...extra
} });
const groups = rows => createSeasonGroups({ loadMappings: async () => rows });
const json = value => new Response(JSON.stringify(value));

test('only explicit, contiguous TV season mappings group; films, OVAs and spin-offs stay separate', () => {
  const index = buildSeasonIndex([row(1, 1), row(2, 2), row(3, 0, 100, { type: 'OVA' }),
    row(4, 1, 100, { type: 'MOVIE' }), row(5, 1, 999)]);
  assert.deepEqual(index.byRoot.get('1').members, [{ id: '1', season: 1 }, { id: '2', season: 2 }]);
  assert.equal(index.byMember.has('3'), false);
  assert.equal(index.byMember.has('4'), false);
  assert.equal(index.byMember.has('5'), false);
});

test('missing, duplicate, conflicting or split-cour season mappings remain ungrouped', () => {
  for (const rows of [
    [row(1, 1), row(2, 3)],
    [row(1, 2), row(2, 3)],
    [row(1, 1), row(2, 2), row(3, 2)],
    [row(1, 1), row(2, 2, 100, { episode_offset: { tmdb: 12 } })],
    [row(1, 1), row(2, 2), row(1, 1, 999), row(3, 2, 999)],
    [row(1, 1), row(2, 2), row(3, undefined)]
  ]) assert.equal(buildSeasonIndex(rows).byMember.size, 0);
  assert.equal(buildSeasonIndex([row(1, 1), row(2, 2), row(2, 2)]).byRoot.size, 1, 'Identical duplicate source rows are harmless');
});

test('eight season metadata retains original stream IDs, local episode numbers and root artwork', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1, i + 1));
  const enriched = [];
  const service = createKitsuService({ request: async path => path.endsWith('/episodes')
    ? { data: [{ attributes: { number: 1, canonicalTitle: 'First episode' } }], meta: { count: 1 } }
    : { data: anime(path.split('/')[1], { startDate: `${2015 + Number(path.split('/')[1])}-01-01`,
      endDate: `${2015 + Number(path.split('/')[1])}-12-31` }) } }, {
    seasonGroups: groups(rows), artwork: {
      remember() {}, decorate: meta => meta, enrich: async meta => { enriched.push(meta.id); return { ...meta, logo: 'https://image.tmdb.org/t/p/w500/title.png' }; }
    }
  });
  const { meta } = await service.metadata('kitsu:1');
  assert.equal(meta.id, 'kitsu:1');
  assert.equal(meta.videos.length, 16);
  assert.deepEqual(meta.videos.filter(video => video.episode === 1).map(video => video.season), [1,2,3,4,5,6,7,8]);
  assert.equal(meta.videos.find(video => video.season === 8 && video.episode === 2).id, 'kitsu:8:2');
  assert.equal(meta.releaseInfo, '2016-2023');
  assert.equal(meta.poster, 'https://media.kitsu.app/1.jpg');
  assert.ok(meta.logo);
  assert.deepEqual(enriched, ['kitsu:1'], 'Only the main show needs a title-logo lookup');
});

test('previously saved child-season IDs keep their original standalone metadata and numbering', async () => {
  const service = createKitsuService({ request: async path => path.endsWith('/episodes')
    ? { data: [], meta: { count: 0 } } : { data: anime(path.split('/')[1]) } }, { seasonGroups: groups([row(1,1), row(2,2)]) });
  const { meta } = await service.metadata('kitsu:2');
  assert.equal(meta.id, 'kitsu:2');
  assert.equal(meta.name, 'Anime 2');
  assert.ok(meta.videos.every(video => video.season === 1));
  assert.equal(meta.videos[0].id, 'kitsu:2:1');
});

test('known episode counts keep all seasons playable when episode detail endpoints fail', async () => {
  const service = createKitsuService({ request: async path => {
    if (path.endsWith('/episodes')) throw new ApiError('Temporary outage');
    return { data: anime(path.split('/')[1]) };
  } }, { seasonGroups: groups([row(1,1), row(2,2)]) });
  const { meta } = await service.metadata('kitsu:1');
  assert.equal(meta.videos.length, 4);
  assert.equal(meta.videos[2].season, 2);
  assert.equal(meta.videos[2].id, 'kitsu:2:1');
});

test('a missing entire season produces a retryable group error rather than silently dropping seasons', async () => {
  const service = createKitsuService({ request: async path => {
    if (path === 'anime/2') throw new ApiError('Not found', 404);
    return path.endsWith('/episodes') ? { data: [], meta: { count: 0 } } : { data: anime(1) };
  } }, { seasonGroups: groups([row(1,1), row(2,2)]) });
  await assert.rejects(service.metadata('kitsu:1'), { status: 502, message: 'Some seasons could not be loaded. Please try again shortly.' });
});

function catalogFixture({ now = Date.now } = {}) {
  // Later seasons rank first; the canonical season-1 cards must be hydrated in
  // bulk, while duplicates encountered on later pages must not consume slots.
  const ids = [...Array.from({ length: 40 }, (_, i) => i + 201),
    ...Array.from({ length: 160 }, (_, i) => i + 41),
    ...Array.from({ length: 40 }, (_, i) => i + 1),
    ...Array.from({ length: 60 }, (_, i) => i + 241)];
  const rows = Array.from({ length: 40 }, (_, i) => [row(i + 1, 1, i + 100), row(i + 201, 2, i + 100)]).flat();
  const calls = [];
  const api = { request: async (path, params) => {
    calls.push({ path, params });
    if (params['filter[id]']) {
      const ids = params['filter[id]'].split(',');
      assert.ok(ids.length <= 20);
      return { data: ids.map(id => anime(id)) };
    }
    const start = (params['page[number]'] - 1) * 20;
    return { data: ids.slice(start, start + 20).map(id => anime(id)), meta: { count: ids.length }, links: { next: start + 20 < ids.length ? 'next' : null } };
  } };
  return { service: createKitsuService(api, { seasonGroups: groups(rows), now }), calls };
}

test('grouped pagination fills 100 unique shows per page, without losing or repeating shows', async () => {
  const { service, calls } = catalogFixture();
  const first = await service.catalog('kitsu-popular');
  const second = await service.catalog('kitsu-popular', { skip: 100 });
  const third = await service.catalog('kitsu-popular', { skip: 200 });
  assert.deepEqual([first.metas.length, second.metas.length, third.metas.length], [100, 100, 60]);
  const ids = [...first.metas, ...second.metas, ...third.metas].map(meta => meta.id);
  assert.equal(new Set(ids).size, 260);
  assert.equal(ids[0], 'kitsu:1');
  assert.equal(first.metas[0].name, 'Anime 1');
  assert.ok(!ids.some(id => Number(id.split(':')[1]) >= 201 && Number(id.split(':')[1]) <= 240));
  assert.equal(calls.filter(call => call.params['filter[id]']).length, 2, 'Forty parent cards use two bulk calls, not forty individual calls');
  assert.deepEqual(await service.catalog('kitsu-popular', { skip: 300 }), { metas: [] });
});

test('concurrent grouped catalog requests serialize cursor updates and reuse fetched pages', async () => {
  const { service, calls } = catalogFixture();
  const [a, b] = await Promise.all([service.catalog('kitsu-popular'), service.catalog('kitsu-popular')]);
  assert.deepEqual(a, b);
  const pages = calls.filter(call => call.params['page[number]']).map(call => call.params['page[number]']);
  assert.equal(new Set(pages).size, pages.length);
  const uneven = await service.catalog('kitsu-popular', { skip: 13 });
  assert.equal(uneven.metas.length, 100);
  assert.equal(uneven.metas[0].id, 'kitsu:14');
});

test('grouped search/category filters remain distinct and film catalogs keep native pagination', async () => {
  const { service, calls } = catalogFixture();
  await service.catalog('kitsu-search', { search: 'A & B' });
  assert.equal(calls[0].params['filter[text]'], 'A & B');
  assert.equal(calls[0].params.sort, undefined);
  await service.catalog('kitsu-category-action');
  assert.ok(calls.some(call => call.params['filter[categories]'] === 'action'));
  const movies = await service.catalog('kitsu-movies');
  assert.equal(movies.metas[0].id, 'kitsu:201', 'Film results must not be canonicalized as TV seasons');
  assert.ok(calls.some(call => call.params['filter[subtype]'] === 'movie'));
});

test('catalog cursor expiration is bounded and distant uncached jumps fail without expensive scanning', async () => {
  let clock = 0;
  const { service, calls } = catalogFixture({ now: () => clock });
  await assert.rejects(service.catalog('kitsu-popular', { skip: 10000 }), { status: 400 });
  assert.equal(calls.length, 0);
  const first = await service.catalog('kitsu-popular');
  clock = 901000;
  assert.deepEqual(await service.catalog('kitsu-popular'), first);
});

test('mapping outage leaves catalogs and metadata usable in the original per-entry format', async () => {
  const seasonGroups = createSeasonGroups({ loadMappings: async () => { throw new Error('Unavailable'); } });
  const service = createKitsuService({ request: async path => path === 'anime' ? { data: [anime(1), anime(2)] }
    : path.endsWith('/episodes') ? { data: [], meta: { count: 0 } } : { data: anime(1) } }, { seasonGroups });
  assert.equal((await service.catalog('kitsu-popular')).metas.length, 2);
  assert.equal((await service.metadata('kitsu:1')).meta.videos.length, 2);
});

test('shared mapping loader deduplicates downloads, strips unused fields and retains recent data during outages', async () => {
  let clock = 1;
  let calls = 0;
  let broken = false;
  const load = createAnimeMappingLoader({ now: () => clock, fetchImpl: async () => {
    calls += 1;
    if (broken) throw new Error('Network unavailable');
    return json([row(1,1,100,{ unused: 'discard' }), row(2,2)]);
  } });
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(a, b);
  assert.equal(a[0].unused, undefined);
  assert.equal(calls, 1);
  clock += 86400001;
  broken = true;
  assert.equal(await load(), a);
  assert.equal(calls, 2);
  await load();
  assert.equal(calls, 2);
  clock += 7 * 86400000;
  await assert.rejects(load(), /temporarily unavailable/);
});

test('season groups and artwork share a single mapping-source download', async () => {
  let calls = 0;
  const loadMappings = createAnimeMappingLoader({ fetchImpl: async () => { calls += 1; return json([row(1,1), row(2,2)]); } });
  const seasonGroups = createSeasonGroups({ loadMappings });
  const artwork = createArtworkService({ token: 'test', publicUrl: 'https://addon.example', mappingLoader: loadMappings,
    fetchImpl: async () => json({ logos: [{ file_path: '/logo.png', width: 600, height: 150, iso_639_1: 'en' }] }) });
  const [index, meta] = await Promise.all([seasonGroups.index(), artwork.enrich({ id: 'kitsu:1' }, anime(1))]);
  assert.equal(index.byRoot.size, 1);
  assert.ok(meta.logo);
  assert.equal(calls, 1);
});

test('grouped series HTTP metadata exposes seasons and preserves Kitsu video IDs', async t => {
  const service = createKitsuService({ request: async path => path.endsWith('/episodes')
    ? { data: [], meta: { count: 0 } } : { data: anime(path.split('/')[1]) } }, { seasonGroups: groups([row(1,1), row(2,2)]) });
  const server = createAddonServer({ service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/meta/series/kitsu:1.json`);
  const { meta } = await response.json();
  assert.equal(meta.videos[2].season, 2);
  assert.equal(meta.videos[2].id, 'kitsu:2:1');
});
