import assert from 'node:assert/strict';
import { CATEGORIES } from '../src/categories.mjs';
import { createApiClient, createKitsuService } from '../src/kitsu.mjs';
import { createSeasonGroups } from '../src/season-groups.mjs';

const api = createApiClient();
const service = createKitsuService(api, { seasonGroups: createSeasonGroups() });

function validPage(metas, id) {
  // Live rankings can move or repeat an item between upstream requests. The
  // deterministic tests assert exact 100-item pagination with a fixed dataset.
  assert.ok(metas.length > 0 && metas.length <= 100, `${id} returned an invalid page size`);
  assert.equal(new Set(metas.map(meta => meta.id)).size, metas.length, `${id} contains duplicate titles`);
}

for (const id of ['kitsu-popular', 'kitsu-top-rated', 'kitsu-airing', 'kitsu-movies']) {
  const { metas } = await service.catalog(id);
  validPage(metas, id);
  assert.ok(metas.every(meta => /^kitsu:\d+$/.test(meta.id) && meta.type === 'series' && meta.name));
  console.log(`PASS ${id}: ${metas.length} titles`);
}

const { metas } = await service.catalog('kitsu-search', { search: 'Cowboy Bebop' });
assert.ok(metas.some(meta => meta.id === 'kitsu:1'), 'Search did not find Cowboy Bebop.');
const { meta } = await service.metadata('kitsu:1');
assert.equal(meta.videos.length, 26);
assert.equal(meta.videos[0].id, 'kitsu:1:1');
assert.ok(meta.videos[0].title && meta.videos[0].released);
assert.notEqual(meta.videos[25].title, 'Episode 26', 'The second episode page did not load.');
console.log(`PASS search and metadata: ${meta.videos.length} episodes with Kitsu IDs`);

const firstMovies = await service.catalog('kitsu-movies');
const secondMovies = await service.catalog('kitsu-movies', { skip: '100' });
validPage(secondMovies.metas, 'second movie page');
const firstIds = new Set(firstMovies.metas.map(meta => meta.id));
assert.ok(secondMovies.metas.every(meta => !firstIds.has(meta.id)), 'Movie pages overlap.');
const action = await service.catalog('kitsu-category-action');
validPage(action.metas, 'Action');
console.log('PASS second catalog page and main Action catalog');

let total = 0;
await Promise.all(Object.entries(CATEGORIES).map(async ([label, slug]) => {
  const result = await service.catalog(`kitsu-category-${slug}`);
  assert.ok(result.metas.length > 0, `No titles returned for the main ${label} catalog.`);
  const sourceLabel = label === 'Children' ? 'Kids' : label === 'Superpower' ? 'Super Power' : label;
  assert.ok(result.metas.every(meta => meta.genres?.includes(sourceLabel)), `Category did not match: ${label} -> ${slug}`);
  total += 1;
  console.log(`PASS main catalog ${label}: ${result.metas.length} matching titles`);
}));
assert.equal(total, 40);
console.log('PASS all live Kitsu checks');
