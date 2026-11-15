// Storage-agnostic library operations. No database connection or HTTP exposure.
// Adapter contract: get(userId, animeId) -> entry|null;
// put(userId, entry) -> entry. Optional: patch(userId, animeId, changes,
// candidate, options) for atomic partial updates, list(userId, filter) and
// remove(userId, animeId). Production adapters must enforce user isolation.
import { createLibraryEntry, updateLibraryEntry } from './library-model.mjs';

function assertUserId(userId) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
    throw new TypeError('A validated user identifier is required');
  }
}

// Validate the stored entry, keeping storage metadata (revision, timestamps).
function validated(stored) {
  const entry = createLibraryEntry(stored);
  if (stored.revision === undefined) return entry;
  return Object.freeze({ ...entry, revision: stored.revision, updatedAt: stored.updatedAt });
}

export function createLibraryService(adapter) {
  if (!adapter || typeof adapter.get !== 'function' || typeof adapter.put !== 'function') {
    throw new TypeError('A get/put storage adapter is required');
  }
  return Object.freeze({
    async get(userId, animeId) {
      assertUserId(userId);
      const valid = createLibraryEntry({ animeId });
      const stored = await adapter.get(userId, valid.animeId);
      return stored == null ? null : validated(stored);
    },
    async list(userId, filter = {}) {
      assertUserId(userId);
      if (typeof adapter.list !== 'function') throw new Error('This storage adapter cannot list entries');
      if (filter.status !== undefined) createLibraryEntry({ animeId: 'kitsu:1', status: filter.status });
      return adapter.list(userId, filter);
    },
    async remove(userId, animeId) {
      assertUserId(userId);
      createLibraryEntry({ animeId });
      if (typeof adapter.remove !== 'function') throw new Error('This storage adapter cannot remove entries');
      return adapter.remove(userId, animeId);
    },
    async save(userId, animeId, changes = {}, options = {}) {
      assertUserId(userId);
      const baseline = createLibraryEntry({ animeId });
      if (typeof adapter.patch === 'function') {
        // The persistent adapter applies partial updates in one SQL statement.
        const candidate = updateLibraryEntry(baseline, changes);
        return validated(await adapter.patch(userId, animeId, changes, candidate, options));
      }
      const existing = await adapter.get(userId, animeId);
      const entry = updateLibraryEntry(existing == null ? baseline : createLibraryEntry(existing), changes);
      return validated(await adapter.put(userId, entry));
    }
  });
}

// Development/test-only adapter. It is intentionally not durable.
export function createMemoryLibraryAdapter() {
  const entries = new Map();
  const key = (userId, animeId) => JSON.stringify([userId, animeId]);
  return {
    async get(userId, animeId) { return entries.get(key(userId, animeId)) ?? null; },
    async put(userId, entry) {
      entries.set(key(userId, entry.animeId), entry);
      return entry;
    },
    async patch(userId, animeId, changes) {
      const current = entries.get(key(userId, animeId)) ?? createLibraryEntry({ animeId });
      const updated = updateLibraryEntry(current, changes);
      entries.set(key(userId, animeId), updated);
      return updated;
    },
    async list(userId) {
      return [...entries].filter(([k]) => JSON.parse(k)[0] === userId).map(([, entry]) => entry);
    },
    async remove(userId, animeId) { return entries.delete(key(userId, animeId)); }
  };
}
