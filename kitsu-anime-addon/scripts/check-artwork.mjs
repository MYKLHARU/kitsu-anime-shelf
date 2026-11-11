import assert from 'node:assert/strict';
import sharp from 'sharp';

const base = process.argv[2];
if (!base) throw new Error('Usage: npm run test:artwork -- https://YOUR-ADDON-HOST');
const origin = new URL(base).origin;
async function request(path, options = {}) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(60000), ...options });
  assert.ok(response.ok || response.status === 304 || options.redirect === 'manual' && response.status === 302, `${path}: HTTP ${response.status}`);
  return response;
}
const health = await (await request('/health')).json();
assert.equal(health.titleLogos, true, 'Title logos are disabled. Set TMDB_API_KEY (or TMDB_READ_ACCESS_TOKEN) and PUBLIC_URL, then redeploy.');
const manifest = await (await request('/manifest.json')).json();
assert.ok(manifest.version, 'Manifest version is missing.');
let logos = 0;
for (const id of ['1', '142']) { // Cowboy Bebop; Princess Mononoke (TV and film).
  const { meta } = await (await request(`/meta/series/kitsu:${id}.json`)).json();
  assert.ok(meta.videos.length > 0 && meta.videos[0].id.startsWith(`kitsu:${id}:`));
  assert.equal(new URL(meta.poster).origin, origin, 'PUBLIC_URL must match this service.');
  const response = await request(new URL(meta.poster).pathname, { redirect: 'manual' });
  if (!meta.logo) {
    console.log(`FALLBACK ${meta.name}: no logo; check TMDB credentials if every title falls back.`);
    continue;
  }
  logos += 1;
  assert.equal(new URL(meta.logo).hostname, 'image.tmdb.org');
  const logo = await fetch(meta.logo, { signal: AbortSignal.timeout(10000) });
  assert.ok(logo.ok, `Logo image missing for ${meta.name}`);
  assert.equal((await sharp(Buffer.from(await logo.arrayBuffer())).metadata()).format, 'png');
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.ok(buffer.length < 100000);
  const image = await sharp(buffer).metadata();
  assert.equal(image.width, 360);
  assert.equal(image.height, 540);
  const etag = response.headers.get('etag');
  assert.ok(etag);
  assert.equal((await request(new URL(meta.poster).pathname, { headers: { 'If-None-Match': etag } })).status, 304);
  console.log(`PASS ${meta.name}: official-source PNG logo, ${buffer.length} byte poster, episodes and cache validation`);
}
assert.ok(logos > 0, 'No sample logos found. Check token permissions, TMDB availability and runtime configuration.');
