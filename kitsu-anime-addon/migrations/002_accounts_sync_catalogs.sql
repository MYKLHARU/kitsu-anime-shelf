-- Kitsu Anime Shelf 2.0: accounts, sessions, AniList connections, personal
-- Stremio install tokens, cached anime metadata and audit logging.
-- Requires PostgreSQL 13+ (gen_random_uuid is built in).

ALTER TABLE shelf_users
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ADD COLUMN email text,
  ADD COLUMN password_hash text,
  ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 60),
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT shelf_users_email_format
    CHECK (email IS NULL OR (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1));
CREATE UNIQUE INDEX shelf_users_email_key ON shelf_users(email);

-- Cached Kitsu metadata used by the dashboard, personal catalogs and
-- recommendations without one upstream request per library entry.
ALTER TABLE shelf_anime
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ADD COLUMN poster_url text CHECK (poster_url IS NULL OR poster_url ~ '^https://'),
  ADD COLUMN subtype text,
  ADD COLUMN episode_count integer CHECK (episode_count IS NULL OR episode_count >= 0),
  ADD COLUMN start_year integer,
  ADD COLUMN categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN metadata_refreshed_at timestamptz;

ALTER TABLE shelf_library_entries
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE INDEX shelf_library_entries_user_updated_idx ON shelf_library_entries(user_id, updated_at DESC);

ALTER TABLE shelf_watch_events ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Opaque session tokens: only the SHA-256 hash is stored.
CREATE TABLE shelf_sessions (
  token_hash bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES shelf_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 256)
);
CREATE INDEX shelf_sessions_user_idx ON shelf_sessions(user_id);
CREATE INDEX shelf_sessions_expiry_idx ON shelf_sessions(expires_at);

-- Revocable, read-only tokens embedded in personal Stremio manifest URLs.
CREATE TABLE shelf_install_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES shelf_users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX shelf_install_tokens_user_idx ON shelf_install_tokens(user_id);

-- External account links. Access tokens are AES-256-GCM encrypted by the
-- application; the database never sees plaintext tokens.
CREATE TABLE shelf_provider_connections (
  user_id uuid NOT NULL REFERENCES shelf_users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('anilist')),
  external_user_id text NOT NULL CHECK (external_user_id ~ '^[0-9]{1,20}$'),
  external_username text CHECK (external_username IS NULL OR length(external_username) <= 64),
  access_token_enc text NOT NULL,
  token_expires_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  sync_status text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'running', 'succeeded', 'failed')),
  sync_started_at timestamptz,
  sync_result jsonb,
  auto_push boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, external_user_id)
);

-- Short-lived OAuth state values (hash only), bound to the signed-in user.
CREATE TABLE shelf_oauth_states (
  state_hash bytea PRIMARY KEY CHECK (length(state_hash) = 32),
  user_id uuid NOT NULL REFERENCES shelf_users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('anilist')),
  expires_at timestamptz NOT NULL
);

-- Security audit trail. Rows are kept for 90 days (see maintenance job).
CREATE TABLE shelf_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES shelf_users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action ~ '^[a-z_.]{1,64}$'),
  ip text CHECK (ip IS NULL OR length(ip) <= 64),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shelf_audit_log_user_idx ON shelf_audit_log(user_id, created_at DESC);
CREATE INDEX shelf_audit_log_time_idx ON shelf_audit_log(created_at);
