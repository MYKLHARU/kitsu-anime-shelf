// Canonical anime records for 2.0 features.
//
// Kitsu IDs remain the Stremio-facing identity. A canonical shelf_anime row is
// created only for a Kitsu ID that Kitsu itself confirms exists, and cached
// metadata (title, poster, categories, episode count) is refreshed weekly.
// AniList IDs are attached only when the Fribb mapping is one-to-one.

const KITSU_BATCH = 20;
const STALE_MS = 7 * 86400000;
const KITSU_ID = /^[1-9]\d{0,9}$/;

export class AnimeNotFoundError extends Error {
  constructor(message = 'Anime not found on Kitsu') { super(message); this.status = 404; }
}

// One-to-one Kitsu <-> AniList pairs. Ambiguous mappings are left unresolved.
export function buildAnilistIndex(rows = []) {
  const byKitsu = new Map();
  const byAnilist = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.kitsu_id) || !Number.isSafeInteger(row?.anilist_id) || row.kitsu_id < 1 || row.anilist_id < 1) continue;
    const kitsu = String(row.kitsu_id);
    (byKitsu.get(kitsu) ?? byKitsu.set(kitsu, new Set()).get(kitsu)).add(row.anilist_id);
    (byAnilist.get(row.anilist_id) ?? byAnilist.set(row.anilist_id, new Set()).get(row.anilist_id)).add(kitsu);
  }
  const kitsuToAnilist = new Map();
  const anilistToKitsu = new Map();
  for (const [kitsu, anilistIds] of byKitsu) {
    if (anilistIds.size !== 1) continue;
    const [anilist] = anilistIds;
    if (byAnilist.get(anilist).size !== 1) continue;
    kitsuToAnilist.set(kitsu, anilist);
    anilistToKitsu.set(anilist, kitsu);
  }
  return { kitsuToAnilist, anilistToKitsu };
}

export function createAnilistIndexLoader(loadMappings) {
  let source;
  let index = buildAnilistIndex([]);
  return async function load() {
    if (!loadMappings) return index;
    try {
      const rows = await loadMappings();
      if (rows !== source) { index = buildAnilistIndex(rows); source = rows; }
    } catch { /* Keep the previous index during mapping outages. */ }
    return index;
  };
}

function summarise(item, included = []) {
  const a = item.attributes || {};
  const categoryIds = new Set((item.relationships?.categories?.data || []).map(category => category.id));
  const categories = included.filter(resource => resource.type === 'categories' && categoryIds.has(resource.id))
    .map(resource => resource.attributes?.slug).filter(slug => typeof slug === 'string' && /^[a-z0-9-]{1,64}$/.test(slug));
  const poster = ['medium', 'small', 'large', 'original'].map(size => a.posterImage?.[size]).find(url => typeof url === 'string' && url.startsWith('https://'));
  const year = Number(a.startDate?.slice(0, 4));
  return {
    kitsuId: String(item.id),
    title: String(a.canonicalTitle || a.titles?.en || a.titles?.en_jp || `Anime ${item.id}`).slice(0, 500),
    poster: poster || null,
    subtype: typeof a.subtype === 'string' ? a.subtype.slice(0, 32) : null,
    episodeCount: Number.isSafeInteger(a.episodeCount) && a.episodeCount >= 0 ? a.episodeCount : null,
    startYear: Number.isSafeInteger(year) && year > 1900 && year < 3000 ? year : null,
    categories: [...new Set(categories)].slice(0, 64)
  };
}

export function createAnimeStore(db, { api, loadAnilistIndex = async () => buildAnilistIndex([]), now = Date.now } = {}) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A pg-compatible query client is required');

  async function fetchFromKitsu(ids) {
    const found = new Map();
    for (let i = 0; i < ids.length; i += KITSU_BATCH) {
      const batch = ids.slice(i, i + KITSU_BATCH);
      const result = await api.request('anime', {
        'filter[id]': batch.join(','),
        include: 'categories',
        'fields[anime]': 'canonicalTitle,titles,subtype,posterImage,episodeCount,startDate,categories',
        'fields[categories]': 'slug,title',
        'page[limit]': KITSU_BATCH
      }, 3600, { priority: 1 });
      for (const item of Array.isArray(result.data) ? result.data : []) {
        if (batch.includes(String(item.id))) found.set(String(item.id), summarise(item, result.included));
      }
    }
    return found;
  }

  async function upsert(summary, anilistId) {
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shelf_anime:kitsu:${summary.kitsuId}`]);
      const existing = (await tx.query(
        `SELECT anime_id FROM shelf_anime_external_ids WHERE provider = 'kitsu' AND external_id = $1`, [summary.kitsuId])).rows[0];
      const values = [summary.title, summary.poster, summary.subtype, summary.episodeCount, summary.startYear, summary.categories];
      let animeId;
      if (existing) {
        animeId = existing.anime_id;
        await tx.query(
          `UPDATE shelf_anime SET canonical_title = $2, poster_url = $3, subtype = $4, episode_count = $5, start_year = $6,
             categories = $7::text[], metadata_refreshed_at = now() WHERE id = $1`, [animeId, ...values]);
      } else {
        animeId = (await tx.query(
          `INSERT INTO shelf_anime (canonical_title, poster_url, subtype, episode_count, start_year, categories, metadata_refreshed_at)
           VALUES ($1, $2, $3, $4, $5, $6::text[], now()) RETURNING id`, values)).rows[0].id;
        await tx.query(
          `INSERT INTO shelf_anime_external_ids (anime_id, provider, external_id, verified) VALUES ($1, 'kitsu', $2, true)`,
          [animeId, summary.kitsuId]);
      }
      if (anilistId) {
        // Mapping-derived, so not marked verified. Never re-point an existing AniList ID.
        await tx.query(
          `INSERT INTO shelf_anime_external_ids (anime_id, provider, external_id, verified) VALUES ($1, 'anilist', $2, false)
           ON CONFLICT DO NOTHING`, [animeId, String(anilistId)]);
      }
      return animeId;
    });
  }

  return Object.freeze({
    // Ensure canonical records exist for Kitsu IDs. Returns Map(kitsuId -> uuid)
    // for IDs Kitsu confirmed; unknown IDs are omitted.
    async ensureKitsu(kitsuIds, { refresh = false } = {}) {
      const ids = [...new Set(kitsuIds.map(String))].filter(id => KITSU_ID.test(id));
      if (!ids.length) return new Map();
      const known = (await db.query(
        `SELECT x.external_id, a.id, a.metadata_refreshed_at FROM shelf_anime_external_ids x
         JOIN shelf_anime a ON a.id = x.anime_id WHERE x.provider = 'kitsu' AND x.external_id = ANY($1::text[])`, [ids])).rows;
      const result = new Map(known.map(row => [row.external_id, row.id]));
      const stale = ids.filter(id => {
        const row = known.find(item => item.external_id === id);
        return !row || refresh || !row.metadata_refreshed_at || now() - row.metadata_refreshed_at.getTime() > STALE_MS;
      });
      if (!stale.length) return result;
      let fetched;
      try { fetched = await fetchFromKitsu(stale); }
      catch (error) {
        // Existing records stay usable during a Kitsu outage; new ones cannot be verified.
        if (stale.every(id => result.has(id))) return result;
        throw error;
      }
      const index = await loadAnilistIndex();
      for (const id of stale) {
        const summary = fetched.get(id);
        if (summary) result.set(id, await upsert(summary, index.kitsuToAnilist.get(id)));
      }
      return result;
    },
    async get(kitsuId) {
      return (await db.query(
        `SELECT a.id, a.canonical_title AS title, a.poster_url AS poster, a.subtype, a.episode_count AS "episodeCount",
                a.start_year AS "startYear", a.categories
         FROM shelf_anime_external_ids x JOIN shelf_anime a ON a.id = x.anime_id
         WHERE x.provider = 'kitsu' AND x.external_id = $1`, [String(kitsuId)])).rows[0] ?? null;
    }
  });
}
