# Kitsu Anime Shelf 2.0 — architecture

Status: **release candidate 2.0.0-rc.1** on `feature/2.0-foundations`. Not merged or deployed.

2.0 adds personal shelves on top of the unchanged public Stremio add-on: accounts, a PostgreSQL watchlist with progress tracking, AniList sync, recommendations, a dashboard, and personal Stremio catalogs. All of it is **off unless `ACCOUNTS_ENABLED=true`** and the configuration is complete. If 2.0 cannot start safely (missing settings, database unreachable, pending migrations), the service logs why and runs as the 1.x public add-on.

## Compatibility guarantees

- The public manifest keeps its ID (`personal.kitsu.anime.shelf`), `kitsu:` ID prefix and episode video IDs (`kitsu:<id>:<n>`). **Rows are chosen by the user:** the plain `/manifest.json` lists only search and sets `configurationRequired`, so existing installs show no rows until reinstalled from the setup page. Configured installs use `/c/<keys>/manifest.json` (see `src/catalog-config.mjs`), and the same catalog, meta and artwork routes work under that prefix. A new `kitsu-top10` catalog serves the first ten of Currently Airing.
- Public routes (`/manifest.json`, `/catalog/…`, `/meta/…`, artwork, `/health`, the setup site) are handled by the same code as 1.4.3. The 2.0 application only receives `/api/v2/*`, `/u/*` and `/dashboard*`.
- Personal catalogs are a **separate** add-on (`personal.kitsu.anime.shelf.mine`) at `/u/<install-token>/manifest.json`. Its metadata responses come from the same Kitsu service, so playback through Kitsu-compatible stream add-ons works identically. The end-to-end test asserts that personal and public metadata are byte-for-byte equal.
- `/health` gains `version`, `accounts` and `anilist` fields; existing fields are unchanged.

## Components (`kitsu-anime-addon/src/`)

| Module | Responsibility |
| --- | --- |
| `pg-client.mjs` | Dependency-free PostgreSQL client: TLS (libpq `sslmode`), SCRAM-SHA-256, parameterised extended-protocol queries, pool, transactions. Exposes the `pg`-compatible `query(text, values)`, so the `pg` package can replace it later. |
| `migrate.mjs`, `scripts/migrate.mjs` | Ordered, checksummed migrations, each in its own transaction under an advisory lock. `npm run migrate`, `npm run migrate -- --status`. |
| `security.mjs` | scrypt password hashing, AES-256-GCM token encryption, random tokens, cookies, client IP behind proxies, rate limiter. |
| `account-store.mjs` | Users, sessions, install tokens, OAuth state, provider connections, audit log, export, deletion, retention clean-up. |
| `anime-store.mjs` | Canonical anime records, created only for Kitsu IDs that Kitsu confirms; cached title, poster, categories and episode count. One-to-one Kitsu↔AniList index from the Fribb mappings. |
| `library-model.mjs`, `library-store.mjs`, `postgres-library-adapter.mjs` | Library domain model and storage. Atomic partial updates, optimistic concurrency (`revision`, `If-Match`), list and delete. |
| `library-api.mjs` | `/api/v2/library` HTTP handler (list, get, patch, delete). |
| `anilist.mjs`, `anilist-sync.mjs` | AniList OAuth and GraphQL client; two-way sync (see [ANILIST-SYNC.md](ANILIST-SYNC.md)). |
| `recommendations.mjs` | Category-affinity recommendations from Kitsu data. |
| `personal-addon.mjs` | Personal Stremio add-on behind revocable install tokens. |
| `v2-app.mjs` | Router: auth, account, library, AniList, recommendations, install links, dashboard assets, security headers, CSRF and rate limits. |
| `v2.mjs` | Reads configuration, checks the schema and assembles everything. |
| `public/dashboard.*` | Responsive dashboard (no framework, no inline script, strict CSP). |

## Data model (migrations `001`, `002`)

`shelf_users` (email, scrypt hash) → `shelf_sessions` (SHA-256 of session token), `shelf_install_tokens` (SHA-256 of install token), `shelf_provider_connections` (encrypted AniList token, sync state), `shelf_oauth_states`, `shelf_library_entries` (status, progress, score, revision), `shelf_watch_events` (reserved), `shelf_audit_log` (90-day retention). `shelf_anime` and `shelf_anime_external_ids` hold canonical anime and provider IDs (`kitsu` verified; `anilist` derived from one-to-one mappings only). Deleting a user cascades to all of their data.

## API summary

All responses are JSON with `Cache-Control: no-store`. Non-GET requests must send `Origin: <PUBLIC_URL>` and `Content-Type: application/json` (when there is a body).

| Method and path | Purpose |
| --- | --- |
| `GET /api/v2/config` | Feature availability. |
| `POST /api/v2/auth/register`, `/login`, `/logout` | Session lifecycle. |
| `GET/PATCH /api/v2/me` | Profile. |
| `POST /api/v2/me/password`, `GET /api/v2/me/sessions`, `POST /api/v2/me/sessions/revoke-others` | Credentials and devices. |
| `GET /api/v2/me/export`, `POST /api/v2/me/delete` | Data export and deletion. |
| `GET /api/v2/library[?status=]`, `GET/PATCH/DELETE /api/v2/library/kitsu:<id>` | Watchlist and progress. `PATCH` accepts `status`, `progress`, `score` and an optional `If-Match: "<revision>"`. |
| `GET /api/v2/recommendations` | Personalised suggestions. |
| `GET/POST /api/v2/stremio/tokens`, `DELETE /api/v2/stremio/tokens/:id` | Personal add-on install links (shown once). |
| `GET/PUT /api/v2/stremio/catalogs` | Lists and genres in the personal add-on (migration 003). |
| `POST /api/v2/anilist/connect`, `GET /api/v2/anilist/callback`, `GET /api/v2/anilist/status`, `POST /api/v2/anilist/sync`, `PATCH /api/v2/anilist/settings`, `DELETE /api/v2/anilist` | AniList. |
| `GET /u/<token>/manifest.json`, `/u/<token>/catalog/series/<id>.json`, `/u/<token>/meta/series/<id>.json` | Personal Stremio add-on. |

## Known limitations

- **No email verification or password reset.** There is no mail service, so a forgotten password cannot be recovered; the owner can reset it in the database. Set `REGISTRATION_OPEN=false` for a private deployment.
- **Progress from Stremio playback is not captured.** Stremio does not send playback events to catalog add-ons. Progress comes from the dashboard and AniList.
- **In-process state.** Rate limits, recommendation caches and AniList sync jobs run in the web process. One instance is assumed; with several instances, limits apply per instance, and a sync interrupted by a restart is retried after 15 minutes.
- **Built-in database client.** It was written because no new npm dependency could be installed in the development environment. It is tested against PostgreSQL 16 (TLS and SCRAM) in CI. Moving to the `pg` package is a drop-in change.
- AniList matching depends on the community Fribb mappings; ambiguous or missing mappings are reported, not guessed.

## History

The 2.0 work began with ChatGPT's foundations (library model, schema 001, PostgreSQL adapter with atomic patch, unmounted library handler). Claude reviewed and ran them (all 80 existing tests passed), then completed the release candidate: database client and migrations, authentication, the mounted API, AniList, recommendations, personal catalogs, dashboard, CI database tests and documentation. Changes to the earlier foundations: schema 001 no longer manages its own transaction (the migration runner does); the adapter adds revisions, list and delete; the library handler adds list, delete, `If-Match`, and maps unmapped IDs to 404 instead of 500; the mapping loader keeps AniList IDs.
