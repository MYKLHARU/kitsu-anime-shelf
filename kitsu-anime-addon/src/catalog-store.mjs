// PostgreSQL-backed store for catalog first pages (see catalog-cache.mjs).
// Keeps rows available across restarts and deploys. Values are the public
// catalog responses (no user data).
const KEY = /^[a-z0-9-]{1,100}$/;
const MAX_BYTES = 2 * 1024 * 1024;

export function createCatalogStore(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A pg-compatible query client is required');
  return Object.freeze({
    async get(key) {
      if (!KEY.test(key)) return undefined;
      const row = (await db.query('SELECT value, saved_at FROM shelf_catalog_cache WHERE key = $1', [key])).rows[0];
      return row ? { value: row.value, saved: row.saved_at.getTime() } : undefined;
    },
    async set(key, value, saved) {
      if (!KEY.test(key)) return;
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > MAX_BYTES) return;
      await db.query(
        `INSERT INTO shelf_catalog_cache (key, value, saved_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, saved_at = EXCLUDED.saved_at
         WHERE shelf_catalog_cache.saved_at <= EXCLUDED.saved_at`,
        [key, json, new Date(saved)]);
    }
  });
}
