// PostgreSQL adapter for the 2.0 library service.
// Inject a pg-compatible client/pool exposing query(text, values). No credentials
// or database connections are created by importing this module.
import { createLibraryEntry } from './library-model.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  return createLibraryEntry({
    animeId,
    status: row.status,
    progress: Number(row.progress),
    score: row.score === null ? null : Number(row.score)
  });
}

export function createPostgresLibraryAdapter(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A pg-compatible query client is required');
  return Object.freeze({
    async get(userId, animeId) {
      assertUuid(userId);
      const [provider, externalId] = parseId(animeId);
      const result = await db.query(
        `SELECT l.status, l.progress, l.score
         FROM shelf_library_entries l
         JOIN shelf_anime_external_ids x ON x.anime_id = l.anime_id
         WHERE l.user_id = $1 AND x.provider = $2 AND x.external_id = $3`,
        [userId, provider, externalId]
      );
      return result.rows[0] ? toEntry(animeId, result.rows[0]) : null;
    },
    async patch(userId, animeId, changes) {
      assertUuid(userId);
      const [provider, externalId] = parseId(animeId);
      const allowed = ['status', 'progress', 'score', 'animeId'];
      if (!changes || typeof changes !== 'object' || Object.keys(changes).some(k => !allowed.includes(k))) {
        throw new TypeError('Invalid library changes');
      }
      if (Object.hasOwn(changes, 'animeId') && changes.animeId !== animeId) {
        throw new Error('Changing animeId requires an explicit migration');
      }
      // Validate supplied fields, while preserving nullable score semantics.
      const valid = createLibraryEntry({ animeId, ...changes });
      const hasStatus = Object.hasOwn(changes, 'status');
      const hasProgress = Object.hasOwn(changes, 'progress');
      const hasScore = Object.hasOwn(changes, 'score');
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
           updated_at = now()
         RETURNING status, progress, score`,
        [userId, provider, externalId, valid.status, valid.progress, valid.score,
         hasStatus, hasProgress, hasScore]
      );
      if (!result.rows[0]) throw new Error('Anime ID has not been mapped to a canonical record');
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
                       updated_at = now()
         RETURNING status, progress, score`,
        [userId, provider, externalId, valid.status, valid.progress, valid.score]
      );
      if (!result.rows[0]) throw new Error('Anime ID has not been mapped to a canonical record');
      return toEntry(valid.animeId, result.rows[0]);
    }
  });
}
