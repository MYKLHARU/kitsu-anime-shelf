import { readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const SOURCE = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const DAY = 86400000;

// Shared by title artwork and season grouping: one download per day, with only
// the small set of fields needed by the addon retained in memory.
export function createAnimeMappingLoader({ fetchImpl = fetch, now = Date.now, cachePath = process.env.ANIME_MAPPING_CACHE_PATH || join(tmpdir(), 'kitsu-anime-mappings.json') } = {}) {
  let rows;
  let saved = 0;
  let retry = 0;
  let pending;
  let restoring;
  // Every caller waits for the same disk read, so a concurrent first call
  // cannot start a download that the disk copy later overwrites.
  function restore() {
    restoring ??= readStored();
    return restoring;
  }
  async function readStored() {
    try {
      const stored = JSON.parse(await readFile(cachePath, 'utf8'));
      // A timestamp from the future is not trusted as fresh.
      if (!rows && Array.isArray(stored.rows) && stored.rows.length <= 100000 &&
          Number.isFinite(stored.saved) && stored.saved <= now() && now() - stored.saved < 7 * DAY &&
          stored.rows.every(row => Number.isSafeInteger(row.kitsu_id) && row.kitsu_id > 0)) {
        rows = stored.rows; saved = stored.saved;
      }
    } catch { /* First run or inaccessible cache: fetch normally. */ }
  }
  return async function load() {
    await restore();
    if (rows && now() - saved < DAY) return rows;
    if (retry > now()) {
      if (rows && now() - saved < 7 * DAY) return rows;
      throw new Error('Anime mappings are temporarily unavailable.');
    }
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchImpl(SOURCE, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        const limit = 10 * 1024 * 1024;
        if (!response.ok || Number(response.headers.get('content-length')) > limit) {
          await response.body?.cancel();
          throw new Error('Anime mapping source unavailable.');
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body || []) {
          size += chunk.length;
          if (size > limit) throw new Error('Anime mapping source too large.');
          chunks.push(chunk);
        }
        const source = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(source) || source.length > 100000) throw new Error('Invalid anime mapping source.');
        rows = source.filter(row => Number.isSafeInteger(row.kitsu_id) && row.kitsu_id > 0).map(row => ({
          kitsu_id: row.kitsu_id, type: row.type, themoviedb_id: row.themoviedb_id,
          season: row.season, episode_offset: row.episode_offset
        }));
        saved = now();
        retry = 0;
        // Atomic best-effort persistence; read-only hosting remains supported.
        const temp = `${cachePath}.${process.pid}.tmp`;
        try { await writeFile(temp, JSON.stringify({ saved, rows }), { mode: 0o600 }); await rename(temp, cachePath); }
        catch { /* Memory cache still works. */ }
        return rows;
      } catch {
        retry = now() + 300000;
        if (rows && now() - saved < 7 * DAY) return rows;
        throw new Error('Anime mappings are temporarily unavailable.');
      }
    })();
    try { return await pending; }
    finally { pending = undefined; }
  };
}
