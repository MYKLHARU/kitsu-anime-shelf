import test from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_STATUSES, normalizeAnimeId, createLibraryEntry, updateLibraryEntry } from '../src/library-model.mjs';

test('normalizes provider identifiers without changing existing Kitsu video IDs', () => {
  assert.equal(normalizeAnimeId('kitsu', 11469), 'kitsu:11469');
  assert.equal(normalizeAnimeId('imdb', 'tt1234567'), 'imdb:tt1234567');
  assert.throws(() => normalizeAnimeId('../bad', '1'), TypeError);
  assert.throws(() => normalizeAnimeId('kitsu', ''), TypeError);
});

test('creates immutable planning entries with safe defaults', () => {
  const entry = createLibraryEntry({ animeId: 'kitsu:11469' });
  assert.deepEqual(entry, { animeId: 'kitsu:11469', status: 'planning', progress: 0, score: null });
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(LIBRARY_STATUSES.length, 5);
});

test('updates progress and score without mutating original entries', () => {
  const original = createLibraryEntry({ animeId: 'kitsu:11469' });
  const updated = updateLibraryEntry(original, { status: 'watching', progress: 8, score: 8.5 });
  assert.equal(original.progress, 0);
  assert.equal(updated.progress, 8);
  assert.equal(updated.score, 8.5);
});

test('rejects invalid progress, scores, status and accidental ID changes', () => {
  for (const progress of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => createLibraryEntry({ animeId: 'kitsu:1', progress }), RangeError);
  }
  assert.throws(() => createLibraryEntry({ animeId: 'kitsu:1', score: 11 }), RangeError);
  assert.throws(() => createLibraryEntry({ animeId: 'kitsu:1', status: 'unknown' }), RangeError);
  assert.throws(() => updateLibraryEntry(createLibraryEntry({ animeId: 'kitsu:1' }), { animeId: 'kitsu:2' }));
  assert.throws(() => updateLibraryEntry(createLibraryEntry({ animeId: 'kitsu:1' }), { admin: true }), TypeError);
});
