const SOURCE = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const DAY = 86400000;

// Shared by title artwork and season grouping: one download per day, with only
// the small set of fields needed by the addon retained in memory.
export function createAnimeMappingLoader({ fetchImpl = fetch, now = Date.now } = {}) {
  let rows;
  let saved = 0;
  let retry = 0;
  let pending;
  return async function load() {
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
