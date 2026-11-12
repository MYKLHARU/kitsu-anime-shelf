# Release notes

## 1.4.1 — 12 November 2026

- Keep grouped catalog pages on one in-memory browsing cursor. Cursors expire after 15 minutes; reopen from page one after expiry or a server restart.
- Bound episode-detail fetching to ten upstream pages per metadata request. Known episode counts still generate numbered entries, while unknown-count titles show fetched episodes. Basic metadata survives episode-detail outages.
- Honor numeric and HTTP-date Retry-After values, with a shared rate-limit cooldown capped at 60 seconds.
- Return bodyless HEAD responses for JSON and static assets, and report explicitly declared artwork capabilities in health responses.
- Save anime mappings atomically to a best-effort local cache and restore recent mappings during provider outages. Set ANIME_MAPPING_CACHE_PATH to choose persistent storage; the default temporary location may reset on redeployment.
- Publish a GitHub Pages website using the existing hosted add-on API, with release notes and installation links.

The addon manifest and npm package are version 1.4.1. Kitsu playback IDs, title logos, posters, and HD hero backgrounds remain supported.
