# Season-grouping verification — 11 November 2026

Release: 1.3.0. These checks were performed before production deployment.

- `npm test`: 39 passing tests, including all existing artwork and addon tests. Grouping checks cover explicit season mappings, missing/duplicate/conflicting mappings, exclusions for films and specials, unchanged playback IDs, legacy child-season links, unavailable episode details, retryable whole-season failures, unique-show pagination, concurrent catalog requests, batch hydration of main cards, cache bounds and a shared mapping download.
- The current mapping source produced 535 groups under the conservative TV-only rules. Multiple parts mapped into one season, nonzero episode offsets and incomplete season sequences are intentionally excluded.
- A temporary local HTTP addon instance passed `test:seasons` against real Kitsu and mapping data. My Hero Academia had seasons 1–8 with episode counts **13, 25, 25, 25, 25, 25, 21, 11** (170 total). Season 2 episode 1 remained `kitsu:12268:1`; season 8 episode 1 remained `kitsu:49279:1`.
- Search returned one main My Hero Academia card; its films and Vigilantes remained separate. Existing direct metadata for the individual second season still returned the same Kitsu ID and original numbering.
- Two live popular catalog pages each returned 100 unique shows with no overlap.
- `npm run test:live` passed against all 40 category catalogs with grouping enabled, plus popular/top-rated/airing/movie lists, search, movie pagination and Cowboy Bebop episode checks. Shoujo Ai returned 99 unique entries from changing live results; the existing live checks allow nonempty pages up to 100, while fixed-data tests require exact pagination.
- The same local instance passed the artwork smoke checks with real TMDB authentication: Cowboy Bebop's JPEG was 46,233 bytes; Princess Mononoke's was 37,090 bytes. PNG logos, poster dimensions, episodes and ETag/304 validation passed. The temporary server used about 125 MiB RSS after those representative checks; this is a sample measurement, not a peak-memory guarantee.
- `git diff --check` passed. No runtime credentials are included in the repository. No new package dependencies or paid service are required.

After the approved release, repeat `npm run test:seasons -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run` and `npm run test:artwork -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run`. Confirm the public manifest reports 1.3.0. Refresh/reinstall the addon in Stremio and open the main show from its Kitsu catalog to verify the client season selector. Existing saved child-season cards are intentionally not migrated automatically.
