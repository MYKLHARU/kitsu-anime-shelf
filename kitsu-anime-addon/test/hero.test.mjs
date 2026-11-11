import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBackdrop, createArtworkService } from '../src/artwork.mjs';
import { toMeta } from '../src/kitsu.mjs';
import { createAddonServer } from '../src/addon.mjs';

const backdrop = (file = '/hero.jpg', extra = {}) => ({ file_path: file, width: 1920, height: 1080,
  iso_639_1: null, vote_average: 8, vote_count: 10, ...extra });
const item = { id: '1', type: 'anime', attributes: { canonicalTitle: 'Cowboy Bebop', subtype: 'TV',
  startDate: '1998-04-03', posterImage: { medium: 'https://media.kitsu.app/poster.jpg' },
  coverImage: { small: 'https://media.kitsu.app/small.jpg', large: 'https://media.kitsu.app/large.jpg', original: 'https://media.kitsu.app/original.jpg' } } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function setup(fetchImpl) {
  const artwork = createArtworkService({ token: 'test', publicUrl: 'https://addon.example', getAnime: async () => item,
    mappingLoader: async () => [{ kitsu_id: 1, themoviedb_id: { tv: 30991 } }],
    fetchImpl: fetchImpl || (async () => json({ logos: [], backdrops: [backdrop()] })) });
  artwork.remember(item, toMeta(item));
  return artwork;
}

test('hero selection prefers wide HD language-neutral JPEGs over text-bearing artwork', () => {
  const selected = chooseBackdrop([backdrop('/english.jpg', { iso_639_1: 'en', vote_average: 10, vote_count: 100 }), backdrop('/clean.jpg')]);
  assert.equal(selected.file_path, '/clean.jpg');
  assert.equal(chooseBackdrop([backdrop('/ja.jpg', { iso_639_1: 'ja' }), backdrop('/en.jpg', { iso_639_1: 'en' })]).file_path, '/en.jpg');
});

test('hero selection rejects tiny, portrait, banner, invalid and unsupported images', () => {
  const images = [backdrop('/tiny.jpg', { width: 640, height: 360 }), backdrop('/portrait.jpg', { width: 1280, height: 1920 }),
    backdrop('/banner.jpg', { width: 3000, height: 720 }), backdrop('/bad.png'), backdrop('/foreign.jpg', { iso_639_1: 'fr' }),
    backdrop('https://evil.test/image.jpg'), backdrop('/bad.jpg', { height: NaN })];
  assert.equal(chooseBackdrop(images), undefined);
  assert.equal(chooseBackdrop(null), undefined);
});

test('hero ranking balances community rating with vote confidence', () => {
  assert.equal(chooseBackdrop([backdrop('/one-vote.jpg', { vote_average: 10, vote_count: 1 }),
    backdrop('/consensus.jpg', { vote_average: 8.5, vote_count: 100 })]).file_path, '/consensus.jpg');
});

test('catalog hero URLs stay lazy and redirect to the CDN without proxying image bytes', async () => {
  let calls = 0;
  const artwork = setup(async url => {
    calls += 1;
    assert.match(url, /^https:\/\/api\.themoviedb\.org\/3\/tv\/30991\/images/);
    return json({ logos: [], backdrops: [backdrop()] });
  });
  const meta = artwork.decorate(toMeta(item));
  assert.equal(meta.background, 'https://addon.example/artwork/v1/background/kitsu:1.jpg');
  assert.equal(calls, 0);
  assert.deepEqual(await artwork.background('1'), { redirect: 'https://image.tmdb.org/t/p/w1280/hero.jpg', cacheSeconds: 604800 });
  await artwork.background('1');
  assert.equal(calls, 1);
});

test('details can have HD backgrounds without a logo, while poster fallback remains intact', async () => {
  let calls = 0;
  const artwork = setup(async () => { calls += 1; return json({ logos: [], backdrops: [backdrop()] }); });
  const meta = await artwork.enrich(artwork.decorate(toMeta(item)), item);
  assert.equal(meta.logo, undefined);
  assert.equal(meta.background, 'https://image.tmdb.org/t/p/w1280/hero.jpg');
  assert.deepEqual(await artwork.poster('1'), { redirect: item.attributes.posterImage.medium });
  assert.equal(calls, 1, 'A background-only match must not attempt to download a missing logo');
});

test('larger Kitsu covers remain available without credentials and during artwork outages', async () => {
  assert.equal(toMeta(item).background, item.attributes.coverImage.large);
  const disabled = createArtworkService();
  assert.equal(disabled.decorate(toMeta(item)).background, item.attributes.coverImage.large);
  const artwork = setup(async () => { throw new Error('TMDB unavailable'); });
  const meta = await artwork.enrich(artwork.decorate(toMeta(item)), item);
  assert.equal(meta.background, item.attributes.coverImage.large);
  assert.deepEqual(await artwork.background('1'), { redirect: item.attributes.coverImage.large, cacheSeconds: 300 });
  assert.equal(await artwork.background('0'), null);
  assert.equal(await artwork.background('http://localhost/secret'), null);
});

test('hero and title-logo metadata share one provider lookup', async () => {
  let calls = 0;
  const artwork = setup(async () => { calls += 1; return json({ backdrops: [backdrop()], logos: [
    { file_path: '/logo.png', width: 500, height: 150, iso_639_1: 'en' }
  ] }); });
  const [hero, meta] = await Promise.all([artwork.background('1'), artwork.enrich(toMeta(item), item)]);
  assert.ok(meta.logo);
  assert.equal(meta.background, hero.redirect);
  assert.equal(calls, 1);
});

test('hero HTTP route supports GET, HEAD, CORS, cacheable redirects and missing artwork', async t => {
  const server = createAddonServer({ service: {}, artwork: { background: async id => id === '1'
    ? { redirect: 'https://image.tmdb.org/t/p/w1280/hero.jpg', cacheSeconds: 604800 } : null } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/artwork/v1/background/kitsu:1.jpg`;
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://image.tmdb.org/t/p/w1280/hero.jpg');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=604800');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  const head = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 302);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(url.replace('kitsu:1', 'kitsu:2'))).status, 404);
});
