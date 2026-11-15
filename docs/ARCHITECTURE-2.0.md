# Kitsu Anime Shelf 2.0 — incremental architecture

## Existing system (audit findings)

The project is a Node.js 22+ ESM Stremio HTTP add-on. Its service entry point is `kitsu-anime-addon/server.mjs`, which calls `createAddonServer` from `src/addon.mjs`. The service already implements Kitsu catalogs, grouped-season metadata, image fallbacks, caching and provider throttling. The public GitHub Pages site is built from `kitsu-anime-addon/public/` into `docs/`. The package has a Node built-in test runner and currently depends on Sharp.

**Keep the existing Stremio resource handlers and Kitsu episode/video IDs intact.** Changing IDs could break installed stream add-ons and saved library entries.

## First foundation

`src/library-model.mjs` introduces a small, pure, independently testable model for library entries and namespaced anime identifiers. No database, accounts, API routes, secrets or deployment changes are introduced. It is intentionally not wired into the public HTTP server.

Run `cd kitsu-anime-addon && npm test` to exercise the new tests alongside the existing suite.

## Proposed next increments

1. Add an internal anime identity table with unique `(provider, external_id)` constraints. Keep the existing Kitsu ID as the Stremio-facing ID until mappings are verified.
2. Add PostgreSQL migrations for `users`, `anime`, `anime_external_ids`, `library_entries`, `watch_events`, `provider_connections` and `sync_jobs`. Scope all user data by authenticated user ID.
3. Add authenticated library endpoints and manual progress updates with idempotency keys and audit timestamps. Avoid claiming playback events are available in all Stremio clients.
4. Add AniList OAuth with encrypted tokens, background sync, explicit conflict handling, and retry/rate-limit policies.
5. Add recommendation ranking and user-specific catalogs behind feature flags. Keep anonymous catalogs fully operational.

## Design constraints

- Never expose account OAuth tokens or database credentials in manifests or browser bundles.
- Use revocable installation tokens for personalized Stremio manifests; avoid long-lived account tokens in URLs.
- Provide export and deletion controls for user data.
- Preserve current public catalog behavior while new features are gated.
- Treat provider mappings as evidence-based and ambiguous season mappings as unresolved.
- Run the existing tests and live integration checks before merging or deploying.

## Audit scope

This initial audit is based on the repository README, package manifest, service entry point, and existing documented behavior. It is not a complete line-by-line security or performance audit. No live API, database, or deployment tests were performed as part of this first change.


## Second foundation: persistence boundary

- `kitsu-anime-addon/migrations/001_personal_library.sql` provides a **review-only PostgreSQL schema** for users, canonical anime, provider IDs, per-user library entries, and idempotent watch events. It is not applied automatically.
- `src/library-store.mjs` defines an asynchronous adapter boundary and a **test-only, non-durable** in-memory adapter. The service validates user IDs and entry data, and its tests check user isolation.
- No routes are exposed and no external database connection is created. Production authentication, authorization, transactional updates and connection pooling are still required.

**Before production:** implement a PostgreSQL adapter with atomic upserts, verified session-to-user binding (never trust a user ID supplied by the client), database least-privilege roles, migration tooling and backups. The current read-then-write service is not concurrency-safe for competing progress updates; implement optimistic concurrency or a transactional upsert before accepting real users. Confirm the canonical-anime mapping policy and provide account data export/deletion.
