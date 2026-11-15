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


## Third foundation: PostgreSQL adapter

`src/postgres-library-adapter.mjs` adds a dependency-injected PostgreSQL adapter using parameterized queries and an atomic upsert. It maps existing `kitsu:<id>`-style identifiers to canonical anime records via `shelf_anime_external_ids`. Unknown IDs are rejected rather than guessed. It does not open connections or enable HTTP routes. Tests use a mocked query interface.

**Known limitations:** The higher-level `createLibraryService.save` still performs a read followed by a write, so two simultaneous partial updates can overwrite each other. The adapter's upsert is atomic, but the overall read-modify-write operation is not. Do not expose concurrent authenticated writes until a transactional patch API or version check is implemented. The adapter also requires pre-created user and canonical anime rows; migration, account provisioning and mapping ingestion are separate work. UUID validation is syntactic, not authentication.

The environment could not clone the public repository to run tests (network DNS unavailable). Run CI and review test results before merging.


## Fourth foundation: atomic partial library writes

The library service now prefers `adapter.patch` for partial changes. The PostgreSQL adapter implements a single-statement conditional `INSERT ... ON CONFLICT DO UPDATE`, preserving fields not supplied by the caller even under competing updates to different fields. A test verifies that no preliminary read occurs on this path. The memory adapter also supports patch, but is for tests only.

This is **not** a substitute for an authenticated API, event-level idempotency, or optimistic concurrency for competing writes to the same field. No live user endpoint has been enabled.


## Fifth foundation: unmounted authenticated library handler

`src/library-api.mjs` adds a small, **unmounted** HTTP handler for `GET /api/v2/library/:animeId` and `PATCH /api/v2/library/:animeId`. It requires an injected `authenticate(req)` verifier and an exact HTTPS dashboard origin, rejects unsupported methods and fields, limits JSON request size, and sends no-store responses. Tests use a mock HTTP request/response pair.

**Security boundary:** This is not an authentication implementation. Do not mount it until the verifier validates a real server-side session or access token, the dashboard and deployment's CSRF model are reviewed, and request throttling and audit logging are added. User IDs must be sourced only from verified sessions. The public Stremio server is deliberately unchanged. The handler does not yet provide list, delete, or export endpoints.
