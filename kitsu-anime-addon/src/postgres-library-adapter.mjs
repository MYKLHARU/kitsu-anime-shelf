// PostgreSQL adapter for the 2.0 library service.
// Inject a pg-compatible client/pool exposing query(text, values). No credentials
// or database connections are created by importing this module.
import { createLibraryEntry } from './library-model.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LIST = 5000;

export class UnmappedAnimeError extends Error {
  constructor() { super('Anime ID has not been mapped to a canonical record'); this.status = 404; }
}

export class RevisionConflictError extends Error {
  constructor() { super('This entry was changed elsewhere. Reload and try again.'); this.status = 412; }
}

function parseId(id) {
  if (typeof id !== 'string') throw new TypeError('Invalid anime ID');
  const match = /^([a-z][a-z0-9_-]{0,31}):([A-Za-z0-9][A-Za-z0-9:_-]{0,127})$/.exec(id);
  if (!match) throw new TypeError('Invalid anime ID');
  return [match[1], match[2]];
}

function assertUuid(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('User ID must be a UUID');
}

function toEntry(animeId, row) {
  const entry = createLibraryEntry({
    animeId,
    status: row.status,
    progress: Number(row.progress),
    score: row.score === null ? null : Number(row.score)
  });
  if (row.revision === undefined) return entry;
  return Object.freeze({ ...entry, revision: Number(row.revision), updatedAt: row.updated_at });
}

export function createPostgresLibraryAdapter(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A pg-compatible query client is required');
  const adapter = {
    async get(userId, animeId) {
      assertUuid(userId);
      const [provider, externalId] = parseId(animeId);
      const result = await db.query(
        `SELECT l.status, l.progress, l.score, l.revision, l.updated_at
         FROM shelf_library_entries l
         JOIN shelf_anime_external_ids x ON x.anime_id = l.anime_id
         WHERE l.user_id = $1 AND x.provider = $2 AND x.external_id = $3`,
        [userId, provider, externalId]
      );
      return result.rows[0] ? toEntry(animeId, result.rows[0]) : null;
    },
    // Library entries joined to cached metadata, addressed by Kitsu ID.
    async list(userId, { status } = {}) {
      assertUuid(userId);
      const result = await db.query(
        `SELECT 'kitsu:' || x.external_id AS anime_id, l.status, l.progress, l.score, l.revision, l.updated_at, l.created_at,
                a.canonical_title, a.poster_url, a.episode_count, a.subtype, a.start_year, a.categories
         FROM shelf_library_entries l
         JOIN shelf_anime a ON a.id = l.anime_id
         JOIN shelf_anime_external_ids x ON x.anime_id = l.anime_id AND x.provider = 'kitsu'
         WHERE l.user_id = $1 AND ($2::text IS NULL OR l.status = $2)
         ORDER BY l.updated_at DESC LIMIT ${MAX_LIST}`,
        [userId, status ?? null]
      );
      return result.rows.map(row => ({
        ...toEntry(row.anime_id, row),
        createdAt: row.created_at,
        anime: {
          title: row.canonical_title, poster: row.poster_url, episodeCount: row.episode_count,
          subtype: row.subtype, startYear: row.start_year, categories: row.categories
        }
      }));
    },
    async remove(userId, animeId) {
      assertUuid(userId);
      const [provider, externalId] = parseId(animeId);
      const result = await db.query(
        `DELETE FROM shelf_library_entries l USING shelf_anime_external_ids x
         WHERE l.user_id = $1 AND x.anime_id = l.anime_id AND x.provider = $2 AND x.external_id = $3`,
        [userId, provider, externalId]
      );
      return result.rowCount > 0;
    },
    async patch(userId, animeId, changes, _candidate, { expectedRevision } = {}) {
      assertUuid(userId);
      const [provider, externalId] = parseId(animeId);
      const allowed = ['status', 'progress', 'score', 'animeId'];
      if (!changes || typeof changes !== 'object' || Object.keys(changes).some(k => !allowed.includes(k))) {
        throw new TypeError('Invalid library changes');
      }
      if (Object.hasOwn(changes, 'animeId') && changes.animeId !== animeId) {
        throw new Error('Changing animeId requires an explicit migration');
      }
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
        throw new TypeError('Invalid revision');
      }
      // Validate supplied fields, while preserving nullable score semantics.
      const valid = createLibraryEntry({ animeId, ...changes });
      const hasStatus = Object.hasOwn(changes, 'status');
      const hasProgress = Object.hasOwn(changes, 'progress');
      const hasScore = Object.hasOwn(changes, 'score');
      if (expectedRevision !== undefined) {
        // Optimistic concurrency: update only the revision the client saw.
        const result = await db.query(
          `UPDATE shelf_library_entries l SET
             status = CASE WHEN $8 THEN $4 ELSE l.status END,
             progress = CASE WHEN $9 THEN $5::integer ELSE l.progress END,
             score = CASE WHEN $10 THEN $6::numeric ELSE l.score END,
             revision = l.revision + 1, updated_at = now()
           FROM shelf_anime_external_ids x
           WHERE l.user_id = $1 AND x.anime_id = l.anime_id AND x.provider = $2 AND x.external_id = $3 AND l.revision = $7
           RETURNING l.status, l.progress, l.score, l.revision, l.updated_at`,
          [userId, provider, externalId, valid.status, valid.progress, valid.score, expectedRevision, hasStatus, hasProgress, hasScore]
        );
        if (result.rows[0]) return toEntry(animeId, result.rows[0]);
        if (await adapter.get(userId, animeId)) throw new RevisionConflictError();
        throw new UnmappedAnimeError();
      }
      const result = await db.query(
        `INSERT INTO shelf_library_entries (user_id, anime_id, status, progress, score)
         SELECT $1, x.anime_id, $4, $5, $6
         FROM shelf_anime_external_ids x
         WHERE x.provider = $2 AND x.external_id = $3
         ON CONFLICT (user_id, anime_id)
         DO UPDATE SET
           status = CASE WHEN $7 THEN EXCLUDED.status ELSE shelf_library_entries.status END,
           progress = CASE WHEN $8 THEN EXCLUDED.progress ELSE shelf_library_entries.progress END,
           score = CASE WHEN $9 THEN EXCLUDED.score ELSE shelf_library_entries.score END,
           revision = shelf_library_entries.revision + 1,
           updated_at = now()
         RETURNING status, progress, score, revision, updated_at`,
        [userId, provider, externalId, valid.status, valid.progress, valid.score,
         hasStatus, hasProgress, hasScore]
      );
      if (!result.rows[0]) throw new UnmappedAnimeError();
      return toEntry(animeId, result.rows[0]);
    },
    async put(userId, entry) {
      assertUuid(userId);
      const valid = createLibraryEntry(entry);
      const [provider, externalId] = parseId(valid.animeId);
      // One statement: resolve the canonical anime, then atomically upsert
      // the library entry. Unknown IDs are rejected rather than auto-matched.
      const result = await db.query(
        `INSERT INTO shelf_library_entries (user_id, anime_id, status, progress, score)
         SELECT $1, x.anime_id, $4, $5, $6
         FROM shelf_anime_external_ids x
         WHERE x.provider = $2 AND x.external_id = $3
         ON CONFLICT (user_id, anime_id)
         DO UPDATE SET status = EXCLUDED.status,
                       progress = EXCLUDED.progress,
                       score = EXCLUDED.score,
                       revision = shelf_library_entries.revision + 1,
                       updated_at = now()
         RETURNING status, progress, score, revision, updated_at`,
        [userId, provider, externalId, valid.status, valid.progress, valid.score]
      );
      if (!result.rows[0]) throw new UnmappedAnimeError();
      return toEntry(valid.animeId, result.rows[0]);
    }
  };
  return Object.freeze(adapter);
}
