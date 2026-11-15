// PostgreSQL persistence for accounts, sessions, install tokens, OAuth state,
// provider connections and the audit log. All queries are parameterised and
// every user-owned row is addressed by the server-verified user ID.

export class EmailTakenError extends Error {
  constructor() { super('An account with this email already exists'); this.status = 409; }
}

const DAY = 86400000;
export const SESSION_IDLE_MS = 14 * DAY;
export const SESSION_ABSOLUTE_MS = 30 * DAY;

export function createAccountStore(db, { now = () => new Date() } = {}) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A pg-compatible query client is required');
  const one = async (sql, values) => (await db.query(sql, values)).rows[0] ?? null;

  return Object.freeze({
    // ---- Users ----
    async createUser({ email, passwordHash, displayName = null }) {
      try {
        return await one(
          `INSERT INTO shelf_users (email, password_hash, display_name) VALUES ($1, $2, $3)
           RETURNING id, email, display_name, created_at`, [email, passwordHash, displayName]);
      } catch (error) {
        if (error.code === '23505') throw new EmailTakenError();
        throw error;
      }
    },
    findUserByEmail(email) {
      return one('SELECT id, email, display_name, password_hash FROM shelf_users WHERE email = $1', [email]);
    },
    getUser(userId) {
      return one('SELECT id, email, display_name, password_hash, created_at, password_changed_at FROM shelf_users WHERE id = $1', [userId]);
    },
    async updatePassword(userId, passwordHash, keepSessionHash = null) {
      await db.transaction(async tx => {
        await tx.query('UPDATE shelf_users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [userId, passwordHash]);
        await tx.query('DELETE FROM shelf_sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2', [userId, keepSessionHash]);
      });
    },
    async rehashPassword(userId, passwordHash) {
      await db.query('UPDATE shelf_users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
    },
    async updateProfile(userId, { displayName }) {
      return one('UPDATE shelf_users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING id, email, display_name', [userId, displayName]);
    },
    async getCatalogChoices(userId) {
      return (await one('SELECT stremio_catalogs FROM shelf_users WHERE id = $1', [userId]))?.stremio_catalogs ?? [];
    },
    async setCatalogChoices(userId, catalogIds) {
      return (await one('UPDATE shelf_users SET stremio_catalogs = $2::text[], updated_at = now() WHERE id = $1 RETURNING stremio_catalogs', [userId, catalogIds]))?.stremio_catalogs ?? [];
    },
    async deleteUser(userId) {
      // Cascades to sessions, tokens, library, watch events and connections.
      const result = await db.query('DELETE FROM shelf_users WHERE id = $1', [userId]);
      return result.rowCount === 1;
    },

    // ---- Sessions ----
    async createSession(userId, tokenHash, userAgent = null) {
      const expires = new Date(now().getTime() + SESSION_IDLE_MS);
      await db.query(
        `INSERT INTO shelf_sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
        [tokenHash, userId, expires, userAgent ? String(userAgent).slice(0, 256) : null]);
      return expires;
    },
    async findSession(tokenHash) {
      const session = await one(
        `SELECT s.user_id, s.created_at, s.last_seen_at, s.expires_at, u.email, u.display_name
         FROM shelf_sessions s JOIN shelf_users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND s.created_at > now() - make_interval(secs => $2)`,
        [tokenHash, SESSION_ABSOLUTE_MS / 1000]);
      if (!session) return null;
      // Sliding idle expiry, written at most every five minutes.
      if (now().getTime() - session.last_seen_at.getTime() > 300000) {
        const expires = new Date(Math.min(now().getTime() + SESSION_IDLE_MS, session.created_at.getTime() + SESSION_ABSOLUTE_MS));
        await db.query('UPDATE shelf_sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1', [tokenHash, expires]);
        session.expires_at = expires;
      }
      return session;
    },
    async deleteSession(tokenHash) {
      await db.query('DELETE FROM shelf_sessions WHERE token_hash = $1', [tokenHash]);
    },
    async deleteOtherSessions(userId, keepSessionHash) {
      const result = await db.query('DELETE FROM shelf_sessions WHERE user_id = $1 AND token_hash <> $2', [userId, keepSessionHash]);
      return result.rowCount;
    },
    async listSessions(userId) {
      return (await db.query(
        `SELECT encode(substr(token_hash, 1, 6), 'hex') AS id, created_at, last_seen_at, expires_at, user_agent
         FROM shelf_sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 50`, [userId])).rows;
    },

    // ---- Stremio install tokens ----
    async createInstallToken(userId, tokenHash, label) {
      const count = await one('SELECT count(*)::int AS n FROM shelf_install_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      if (count.n >= 10) { const error = new Error('Revoke an existing install link before creating another (limit 10)'); error.status = 409; throw error; }
      return one(
        `INSERT INTO shelf_install_tokens (user_id, token_hash, label) VALUES ($1, $2, $3)
         RETURNING id, label, created_at`, [userId, tokenHash, label]);
    },
    async listInstallTokens(userId) {
      return (await db.query(
        `SELECT id, label, created_at, last_used_at FROM shelf_install_tokens
         WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`, [userId])).rows;
    },
    async revokeInstallToken(userId, tokenId) {
      const result = await db.query(
        'UPDATE shelf_install_tokens SET revoked_at = now() WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL', [userId, tokenId]);
      return result.rowCount === 1;
    },
    async findInstallToken(tokenHash) {
      const token = await one(
        `SELECT id, user_id, last_used_at FROM shelf_install_tokens WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
      if (token && (!token.last_used_at || now().getTime() - token.last_used_at.getTime() > 600000)) {
        await db.query('UPDATE shelf_install_tokens SET last_used_at = now() WHERE id = $1', [token.id]);
      }
      return token;
    },

    // ---- OAuth state ----
    async createOAuthState(userId, provider, stateHash, ttlMs = 600000) {
      await db.query('INSERT INTO shelf_oauth_states (state_hash, user_id, provider, expires_at) VALUES ($1, $2, $3, $4)',
        [stateHash, userId, provider, new Date(now().getTime() + ttlMs)]);
    },
    // Single use: the state row is deleted whether or not it is still valid.
    async consumeOAuthState(stateHash, provider) {
      return one(
        `DELETE FROM shelf_oauth_states WHERE state_hash = $1 AND provider = $2
         RETURNING user_id, expires_at > now() AS valid`, [stateHash, provider]);
    },

    // ---- Provider connections ----
    async saveConnection(userId, { provider, externalUserId, externalUsername, accessTokenEnc, tokenExpiresAt }) {
      try {
        return await one(
          `INSERT INTO shelf_provider_connections (user_id, provider, external_user_id, external_username, access_token_enc, token_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, provider) DO UPDATE SET external_user_id = EXCLUDED.external_user_id,
             external_username = EXCLUDED.external_username, access_token_enc = EXCLUDED.access_token_enc,
             token_expires_at = EXCLUDED.token_expires_at, connected_at = now(),
             last_synced_at = CASE WHEN shelf_provider_connections.external_user_id = EXCLUDED.external_user_id
               THEN shelf_provider_connections.last_synced_at END
           RETURNING provider, external_user_id, external_username, connected_at`,
          [userId, provider, externalUserId, externalUsername, accessTokenEnc, tokenExpiresAt]);
      } catch (error) {
        if (error.code === '23505') {
          const conflict = new Error('This AniList account is already linked to another Kitsu Anime Shelf account');
          conflict.status = 409;
          throw conflict;
        }
        throw error;
      }
    },
    getConnection(userId, provider) {
      return one(
        `SELECT provider, external_user_id, external_username, access_token_enc, token_expires_at, connected_at,
                last_synced_at, sync_status, sync_started_at, sync_result, auto_push
         FROM shelf_provider_connections WHERE user_id = $1 AND provider = $2`, [userId, provider]);
    },
    async deleteConnection(userId, provider) {
      return (await db.query('DELETE FROM shelf_provider_connections WHERE user_id = $1 AND provider = $2', [userId, provider])).rowCount === 1;
    },
    async setAutoPush(userId, provider, enabled) {
      return (await db.query('UPDATE shelf_provider_connections SET auto_push = $3 WHERE user_id = $1 AND provider = $2', [userId, provider, enabled])).rowCount === 1;
    },
    // Claim the sync slot atomically. A run left 'running' for 15 minutes
    // (for example after a restart) is considered abandoned.
    async claimSync(userId, provider) {
      return one(
        `UPDATE shelf_provider_connections SET sync_status = 'running', sync_started_at = now()
         WHERE user_id = $1 AND provider = $2
           AND (sync_status <> 'running' OR sync_started_at < now() - interval '15 minutes')
         RETURNING sync_started_at, last_synced_at`, [userId, provider]);
    },
    async heartbeatSync(userId, provider) {
      await db.query(`UPDATE shelf_provider_connections SET sync_started_at = now() WHERE user_id = $1 AND provider = $2 AND sync_status = 'running'`, [userId, provider]);
    },
    async finishSync(userId, provider, { status, result, watermark }) {
      await db.query(
        `UPDATE shelf_provider_connections SET sync_status = $3, sync_result = $4,
           last_synced_at = CASE WHEN $3 = 'succeeded' THEN $5 ELSE last_synced_at END
         WHERE user_id = $1 AND provider = $2`, [userId, provider, status, result, watermark]);
    },

    // ---- Audit and data rights ----
    async audit(userId, action, ip = null, detail = null) {
      await db.query('INSERT INTO shelf_audit_log (user_id, action, ip, detail) VALUES ($1, $2, $3, $4)',
        [userId, action, ip ? String(ip).slice(0, 64) : null, detail]);
    },
    async exportUser(userId) {
      const [user, library, tokens, connection, audit, events] = await Promise.all([
        one('SELECT id, email, display_name, created_at, password_changed_at, stremio_catalogs FROM shelf_users WHERE id = $1', [userId]),
        db.query(
          `SELECT 'kitsu:' || x.external_id AS anime_id, a.canonical_title AS title, l.status, l.progress, l.score,
                  l.created_at, l.updated_at
           FROM shelf_library_entries l JOIN shelf_anime a ON a.id = l.anime_id
           LEFT JOIN shelf_anime_external_ids x ON x.anime_id = l.anime_id AND x.provider = 'kitsu'
           WHERE l.user_id = $1 ORDER BY l.updated_at DESC`, [userId]),
        db.query('SELECT label, created_at, last_used_at, revoked_at FROM shelf_install_tokens WHERE user_id = $1', [userId]),
        one(`SELECT provider, external_user_id, external_username, connected_at, last_synced_at, auto_push
             FROM shelf_provider_connections WHERE user_id = $1`, [userId]),
        db.query('SELECT action, ip, detail, created_at FROM shelf_audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000', [userId]),
        db.query(
          `SELECT 'kitsu:' || x.external_id AS anime_id, e.episode_number, e.source, e.occurred_at
           FROM shelf_watch_events e LEFT JOIN shelf_anime_external_ids x ON x.anime_id = e.anime_id AND x.provider = 'kitsu'
           WHERE e.user_id = $1 ORDER BY e.occurred_at DESC LIMIT 10000`, [userId])
      ]);
      if (!user) return null;
      return { exportedAt: now().toISOString(), format: 'kitsu-anime-shelf-export/1', account: user, library: library.rows,
        watchEvents: events.rows, stremioInstallLinks: tokens.rows, connections: connection ? [connection] : [], securityLog: audit.rows };
    },
    async cleanup() {
      await db.query('DELETE FROM shelf_sessions WHERE expires_at < now() OR created_at < now() - make_interval(secs => $1)', [SESSION_ABSOLUTE_MS / 1000]);
      await db.query('DELETE FROM shelf_oauth_states WHERE expires_at < now()');
      await db.query(`DELETE FROM shelf_audit_log WHERE created_at < now() - interval '90 days'`);
    }
  });
}
