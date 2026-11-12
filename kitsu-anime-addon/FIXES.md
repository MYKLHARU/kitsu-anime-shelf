# Reliability fixes

- Grouped catalogs now use one live in-memory cursor for first and subsequent pages. The unrelated 24-hour first-page cache is not used for grouped results. Restarting the process or waiting past the cursor TTL can still change rankings; clients should reopen at page one.
- Episode-detail fetching is bounded to ten pages (200 actual episode records) per metadata request. Known `episodeCount` values still generate numbered video entries up to the existing 20,000 limit. For titles without a known count, only fetched episodes are listed. Missing episode details no longer prevent basic anime metadata from being returned.
- HTTP 429 retries honor numeric and HTTP-date `Retry-After` headers, with a shared cooldown capped at 60 seconds. Upstream 5xx retries also respect the delay.
- JSON and static asset HEAD responses do not include a body.
- The `/health` endpoint accepts an explicitly declared `service.capabilities.artwork` for injected services; without that declaration it reports only known local artwork support.
- Anime mappings are saved atomically to a local best-effort cache and can be restored for up to seven days after a source outage. Override the location with `ANIME_MAPPING_CACHE_PATH` for persistent storage on hosts where the system temp directory is ephemeral. Cache persistence failures do not prevent operation.

Run `npm ci && npm test` inside `kitsu-anime-addon`. The grouped-pagination regression test covers ranking changes within the 15-minute cursor lifetime and a fresh browsing order after expiry. Dependency-free regression tests can also be run with `node --test test/reliability-fixes.test.mjs`.
