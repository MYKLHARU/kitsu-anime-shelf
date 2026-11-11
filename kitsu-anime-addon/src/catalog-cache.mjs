// Keep the last complete first page available during a slow Kitsu refresh.
// Refresh one catalog at a time so 40 stale homepage rows cannot flood Kitsu.
export function createCatalogCache({ now = Date.now, maxEntries = 64,
  freshMs = 900000, staleMs = 86400000, retryMs = 60000 } = {}) {
  const entries = new Map();
  const pending = new Map();
  const queued = new Map();
  const retry = new Map();
  let refreshing = false;

  function save(key, value) {
    entries.delete(key);
    entries.set(key, { value, saved: now() });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    retry.delete(key);
    return value;
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
    async read(key, load) {
      const cached = entries.get(key);
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
      return loadOnce(key, load);
    }
  };
}
