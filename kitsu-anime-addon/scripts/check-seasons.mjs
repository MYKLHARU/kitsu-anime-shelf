import assert from 'node:assert/strict';
import { createApiClient, createKitsuService } from '../src/kitsu.mjs';
import { createSeasonGroups } from '../src/season-groups.mjs';

const base = process.argv[2] ? new URL(process.argv[2]).origin : undefined;
async function read(path, params = {}) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const service = base ? {
  metadata: id => read(`/meta/series/${id}.json`),
  catalog: (id, extra = {}) => read(`/catalog/series/${id}.json`, extra)
} : createKitsuService(createApiClient(), { seasonGroups: createSeasonGroups() });
if (base) {
  const health = await read('/health');
  assert.equal(health.seasonGrouping, true, 'Season grouping is not enabled on this deployment.');
}

const { meta } = await service.metadata('kitsu:11469');
const counts = Object.fromEntries([...new Set(meta.videos.map(video => video.season))]
  .map(season => [season, meta.videos.filter(video => video.season === season).length]));
assert.deepEqual(Object.keys(counts), ['1','2','3','4','5','6','7','8']);
assert.equal(meta.videos.find(video => video.season === 2 && video.episode === 1)?.id, 'kitsu:12268:1');
assert.equal(meta.videos.find(video => video.season === 8 && video.episode === 1)?.id, 'kitsu:49279:1');
assert.ok(Object.values(counts).every(count => count > 0));
console.log(`PASS My Hero Academia: ${meta.videos.length} episodes across 8 seasons; original playback IDs preserved`);

const search = await service.catalog('kitsu-search', { search: 'My Hero Academia' });
const seasonIds = new Set(['11469','12268','13881','41971','43108','45240','47232','49279'].map(id => `kitsu:${id}`));
assert.deepEqual(search.metas.filter(meta => seasonIds.has(meta.id)).map(meta => meta.id), ['kitsu:11469']);
assert.ok(search.metas.some(meta => meta.id === 'kitsu:14084'), 'The first film should remain separate.');
assert.ok(search.metas.some(meta => meta.name.includes('Vigilante')), 'Vigilantes should remain separate.');
console.log('PASS search: one main show; films and Vigilantes remain separate');

const child = await service.metadata('kitsu:12268');
assert.equal(child.meta.id, 'kitsu:12268');
assert.ok(child.meta.videos.every(video => video.season === 1));
console.log('PASS previously saved individual-season metadata remains compatible');

const first = await service.catalog('kitsu-popular');
const second = await service.catalog('kitsu-popular', { skip: 100 });
assert.equal(first.metas.length, 100);
assert.equal(second.metas.length, 100);
const seen = new Set(first.metas.map(meta => meta.id));
assert.ok(second.metas.every(meta => !seen.has(meta.id)), 'Grouped catalog pages overlap.');
console.log('PASS grouped pagination: two full 100-show pages without duplicates');
