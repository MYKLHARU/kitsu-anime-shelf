# Artwork verification — 11 November 2026

Verified locally against this change; the existing Northflank deployment has not been changed by this PR.

- Automated suite: 25 passing tests, including the 10 existing addon tests. Tests cover both TMDB credential formats, lazy catalog decoration, conservative title/year and explicit ID matching, ambiguous matches, language/PNG preference, upstream failures, image validation, actual composition pixels and dimensions, deduplication, cache eviction, HTTP HEAD/ETag/304 and fallback redirects.
- `npm run test:live`: passed against real Kitsu for all 40 category catalogs, popular/top-rated/airing/movie lists, search, second-page movie navigation and Cowboy Bebop's 26 episodes. The changing top-rated list returned 99 unique titles after deduplication; the live check now permits a nonempty page up to 100 entries. Fixed-data unit tests still require exact 100-item pagination.
- `npm run test:artwork -- http://127.0.0.1:47865`: passed against a temporary local addon instance using real TMDB authentication, real Fribb ID mappings, real Kitsu metadata/posters and real TMDB images. Cowboy Bebop (TV) returned a PNG logo and a 46,233-byte composed JPEG; Princess Mononoke (film) returned a PNG logo and a 37,090-byte composed JPEG. Both posters were 360×540, with valid ETags and successful 304 responses; episode navigation was preserved. Credentials were supplied only to the local test process and are absent from the repository.
- The Cowboy Bebop poster was visually inspected: title logo centered over the shaded lower portion, with the original artwork retained.
- `git diff --check`: passed. Dependency installation audit reported no vulnerabilities.

GitHub Actions adds the same automated suite on Node.js 22/Linux to verify native image-library installation on the deployment platform. Live calls are intentionally separate from CI to avoid requiring secrets and depending on changing provider catalogs.

Remaining deployment checks: merge the reviewed change, set the private TMDB runtime credential and `PUBLIC_URL` on Northflank, rebuild with dependencies, run the artwork check against the public service URL, then verify the installed addon on the user's Stremio client. No interactive Stremio client check has been performed locally.
