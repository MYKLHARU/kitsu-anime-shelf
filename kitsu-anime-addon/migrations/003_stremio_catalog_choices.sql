-- Kitsu Anime Shelf 2.0: lists and genres each user chose for their personal
-- Stremio add-on (catalog IDs, validated by the application). Empty means
-- only the shelf rows are shown.
ALTER TABLE shelf_users
  ADD COLUMN stremio_catalogs text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(stremio_catalogs) <= 60);
