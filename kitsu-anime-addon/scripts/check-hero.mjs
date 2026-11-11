import assert from 'node:assert/strict';
import sharp from 'sharp';

const base = process.argv[2];
if (!base) throw new Error('Usage: npm run test:hero -- https://YOUR-ADDON-HOST');
const origin = new URL(base).origin;
async function json(path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(60000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
let hd = 0;
for (const id of ['1','11469','142']) {
  const { meta } = await json(`/meta/series/kitsu:${id}.json`);
  assert.ok(meta.background && meta.videos?.length);
  const redirect = await fetch(`${origin}/artwork/v1/background/kitsu:${id}.jpg`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), meta.background);
  const response = await fetch(meta.background, { signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok);
  const buffer = Buffer.from(await response.arrayBuffer());
  const info = await sharp(buffer).metadata();
  if (new URL(meta.background).hostname === 'image.tmdb.org') {
    hd += 1;
    assert.equal(info.width, 1280);
    assert.ok(info.height >= 640 && info.height <= 800);
    assert.equal(info.format, 'jpeg');
    assert.ok(buffer.length < 500000, 'Sample HD backdrop exceeds the recommended background image budget.');
    console.log(`PASS ${meta.name}: ${info.width}x${info.height} HD hero, ${buffer.length} bytes, direct CDN`);
  } else console.log(`FALLBACK ${meta.name}: larger Kitsu cover`);
}
assert.ok(hd > 0, 'No sample HD hero images found; check the deployed version and TMDB credentials.');
