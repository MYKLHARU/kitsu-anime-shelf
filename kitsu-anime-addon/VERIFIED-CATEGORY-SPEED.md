# Category-speed verification — 11 November 2026

Release: 1.3.1. Recorded before deployment.

## Cause observed in 1.3.0

Public endpoint measurements: health 0.17 s; Action/Historical category responses 0.09 s; Isekai 7.01 s; Romance 10.08 s; repeated Historical 0.04 s; a requested My Hero Academia poster 0.17 s. Separate expanded Kitsu requests for 20 titles took 5.71 s and 6.48 s. These are observations, not a controlled network benchmark.

The code waited for 100 unique shows plus grouped-parent lookups for a category. It expanded every title's category relationships, and all category requests shared a three-request FIFO pool. Many initial row requests could queue in front of the continuation and parent requests required to finish an already-started row. Once caches expired, clients had to wait again.

## Change and verification

- Complete first pages stay available during background refresh: fresh for 15 minutes; reusable for 24 hours after completion; at most 64 entries; one background catalog refresh at a time; one-minute retry backoff. Cold loads deduplicate. Search and later pages retain their live behavior.
- Sparse catalog fields replace expanded category relationships. A paired Romance API sample returned 226,422 bytes for the old expanded page and 64,608 bytes for the lightweight page (20 titles in both). Timings were 0.97 s and 0.54 s respectively; network and provider conditions vary. Full details still fetch complete genres.
- Metadata and catalog-completion requests take priority over first-row and background work without increasing the three-request limit. Background ranking refreshes use isolated cursors; cached first-page IDs seed pagination so later pages do not jump to the refreshed order before the new first page is delivered.
- `npm test`: 47 passing tests. New tests cover immediate stale responses while refresh is blocked, serial background refresh, deduplication, retry backoff, bounded storage, expiry, preserved detail genres, ranking changes during pagination and request priority.
- `npm run test:live`: all 40 real category checks and existing list/search/episode checks passed with the optimized queries.
- A local real-data cache probe returned 100 Romance titles in 2,249.13 ms on its initial request and 0.02 ms on a repeat. Advancing the injected cache clock past 15 minutes returned the old complete page in 0.07 ms while a real refresh ran in the background; awaiting that refresh took 1,559.45 ms. The clock was simulated to test expiry; no claim is made that these sub-millisecond internal timings include public-network or Stremio rendering latency.
- A temporary local HTTP server passed the eight-season/170-episode My Hero Academia checks, search exclusions, legacy season IDs, two full unique catalog pages, and real authenticated Cowboy Bebop/Princess Mononoke logo/poster checks. Representative RSS remained about 125 MiB after those checks, not a peak-memory guarantee.
- No new packages, credentials, volumes or hosting changes are required. `git diff --check` passes.

After approved deployment: confirm public version 1.3.1, repeat season/artwork smoke checks, load all 44 fixed catalogs once, and measure repeat category responses. The cache is in memory, so first visits after process restarts still depend on Kitsu; cold searches, uncached later pages and fresh metadata can still be slow during provider outages.
