# Kitsu Anime Shelf 2.0 — security model

This describes the controls in the 2.0 release candidate, how they are tested, and what remains the operator's responsibility.

## Assets and trust boundaries

- **Account data:** email, password hash, library, sessions, install links, audit log.
- **Third-party secrets:** AniList access tokens (one-year bearer tokens), `ANILIST_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`.
- **Untrusted inputs:** every HTTP request; Kitsu, AniList and the mapping source are treated as untrusted data sources.

The browser dashboard and API share one origin (`PUBLIC_URL`). Stremio clients reach personal catalogs with an install token in the URL path and never see session cookies.

## Controls

| Area | Control | Where tested |
| --- | --- | --- |
| Passwords | scrypt (N=2¹⁵, r=8, p=1, 16-byte salt), constant-time comparison, automatic rehash when parameters increase, 10–256 characters, not equal to the email. Unknown emails run a dummy hash so timing and messages do not reveal accounts. | `security.test.mjs`, `v2-e2e.test.mjs` |
| Sessions | 256-bit random tokens; only SHA-256 hashes stored. Cookie `__Host-kas_session` over HTTPS (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`). 14-day idle and 30-day absolute expiry. A new token is issued at each login (no fixation). Password changes sign out other sessions; users can revoke other devices. | e2e |
| CSRF | Every non-GET API request must carry `Origin` equal to `PUBLIC_URL`, must not be `Sec-Fetch-Site: cross-site`, and bodies must be `application/json` (cross-site forms cannot send this without CORS preflight, which is never granted). GET requests do not change state. Cross-origin GETs with a foreign `Origin` are rejected. | e2e |
| Authorisation | User IDs come only from the verified session; every query filters by that ID. Install tokens are read-only and limited to the personal add-on; they are not sessions. Tested with a second user attempting reads, deletes and revocations. | e2e |
| OAuth | Random single-use `state` (hash stored, 10-minute expiry) bound to the initiating user; code exchanged server-side; one AniList account per shelf; fixed redirect URI derived from `PUBLIC_URL`; callback redirects only to `/dashboard`. | e2e, `anilist.test.mjs` |
| Secrets at rest | AniList tokens: AES-256-GCM, random 96-bit IV, user-bound additional authenticated data, key ID prefix. Tokens never appear in API responses, exports or logs. | `security.test.mjs`, e2e |
| Injection | All SQL is parameterised (no user data in SQL text). The dashboard builds DOM with `textContent` only and runs under `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'`. | e2e (headers), review |
| Abuse limits | Per-IP and per-account limits: registration 5/hour/IP, login 10 per 15 min per IP+email and 30 per IP, password change 5/15 min, AniList sync 6/hour, all API calls 600/min/IP, personal add-on requests 300/min/IP and 240/min per valid link, at most 10 active links. Credential limits are kept in a separate store that other traffic cannot evict, and the limiter drops expired windows before live ones. AniList calls are queued per user, with a bounded shared queue. JSON bodies at most 16 KiB; URLs at most 4 KiB; control characters are rejected in names, labels and emails. | e2e, unit |
| Headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` on the API, HSTS over HTTPS. | e2e |
| Database | TLS with `sslmode` semantics (`verify-full` is the default for non-local hosts; `verify-ca` requires a pinned `sslrootcert`); SCRAM-SHA-256 with mandatory server signature verification and bounded iteration counts; refuses cleartext passwords without TLS; one timeout covering TCP, TLS and authentication; a connection is discarded after any unexpected protocol error; fixed ISO dates in UTC; 15-second statement timeout (lifted for migrations); constraints on email format, token hash lengths, HTTPS poster URLs and enum values. | `pg-client.test.mjs` |
| Privacy | JSON export of all stored personal data; self-service deletion (password required) cascades everything; audit log entries are kept 90 days. No analytics or third-party scripts. | e2e |
| Failure isolation | 2.0 starts only with a complete configuration and an up-to-date schema; otherwise the public add-on runs unchanged. Internal errors return a generic message. | e2e |

## Operator responsibilities

- Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -hex 32` and keep it in the host's secret store. Losing it only means users reconnect AniList; leaking it, together with a database copy, exposes AniList tokens.
- Use `sslmode=verify-full` (with `sslrootcert` if the provider uses a private CA). Give the application role only the privileges it needs after migrating.
- Set `TRUST_PROXY_HOPS=1` on Northflank or Render so rate limits use the client address rather than the proxy's. Leave it at `0` when the service is reached directly. The service logs a warning if it sees `X-Forwarded-For` while this is `0`.
- Back up the database. Keep `REGISTRATION_OPEN=false` if the instance is meant for yourself or invited users.
- Run a single web instance, or accept per-instance rate limits.

## Independent review

Before the release candidate was pushed, a separate reviewer audited the 2.0 code adversarially. It reported no critical issues. Its confirmed findings were fixed, each with a regression test:

- High: limiter-key flooding through random install links could evict login limits.
- High: AniList sync could lose edits through a stale push after an edit made during a run, or a full-entry auto-push clearing AniList-only values.
- Medium: an unbounded shared AniList queue.
- Medium: `verify-ca` without a pinned CA; missing handshake timeout; leaked sockets.
- Low: control characters causing 500 errors; HEAD on the library list.

Registration still reveals whether an email is registered (HTTP 409), limited to five attempts an hour per address. This is accepted so that people get a clear message.

## Known gaps

- No email verification, password reset or multi-factor authentication.
- No account lockout beyond rate limiting (deliberately, to avoid lockout-based denial of service).
- Install links are bearer URLs. Anyone who obtains one can see that user's shelf rows (read-only) until it is revoked.
- The PostgreSQL client is project code rather than a widely used library. It is covered by integration tests, but switching to `pg` reduces long-term maintenance risk.
