// Storage-agnostic library operations. No database connection or HTTP exposure.
// Adapter contract: get(userId, animeId) -> entry|null;
// put(userId, entry) -> entry. Production adapters must enforce user isolation.
import { createLibraryEntry, updateLibraryEntry } from './library-model.mjs';

function assertUserId(userId) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
    throw new TypeError('A validated user identifier is required');
  }
}

export function createLibraryService(adapter) {
  if (!adapter || typeof adapter.get !== 'function' || typeof adapter.put !== 'function') {
    throw new TypeError('A get/put storage adapter is required');
  }
  return Object.freeze({
    async get(userId, animeId) {
      assertUserId(userId);
      const validated = createLibraryEntry({ animeId });
      const stored = await adapter.get(userId, validated.animeId);
      return stored == null ? null : createLibraryEntry(stored);
    },
    async save(userId, animeId, changes = {}) {
      assertUserId(userId);
      const baseline = createLibraryEntry({ animeId });
      const existing = await adapter.get(userId, animeId);
      const entry = updateLibraryEntry(existing == null ? baseline : createLibraryEntry(existing), changes);
      return createLibraryEntry(await adapter.put(userId, entry));
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
    }
  };
}
