import test from 'node:test';
import assert from 'node:assert/strict';
import './isolated-mapping-cache.mjs';
import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import { setImmediate } from 'node:timers/promises';
import { randomFillSync } from 'node:crypto';
import { createArtworkService, composePoster, chooseLogo, strictTitleMatch, safeImageUrl, boundedCache } from '../src/artwork.mjs';
import { createKitsuService } from '../src/kitsu.mjs';
import { createAddonServer } from '../src/addon.mjs';

const item = { id: '1', attributes: { canonicalTitle: 'Cowboy Bebop', titles: { en: 'Cowboy Bebop' },
  subtype: 'TV', startDate: '1998-04-03', episodeCount: 26,
  posterImage: { medium: 'https://media.kitsu.app/anime/poster_images/1/medium.jpg' } } };
const original = item.attributes.posterImage.medium;
const preview = { id: 'kitsu:1', type: 'series', name: 'Cowboy Bebop', poster: original };
const pngLogo = (language = 'en', file = '/title.png') => ({ iso_639_1: language, file_path: file, width: 600, height: 180 });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const mapping = [{ kitsu_id: 1, themoviedb_id: { tv: 30991 } }];

async function fixtures() {
  return {
    poster: await sharp({ create: { width: 400, height: 600, channels: 3, background: '#18395a' } }).jpeg().toBuffer(),
    logo: await sharp(Buffer.from('<svg width="300" height="80"><rect x="5" y="5" width="290" height="70" rx="12" fill="#f8d35b"/></svg>')).png().toBuffer()
  };
}

function setup({ fetchImpl, mappingLoader = async () => mapping, ...options } = {}) {
  const artwork = createArtworkService({ token: 'test-secret', publicUrl: 'https://addon.example',
    getAnime: async () => item, mappingLoader,
    fetchImpl: fetchImpl || (async () => json({ logos: [pngLogo()] })), ...options });
  artwork.remember(item, preview);
  return artwork;
}

test('no token preserves artwork and makes no logo requests; invalid origins fail clearly', async () => {
  const artwork = createArtworkService({ fetchImpl: () => { throw new Error('Unexpected network request'); } });
  assert.equal(artwork.enabled, false);
  assert.deepEqual(artwork.decorate(preview), preview);
  assert.deepEqual(await artwork.enrich(preview, item), preview);
  assert.throws(() => setup({ publicUrl: 'http://public.example' }), /PUBLIC_URL/);
  assert.throws(() => setup({ publicUrl: 'https://addon.example/path' }), /PUBLIC_URL/);
});

test('logo preference is English, language-neutral, Japanese, and PNG only', () => {
  assert.equal(chooseLogo([pngLogo('ja'), pngLogo(null), pngLogo('en')]).iso_639_1, 'en');
  assert.equal(chooseLogo([pngLogo('ja'), pngLogo(null)]).iso_639_1, null);
  assert.equal(chooseLogo([pngLogo('fr'), pngLogo('en', '/vector.svg')]), undefined);
});

test('v3 API keys are accepted as an alternative and never appear in public artwork URLs', async () => {
  const artwork = setup({ token: '', apiKey: 'test-v3-key', fetchImpl: async (url, options) => {
    assert.equal(new URL(url).searchParams.get('api_key'), 'test-v3-key');
    assert.equal(options.headers.Authorization, undefined);
    return json({ logos: [pngLogo()] });
  } });
  assert.ok((await artwork.enrich(preview, item)).logo);
  assert.equal(JSON.stringify(artwork.decorate(preview)).includes('test-v3-key'), false);
});

test('strict search rejects live action, wrong years, sequels, missing dates and ambiguous matches', () => {
  const good = { id: 30991, name: 'Cowboy Bebop', first_air_date: '1998-04-03', genre_ids: [16], original_language: 'ja' };
  assert.deepEqual(strictTitleMatch([good], item.attributes, 'tv'), { type: 'tv', id: 30991 });
  for (const change of [{ genre_ids: [18] }, { first_air_date: '2021-01-01' }, { name: 'Cowboy Bebop 2' }, { original_language: 'en' }]) {
    assert.equal(strictTitleMatch([{ ...good, ...change }], item.attributes, 'tv'), undefined);
  }
  assert.equal(strictTitleMatch([good, { ...good, id: 2 }], item.attributes, 'tv'), undefined);
  assert.equal(strictTitleMatch([good], { canonicalTitle: 'Cowboy Bebop' }, 'tv'), undefined);
});

test('catalog stays lazy; metadata uses direct CDN logos and preserves Kitsu episodes', async () => {
  let calls = 0;
  const artwork = setup({ fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).pathname, '/3/tv/30991/images');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'error');
    return json({ logos: [pngLogo()] });
  } });
  const api = { request: async path => path === 'anime' ? { data: [item] } : path.endsWith('/episodes')
    ? { data: [], meta: { count: 0 } } : { data: item } };
  const service = createKitsuService(api, { artwork });
  const { metas } = await service.catalog('kitsu-popular');
  assert.equal(calls, 0);
  assert.equal(metas[0].poster, 'https://addon.example/artwork/v1/poster/kitsu:1.jpg');
  const { meta } = await service.metadata('kitsu:1');
  assert.equal(meta.logo, 'https://image.tmdb.org/t/p/w500/title.png');
  assert.equal(meta.videos.length, 26);
  assert.equal(meta.videos[25].id, 'kitsu:1:26');
  assert.equal(calls, 1);
});

test('mapped films use movie endpoints; multiple movie IDs do not guess a match', async () => {
  const movie = { ...item, attributes: { ...item.attributes, subtype: 'movie' } };
  let calls = 0;
  const artwork = setup({ mappingLoader: async () => [{ kitsu_id: 1, themoviedb_id: { movie: [128] } }],
    fetchImpl: async url => { calls += 1; assert.match(url, /\/movie\/128\/images/); return json({ logos: [pngLogo()] }); } });
  assert.ok((await artwork.enrich(preview, movie)).logo);
  assert.equal(calls, 1);
  const ambiguous = setup({ mappingLoader: async () => [{ kitsu_id: 1, themoviedb_id: { movie: [128, 129] } }],
    fetchImpl: async () => { throw new Error('Do not search an ambiguous mapping.'); } });
  assert.equal((await ambiguous.enrich(preview, movie)).logo, undefined);
});

test('unmapped titles use strict title/year search even during a mapping outage', async () => {
  const urls = [];
  const artwork = setup({ mappingLoader: async () => { throw new Error('Mapping source down'); }, fetchImpl: async url => {
    urls.push(url);
    return url.includes('/search/') ? json({ results: [{ id: 30991, name: 'Cowboy Bebop', first_air_date: '1998-04-03', genre_ids: [16], original_language: 'ja' }] })
      : json({ logos: [pngLogo()] });
  } });
  assert.ok((await artwork.enrich(preview, item)).logo);
  assert.equal(new URL(urls[0]).searchParams.get('first_air_date_year'), '1998');
  assert.equal(urls.length, 2);
});

test('outages and missing logos keep original art; failures retry after their short cache expires', async () => {
  let clock = 1;
  let calls = 0;
  let broken = true;
  const artwork = setup({ now: () => clock, fetchImpl: async () => {
    calls += 1;
    if (broken) throw new Error('Unavailable');
    return json({ logos: [] });
  } });
  assert.deepEqual(await artwork.poster('1'), { redirect: original });
  assert.equal((await artwork.enrich(preview, item)).logo, undefined);
  assert.equal(calls, 1);
  broken = false;
  clock += 61000;
  assert.deepEqual(await artwork.poster('1'), { redirect: original });
  assert.equal(calls, 2);
});

test('401 and 429 pause further TMDB requests without exposing the token or breaking metadata', async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const artwork = setup({ fetchImpl: async () => { calls += 1; return json({}, status); } });
    await artwork.enrich(preview, item);
    await artwork.enrich({ ...preview, id: 'kitsu:2' }, { ...item, id: '2' });
    assert.equal(calls, 1);
  }
});

test('composites are real 360x540 JPEGs under 100KB with the logo in the lower panel', async () => {
  const input = await fixtures();
  const buffer = await composePoster(input.poster, input.logo);
  const info = await sharp(buffer).metadata();
  assert.equal(info.format, 'jpeg');
  assert.equal(info.width, 360);
  assert.equal(info.height, 540);
  assert.ok(buffer.length < 100000);
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const pixel = (480 * 360 + 180) * 3;
  assert.ok(data[pixel] > 180 && data[pixel + 1] > 150 && data[pixel + 2] < 150, 'Logo must appear over the poster');
});

test('image fetch/render is deduplicated, cached, and shared across poster requests', async () => {
  const input = await fixtures();
  const urls = [];
  const artwork = setup({ fetchImpl: async url => {
    urls.push(url);
    await delay(5);
    if (url.startsWith('https://api.themoviedb.org')) return json({ logos: [pngLogo()] });
    return new Response(url.endsWith('.png') ? input.logo : input.poster, { headers: { 'Content-Type': url.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => artwork.poster('1')));
  assert.ok(results.every(result => result.etag === results[0].etag && result.buffer.equals(results[0].buffer)));
  await artwork.poster('1');
  assert.equal(urls.length, 3);
});

test('cached source images avoid downloads even after a composite is evicted', async () => {
  const input = await fixtures();
  const urls = [];
  const artwork = setup({ posterCacheBytes: 1, fetchImpl: async url => {
    urls.push(url);
    if (url.startsWith('https://api.themoviedb.org')) return json({ logos: [pngLogo()] });
    return new Response(url.endsWith('.png') ? input.logo : input.poster,
      { headers: { 'Content-Type': url.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
  } });
  const a = await artwork.poster('1');
  const b = await artwork.poster('1');
  assert.ok(a.buffer.equals(b.buffer));
  assert.equal(urls.length, 3, 'Evicting a composite must not force redownloading both source images');
});

test('slow TMDB lookups cannot block image downloads for an already resolved title', async () => {
  const input = await fixtures();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const images = [];
  const artwork = setup({ mappingLoader: async () => [1,2,3,4].map(id => ({ kitsu_id: id, themoviedb_id: { tv: 30990 + id } })),
    fetchImpl: async url => {
      if (url.startsWith('https://api.themoviedb.org')) {
        if (!url.includes('/tv/30991/')) await gate;
        return json({ logos: [pngLogo()] });
      }
      images.push(url);
      return new Response(url.endsWith('.png') ? input.logo : input.poster,
        { headers: { 'Content-Type': url.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
    }
  });
  await artwork.enrich(preview, item);
  const lookups = [2,3,4].map(id => artwork.enrich({ ...preview, id: `kitsu:${id}` }, { ...item, id: String(id) }));
  await setImmediate();
  const poster = artwork.poster('1');
  await setImmediate();
  try { assert.equal(images.length, 2, 'Poster and logo downloads should start before blocked metadata lookups finish'); }
  finally { release(); }
  const [result] = await Promise.all([poster, ...lookups]);
  assert.ok(result.buffer);
});

test('fast JPEG output stays below the image budget even for detailed noisy artwork', async () => {
  const noise = randomFillSync(Buffer.alloc(400 * 600 * 3));
  const poster = await sharp(noise, { raw: { width: 400, height: 600, channels: 3 } }).png().toBuffer();
  const { logo } = await fixtures();
  const result = await composePoster(poster, logo);
  assert.ok(result.length < 100000);
  const info = await sharp(result).metadata();
  assert.equal(info.format, 'jpeg');
  assert.equal(info.width, 360);
  assert.equal(info.height, 540);
});

test('a corrupt image is retried after the short fallback cache rather than retained for a day', async () => {
  const input = await fixtures();
  let clock = 0;
  let corrupt = true;
  const artwork = setup({ now: () => clock, fetchImpl: async url => {
    if (url.startsWith('https://api.themoviedb.org')) return json({ logos: [pngLogo()] });
    return new Response(corrupt ? Buffer.from('corrupt image') : url.endsWith('.png') ? input.logo : input.poster,
      { headers: { 'Content-Type': url.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
  } });
  assert.deepEqual(await artwork.poster('1'), { redirect: original });
  corrupt = false;
  clock = 61000;
  assert.ok((await artwork.poster('1')).buffer);
});

test('malformed/oversized image responses redirect to Kitsu and never become metadata errors', async () => {
  for (const headers of [{ 'Content-Type': 'image/png' }, { 'Content-Type': 'text/html' },
    { 'Content-Type': 'image/png', 'Content-Length': '9999999' }]) {
    const artwork = setup({ fetchImpl: async url => url.startsWith('https://api.themoviedb.org')
      ? json({ logos: [pngLogo()] }) : new Response('bad', { headers }) });
    assert.deepEqual(await artwork.poster('1'), { redirect: original });
  }
});

test('only fixed CDN hosts are fetchable; route cannot be used as an arbitrary proxy', async () => {
  for (const value of ['http://media.kitsu.app/x.jpg', 'https://localhost/x.png', 'https://image.tmdb.org.evil.test/x.png',
    'https://user:pass@media.kitsu.app/x.jpg', 'https://media.kitsu.app:1234/x.jpg']) assert.equal(safeImageUrl(value), undefined);
  const artwork = setup();
  assert.equal(await artwork.poster('http://localhost/secret'), null);
  assert.equal(await artwork.poster('0'), null);
});

test('byte-bounded cache evicts old renders and respects expiry', () => {
  let clock = 0;
  const cache = boundedCache({ maxEntries: 10, maxBytes: 10, now: () => clock });
  cache.set('a', 'a', 100, 6);
  cache.set('b', 'b', 100, 6);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 'b');
  clock = 101;
  assert.equal(cache.get('b'), undefined);
});

test('poster HTTP route provides JPEG, CORS, HEAD, ETag 304 and short-lived redirects', async t => {
  const input = await fixtures();
  const buffer = await composePoster(input.poster, input.logo);
  const artwork = { enabled: true, poster: async id => id === '1' ? { buffer, etag: '"test"' } : id === '2' ? { redirect: original } : null };
  const server = createAddonServer({ service: {}, artwork });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = `${base}/artwork/v1/poster/kitsu:1.jpg`;
  const response = await fetch(path);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('cache-control'), /max-age=604800/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer);
  assert.equal((await fetch(path, { headers: { 'If-None-Match': 'W/"other", W/"test"' } })).status, 304);
  const head = await fetch(path, { method: 'HEAD' });
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get('content-length')), buffer.length);
  const redirect = await fetch(`${base}/artwork/v1/poster/kitsu:2.jpg`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), original);
  assert.equal(redirect.headers.get('cache-control'), 'public, max-age=60');
  assert.equal((await fetch(`${base}/artwork/v1/poster/kitsu:3.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/artwork/v1/poster/kitsu:0.jpg`)).status, 404);
  assert.equal((await (await fetch(`${base}/health`)).json()).titleLogos, true);
});
