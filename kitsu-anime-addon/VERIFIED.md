# Verification — 10 November 2026

- **9 automated tests passed**, including the Stremio HTTP endpoints, all 40 main catalog declarations, search encoding, aliases, pagination, caching, errors and episode fallbacks.
- **All 40 requested categories are main catalogs** with their own catalog IDs and matching Kitsu content. The manifest lists 45 catalogs in total, including the four general catalogs and search.
- Popular, Top Rated, Currently Airing and Anime Movies each returned **100 titles** on the first page.
- Anime Movies returned another **100 titles** on the second page with no overlap; the main Action catalog also returned a full 100-title page.
- Searching for Cowboy Bebop found `kitsu:1`; its metadata contained **26 episodes**, including the second page of episode titles and standard `kitsu:1:1` IDs.
- The installation page exposes the 40 categories as main catalog choices. The separate category filter has been removed.

Kitsu's current anime search backend repeats the first page when using offset-based pagination with filters. Catalog requests use its working `page[number]` / `page[size]` pagination instead. Episode requests retain the working offset-based paginator.

The add-on has not been installed into a Stremio account or published to a public host. Stream availability is provided by the user's separate Kitsu-compatible stream add-ons.
