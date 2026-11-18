-- Persistent first pages of public catalog rows, so rows load instantly
-- after a restart or deploy. Public Kitsu data only; safe to truncate.
CREATE TABLE shelf_catalog_cache (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9-]{1,100}$'),
  value jsonb NOT NULL,
  saved_at timestamptz NOT NULL
);
