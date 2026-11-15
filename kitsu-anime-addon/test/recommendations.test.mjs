import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, rankCandidates } from '../src/recommendations.mjs';

const entry = (animeId, status, categories, score = null) => ({ animeId, status, score, anime: { categories } });
const candidate = (id, categories, rank = 0, extra = {}) => ({ id: `kitsu:${id}`, categories, rank, rating: 75, subtype: 'TV', ...extra });

test('profile rewards finished, well-rated titles and penalises dropped ones', () => {
  const profile = buildProfile([
    entry('kitsu:1', 'completed', ['isekai', 'fantasy'], 10),
    entry('kitsu:2', 'watching', ['isekai']),
    entry('kitsu:3', 'dropped', ['sports']),
    entry('kitsu:4', 'completed', ['romance'], 2),
    entry('kitsu:5', 'completed', ['japan', 'mecha'])
  ]);
  assert.ok(profile.get('isekai') > profile.get('fantasy'));
  assert.ok(profile.get('sports') < 0);
  assert.ok(profile.get('romance') < 0, 'a low score counts against the category');
  assert.ok(profile.get('japan') < profile.get('mecha'), 'generic location tags are damped');
});

test('ranking excludes the library, other seasons and music videos, and prefers taste', () => {
  const affinity = new Map([['isekai', 2], ['fantasy', 1], ['sports', -1]]);
  const groups = { 'kitsu:10': 'g1', 'kitsu:11': 'g1', 'kitsu:20': 'g2', 'kitsu:21': 'g2' };
  const ranked = rankCandidates([
    candidate(1, ['isekai']),                       // already in library
    candidate(11, ['isekai', 'fantasy']),           // another season of a library title
    candidate(20, ['isekai'], 5),
    candidate(21, ['isekai'], 6),                   // second season of 20: deduplicated
    candidate(30, ['sports'], 0),
    candidate(40, ['fantasy'], 1),
    candidate(50, ['isekai'], 2, { subtype: 'music' })
  ], affinity, { exclude: new Set(['kitsu:1', 'kitsu:10']), groupOf: id => groups[id] });
  assert.deepEqual(ranked.map(item => item.id), ['kitsu:20', 'kitsu:40', 'kitsu:30']);
  assert.equal(ranked[0].reasonSlug, 'isekai');
});

test('no single category takes more than 40% of a long list', () => {
  const affinity = new Map([['isekai', 5], ['drama', 1]]);
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) => candidate(i + 1, ['isekai'], i)),
    ...Array.from({ length: 30 }, (_, i) => candidate(i + 100, ['drama'], i))
  ];
  const ranked = rankCandidates(candidates, affinity, { limit: 20 });
  assert.equal(ranked.length, 20, 'the list is still filled');
  assert.equal(ranked.slice(0, 16).filter(item => item.reasonSlug === 'isekai').length, 8);
  assert.ok(ranked.slice(0, 16).some(item => item.reasonSlug === 'drama'));
});
