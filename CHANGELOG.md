# Release notes

## 2.0.0-rc.1 — release candidate (not yet released)

Personal shelves, built on the unchanged public add-on. Off unless `ACCOUNTS_ENABLED=true`; see `kitsu-anime-addon/DEPLOY-2.0.md`.

- **Accounts:** email and password sign-in with scrypt hashing, hashed server-side sessions in `__Host-` cookies, CSRF origin checks, rate limits, an audit log, device sign-out, data export and self-service account deletion. Registration can be closed with `REGISTRATION_OPEN=false`.
- **Watchlist and progress:** status, episode progress and score per title, stored in PostgreSQL with atomic updates and conflict detection between devices. Titles are verified against Kitsu before they are added.
- **AniList:** OAuth connection with encrypted token storage, automatic first import, two-way sync with a documented conflict policy, optional instant updates, and a list of titles that could not be matched exactly.
- **Recommendations:** ranked from the Kitsu categories of what you watch and how you rate it, excluding titles and seasons already on your shelf.
- **Personal Stremio rows:** Continue Watching, For You, Plan to Watch, On Hold and Completed, installed through revocable per-device links. Metadata and `kitsu:` episode IDs are identical to the public add-on, so playback is unchanged.
- **Dashboard:** a responsive 2.0 dashboard at `/dashboard` with a strict Content Security Policy. The setup page links to it when accounts are enabled.
- **Choose your rows:** the add-on now shows nothing in Stremio until you choose rows. Choose from Top 10 Airing, Most popular, Top rated, Airing now, Movies and the 40 genres, on the setup page (saved in the install link) or in the dashboard for your personal install link. **Existing installs of `/manifest.json` show no rows until reinstalled with choices.** IDs, metadata and playback are unchanged.
- **Discover:** a numbered Top 10 of the most popular airing anime, and browsing by Most popular, Top rated, Airing now, Movies and all 40 genres, each title addable to your shelf in one tap.
- **Database tooling:** a dependency-free PostgreSQL client (TLS, SCRAM-SHA-256), checksummed migrations (`npm run migrate`), and CI integration tests against PostgreSQL 16.

The public manifest keeps its ID, catalogs and ID prefix; its version is now 2.0.0-rc.1. `/health` also reports `version`, `accounts` and `anilist`.

## 1.4.3 — 12 November 2026

- Serve grouped category rows from the first-page cache again. Since 1.4.1 every category except Anime Movies waited for Kitsu once its 15-minute cursor expired; in a simulated slow-Kitsu test, loading all 44 homepage rows took about 29 seconds every 15 minutes. Stale rows now return immediately while they refresh in the background.
- Keep paging consistent with the cache. Each fixed catalog's browsing cursor lives as long as its cached first page, and a background refresh installs its new cursor at the same moment its new first page replaces the cached one. A client paging on from an older first page gets matching later pages, and a failed refresh keeps both.
- Give search its own pool of short-lived cursors so searches no longer evict category cursors.

The addon manifest and npm package are version 1.4.3.

## 1.4.2 — 12 November 2026

- List every episode of long-running airing series. Titles without a declared episode count (for example One Piece, with 1,410 episodes on Kitsu) previously stopped at episode 200. Episodes beyond the ten-page detail limit appear as "Episode N" with their correct Kitsu IDs.
- Fix a startup race in which an older saved anime-mapping file could replace a fresh download. Mapping files dated in the future are no longer treated as fresh.
- Tests use a private mapping cache instead of the shared system temp file, so repeated local test runs pass.

The addon manifest and npm package are version 1.4.2.

## 1.4.1 — 12 November 2026

- Keep grouped catalog pages on one in-memory browsing cursor. Cursors expire after 15 minutes; reopen from page one after expiry or a server restart.
- Bound episode-detail fetching to ten upstream pages per metadata request. Known episode counts still generate numbered entries, while unknown-count titles show fetched episodes. Basic metadata survives episode-detail outages.
- Honor numeric and HTTP-date Retry-After values, with a shared rate-limit cooldown capped at 60 seconds.
- Return bodyless HEAD responses for JSON and static assets, and report explicitly declared artwork capabilities in health responses.
- Save anime mappings atomically to a best-effort local cache and restore recent mappings during provider outages. Set ANIME_MAPPING_CACHE_PATH to choose persistent storage; the default temporary location may reset on redeployment.
- Publish a GitHub Pages website using the existing hosted add-on API, with release notes and installation links.

The addon manifest and npm package are version 1.4.1. Kitsu playback IDs, title logos, posters, and HD hero backgrounds remain supported.
