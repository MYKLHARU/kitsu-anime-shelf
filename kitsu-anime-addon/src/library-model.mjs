// Pure, account-independent library primitives for Kitsu Anime Shelf 2.0.
// This module does not persist personal data or modify existing Stremio IDs.
export const LIBRARY_STATUSES = Object.freeze(['planning', 'watching', 'completed', 'on_hold', 'dropped']);

export function normalizeAnimeId(provider, id) {
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(provider)) {
    throw new TypeError('Invalid anime ID provider');
  }
  const value = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) {
    throw new TypeError('Invalid anime ID');
  }
  return `${provider}:${value}`;
}

export function createLibraryEntry({ animeId, status = 'planning', progress = 0, score = null } = {}) {
  if (typeof animeId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(animeId)) {
    throw new TypeError('animeId must be a namespaced ID');
  }
  if (!LIBRARY_STATUSES.includes(status)) throw new RangeError('Invalid library status');
  if (!Number.isSafeInteger(progress) || progress < 0) throw new RangeError('Progress must be a non-negative integer');
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 10)) {
    throw new RangeError('Score must be between 0 and 10');
  }
  return Object.freeze({ animeId, status, progress, score });
}

export function updateLibraryEntry(entry, changes = {}) {
  if (!entry || typeof entry !== 'object' || !changes || typeof changes !== 'object') {
    throw new TypeError('Entry and changes must be objects');
  }
  if (Object.hasOwn(changes, 'animeId') && changes.animeId !== entry.animeId) {
    throw new Error('Changing animeId requires an explicit ID migration');
  }
  const allowed = new Set(['status', 'progress', 'score', 'animeId']);
  if (Object.keys(changes).some(key => !allowed.has(key))) throw new TypeError('Unknown library field');
  return createLibraryEntry({ ...entry, ...changes });
}
