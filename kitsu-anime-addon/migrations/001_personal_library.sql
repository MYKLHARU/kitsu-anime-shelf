-- Kitsu Anime Shelf 2.0: PostgreSQL foundation.
-- Apply only to a dedicated database after reviewing credentials and backups.
BEGIN;

CREATE TABLE IF NOT EXISTS shelf_users (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shelf_anime (
  id uuid PRIMARY KEY,
  canonical_title text NOT NULL CHECK (length(trim(canonical_title)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shelf_anime_external_ids (
  anime_id uuid NOT NULL REFERENCES shelf_anime(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  external_id text NOT NULL CHECK (external_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY (provider, external_id),
  UNIQUE (anime_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS shelf_anime_external_ids_anime_idx ON shelf_anime_external_ids(anime_id);

CREATE TABLE IF NOT EXISTS shelf_library_entries (
  user_id uuid NOT NULL REFERENCES shelf_users(id) ON DELETE CASCADE,
  anime_id uuid NOT NULL REFERENCES shelf_anime(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'watching', 'completed', 'on_hold', 'dropped')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  score numeric(3,1) CHECK (score BETWEEN 0 AND 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, anime_id)
);
CREATE INDEX IF NOT EXISTS shelf_library_entries_user_status_idx
  ON shelf_library_entries(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS shelf_watch_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES shelf_users(id) ON DELETE CASCADE,
  anime_id uuid NOT NULL REFERENCES shelf_anime(id) ON DELETE CASCADE,
  episode_number integer NOT NULL CHECK (episode_number > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'anilist', 'stremio')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS shelf_watch_events_user_time_idx
  ON shelf_watch_events(user_id, occurred_at DESC);

COMMIT;
