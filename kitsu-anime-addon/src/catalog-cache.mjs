// Keep the last complete first page available during a slow Kitsu refresh.
// Refresh one catalog at a time so 40 stale homepage rows cannot flood Kitsu.
// An optional persistent store ({ get(key), set(key, value, savedMs) }) keeps
// first pages across restarts, so rows load instantly after a deploy.
export function createCatalogCache({ now = Date.now, maxEntries = 64,
  freshMs = 900000, staleMs = 86400000, retryMs = 60000, store } = {}) {
  const entries = new Map();
  const pending = new Map();
  const queued = new Map();
  const retry = new Map();
  let refreshing = false;

  function save(key, value) {
    const saved = now();
    entries.delete(key);
    entries.set(key, { value, saved });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    retry.delete(key);
    // Persisting is best effort and never delays a response.
    if (store) Promise.resolve().then(() => store.set(key, value, saved)).catch(() => {});
    return value;
  }

  async function restore(key) {
    if (!store) return undefined;
    try {
      const stored = await store.get(key);
      if (!stored || !(now() - stored.saved < staleMs)) return undefined;
      if (!entries.has(key)) {
        entries.set(key, { value: stored.value, saved: stored.saved });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      }
      return entries.get(key);
    } catch {
      return undefined; // A store outage falls back to loading from Kitsu.
    }
  }

  async function loadOnce(key, load, background = false) {
    if (pending.has(key)) return pending.get(key);
    const operation = Promise.resolve().then(() => load({ background })).then(value => save(key, value));
    pending.set(key, operation);
    try { return await operation; }
    finally { pending.delete(key); }
  }

  async function drain() {
    if (refreshing) return;
    refreshing = true;
    try {
      while (queued.size) {
        const [key, load] = queued.entries().next().value;
        queued.delete(key);
        try { await loadOnce(key, load, true); }
        catch {
          retry.set(key, now() + retryMs);
          while (retry.size > maxEntries) retry.delete(retry.keys().next().value);
        }
      }
    } finally { refreshing = false; }
  }

  return {
    async read(key, load, { background = false } = {}) {
      const cached = entries.get(key) ?? (pending.has(key) ? undefined : await restore(key));
      if (cached && now() - cached.saved < staleMs) {
        entries.delete(key);
        entries.set(key, cached);
        if (now() - cached.saved >= freshMs && !pending.has(key) && !queued.has(key) && !(retry.get(key) > now())) {
          queued.set(key, load);
          void drain();
        }
        return cached.value;
      }
      queued.delete(key);
      return loadOnce(key, load, background);
    }
  };
}
